// Fetches PR state for every repo in pr-desk.config.json and writes
// public/data/pr-board.json (what the page reads) and public/data/state.json
// (carried to the next run so conflict start/resolve times can be tracked).
//
//   GITHUB_TOKEN=$(gh auth token) npm run sync
//
// Cost: roughly 1 + open/10 + merged/50 GraphQL calls per repo (~40 for a repo
// with 200 open PRs), plus one REST call per unlisted author for public org
// memberships, cached for a week.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig, type PrDeskConfig } from "../src/lib/config";
import { isBot } from "../src/lib/bots";
import { MERGE_HEADLINE } from "../src/lib/derive";
import {
  SNAPSHOT_VERSION,
  type AuthorProfile,
  type RawMergedPr,
  type RawPr,
  type RawPrEvent,
  type Snapshot,
  type SyncState,
} from "../src/lib/snapshot";
import { RATE, client, pool, runQuery, usage, type Gql } from "./github";

const CONFIG_FILE = process.env.PR_DESK_CONFIG ?? "pr-desk.config.json";
const OUT_DIR = path.join("public", "data");
const BOARD_FILE = path.join(OUT_DIR, "pr-board.json");
const STATE_FILE = path.join(OUT_DIR, "state.json");

const CONCURRENCY = 4;
const DETAIL_BATCH = 10;
const PROFILE_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

const PR_FIELDS = `
  number title url createdAt updatedAt isDraft additions deletions
  mergeable reviewDecision maintainerCanModify
  author { login }
  labels(first: 10) { nodes { name color } }
  reviewRequests(first: 10) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  latestOpinionatedReviews(first: 20) { nodes { state submittedAt author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  timelineItems(last: 60, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, READY_FOR_REVIEW_EVENT, REVIEW_DISMISSED_EVENT]) {
    nodes {
      __typename
      ... on PullRequestCommit { commit { committedDate messageHeadline parents { totalCount } } }
      ... on HeadRefForcePushedEvent { createdAt actor { login } }
      ... on PullRequestReview { submittedAt state author { login } }
      ... on IssueComment { createdAt author { login } }
      ... on ReadyForReviewEvent { createdAt }
      ... on ReviewDismissedEvent { createdAt previousReviewState }
    }
  }
`;

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

