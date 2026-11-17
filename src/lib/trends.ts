// Merged-PR statistics over the full history (history.json), by group and
// by month. Groups use today's config, so a re-grouped author moves in the
// past too.

import { isBot } from "./bots";
import type { PrDeskConfig } from "./config";
import { COMMUNITY, businessDaysBetween, classifyAuthor } from "./derive";
import type { HistoryFile } from "./snapshot";

export type Period = "90d" | "6m" | "12m" | "all";

export const PERIODS: { key: Period; label: string; days: number | null }[] = [
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "6m", label: "Last 6 months", days: 182 },
  { key: "12m", label: "Last 12 months", days: 365 },
  { key: "all", label: "All time", days: null },
];

export type GroupStats = {
  merged: number;
  responded: number;
  medianFirstResponseH: number | null;
  p90FirstResponseH: number | null;
  medianTimeToMergeH: number | null;
  // Share of merged PRs whose first response came within the first-review
  // target (business days).
  withinTarget: number | null;
};

export type MonthRow = {
  month: string; // "2026-03"
  merged: Record<string, number>;
  medianFirstResponseH: Record<string, number | null>;
  responded: Record<string, number>;
};

export type Trends = {
  totalMerged: number;
  firstMergedAt: number | null;
  byGroup: Record<string, GroupStats>; // plus "all"
  months: MonthRow[];
};

function quantile(sorted: number[], q: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
}

const median = (xs: number[]) => quantile(xs.slice().sort((a, b) => a - b), 0.5);

const monthFormatters = new Map<string, Intl.DateTimeFormat>();

function monthKey(sec: number, timeZone: string): string {
  let f = monthFormatters.get(timeZone);
  // en-CA formats as YYYY-MM.
  if (!f) monthFormatters.set(timeZone, (f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" })));
  return f.format(new Date(sec * 1000)).slice(0, 7);
}

export function groupKeys(config: PrDeskConfig): string[] {
  return [COMMUNITY, ...config.groups.map((g) => g.key)];
}

export function computeTrends(
  history: HistoryFile,
  config: PrDeskConfig,
  now: number,
  period: Period,
  repo: string | null = null,
): Trends {
  const days = PERIODS.find((p) => p.key === period)?.days ?? null;
  const fromSec = days == null ? -Infinity : (now - days * 86_400_000) / 1000;
  const keys = groupKeys(config);
  const groupOf = new Map<string, string>();
  const group = (author: string) => {
    let g = groupOf.get(author);
    if (!g) {
      g = classifyAuthor(author, config).group;
      groupOf.set(author, g);
    }
    return g;
  };

  const acc: Record<string, { first: number[]; merge: number[]; within: number; merged: number }> = {};
  for (const k of ["all", ...keys]) acc[k] = { first: [], merge: [], within: 0, merged: 0 };
  const months = new Map<string, { merged: Record<string, number>; first: Record<string, number[]> }>();
  let total = 0;
  let firstMergedAt: number | null = null;

  for (const [r, h] of Object.entries(history.repos)) {
    if (repo && r !== repo) continue;
    for (const [, , author, created, mergedAt, , firstAt] of h.rows) {
      if (isBot(author, config.bots)) continue;
      total++;
      if (firstMergedAt == null || mergedAt < firstMergedAt) firstMergedAt = mergedAt;
      if (mergedAt < fromSec) continue;
      const g = group(author);
      const m = monthKey(mergedAt, config.businessDays.timezone);
      let mrow = months.get(m);
      if (!mrow) months.set(m, (mrow = { merged: {}, first: {} }));
      mrow.merged[g] = (mrow.merged[g] ?? 0) + 1;
      const firstH = firstAt != null ? Math.max(0, firstAt - created) / 3600 : null;
      if (firstH != null) (mrow.first[g] ??= []).push(firstH);

      for (const k of ["all", g]) {
        const a = (acc[k] ??= { first: [], merge: [], within: 0, merged: 0 });
        a.merged++;
        a.merge.push(Math.max(0, mergedAt - created) / 3600);
        if (firstH != null) {
          a.first.push(firstH);
          if (businessDaysBetween(created * 1000, firstAt! * 1000, config.businessDays) <= config.targets.firstReviewDays) a.within++;
        }
      }
    }
  }

  const byGroup: Record<string, GroupStats> = {};
  for (const [k, a] of Object.entries(acc)) {
    const first = a.first.sort((x, y) => x - y);
    byGroup[k] = {
      merged: a.merged,
      responded: first.length,
      medianFirstResponseH: quantile(first, 0.5),
      p90FirstResponseH: quantile(first, 0.9),
      medianTimeToMergeH: median(a.merge),
      withinTarget: a.merged ? a.within / a.merged : null,
    };
  }

  const monthRows: MonthRow[] = Array.from(months.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, r]) => ({
      month,
      merged: r.merged,
      responded: Object.fromEntries(Object.entries(r.first).map(([g, xs]) => [g, xs.length])),
      medianFirstResponseH: Object.fromEntries(Object.entries(r.first).map(([g, xs]) => [g, median(xs)])),
    }));

  return { totalMerged: total, firstMergedAt, byGroup, months: monthRows };
}

export type MonthPr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  group: string;
  createdAt: number; // Unix seconds
  mergedAt: number;
  mergedBy: string | null;
  firstResponseH: number | null;
  timeToMergeH: number;
};

// Merged PRs for one calendar month (in the business timezone), newest first.
// `group` is a group key, "community", or "all".
export function mergedInMonth(
  history: HistoryFile,
  config: PrDeskConfig,
  month: string,
  group: string,
  repo: string | null = null,
): MonthPr[] {
  const out: MonthPr[] = [];
  for (const [r, h] of Object.entries(history.repos)) {
    if (repo && r !== repo) continue;
    for (const [number, title, author, created, mergedAt, mergedBy, firstAt] of h.rows) {
      if (isBot(author, config.bots)) continue;
      if (monthKey(mergedAt, config.businessDays.timezone) !== month) continue;
      const g = classifyAuthor(author, config).group;
      if (group !== "all" && g !== group) continue;
      out.push({
        repo: r,
        number,
        title,
        url: `https://github.com/${r}/pull/${number}`,
        author,
        group: g,
        createdAt: created,
        mergedAt,
        mergedBy,
        firstResponseH: firstAt != null ? Math.max(0, firstAt - created) / 3600 : null,
        timeToMergeH: Math.max(0, mergedAt - created) / 3600,
      });
    }
  }
  return out.sort((a, b) => b.mergedAt - a.mergedAt);
}
