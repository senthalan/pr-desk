import { useCallback, useEffect, useMemo, useState } from "react";
import {
  COMMUNITY,
  STAGE_HINTS,
  STAGE_LABELS,
  STAGE_ORDER,
  deriveMerged,
  derivePr,
  groupLabel,
  type DerivedPr,
  type Stage,
} from "./lib/derive";
import { HISTORY_VERSION, SNAPSHOT_VERSION, type HistoryFile, type Snapshot } from "./lib/snapshot";
import { computeTrends } from "./lib/trends";
import { ThemeToggle } from "./components/ThemeToggle";
import { Queue, type QueueSection } from "./components/Queue";
import { Board } from "./components/Board";
import { Drawer } from "./components/Drawer";
import { Trends } from "./components/Trends";
import { STAGE_TONE, TONE_CLASSES, formatHours, formatRelative, formatSpan, reviewSide } from "./components/Parts";

type View = "queue" | "board" | "trends";
const ALL = "all";
const DATA_URL = `${import.meta.env.BASE_URL}data/pr-board.json`;
const HISTORY_URL = `${import.meta.env.BASE_URL}data/history.json`;
// Pages caches for ~10 minutes; re-reading more often buys nothing.
const RELOAD_MS = 5 * 60_000;
// Past this, the scheduled sync has probably stopped (GitHub pauses
// schedules on inactive repos) — say so instead of showing stale data quietly.
const STALE_MS = 3 * 60 * 60_000;

const SLA_RANK = { breach: 0, warn: 1, ok: 2 } as const;

// Most urgent first: past-target before near-target, then longest wait.
function byUrgency(a: DerivedPr, b: DerivedPr): number {
  const ra = a.sla ? SLA_RANK[a.sla] : 3;
  const rb = b.sla ? SLA_RANK[b.sla] : 3;
  if (ra !== rb) return ra - rb;
  return (b.waitingDays ?? 0) - (a.waitingDays ?? 0);
}