function mapTimeline(nodes: any[]): RawPrEvent[] {
  const out: RawPrEvent[] = [];
  for (const n of nodes ?? []) {
    switch (n?.__typename) {
      case "PullRequestCommit": {
        const c = n.commit;
        if (!c?.committedDate) break;
        const merge = (c.parents?.totalCount ?? 1) > 1 || MERGE_HEADLINE.test(c.messageHeadline ?? "");
        out.push({ kind: "commit", at: c.committedDate, merge });
        break;
      }
      case "HeadRefForcePushedEvent":
        out.push({ kind: "force_push", at: n.createdAt, actor: n.actor?.login ?? null });
        break;
      case "PullRequestReview":
        // Pending reviews have no submittedAt and aren't visible to anyone yet.
        if (n.submittedAt && n.author?.login) out.push({ kind: "review", at: n.submittedAt, actor: n.author.login, state: n.state });
        break;
      case "IssueComment":
        if (n.author?.login) out.push({ kind: "comment", at: n.createdAt, actor: n.author.login });
        break;
      case "ReadyForReviewEvent":
        out.push({ kind: "ready", at: n.createdAt });
        break;
      case "ReviewDismissedEvent":
        out.push({ kind: "dismissed", at: n.createdAt, previousState: n.previousReviewState ?? null });
        break;
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function mapPr(repo: string, n: any, bots: string[]): RawPr | null {
  const author = n?.author?.login;
  if (!n || !author || isBot(author, bots)) return null;
  return {
    repo,
    number: n.number,
    title: n.title,
    url: n.url,
    author,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    isDraft: !!n.isDraft,
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    mergeable: n.mergeable ?? "UNKNOWN",
    reviewDecision: n.reviewDecision ?? null,
    maintainerCanModify: !!n.maintainerCanModify,
    ciState: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    labels: (n.labels?.nodes ?? []).map((l: any) => ({ name: l.name, color: l.color })),
    requestedReviewers: (n.reviewRequests?.nodes ?? [])
      .map((r: any) => r.requestedReviewer?.login ?? (r.requestedReviewer?.slug ? `team/${r.requestedReviewer.slug}` : null))
      .filter(Boolean),
    latestReviews: (n.latestOpinionatedReviews?.nodes ?? [])
      .filter((r: any) => r.author?.login && r.submittedAt)
      .map((r: any) => ({ author: r.author.login, state: r.state, at: r.submittedAt })),
    timeline: mapTimeline(n.timelineItems?.nodes ?? []),
    conflictSince: null,
    conflictResolvedAt: null,
  };
}

// Cursor pagination over full PR detail is slow (~6s per page of 25), so list
// open numbers cheaply, then fetch detail in parallel aliased batches.
async function listOpenNumbers(gql: Gql, owner: string, name: string): Promise<number[]> {
  const q = `query($owner: String!, $name: String!, $cursor: String) { ${RATE}
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { number } }
    } }`;
  const out: number[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < 50; p++) {
    const res: any = await runQuery(gql, `${owner}/${name} open list p${p}`, q, { owner, name, cursor });
    const page = res?.repository?.pullRequests;
    if (!page) throw new Error(`Repository ${owner}/${name} not found or not readable with this token`);
    for (const n of page.nodes ?? []) if (n?.number) out.push(n.number);
    if (!page.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

async function fetchByNumber(
  gql: Gql,
  owner: string,
  name: string,
  numbers: number[],
  fields: string,
  label: string,
  batchSize: number,
): Promise<Map<number, any>> {
  const batches: number[][] = [];
  for (let i = 0; i < numbers.length; i += batchSize) batches.push(numbers.slice(i, i + batchSize));
  const out = new Map<number, any>();
  await pool(
    batches.map((chunk, b) => async () => {
      const body = chunk.map((n) => `p${Number(n)}: pullRequest(number: ${Number(n)}) { ${fields} }`).join("\n");
      const q = `query($owner: String!, $name: String!) { ${RATE} repository(owner: $owner, name: $name) { ${body} } }`;
      const res: any = await runQuery(gql, `${owner}/${name} ${label} b${b}`, q, { owner, name });
      for (const n of chunk) {
        const node = res?.repository?.[`p${n}`];
        if (node) out.set(n, node);
      }
    }),
    CONCURRENCY,
  );
  return out;
}

async function fetchOpen(gql: Gql, repo: string, bots: string[]): Promise<RawPr[]> {
  const { owner, name } = splitRepo(repo);
  const numbers = await listOpenNumbers(gql, owner, name);
  const nodes = await fetchByNumber(gql, owner, name, numbers, PR_FIELDS, "open", DETAIL_BATCH);
  const prs = numbers.map((n) => mapPr(repo, nodes.get(n), bots)).filter((p): p is RawPr => !!p);

  // GitHub computes mergeability lazily: the first read after a push often
  // returns UNKNOWN and starts the computation. One delayed re-read settles most.
  const unknown = prs.filter((p) => p.mergeable === "UNKNOWN");
  if (unknown.length) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetchByNumber(gql, owner, name, unknown.map((p) => p.number), "mergeable", "mergeable", 50);
      for (const p of unknown) p.mergeable = res.get(p.number)?.mergeable ?? p.mergeable;
    } catch (e: any) {
      console.warn(`  ! ${repo}: mergeable re-read failed: ${e?.message}`);
    }
  }
  return prs;
}

// Walk merged PRs by most recent update and stop once a page is entirely
// older than the window (mergedAt <= updatedAt, so nothing recent is skipped).
// Search is avoided: it's several times slower here.
async function fetchMerged(gql: Gql, repo: string, days: number, bots: string[]): Promise<RawMergedPr[]> {
  const { owner, name } = splitRepo(repo);
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const q = `query($owner: String!, $name: String!, $cursor: String) { ${RATE}
    repository(owner: $owner, name: $name) {
      pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url createdAt updatedAt mergedAt
          author { login }
          mergedBy { login }
          reviews(first: 10) { nodes { submittedAt author { login } } }
          comments(first: 10) { nodes { createdAt author { login } } }
        }
      }
    } }`;
  const out: RawMergedPr[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < 60; p++) {
    const res: any = await runQuery(gql, `${repo} merged p${p}`, q, { owner, name, cursor });
    const page = res?.repository?.pullRequests;
    if (!page) break;
    let oldestUpdated: string | null = null;
    for (const n of page.nodes ?? []) {
      oldestUpdated = n?.updatedAt ?? oldestUpdated;
      const author = n?.author?.login;
      if (!n?.mergedAt || n.mergedAt < since || !author || isBot(author, bots)) continue;
      const a = author.toLowerCase();
      const responses: string[] = [
        ...(n.reviews?.nodes ?? []).filter((r: any) => r.submittedAt).map((r: any) => ({ at: r.submittedAt, who: r.author?.login })),
        ...(n.comments?.nodes ?? []).map((c: any) => ({ at: c.createdAt, who: c.author?.login })),
      ]
        .filter((x: any) => x.who && x.who.toLowerCase() !== a && !isBot(x.who, bots))
        .map((x: any) => x.at)
        .sort();
      out.push({
        repo,
        number: n.number,
        title: n.title,
        url: n.url,
        author,
        createdAt: n.createdAt,
        mergedAt: n.mergedAt,
        mergedBy: n.mergedBy?.login ?? null,
        firstResponseAt: responses[0] ?? null,
      });
    }
    if (!page.pageInfo?.hasNextPage || (oldestUpdated && oldestUpdated < since)) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

type StoredProfile = AuthorProfile & { at: string };
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Public org memberships only. The GraphQL `user.organizations` field also
// returns *private* memberships the token's owner can see, which would end up
// on a public page and make results depend on whose token ran the sync. The
// REST endpoint lists public memberships for every token.
async function publicOrgs(login: string): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/orgs?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { login: string }[];
  return body.map((o) => o.login);
}

// Company + public org memberships, for groups' `match` terms. A hint only;
// `members` lists always win.
async function fetchProfiles(gql: Gql, logins: string[]): Promise<Record<string, StoredProfile>> {
  const out: Record<string, StoredProfile> = {};
  const now = new Date().toISOString();
  const chunks: string[][] = [];
  for (let i = 0; i < logins.length; i += 40) chunks.push(logins.slice(i, i + 40));

  const companies: Record<string, string | null> = {};
  await pool(
    chunks.map((chunk) => async () => {
      const vars: Record<string, string> = {};
      const decls: string[] = [];
      const fields: string[] = [];
      chunk.forEach((login, j) => {
        vars[`l${j}`] = login;
        decls.push(`$l${j}: String!`);
        fields.push(`u${j}: user(login: $l${j}) { company }`);
      });
      const q = `query(${decls.join(", ")}) { ${RATE} ${fields.join("\n")} }`;
      let data: any;
      try {
        data = await runQuery(gql, `profiles ${chunk.length}`, q, vars);
      } catch (e: any) {
        // A renamed/deleted account fails its own alias only; @octokit/graphql
        // throws with the partial result on `e.data`.
        data = e?.data;
      }
      chunk.forEach((login, j) => (companies[login] = data?.[`u${j}`]?.company ?? null));
    }),
    CONCURRENCY,
  );
  await pool(
    logins.map((login) => async () => {
      out[login.toLowerCase()] = { company: companies[login] ?? null, orgs: await publicOrgs(login).catch(() => []), at: now };
    }),
    CONCURRENCY,
  );
  return out;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, file);
}

// Conflict start/resolve times aren't events on GitHub, so compare each PR's
// mergeability with what the previous run saw. A conflict's start is only
// known when a run saw the PR mergeable and the next saw it conflicting; one
// that predates the first run stays unknown rather than starting "now".
function applyState(prs: RawPr[], prev: SyncState): SyncState {
  const now = new Date().toISOString();
  const next: SyncState = { version: 2, prs: {} };
  for (const pr of prs) {
    const key = `${pr.repo}#${pr.number}`;
    const was = prev.prs[key];
    let entry: SyncState["prs"][string];
    if (pr.mergeable === "CONFLICTING") {
      entry = { m: "C", conflictSince: was?.m === "M" ? now : was?.conflictSince };
    } else if (pr.mergeable === "MERGEABLE") {
      entry = { m: "M", conflictResolvedAt: was?.m === "C" ? now : was?.conflictResolvedAt };
    } else {
      entry = { ...(was ?? {}) }; // UNKNOWN: no new information
    }
    pr.conflictSince = entry.conflictSince ?? null;
    pr.conflictResolvedAt = entry.conflictResolvedAt ?? null;
    next.prs[key] = JSON.parse(JSON.stringify(entry)); // drop undefined fields
  }
  return next;
}

async function main() {
  const t0 = Date.now();
  const config: PrDeskConfig = parseConfig(JSON.parse(await readFile(CONFIG_FILE, "utf8")));
  const gql = client();
  const now = new Date().toISOString();

  const stored = await readJson<SyncState>(STATE_FILE);
  const prevState: SyncState = stored?.version === 2 ? stored : { version: 2, prs: {} };
  const prevBoard = await readJson<Snapshot>(BOARD_FILE);

  const open: RawPr[] = [];
  const merged: RawMergedPr[] = [];
  const window = Math.max(config.recentMergedDays, config.historyDays);
  for (const repo of config.repos) {
    const [o, m] = await Promise.all([fetchOpen(gql, repo, config.bots), fetchMerged(gql, repo, window, config.bots)]);
    console.log(`${repo}: ${o.length} open, ${m.length} merged in the last ${window} days`);
    open.push(...o);
    merged.push(...m);
  }
  const state = applyState(open, prevState);

  // Profiles are only needed when some group matches on them, and only for
  // authors no list already places. Reuse recent lookups from the last run.
  const profiles: Record<string, StoredProfile> = {};
  if (config.groups.some((g) => g.match.length)) {
    const pinned = new Set(
      [...config.community.members, ...config.groups.flatMap((g) => g.members)].map((l) => l.toLowerCase()),
    );
    const prevProfiles = (prevBoard?.profiles ?? {}) as Record<string, StoredProfile>;
    const fresh = Date.now() - PROFILE_TTL_DAYS * DAY_MS;
    const wanted = new Set<string>();
    for (const p of [...open, ...merged]) {
      const l = p.author.toLowerCase();
      if (pinned.has(l) || !LOGIN_RE.test(p.author)) continue;
      const cached = prevProfiles[l];
      if (cached?.at && Date.parse(cached.at) > fresh) profiles[l] = cached;
      else wanted.add(p.author);
    }
    Object.assign(profiles, await fetchProfiles(gql, Array.from(wanted)));
  }

  const snapshot: Snapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: now,
    host: process.env.GITHUB_REPOSITORY ?? null,
    config,
    open,
    merged,
    profiles,
  };
  await writeJson(BOARD_FILE, snapshot);
  await writeJson(STATE_FILE, state);

  const { calls, lastRemaining } = usage();
  console.log(
    `Wrote ${BOARD_FILE}: ${open.length} open, ${merged.length} merged, ${Object.keys(profiles).length} profiles ` +
      `— ${calls} API calls in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (lastRemaining != null ? `, ${lastRemaining} left this hour` : ""),
  );
}

main().catch((e) => {
  console.error(e?.errors ? JSON.stringify(e.errors, null, 2) : e);
  process.exit(1);
});
