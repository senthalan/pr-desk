import { graphql } from "@octokit/graphql";

export type Gql = ReturnType<typeof graphql.defaults>;

export function client(): Gql {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "Set GITHUB_TOKEN (in CI the workflow passes it automatically; locally try `GITHUB_TOKEN=$(gh auth token) npm run sync`).",
    );
  }
  return graphql.defaults({ headers: { authorization: `token ${token}` } });
}

export const RATE = `rateLimit { remaining cost resetAt }`;

let calls = 0;
let lastRemaining: number | null = null;

export function usage() {
  return { calls, lastRemaining };
}

// GraphQL with retries on GitHub's transient 5xx (common on heavy queries).
export async function runQuery<T = any>(gql: Gql, label: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      calls++;
      const res: any = await gql(query, variables);
      if (res?.rateLimit) lastRemaining = res.rateLimit.remaining;
      if (process.env.PR_DESK_VERBOSE) console.log(`  · ${label} ${Date.now() - t0}ms`);
      return res as T;
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const retryable = status === 500 || status === 502 || status === 503 || status === 504;
      if (!retryable || attempt >= maxAttempts) throw e;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(`  ! ${label} failed with ${status}, retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Run tasks with at most `limit` in flight. GitHub's secondary rate limits
// punish bursts, so keep this small.
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
