// Shape of public/data/pr-board.json — written by scripts/sync.ts, read by
// the browser. Everything the page needs is in this one file.

import type { PrDeskConfig } from "./config";

export const SNAPSHOT_VERSION = 3;

export type RawPrEvent =
  | { kind: "commit"; at: string; merge: boolean }
  | { kind: "force_push"; at: string; actor: string | null }
  | { kind: "review"; at: string; actor: string; state: string }
  | { kind: "comment"; at: string; actor: string }
  | { kind: "ready"; at: string }
  | { kind: "dismissed"; at: string; previousState: string | null };

export type RawPr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  maintainerCanModify: boolean;
  ciState: string | null;
  labels: { name: string; color: string }[];
  requestedReviewers: string[];
  latestReviews: { author: string; state: string; at: string }[];
  timeline: RawPrEvent[];
  // From state carried across syncs (GitHub has no event for these).
  // conflictSince is null when the conflict predates tracking.
  conflictSince: string | null;
  conflictResolvedAt: string | null;
};

export type RawMergedPr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  mergedAt: string;
  mergedBy: string | null;
  // First review or comment by someone other than the author (bots excluded).
  firstResponseAt: string | null;
};

export type Snapshot = {
  version: typeof SNAPSHOT_VERSION;
  generatedAt: string;
  // "owner/name" of the repo hosting this desk (from GITHUB_REPOSITORY in CI),
  // used for "edit the config" links.
  host: string | null;
  config: PrDeskConfig;
  open: RawPr[];
  merged: RawMergedPr[];
};

// public/data/history.json — every merged PR, kept compact. Backfilled once
// (resumable across runs), then extended with new merges each sync. Loaded by
// the page separately from pr-board.json, for the Trends view.
//
// Row: [number, title, author, createdAt, mergedAt, mergedBy, firstResponseAt]
// with times as Unix seconds (firstResponseAt null when nobody but the author
// and bots ever responded).
export type HistoryRow = [number, string, string, number, number, string | null, number | null];

export type RepoHistory = {
  // Start time of the last sync that walked recent merges; the next sync
  // only fetches PRs updated after this.
  syncedAt: string;
  // Cursor for the one-time backfill (oldest first). null once complete.
  backfillCursor: string | null;
  backfilled: boolean;
  rows: HistoryRow[];
};

export const HISTORY_VERSION = 1;

export type HistoryFile = {
  version: typeof HISTORY_VERSION;
  generatedAt: string;
  repos: Record<string, RepoHistory>;
};

// Carried between syncs in public/data/state.json (CI restores it from the
// previously deployed site). Keyed by "owner/name#number".
export type SyncState = {
  version: 2;
  // m: mergeability last seen (C = conflicting, M = mergeable).
  prs: Record<string, { m?: "C" | "M"; conflictSince?: string; conflictResolvedAt?: string }>;
};
