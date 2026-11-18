# AGENTS.md

Guidance for coding agents (and people) working on pr-desk. `README.md` is the
user-facing guide; this file records **how it's built and why**, so changes
keep the design intact.

## What this is

A public, support-queue view of a team's open pull requests: which stage each
PR is in, whose turn it is, how long it has waited against a review target,
and what's stuck. Built to stop community contributions from going stale.

- **No server.** A scheduled GitHub Actions workflow fetches PR state, writes
  JSON, builds a static Vite + React site and deploys it to GitHub Pages.
- **Reusable.** Another team copies the repo (it's a template), edits
  `pr-desk.config.json`, turns on Pages, and runs the workflow. Nothing is
  specific to one project outside that config file.
- This copy tracks `thunder-id/thunderid` and is published at
  `https://senthalan.github.io/pr-desk/`.

## Commands

```bash
npm install
GITHUB_TOKEN=$(gh auth token) npm run sync   # fetch → public/data/*.json
npm run dev                                   # http://localhost:5173
npm run build && npm run preview              # production build, served locally
npm run typecheck                             # page AND sync script (two tsconfigs)
npm run check-config                          # validate pr-desk.config.json, no API calls
npm run check-config -- --schema              # also regenerate pr-desk.config.schema.json
```

There are no tests. Before pushing, run `npm run typecheck` and
`npm run check-config`, and check the change in a browser against real data
(`npm run sync` then `npm run build && npm run preview`).

## Layout

```
pr-desk.config.json          the one file a team edits
pr-desk.config.schema.json   generated from src/lib/config.ts (editor autocomplete)
examples/                    generic example config
scripts/
  sync.ts                    GitHub → public/data/{pr-board,history,state}.json
  github.ts                  GraphQL client, retries on 5xx, small concurrency pool
  check-config.ts            validation + schema generation
src/
  lib/config.ts              zod schema + parseConfig (sync/CI only — never imported at runtime by the page)
  lib/constants.ts           RESERVED_GROUP; split out so the page bundle doesn't pull in zod
  lib/snapshot.ts            types for the three JSON files, with version constants
  lib/derive.ts              pure: stage / turn / wait time / groups / business days
  lib/trends.ts              pure: monthly and per-group stats from history.json
  lib/bots.ts                bot detection (built-in list + config `bots`)
  App.tsx                    page shell, data loading, filters, URL state
  components/                Queue, Drawer, Trends, Parts (shared pills, chips, avatars)
.github/workflows/pr-desk.yml  schedule → sync → build → deploy (+ keepalive)
```

## Data flow

```
every 20 min, best effort (and on push / manual run)
  restore state.json + history.json from the LIVE site (curl)
  npm run check-config
  npm run sync     → public/data/pr-board.json   open PRs + config      (page loads first)
                   → public/data/history.json    every merged PR        (loaded after, for Trends)
                   → public/data/state.json      conflict tracking      (only the next sync reads it)
  npm run build    → dist/ (public/ is copied in)
  deploy to Pages
browser
  fetch pr-board.json → derivePr() for every PR, in the browser
  fetch history.json  → computeTrends() / mergedInMonth()
```

Key decisions:

- **Stages are derived in the browser, not in the sync.** Wait times keep
  ticking between syncs (the page re-derives every minute), and config
  changes take effect as soon as the site redeploys.
- **State is carried through the published site.** The workflow curls the
  previous `state.json` and `history.json` from Pages before syncing. There's
  no database, cache action or data branch. If a file is missing (first run,
  Pages down), the sync starts that part fresh — history re-backfills.
- **`public/data/` is gitignored.** Data is never committed; CI regenerates
  it. Don't add generated data to the repo.

## Sync (`scripts/sync.ts`)

Token: `GITHUB_TOKEN` (CI passes `secrets.PR_DESK_TOKEN || github.token`;
locally `gh auth token`). The built-in Actions token reads any public repo.

**Open PRs** — per repo:
1. List open PR numbers (`first: 100` pages; cheap).
2. Fetch detail in aliased batches of `DETAIL_BATCH` (10) PRs, `CONCURRENCY`
   (4) in flight. Cursor pagination over full detail was ~6 s per page of 25;
   this cut a sync from ~96 s to ~10 s.
3. Fields: draft, `mergeable`, `reviewDecision`, `maintainerCanModify`, CI
   rollup of the last commit, labels, requested reviewers,
   `latestOpinionatedReviews`, and `timelineItems(last: 60)` of commits,
   force-pushes, reviews, issue comments, ready-for-review and review-dismissed.
4. **Mergeability is lazy on GitHub**: the first read after a push is often
   `UNKNOWN`. Wait 3 s and re-read just those (fixed 173 of 173 in testing).

**Merged history** — two walks that both upsert rows by PR number:
- *Recent*: `UPDATED_AT DESC`, stop once a page is older than the previous
  sync minus 6 h. Usually one page. `mergedAt <= updatedAt`, so stopping on
  `updatedAt` can't skip a merge.
- *Backfill*: once, `CREATED_AT ASC`, resumable via `backfillCursor`, up to
  `BACKFILL_PAGES_PER_RUN` (120 × 50 PRs) per run. A PR merged mid-backfill can
  land before the saved cursor, but it was just updated, so the recent walk
  catches it.
- Search API is avoided: several times slower here.
- `firstResponseAt` = earliest review or comment by someone other than the
  author or a bot, from the first 10 reviews and 10 comments.

**Conflict tracking** (`applyState`) — GitHub has no event for "a conflict
started/was resolved". Each run stores every open PR's last-seen
mergeability (`m: "C" | "M"`):
- `M → C`: `conflictSince = now` (a known start).
- `C → M`: `conflictResolvedAt = now`.
- A conflict seen on the first observation has an **unknown** start
  (`conflictSince` null) — never "now", which would make an 84-day-old
  approved PR look 1 hour old.
- `UNKNOWN`: carry the previous entry unchanged.

Cost for thunderid (~210 open, ~3,300 merged): ~25 GraphQL calls / ~12 s per
sync after the one-time ~67-page backfill (~100 calls, ~3.5 min).

## Stage logic (`src/lib/derive.ts`)

Checked in this order; first match wins:

| Stage | Condition | Turn | Waiting since | Target |
| --- | --- | --- | --- | --- |
| draft | `isDraft` | author | last activity | — |
| approved_conflict | conflicting **and** approved | `team` if `maintainerCanModify`, else author | later of approval and known conflict start | mergeDays |
| conflict | conflicting | author | conflict start, else last activity | — |
| approved | approved | maintainer | later of approval and conflict resolution | mergeDays |
| new | no review/comment from anyone but the author | reviewer | created / ready-for-review | firstReviewDays |
| updated | author acted after the last reviewer action | reviewer | author's **first** action after the last review | reReviewDays |
| on_author | otherwise | author | reviewer's first action after the author's last | — |

Definitions that matter:
- **Approved** = `reviewDecision === "APPROVED"`, or (when the repo doesn't
  require reviews and `reviewDecision` is null) at least one approval and no
  outstanding change request.
- **Author activity** = commits and force-pushes (whoever pushed — a
  maintainer's rebase also needs re-review) plus the author's own comments and
  reviews. **Reviewer activity** = reviews and comments by anyone else.
- **Bots never move the ball** and never count as reviewers, commenters or
  authors (`isBot` + config `bots`).
- `reviewers` = people who **submitted a review** (approvers first).
  `commenters` = people who only commented on the conversation. Both are
  shown; a comment alone still counts as a response for staging.
- Waiting time is in **business days** in `businessDays.timezone`, weekends
  removed (`weekendDays` is **Monday-first**: 0 = Mon … 6 = Sun). SLA:
  `warn` past half the target, `breach` past it; only for stages where it's
  our turn (`onUs`).
- Badges: rebased (force-push or merge commit after the last review),
  conflict resolved (since reviewers last looked), was approved (approval
  dismissed/superseded), pushed after approval, changes requested, CI failing,
  merge status pending.

## Groups

- Groups come **only** from the config: `groups[].members`, else Community.
  `community.members` overrides a group listing. First matching group wins if
  a login is in two groups.
- **No GitHub profile data is fetched or published.** An earlier version
  matched company / org memberships; it was removed because (a) the GraphQL
  `organizations` field returns *private* memberships visible to the token
  owner, which leaked onto a public page and made results depend on whose
  token ran the sync, and (b) profiles were unreliable. Don't reintroduce it.
- Changing groups re-classifies history too (Trends uses today's config).

## Views

- **Queue**: open PRs only (drafts behind a toggle). No merged PRs —
  those live in Trends. Queue sections: *Approved · conflicts* pinned first,
  then *Waiting on us*, then *Waiting on author*; sorted past-target first,
  then longest wait.
- **Trends**: full merged history. Period picker (90 d / 6 m / 12 m / all),
  per-group tiles and table, merged-per-month stacked bars, median
  first-response-per-month lines, monthly data table. Clicking a month (or
  Enter on a focused bar) lists that month's merged PRs. Follows the group tab
  and repo filter.
  Reached from the **Trends** button in the header (it flips to "← Open PRs")
  or the first-response tile. There used to be a Board (kanban) view; it was
  dropped, and an old `?view=board` link opens the queue.
- **Drawer**: stage, turn, wait, conflict times, group (with an "edit the
  config" link for unlisted authors), approvers / reviewers / commenters /
  requested, last 60 timeline events.
- Filters live in the URL (`group`, `stage`, `repo`, `reviewer`, `view`), so
  `?reviewer=<login>` is a bookmarkable personal queue. View and reviewer are
  also remembered in localStorage (wrapped in try/catch).
- The page warns when data is > 3 h old (the schedule has probably stopped).

## Charts

Follow the dataviz rules already applied in `Trends.tsx`:
- Categorical colors from `--series-1..8` in `src/index.css`, light and dark
  values both validated against the page surfaces. **Color follows the
  group, never its rank**: Community is slot 1, then groups in config order.
- One y-axis per chart; never dual-axis. Bars ≤ 24 px, 4 px rounded top,
  2 px surface gap between stacked segments; 2 px lines; legend for ≥ 2
  series plus direct labels on line ends; hover tooltips; a data table.
- Two light-mode slots are under 3:1 contrast, which is why the legend,
  direct labels and table must stay.

## Data formats and versions

| File | Version constant | Shape |
| --- | --- | --- |
| `pr-board.json` | `SNAPSHOT_VERSION` (4) | `{ version, generatedAt, host, config, open: RawPr[] }` |
| `history.json` | `HISTORY_VERSION` (1) | `{ version, generatedAt, repos: { [repo]: { syncedAt, backfillCursor, backfilled, rows } } }`; row = `[number, title, author, createdAt, mergedAt, mergedBy, firstResponseAt]`, times in Unix seconds |
| `state.json` | `version: 2` | `{ prs: { "owner/name#n": { m, conflictSince?, conflictResolvedAt? } } }` |

**Bump the version** when a file's shape changes incompatibly. The page shows
an error instead of misreading an old file, and the sync discards an old
`state.json`/`history.json` and rebuilds (a history rebuild costs a backfill).

## Config rules

- Unknown keys are ignored (zod strips them), so removing a field never
  breaks existing configs. Removed so far: `historyDays`,
  `recentMergedDays`, `groups[].match`.
- After changing `src/lib/config.ts`, run `npm run check-config -- --schema`
  and commit the regenerated schema.
- `parseConfig` also checks duplicate group keys, `defaultView`, and the
  timezone.

## Gotchas

- **Hand-edited config JSON often has a trailing comma** or a group placed
  outside `groups`. The workflow fails at "Validate pr-desk.config.json" and
  the site keeps the previous deploy. Run `npm run check-config` before
  pushing.
- **Every push to `main` redeploys** the public site (the workflow runs on
  push, except Markdown-only changes).
- **Scheduled runs are best effort.** On this repo a `*/20` cron fired only
  every 5-6 h. The cron uses `7,27,47` to stay off the top of the hour, which
  GitHub says is the busiest. Don't "fix" this with a workflow that sleeps in
  a loop and re-dispatches itself: it holds a runner all day for a few seconds
  of work. If a guaranteed interval is needed, trigger `workflow_dispatch`
  from an outside scheduler.
- GitHub disables schedules after 60 days without activity; the `keepalive`
  job pushes an empty commit after 50 quiet days.
- **Pages caches for ~10 minutes**; the page re-fetches data every 5 minutes.
- **Local tokens can see more than CI's.** Never add data to the published
  files that only some tokens can read (see the profile lesson above).
- **Bot logins without `[bot]`** (for example `thunder-automation-bot`) must
  be added to config `bots`, or they count as people.
- **Bot PRs are excluded everywhere**, so counts are slightly lower than
  GitHub's totals; that's expected.
- **Keep the page bundle free of zod**: import only types from
  `lib/config.ts` in browser code; runtime constants go in `lib/constants.ts`.

## Conventions

- TypeScript strict; plain React (no state library); Tailwind 3 with theme
  tokens defined as CSS variables in `src/index.css` (light and dark via
  `data-theme`).
- `lib/derive.ts` and `lib/trends.ts` stay pure (no I/O) so both the page and
  scripts can use them.
- Comments explain *why* (constraints, GitHub quirks), not what.
- Licensed Apache-2.0.
