// Fetches PR state for every repo in pr-desk.config.json and writes, under
// public/data/:
//   pr-board.json  what the page reads first: open PRs and the config
//   history.json   every merged PR, compact (Trends view); extended each run
//   state.json     conflict tracking carried to the next run
//
//   GITHUB_TOKEN=$(gh auth token) npm run sync
//
// Cost per repo: ~1 + open/10 GraphQL calls for open PRs (~22 for 200 open),
// usually 1 for new merges, plus a one-time backfill of merged history
// (merged/50 calls).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig, type PrDeskConfig } from "../src/lib/config";
import { isBot } from "../src/lib/bots";
import { MERGE_HEADLINE } from "../src/lib/derive";
import {
  SNAPSHOT_VERSION,
  HISTORY_VERSION,
  type HistoryFile,
  type HistoryRow,
  type RawPr,
  type RepoHistory,
  type RawPrEvent,
  type Snapshot,
  type SyncState,
} from "../src/lib/snapshot";
import { RATE, client, pool, runQuery, usage, type Gql } from "./github";

const CONFIG_FILE = process.env.PR_DESK_CONFIG ?? "pr-desk.config.json";
const OUT_DIR = path.join("public", "data");
const BOARD_FILE = path.join(OUT_DIR, "pr-board.json");
const STATE_FILE = path.join(OUT_DIR, "state.json");
const HISTORY_FILE = path.join(OUT_DIR, "history.json");

const CONCURRENCY = 4;
const DETAIL_BATCH = 10;
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

const MERGED_FIELDS = `
  number title createdAt updatedAt mergedAt
  author { login }
  mergedBy { login }
  reviews(first: 10) { nodes { submittedAt author { login } } }
  comments(first: 10) { nodes { createdAt author { login } } }
`;

const toSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function mergedRow(n: any, bots: string[]): HistoryRow | null {
  const author = n?.author?.login;
  if (!n?.mergedAt || !author || isBot(author, bots)) return null;
  const a = author.toLowerCase();
  // First review or comment by someone other than the author or a bot.
  const first = [
    ...(n.reviews?.nodes ?? []).filter((r: any) => r.submittedAt).map((r: any) => ({ at: r.submittedAt, who: r.author?.login })),
    ...(n.comments?.nodes ?? []).map((c: any) => ({ at: c.createdAt, who: c.author?.login })),
  ]
    .filter((x: any) => x.who && x.who.toLowerCase() !== a && !isBot(x.who, bots))
    .map((x: any) => x.at as string)
    .sort()[0];
  return [n.number, n.title, author, toSec(n.createdAt), toSec(n.mergedAt), n.mergedBy?.login ?? null, first ? toSec(first) : null];
}

// Max pages of backfill per run (50 PRs each). A repo with more history than
// this finishes over several runs; the cursor is saved in history.json.
const BACKFILL_PAGES_PER_RUN = 120;

