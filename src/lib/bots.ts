/**
 * Bot detection. Bots never move a PR between stages and never count as
 * reviewers or authors. Teams add their own bot logins via config `bots`.
 */

// Exact logins.
const BOT_LOGINS = new Set([
  "dependabot",
  "renovate",
  "github-actions",
  "github-code-quality",
  "codecov",
  "coderabbitai",
  "coderabit",
  "github-copilot",
  "copilot",
  "copilot-swe-agent",
  "copilot-pull-request-reviewer",
  "sonarcloud",
  "sonarqubecloud",
  "claude",
  "anthropic-claude",
]);

// Login prefixes — these vendors ship several differently-suffixed accounts
// (copilot-swe-agent, copilot-pull-request-reviewer, …), so match the family.
const BOT_PREFIXES = [
  "copilot-",
  "coderabbit",
  "dependabot",
  "renovate",
  "codecov",
  "github-actions",
];

export function isBot(login: string | undefined | null, extra: string[] = []): boolean {
  if (!login) return true;
  const l = login.toLowerCase();
  if (extra.some((b) => b.toLowerCase() === l)) return true;
  if (l.endsWith("[bot]")) return true;
  if (BOT_LOGINS.has(l)) return true;
  return BOT_PREFIXES.some((p) => l.startsWith(p));
}