function byMergedDesc(a: DerivedPr, b: DerivedPr): number {
  return (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "");
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const q0 = readQuery();
  const [group, setGroup] = useState<string | null>(q0.get("group"));
  const [repo, setRepo] = useState<string>(q0.get("repo") ?? "");
  const [stage, setStage] = useState<Stage | null>(() => {
    const s = q0.get("stage");
    return s && (STAGE_ORDER as string[]).includes(s) ? (s as Stage) : null;
  });
  const [view, setView] = useState<View>(() => {
    const v = readQuery().get("view") ?? readPref("prdesk.view");
    return v === "board" || v === "trends" ? v : "queue";
  });
  const [history, setHistory] = useState<HistoryFile | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [showDrafts, setShowDrafts] = useState(false);
  const [reviewer, setReviewer] = useState(q0.get("reviewer") ?? readPref("prdesk.reviewer") ?? "");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(DATA_URL, { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status === 404 ? "No data yet — the first sync hasn't run." : `HTTP ${r.status}`);
      const j = (await r.json()) as Snapshot;
      if (j.version !== SNAPSHOT_VERSION) throw new Error("Data was written by a different version of pr-desk.");
      setSnap(j);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    }
    // The full merged history is a separate, larger file; it only feeds the
    // Trends view and one tile, so it never delays the queue.
    try {
      const r = await fetch(HISTORY_URL, { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status === 404 ? "no history yet — it's written by the next sync" : `HTTP ${r.status}`);
      const h = (await r.json()) as HistoryFile;
      if (h.version !== HISTORY_VERSION) throw new Error("history was written by a different version of pr-desk");
      setHistory(h);
      setHistoryError(null);
    } catch (e: any) {
      setHistoryError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const reload = window.setInterval(() => document.visibilityState === "visible" && void load(), RELOAD_MS);
    // Wait times are computed here, so tick them forward between syncs.
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearInterval(reload);
      window.clearInterval(tick);
    };
  }, [load]);

  const config = snap?.config ?? null;
  const activeGroup = group ?? config?.defaultView ?? COMMUNITY;

  useEffect(() => {
    if (config) document.title = config.title;
  }, [config]);

  // Keep filters in the URL so a view (e.g. "my queue") can be bookmarked.
  useEffect(() => {
    if (!config) return;
    const q = readQuery();
    const set = (k: string, v: string | null) => (v ? q.set(k, v) : q.delete(k));
    set("group", activeGroup === config.defaultView ? null : activeGroup);
    set("stage", stage);
    set("repo", repo || null);
    set("reviewer", reviewer || null);
    set("view", view === "queue" ? null : view);
    const qs = q.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [config, activeGroup, stage, repo, reviewer, view]);

  const derived = useMemo(() => {
    if (!snap) return [] as DerivedPr[];
    const ctx = { now, config: snap.config };
    const mergedCutoff = new Date(now - snap.config.recentMergedDays * 86_400_000).toISOString();
    const prs = [
      ...snap.open.map((p) => derivePr(p, ctx)),
      ...snap.merged.filter((m) => m.mergedAt >= mergedCutoff).map((m) => deriveMerged(m, ctx)),
    ];
    return prs;
  }, [snap, now]);

  // Recent first-response figures for the tile, from the full history.
  const recent = useMemo(
    () => (history && snap ? computeTrends(history, snap.config, now, "90d", repo || null) : null),
    [history, snap, now, repo],
  );

  const labelOf = useCallback((key: string) => (config ? groupLabel(config, key) : key), [config]);
  const tabs = useMemo(
    () => (config ? [{ key: COMMUNITY, label: config.community.label }, ...config.groups.map((g) => ({ key: g.key, label: g.label })), { key: ALL, label: "All" }] : []),
    [config],
  );
  const multiRepo = (config?.repos.length ?? 0) > 1;

  const inScope = useMemo(
    () => derived.filter((p) => (activeGroup === ALL || p.group === activeGroup) && (!repo || p.repo === repo)),
    [derived, activeGroup, repo],
  );

  const reviewerOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of inScope) if (p.stage !== "merged") for (const l of reviewSide(p)) s.add(l);
    if (reviewer) s.add(reviewer);
    return Array.from(s).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [inScope, reviewer]);

  const filtered = useMemo(() => {
    const text = search.trim().toLowerCase();
    const rl = reviewer.toLowerCase();
    return inScope.filter((p) => {
      if (!showDrafts && p.stage === "draft") return false;
      // Reviewer filter includes pending requests, so "my queue" also finds
      // PRs I've been asked to look at but haven't yet.
      if (rl && !reviewSide(p).some((l) => l.toLowerCase() === rl)) return false;
      if (text) {
        const hay = `#${p.number} ${p.title} ${p.author} ${p.repo} ${p.labels.map((l) => l.name).join(" ")}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }, [inScope, showDrafts, reviewer, search]);

  const byStage = useMemo(() => {
    const m = new Map<Stage, DerivedPr[]>();
    for (const s of [...STAGE_ORDER, "draft" as Stage]) m.set(s, []);
    for (const p of filtered) m.get(p.stage)!.push(p);
    for (const [s, list] of m) list.sort(s === "merged" ? byMergedDesc : byUrgency);
    return m;
  }, [filtered]);

  const tabCounts = useMemo(() => {
    const c: Record<string, number> = { [ALL]: 0 };
    for (const p of derived) {
      if (p.stage === "merged" || p.stage === "draft" || (repo && p.repo !== repo)) continue;
      c[ALL]++;
      c[p.group] = (c[p.group] ?? 0) + 1;
    }
    return c;
  }, [derived, repo]);

  const kpis = useMemo(() => {
    const active = inScope.filter((p) => p.stage !== "merged" && p.stage !== "draft");
    const onUs = active.filter((p) => p.onUs);
    return {
      onUs: onUs.length,
      breach: active.filter((p) => p.sla === "breach").length,
      approvedConflict: active.filter((p) => p.stage === "approved_conflict").length,
      approvedConflictFixable: active.filter((p) => p.stage === "approved_conflict" && p.maintainerCanModify).length,
      oldest: onUs.reduce<number | null>((m, p) => Math.max(m ?? 0, p.waitingBusinessDays ?? 0), null),
    };
  }, [inScope]);

  const sections: QueueSection[] = useMemo(() => {
    if (stage) {
      return [{ key: stage, title: STAGE_LABELS[stage], hint: STAGE_HINTS[stage], tone: stage === "approved_conflict" ? "danger" : undefined, prs: byStage.get(stage) ?? [] }];
    }
    const active = filtered.filter((p) => p.stage !== "merged" && p.stage !== "draft");
    return [
      {
        key: "approved_conflict",
        title: "Approved · conflicts",
        hint: "Approved work blocked only by conflicts. Rebase it ourselves where maintainers can edit",
        tone: "danger" as const,
        prs: byStage.get("approved_conflict") ?? [],
      },
      {
        key: "on_us",
        title: "Waiting on us",
        hint: "New, updated since the last review, or approved and ready to merge",
        prs: active.filter((p) => p.onUs && p.stage !== "approved_conflict").sort(byUrgency),
      },
      {
        key: "on_author",
        title: "Waiting on author",
        hint: "Changes requested or conflicts to resolve",
        prs: active.filter((p) => !p.onUs && p.stage !== "approved_conflict").sort(byUrgency),
      },
      ...(showDrafts ? [{ key: "draft", title: "Drafts", prs: byStage.get("draft") ?? [] }] : []),
    ];
  }, [stage, filtered, byStage, showDrafts]);

  const openPr = openId ? derived.find((p) => p.id === openId) ?? null : null;
  const stats = recent?.byGroup[activeGroup === ALL ? "all" : activeGroup];
  const configUrl = snap?.host ? `https://github.com/${snap.host}/edit/main/pr-desk.config.json` : null;
  const stale = snap ? now - Date.parse(snap.generatedAt) > STALE_MS : false;

  if (!snap) {
    return (
      <main className="min-h-screen px-6 py-16 max-w-xl mx-auto text-center">
        <h1 className="text-xl font-semibold">PR desk</h1>
        <p className="text-sm text-muted mt-2">{loadError ?? "Loading pull requests…"}</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{snap.config.title}</h1>
          <p className="text-sm text-muted mt-0.5">
            {snap.config.description ?? "Open pull requests by whose turn it is"}
          </p>
          <p className="text-xs text-muted mt-1 flex flex-wrap gap-x-3">
            {snap.config.repos.map((r) => (
              <a key={r} href={`https://github.com/${r}/pulls`} target="_blank" rel="noreferrer" className="font-mono hover:text-fg">
                {r}
              </a>
            ))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted" title={new Date(snap.generatedAt).toLocaleString()}>
            Synced {formatRelative(snap.generatedAt)}
          </span>
          <ThemeToggle />
        </div>
      </header>

      {stale && (
        <div className="mb-4 border border-warn-border bg-warn-bg text-warn-fg rounded p-3 text-sm">
          This data is from {new Date(snap.generatedAt).toLocaleString()}. The scheduled sync may have stopped; check the
          repository&apos;s Actions tab.
        </div>
      )}
      {loadError && (
        <div className="mb-4 border border-warn-border bg-warn-bg text-warn-fg rounded p-3 text-sm">
          Couldn&apos;t reload data: {loadError}. Showing what was loaded earlier.
        </div>
      )}

      <nav className="flex flex-wrap items-center gap-1 mb-4" aria-label="Group">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setGroup(t.key)}
            aria-pressed={activeGroup === t.key}
            className={`px-3 py-1.5 rounded text-sm border ${
              activeGroup === t.key ? "bg-panel border-muted text-fg font-medium" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {t.label} <span className="text-muted font-normal">{tabCounts[t.key] ?? 0}</span>
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {multiRepo && (
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              aria-label="Repository"
              className="px-2 py-1.5 rounded border border-border bg-panel text-sm"
            >
              <option value="">All repositories</option>
              {snap.config.repos.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          )}
          <div className="inline-flex rounded border border-border overflow-hidden" role="group" aria-label="View">
            {(["queue", "board", "trends"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => {
                  setView(v);
                  writePref("prdesk.view", v);
                }}
                aria-pressed={view === v}
                className={`px-3 py-1.5 text-sm ${view === v ? "bg-panel text-fg" : "text-muted hover:text-fg"}`}
              >
                {v === "queue" ? "Queue" : v === "board" ? "Board" : "Trends"}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {view !== "trends" && (
      <>
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Kpi label="Waiting on us" value={String(kpis.onUs)} />
        <Kpi
          label="Past target"
          value={String(kpis.breach)}
          tone={kpis.breach > 0 ? "danger" : undefined}
          hint={`First review ${snap.config.targets.firstReviewDays}d · re-review ${snap.config.targets.reReviewDays}d · merge ${snap.config.targets.mergeDays}d (business days)`}
        />
        <Kpi
          label="Approved · conflicts"
          value={String(kpis.approvedConflict)}
          tone={kpis.approvedConflict > 0 ? "danger" : undefined}
          sub={kpis.approvedConflict > 0 ? `${kpis.approvedConflictFixable} we can rebase` : undefined}
          onClick={() => setStage(stage === "approved_conflict" ? null : "approved_conflict")}
        />
        <Kpi label="Longest wait on us" value={formatSpan(kpis.oldest)} sub="business days" />
        <Kpi
          label="First response · 90d"
          value={stats?.p90FirstResponseH != null ? `p90 ${formatHours(stats.p90FirstResponseH)}` : "—"}
          sub={stats ? `median ${formatHours(stats.medianFirstResponseH)} · ${stats.merged} merged PRs` : history ? "no merged PRs" : "loading…"}
          hint="Time from opening to the first review or comment by someone other than the author, for PRs merged in the last 90 days. See Trends for more."
          onClick={() => {
            setView("trends");
            writePref("prdesk.view", "trends");
          }}
        />
      </section>

      <section className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-4" aria-label="Stages">
        {STAGE_ORDER.map((s) => {
          const n = byStage.get(s)?.length ?? 0;
          const selected = stage === s;
          const urgent = s === "approved_conflict" && n > 0;
          return (
            <button
              key={s}
              onClick={() => setStage(selected ? null : s)}
              aria-pressed={selected}
              title={STAGE_HINTS[s]}
              className={`text-left rounded border px-3 py-2 transition-colors ${
                selected ? `${TONE_CLASSES[STAGE_TONE[s]]} ring-1 ring-current` : urgent ? TONE_CLASSES.danger : "bg-panel border-border hover:border-muted"
              }`}
            >
              <div className={`text-[11px] truncate ${selected || urgent ? "" : "text-muted"}`}>{STAGE_LABELS[s]}</div>
              <div className="text-xl font-semibold">{n}</div>
            </button>
          );
        })}
      </section>

      <section className="flex flex-wrap items-center gap-2 mb-4 text-sm">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by #, title, author, label"
          aria-label="Filter"
          className="px-2.5 py-1.5 rounded border border-border bg-panel w-64 max-w-full"
        />
        <label className="flex items-center gap-1.5 text-muted">
          Reviewer
          <select
            value={reviewer}
            onChange={(e) => {
              setReviewer(e.target.value);
              writePref("prdesk.reviewer", e.target.value);
            }}
            className="px-2 py-1.5 rounded border border-border bg-panel text-fg max-w-[180px]"
          >
            <option value="">Anyone</option>
            {reviewerOptions.map((l) => (
              <option key={l} value={l}>@{l}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted cursor-pointer">
          <input type="checkbox" checked={showDrafts} onChange={(e) => setShowDrafts(e.target.checked)} />
          Drafts ({inScope.filter((p) => p.stage === "draft").length})
        </label>
        {stage && (
          <button onClick={() => setStage(null)} className="text-xs text-muted hover:text-fg underline">
            Clear stage filter
          </button>
        )}
      </section>
      </>
      )}

      {view === "trends" ? (
        <Trends history={history} error={historyError} config={snap.config} group={activeGroup} repo={repo || null} now={now} />
      ) : view === "queue" ? (
        <Queue sections={sections} groupLabel={labelOf} showGroup={activeGroup === ALL} showRepo={multiRepo} onOpen={(p) => setOpenId(p.id)} />
      ) : (
        <Board
          columns={[...(stage ? [stage] : STAGE_ORDER), ...(showDrafts && !stage ? (["draft"] as Stage[]) : [])].map((s) => ({
            stage: s,
            prs: byStage.get(s) ?? [],
          }))}
          showRepo={multiRepo}
          onOpen={(p) => setOpenId(p.id)}
        />
      )}

      <footer className="mt-10 pt-4 border-t border-border text-xs text-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>
          Waiting times are in business days ({snap.config.businessDays.timezone}). Groups come from the member lists in the
          config.
        </span>
        {configUrl && (
          <a href={configUrl} target="_blank" rel="noreferrer" className="underline hover:text-fg">
            Edit configuration
          </a>
        )}
        {snap.host && (
          <a href={`https://github.com/${snap.host}`} target="_blank" rel="noreferrer" className="underline hover:text-fg">
            Source
          </a>
        )}
      </footer>

      {openPr && (
        <Drawer pr={openPr} groupLabel={labelOf(openPr.group)} configUrl={configUrl} onClose={() => setOpenId(null)} />
      )}
    </main>
  );
}

function Kpi({
  label,
  value,
  sub,
  hint,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  tone?: "danger";
  onClick?: () => void;
}) {
  const cls = `text-left rounded border px-3 py-2.5 ${tone === "danger" ? TONE_CLASSES.danger : "bg-panel border-border"} ${
    onClick ? "hover:border-muted cursor-pointer" : ""
  }`;
  const body = (
    <>
      <div className={`text-xs ${tone ? "" : "text-muted"}`}>{label}</div>
      <div className="text-2xl font-semibold mt-0.5">{value}</div>
      {sub && <div className={`text-xs mt-0.5 ${tone ? "" : "text-muted"}`}>{sub}</div>}
    </>
  );
  return onClick ? (
    <button onClick={onClick} title={hint} className={cls}>{body}</button>
  ) : (
    <div title={hint} className={cls}>{body}</div>
  );
}
