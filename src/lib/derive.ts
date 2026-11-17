// Turns the raw snapshot into stages, turns and wait times. Pure and
// browser-side, so wait times stay current between syncs and nothing here
// needs a GitHub call.

import { isBot } from "./bots";
import { RESERVED_GROUP } from "./constants";
import type { PrDeskConfig } from "./config";
import type { RawPr, RawPrEvent } from "./snapshot";

export const COMMUNITY = RESERVED_GROUP;

export type Stage =
  | "new"
  | "on_author"
  | "updated"
  | "approved"
  | "approved_conflict"
  | "conflict"
  | "draft";

// Whose move it is. "team" = an approved PR with conflicts that maintainers
// may fix themselves (the author allowed edits from maintainers).
export type Turn = "reviewer" | "maintainer" | "team" | "author" | "none";

export type SlaState = "ok" | "warn" | "breach";

export type GroupSource = "member" | "default";

export type DerivedPr = {
  id: string; // "owner/name#number"
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  group: string;
  groupSource: GroupSource;
  createdAt: string;
  stage: Stage;
  turn: Turn;
  onUs: boolean;
  // When the ball landed in the current court (or the best stand-in where
  // GitHub doesn't say — see derivePr).
  since: string | null;
  waitingDays: number | null; // calendar days
  waitingBusinessDays: number | null;
  sla: SlaState | null;
  slaDays: number | null;
  additions: number;
  deletions: number;
  ciState: string | null;
  labels: { name: string; color: string }[];
  requestedReviewers: string[];
  approvers: string[];
  // Submitted a review — not just commented, not just requested.
  reviewers: string[];
  // Commented on the conversation without submitting a review (not the
  // author, not bots, not anyone already in `reviewers`).
  commenters: string[];
  approvedAt: string | null;
  maintainerCanModify: boolean;
  mergeableUnknown: boolean;
  badges: {
    rebased: boolean;
    wasApproved: boolean;
    pushedAfterApproval: boolean;
    changesRequested: boolean;
    conflictResolved: boolean;
  };
  conflictSince: string | null;
  conflictResolvedAt: string | null;
  timeline: RawPrEvent[];
};

export const STAGE_ORDER: Stage[] = [
  "new",
  "on_author",
  "updated",
  "approved",
  "approved_conflict",
  "conflict",
];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  on_author: "On author",
  updated: "Updated",
  approved: "Approved",
  approved_conflict: "Approved · conflicts",
  conflict: "Conflicts",
  draft: "Draft",
};

export const STAGE_HINTS: Record<Stage, string> = {
  new: "No review or comment from anyone but the author yet",
  on_author: "A reviewer acted last — waiting on the author",
  updated: "The author pushed or replied after the last review — needs a re-review",
  approved: "Approved and mergeable — waiting on a maintainer to merge",
  approved_conflict: "Approved, but conflicts with the base branch",
  conflict: "Conflicts with the base branch and not approved yet",
  draft: "Draft pull request",
};

export const MERGE_HEADLINE = /^Merge (branch|remote-tracking branch|pull request|.+ into )/i;

// ---- Groups ----

// Groups come only from the config lists. Anyone not listed is community.
export function classifyAuthor(login: string, config: PrDeskConfig): { group: string; source: GroupSource } {
  const l = login.toLowerCase();
  const has = (list: string[]) => list.some((m) => m.toLowerCase() === l);
  if (has(config.community.members)) return { group: COMMUNITY, source: "member" };
  for (const g of config.groups) if (has(g.members)) return { group: g.key, source: "member" };
  return { group: COMMUNITY, source: "default" };
}

export function groupLabel(config: PrDeskConfig, key: string): string {
  if (key === COMMUNITY) return config.community.label;
  return config.groups.find((g) => g.key === key)?.label ?? key;
}

// ---- Business time ----

const DAY_MS = 86_400_000;
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