// Merged-PR history, in two walks that both upsert by PR number:
//  - recent: newest updates first, stopping at the previous sync (minus a
//    margin). Cheap — usually one page. Catches every new merge.
//  - backfill: oldest first, once, resumable. Fills in everything before the
//    first sync. A PR merged mid-backfill can land before the saved cursor,
//    but it was just updated, so the recent walk catches it.
async function updateHistory(
  gql: Gql,
  repo: string,
  prev: RepoHistory | undefined,
  bots: string[],
): Promise<RepoHistory> {
  const { owner, name } = splitRepo(repo);
  const startedAt = new Date().toISOString();
  const rows = new Map<number, HistoryRow>((prev?.rows ?? []).map((r) => [r[0], r]));
  const page = async (order: "UPDATED_AT DESC" | "CREATED_AT ASC", cursor: string | null, label: string) => {
    const [field, direction] = order.split(" ");
    const q = `query($owner: String!, $name: String!, $cursor: String) { ${RATE}
      repository(owner: $owner, name: $name) {
        pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: {field: ${field}, direction: ${direction}}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${MERGED_FIELDS} }
        }
      } }`;
    const res: any = await runQuery(gql, `${repo} ${label}`, q, { owner, name, cursor });
    const pr = res?.repository?.pullRequests;
    for (const n of pr?.nodes ?? []) {
      const row = mergedRow(n, bots);
      if (row) rows.set(row[0], row);
    }
    return { nodes: (pr?.nodes ?? []) as any[], next: pr?.pageInfo?.hasNextPage ? (pr.pageInfo.endCursor as string) : null };
  };

  // Recent walk. mergedAt <= updatedAt, so stopping on updatedAt can't skip a
  // recent merge. Six hours of overlap absorbs clock skew and late indexing.
  // On the first run the backfill covers everything, so one day is plenty.
  const since = new Date((prev?.syncedAt ? Date.parse(prev.syncedAt) : Date.now() - DAY_MS) - 6 * 3_600_000).toISOString();
  let cursor: string | null = null;
  let recentPages = 0;
  for (; recentPages < 200; recentPages++) {
    const { nodes, next } = await page("UPDATED_AT DESC", cursor, `merged recent p${recentPages}`);
    const oldest = nodes.at(-1)?.updatedAt;
    if (!next || (oldest && oldest < since)) break;
    cursor = next;
  }

  // Backfill, if not done yet.
  let backfillCursor = prev ? prev.backfillCursor : null;
  let backfilled = prev?.backfilled ?? false;
  let backfillPages = 0;
  if (!backfilled) {
    for (; backfillPages < BACKFILL_PAGES_PER_RUN; backfillPages++) {
      const { next } = await page("CREATED_AT ASC", backfillCursor, `merged backfill p${backfillPages}`);
      backfillCursor = next;
      if (!next) {
        backfilled = true;
        break;
      }
    }
  }

  console.log(
    `${repo}: merged history ${rows.size} PRs (${recentPages + 1} recent page(s)` +
      (backfillPages || !prev?.backfilled ? `, ${backfillPages + (backfilled && !prev?.backfilled ? 1 : 0)} backfill page(s)${backfilled ? ", complete" : ", continues next run"}` : "") +
      ")",
  );
  return {
    syncedAt: startedAt,
    backfillCursor: backfilled ? null : backfillCursor,
    backfilled,
    rows: Array.from(rows.values()).sort((a, b) => a[4] - b[4]),
  };
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

  const storedHistory = await readJson<HistoryFile>(HISTORY_FILE);
  const prevHistory = storedHistory?.version === HISTORY_VERSION ? storedHistory.repos : {};
  const history: HistoryFile = { version: HISTORY_VERSION, generatedAt: now, repos: {} };

  const open: RawPr[] = [];
  for (const repo of config.repos) {
    const [o, h] = await Promise.all([
      fetchOpen(gql, repo, config.bots),
      updateHistory(gql, repo, prevHistory[repo], config.bots),
    ]);
    console.log(`${repo}: ${o.length} open`);
    open.push(...o);
    history.repos[repo] = h;
  }

  const state = applyState(open, prevState);

  const snapshot: Snapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: now,
    host: process.env.GITHUB_REPOSITORY ?? null,
    config,
    open,
  };
  await writeJson(BOARD_FILE, snapshot);
  await writeJson(STATE_FILE, state);
  await writeJson(HISTORY_FILE, history);

  const { calls, lastRemaining } = usage();
  console.log(
    `Wrote ${BOARD_FILE}: ${open.length} open, ${Object.values(history.repos).reduce((n, h) => n + h.rows.length, 0)} merged in history ` +
      `— ${calls} API calls in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (lastRemaining != null ? `, ${lastRemaining} left this hour` : ""),
  );
}

main().catch((e) => {
  console.error(e?.errors ? JSON.stringify(e.errors, null, 2) : e);
  process.exit(1);
});
