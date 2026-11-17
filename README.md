# PR desk

A public, support-queue view of your team's open pull requests: whose turn
each PR is, how long it has waited, and what's stuck. Built for projects that
get outside contributions and need to stop them from going stale.

It runs entirely on GitHub: a scheduled workflow fetches PR state every 20
minutes and publishes a static page to GitHub Pages. No server, no database,
no secrets for public repos.

## What it shows

Every open PR is placed in one stage, by whose move it is:

| Stage | Meaning | Whose turn |
| --- | --- | --- |
| **New** | No review or comment from anyone but the author | Reviewer |
| **On author** | A reviewer acted after the author's last update | Author |
| **Updated** | The author pushed or replied after the last review | Reviewer |
| **Approved** | Approved and mergeable | Maintainer |
| **Approved · conflicts** | Approved, but conflicts with the base branch | Us, if the author allows maintainer edits; otherwise the author |
| **Conflicts** | Conflicts and not approved | Author |

Conflicts are checked first, so a conflicting PR never shows as Approved or
On author. Approved PRs with conflicts are pinned to the top of the queue,
since they're the cheapest work to finish.

On top of that:

- **Groups.** Authors are split into the groups you list (for example "Core
  team", "Partner Co") and **Community** for everyone else. Community opens
  first.
- **Waiting time** counts business days in your timezone, and turns amber at
  half the target and red past it.
- **Badges:** rebased, conflict resolved, was approved, pushed after approval,
  changes requested, CI failing.
- **Queue and Board views**, a reviewer filter ("my queue"), and a detail
  drawer with each PR's recent activity. Filters are kept in the URL, so
  `?reviewer=your-login` is a bookmarkable personal queue.
- **Trends** over your whole merged history: merged PRs per month, median
  time to first response per month, and per-group figures (first response
  median and p90, share answered within target, time to merge) for the last
  90 days, 6 months, 12 months or all time. Click a month in either chart to
  list the PRs merged that month, with who merged them, time to first
  response and time to merge.

### What each view covers

| View | Shows |
| --- | --- |
| **Queue** and **Board** | Every open PR (drafts behind a toggle). No merged PRs. |
| **Trends** | Every merged PR since the repo's first one, by month and group. |

Bot PRs (Dependabot, Copilot, your `bots` list, …) are left out everywhere,
so counts are a little lower than GitHub's.

## Set it up for your project

1. **Create your copy.** Click **Use this template** (or fork / copy this
   repository). It can live under your user or your organization, and doesn't
   have to be in the same org as the repos it tracks.
2. **Edit `pr-desk.config.json`.** At minimum set `title` and `repos`; then add
   your groups. See [Configuration](#configuration) and
   [`examples/pr-desk.config.example.json`](examples/pr-desk.config.example.json).
3. **Turn on Pages.** Settings → Pages → Source: **GitHub Actions**.
4. **Run it.** Actions → **Sync and publish** → **Run workflow**, or just push
   a commit. After that it runs every 20 minutes on its own.

Your desk is then at `https://<owner>.github.io/<repo>/`.

## Configuration

`pr-desk.config.json` (editors autocomplete it from
`pr-desk.config.schema.json`):

```json
{
  "$schema": "./pr-desk.config.schema.json",
  "title": "Acme PR desk",
  "description": "Open pull requests to Acme projects, by whose turn it is.",
  "repos": ["acme/widget", "acme/widget-docs"],
  "groups": [
    { "key": "core", "label": "Core team", "members": ["alice", "bob"] },
    { "key": "partner", "label": "Partner Co", "members": ["carol"] }
  ],
  "community": { "label": "Community", "members": [] },
  "defaultView": "community",
  "targets": { "firstReviewDays": 2, "reReviewDays": 2, "mergeDays": 1 },
  "businessDays": { "timezone": "Europe/Berlin", "weekendDays": [5, 6] },
  "bots": ["acme-release-bot"]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `title`, `description` | `"PR desk"` | Page heading. |
| `repos` | required | `owner/name` of each repository to track. |
| `groups[]` | `[]` | Your groups. `key` is lowercase and can't be `community`. |
| `groups[].members` | `[]` | GitHub logins in this group. |
| `community.label` | `"Community"` | Name of the everyone-else group. |
| `community.members` | `[]` | Optional: authors listed here count as Community even if a group also lists them. |
| `defaultView` | `"community"` | Tab opened first: a group key, `community` or `all`. |
| `targets` | `2 / 2 / 1` | Business days allowed for a first review, a re-review after an update, and merging an approved PR. |
| `businessDays.timezone` | `"UTC"` | IANA timezone that defines your working days. |
| `businessDays.weekendDays` | `[5, 6]` | Days off, **Monday-first**: `0` = Mon … `6` = Sun. |
| `bots` | `[]` | Extra logins to ignore, on top of the built-in list (Dependabot, Renovate, Copilot, CodeRabbit, …). |

An author's group comes only from these lists: listed in a group's `members`
→ that group; otherwise → Community. Nothing is inferred from GitHub
profiles. The PR drawer links straight to editing the config for anyone who
isn't listed.

Run `npm run check-config` to validate the file without calling GitHub; the
workflow runs the same check before every sync.

## Private repositories

The workflow's built-in token can read any public repository. To track
private ones, add a repository secret `PR_DESK_TOKEN` holding a fine-grained
personal access token with read access to those repos' pull requests. Note
that publishing Pages from a private repository needs a paid GitHub plan, and
the page is public unless your plan supports private Pages.

## How it works

```
schedule (every 20 min)
  └─ npm run sync      scripts/sync.ts → public/data/pr-board.json, history.json, state.json
  └─ npm run build     Vite → dist/
  └─ deploy            GitHub Pages
browser
  └─ loads data/pr-board.json and works out stages and wait times locally,
     so wait times stay current between syncs
```

- **API cost:** about 1 + open/10 GraphQL calls per repo for open PRs, plus
  usually one more for new merges. Around 25 calls for a repo with 200 open
  PRs, well within the built-in token's hourly limit at a 20-minute schedule.
- **Merged history:** the first run backfills every merged PR (merged/50
  calls, resumed over several runs for very large repos); later runs only add
  new merges. It's published as `data/history.json` (number, title, author,
  times, merger, first-response time) and loaded only by the Trends view.
- **Conflict tracking:** GitHub has no event for "a conflict started" or
  "was resolved", so each run compares mergeability with the previous run.
  The previous state (and the history) is read back from the published site,
  so there's nothing extra to store. Conflicts that already existed before the
  first run show their start as unknown.
- **Keepalive:** GitHub pauses scheduled workflows in a public repo after 60
  days without activity. The workflow pushes an empty commit if nothing has
  been committed for 50 days.

## Local development

```bash
npm install
GITHUB_TOKEN=$(gh auth token) npm run sync   # writes public/data/
npm run dev                                   # http://localhost:5173
```

`npm run typecheck` checks both the page and the sync script.
`npm run check-config -- --schema` regenerates `pr-desk.config.schema.json`
after changing `src/lib/config.ts`.

## License

[Apache License 2.0](LICENSE).