// Milliseconds east of UTC for `timeZone` at instant `ms`.
function tzOffsetMs(ms: number, timeZone: string): number {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Elapsed days between two instants with weekend days removed. Weekends are
 * whole local days in `timezone`, Monday-first indices. One UTC offset is used
 * for the whole span; a DST shift moves the result by at most an hour.
 */
export function businessDaysBetween(
  fromMs: number,
  toMs: number,
  days: PrDeskConfig["businessDays"],
): number {
  if (toMs <= fromMs) return 0;
  let off = 0;
  try {
    off = tzOffsetMs(toMs, days.timezone);
  } catch {
    off = 0;
  }
  const weekend = new Set(days.weekendDays);
  const a = fromMs + off;
  const b = toMs + off;
  let total = 0;
  for (let day = Math.floor(a / DAY_MS); day * DAY_MS < b; day++) {
    // 1970-01-01 was a Thursday → Monday-first index 3.
    const dow = (((day + 3) % 7) + 7) % 7;
    if (weekend.has(dow)) continue;
    const start = day * DAY_MS;
    total += Math.min(b, start + DAY_MS) - Math.max(a, start);
  }
  return total / DAY_MS;
}

// ---- Stages ----

function maxIso(values: (string | null | undefined)[]): string | null {
  let m: string | null = null;
  for (const v of values) if (v && (!m || v > m)) m = v;
  return m;
}

function minIso(values: (string | null | undefined)[]): string | null {
  let m: string | null = null;
  for (const v of values) if (v && (!m || v < m)) m = v;
  return m;
}

function slaFor(days: number | null, limit: number | null): SlaState | null {
  if (days == null || limit == null) return null;
  if (days > limit) return "breach";
  if (days > limit / 2) return "warn";
  return "ok";
}

export type DeriveContext = {
  now: number;
  config: PrDeskConfig;
};

export function derivePr(pr: RawPr, ctx: DeriveContext): DerivedPr {
  const { config } = ctx;
  const bot = (l: string | null | undefined) => isBot(l, config.bots);
  const authorL = pr.author.toLowerCase();
  const isAuthor = (l: string | null | undefined) => !!l && l.toLowerCase() === authorL;

  // Bots never move the ball, in either direction.
  const timeline = pr.timeline.filter((e) => {
    if (e.kind === "review" || e.kind === "comment") return !bot(e.actor);
    if (e.kind === "force_push") return !e.actor || !bot(e.actor);
    return true;
  });

  const reviewerActs = timeline.filter(
    (e): e is Extract<RawPrEvent, { kind: "review" | "comment" }> =>
      (e.kind === "review" || e.kind === "comment") && !isAuthor(e.actor),
  );
  // Commits and force-pushes count as an update whoever pushed them — a
  // maintainer's rebase also needs the reviewer to look again.
  const authorActs = timeline.filter(
    (e) =>
      e.kind === "commit" ||
      e.kind === "force_push" ||
      ((e.kind === "review" || e.kind === "comment") && isAuthor(e.actor)),
  );

  const latest = pr.latestReviews.filter((r) => !isAuthor(r.author) && !bot(r.author));
  const approvals = latest.filter((r) => r.state === "APPROVED");
  const changesRequested = latest.some((r) => r.state === "CHANGES_REQUESTED");
  // reviewDecision is null when branch protection doesn't require reviews;
  // then any approval without an outstanding change request counts.
  const approved =
    pr.reviewDecision === "APPROVED" ||
    (pr.reviewDecision == null && approvals.length > 0 && !changesRequested);
  const approvedAt = approved ? maxIso(approvals.map((r) => r.at)) : null;

  const lastReviewerAt = maxIso(reviewerActs.map((e) => e.at));
  const lastAuthorAt = maxIso(authorActs.map((e) => e.at));
  const hasReview = reviewerActs.length > 0 || latest.length > 0;
  const conflicting = pr.mergeable === "CONFLICTING";
  const readyAt = maxIso(timeline.filter((e) => e.kind === "ready").map((e) => e.at));
  const lastAny = maxIso([lastReviewerAt, lastAuthorAt, pr.createdAt]);
  const updatesAfter = (iso: string | null) => (iso ? authorActs.filter((e) => e.at > iso) : authorActs);

  const badges = {
    rebased:
      !!lastReviewerAt &&
      updatesAfter(lastReviewerAt).some((e) => e.kind === "force_push" || (e.kind === "commit" && e.merge)),
    wasApproved:
      !approved &&
      (timeline.some((e) => e.kind === "dismissed" && e.previousState === "APPROVED") ||
        reviewerActs.some((e) => e.kind === "review" && e.state === "APPROVED")),
    pushedAfterApproval:
      !!approvedAt &&
      authorActs.some((e) => (e.kind === "commit" || e.kind === "force_push") && e.at > approvedAt),
    changesRequested,
    // Resolved since the reviewers last looked.
    conflictResolved:
      !conflicting && !!pr.conflictResolvedAt && (!lastReviewerAt || pr.conflictResolvedAt > lastReviewerAt),
  };

  let stage: Stage;
  let turn: Turn;
  let since: string | null;
  let slaDays: number | null = null;

  if (pr.isDraft) {
    stage = "draft";
    turn = "author";
    since = lastAny;
  } else if (conflicting && approved) {
    // Blocked since whichever came last: the approval or the conflict
    // (when the conflict's start is unknown, since the approval).
    stage = "approved_conflict";
    turn = pr.maintainerCanModify ? "team" : "author";
    since = maxIso([approvedAt, pr.conflictSince]);
    slaDays = config.targets.mergeDays;
  } else if (conflicting) {
    stage = "conflict";
    turn = "author";
    since = pr.conflictSince ?? lastAny;
  } else if (approved) {
    stage = "approved";
    turn = "maintainer";
    since = maxIso([approvedAt, pr.conflictResolvedAt]);
    slaDays = config.targets.mergeDays;
  } else if (!hasReview) {
    stage = "new";
    turn = "reviewer";
    since = maxIso([pr.createdAt, readyAt]);
    slaDays = config.targets.firstReviewDays;
  } else if (lastAuthorAt && (!lastReviewerAt || lastAuthorAt > lastReviewerAt)) {
    stage = "updated";
    turn = "reviewer";
    // The ball moved at the author's first action after the last review.
    since = minIso(updatesAfter(lastReviewerAt).map((e) => e.at)) ?? lastAuthorAt;
    slaDays = config.targets.reReviewDays;
  } else {
    stage = "on_author";
    turn = "author";
    since =
      minIso(reviewerActs.filter((e) => !lastAuthorAt || e.at > lastAuthorAt).map((e) => e.at)) ??
      lastReviewerAt;
  }

  const onUs = turn === "reviewer" || turn === "maintainer" || turn === "team";
  if (!onUs) slaDays = null;
  const sinceMs = since ? Date.parse(since) : null;
  const waitingDays = sinceMs != null ? Math.max(0, (ctx.now - sinceMs) / DAY_MS) : null;
  const waitingBusinessDays = sinceMs != null ? businessDaysBetween(sinceMs, ctx.now, config.businessDays) : null;
  const { group, source } = classifyAuthor(pr.author, config);
  const reviewers = Array.from(
    new Set([
      ...approvals.map((r) => r.author),
      ...latest.map((r) => r.author),
      ...reviewerActs.filter((e) => e.kind === "review").map((e) => e.actor),
    ]),
  );

  return {
    id: `${pr.repo}#${pr.number}`,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    group,
    groupSource: source,
    createdAt: pr.createdAt,
    stage,
    turn,
    onUs,
    since,
    waitingDays,
    waitingBusinessDays,
    sla: slaFor(waitingBusinessDays, slaDays),
    slaDays,
    additions: pr.additions,
    deletions: pr.deletions,
    ciState: pr.ciState,
    labels: pr.labels,
    requestedReviewers: pr.requestedReviewers,
    approvers: approvals.map((r) => r.author),
    reviewers,
    commenters: Array.from(
      new Set(reviewerActs.filter((e) => e.kind === "comment" && !reviewers.includes(e.actor)).map((e) => e.actor)),
    ),
    approvedAt,
    maintainerCanModify: pr.maintainerCanModify,
    mergeableUnknown: pr.mergeable === "UNKNOWN",
    badges,
    conflictSince: pr.conflictSince,
    conflictResolvedAt: pr.conflictResolvedAt,
    timeline,
  };
}
