// Schema for pr-desk.config.json — the one file a team edits.
//
// Validated by the sync script (and `npm run check-config`); the parsed,
// defaults-filled result is embedded in the published snapshot, so the
// browser never needs zod.

import { z } from "zod";
import { RESERVED_GROUP } from "./constants";

export { RESERVED_GROUP };

const LOGIN = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/, "not a GitHub login");
const REPO = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected "owner/name"');

const GroupSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9-]+$/, "use lowercase letters, digits and dashes")
    .refine((k) => k !== RESERVED_GROUP, `"${RESERVED_GROUP}" is reserved for everyone not in a group`),
  label: z.string().min(1),
  // Explicit members. Always wins over a profile match.
  members: z.array(LOGIN).default([]),
  // Terms looked for (case-insensitive substring) in an author's GitHub
  // profile company and public org memberships. A hint only — private
  // memberships aren't visible, so prefer `members` for anyone you know.
  match: z.array(z.string().min(2)).default([]),
});

export const ConfigSchema = z.object({
  title: z.string().min(1).default("PR desk"),
  description: z.string().optional(),
  repos: z.array(REPO).min(1, "list at least one repo"),
  groups: z.array(GroupSchema).default([]),
  community: z
    .object({
      label: z.string().min(1).default("Community"),
      // Pin these authors to community even if a group's `match` would claim them.
      members: z.array(LOGIN).default([]),
    })
    .default({ label: "Community", members: [] }),
  // Tab selected when the page opens: a group key or "community".
  defaultView: z.string().default(RESERVED_GROUP),
  // Review targets, in business days.
  targets: z
    .object({
      firstReviewDays: z.number().positive().default(2),
      reReviewDays: z.number().positive().default(2),
      mergeDays: z.number().positive().default(1),
    })
    .default({ firstReviewDays: 2, reReviewDays: 2, mergeDays: 1 }),
  businessDays: z
    .object({
      timezone: z.string().min(1).default("UTC"),
      // Monday-first: 0 = Mon … 6 = Sun.
      weekendDays: z.array(z.number().int().min(0).max(6)).default([5, 6]),
    })
    .default({ timezone: "UTC", weekendDays: [5, 6] }),
  // How long merged PRs stay on the board.
  recentMergedDays: z.number().int().min(1).max(60).default(14),
  // Window for the "time to first response" statistic (merged PRs).
  historyDays: z.number().int().min(7).max(90).default(30),
  // Extra logins to treat as bots, on top of the built-in list.
  bots: z.array(z.string()).default([]),
});

export type PrDeskConfig = z.infer<typeof ConfigSchema>;
export type GroupConfig = PrDeskConfig["groups"][number];

export function parseConfig(raw: unknown): PrDeskConfig {
  const config = ConfigSchema.parse(raw);
  const keys = new Set<string>();
  for (const g of config.groups) {
    if (keys.has(g.key)) throw new Error(`Duplicate group key "${g.key}"`);
    keys.add(g.key);
  }
  if (config.defaultView !== RESERVED_GROUP && config.defaultView !== "all" && !keys.has(config.defaultView)) {
    throw new Error(`defaultView "${config.defaultView}" is not a group key, "community" or "all"`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.businessDays.timezone });
  } catch {
    throw new Error(`businessDays.timezone "${config.businessDays.timezone}" is not a valid IANA timezone`);
  }
  return config;
}
