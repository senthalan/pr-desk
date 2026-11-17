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
| **Merged** | Merged recently | — |

Conflicts are checked first, so a conflicting PR never shows as Approved or
On author. Approved PRs with conflicts are pinned to the top of the queue,
since they're the cheapest work to finish.

On top of that:

- **Groups.** Authors are split into your groups (for example "Core team",
  "Partner Co") and **Community** for everyone else. Community opens first.
- **Waiting time** counts business days in your timezone, and turns amber at
  half the target and red past it.
- **Badges:** rebased, conflict resolved, was approved, pushed after approval,
  changes requested, CI failing.
- **Queue and Board views**, a reviewer filter ("my queue"), and a detail
  drawer with each PR's recent activity. Filters are kept in the URL, so
  `?reviewer=your-login` is a bookmarkable personal queue.
- **Time to first response** for PRs merged in the last 30 days, per group.

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
    { "key": "core", "label": "Core team", "members": ["alice", "bob"], "match": [] },
    { "key": "partner", "label": "Partner Co", "members": [], "match": ["partnerco"] }
  ],
  "community": { "label": "Community", "members": [] },
  "defaultView": "community",
  "targets": { "firstReviewDays": 2, "reReviewDays": 2, "mergeDays": 1 },
  "businessDays": { "timezone": "Europe/Berlin", "weekendDays": [5, 6] },
  "recentMergedDays": 14,
  "historyDays": 30,
  "bots": ["acme-release-bot"]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `title`, `description` | `"PR desk"` | Page heading. |
| `repos` | required | `owner/name` of each repository to track. |
| `groups[]` | `[]` | Your groups. `key` is lowercase and can't be `community`. |
| `groups[].members` | `[]` | GitHub logins in this group. |
| `groups[].match` | `[]` | Terms looked for in an author's GitHub profile company and **public** org memberships. A hint for people you haven't listed. |
| `community.label` | `"Community"` | Name of the everyone-else group. |
| `community.members` | `[]` | Force these authors into Community even if a `match` term would claim them. |
| `defaultView` | `"community"` | Tab opened first: a group key, `community` or `all`. |
| `targets` | `2 / 2 / 1` | Business days allowed for a first review, a re-review after an update, and merging an approved PR. |
| `businessDays.timezone` | `"UTC"` | IANA timezone that defines your working days. |
| `businessDays.weekendDays` | `[5, 6]` | Days off, **Monday-first**: `0` = Mon … `6` = Sun. |
| `recentMergedDays` | `14` | How long merged PRs stay on the board. |
| `historyDays` | `30` | Window for the time-to-first-response statistic. |
| `bots` | `[]` | Extra logins to ignore, on top of the built-in list (Dependabot, Renovate, Copilot, CodeRabbit, …). |

How an author's group is decided, first match wins:

1. Listed in `community.members` → Community.
2. Listed in a group's `members` → that group.
3. A group's `match` term appears in their profile company or public orgs →
   that group.
4. Otherwise → Community.

Profiles are often blank, and org memberships are usually private, so list
the people you know in `members`. The drawer links straight to editing the
config for anyone who isn't listed.

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
  └─ npm run sync      scripts/sync.ts → public/data/pr-board.json + state.json
  └─ npm run build     Vite → dist/
  └─ deploy            GitHub Pages
browser
  └─ loads data/pr-board.json and works out stages and wait times locally,
     so wait times stay current between syncs
```

- **API cost:** about 1 + open/10 + merged/50 GraphQL calls per repo, plus a
  few for author profiles. Around 40 calls for a repo with 200 open PRs, well
  within the built-in token's hourly limit at a 20-minute schedule.
- **Conflict tracking:** GitHub has no event for "a conflict started" or
  "was resolved", so each run compares mergeability with the previous run.
  The previous state is read back from the published site, so there's nothing
  extra to store. The first run starts the clock at that run.
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
