import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { PrDeskConfig } from "../lib/config";
import { groupLabel } from "../lib/derive";
import { PERIODS, computeTrends, groupKeys, mergedInMonth, type Period, type Trends as TrendsData } from "../lib/trends";
import type { HistoryFile } from "../lib/snapshot";
import { Avatar, formatHours } from "./Parts";

// Color follows the group, never its rank: community is slot 1, then groups
// in config order. Past eight, groups share a neutral.
function seriesColor(config: PrDeskConfig, key: string): string {
  const i = groupKeys(config).indexOf(key);
  return i >= 0 && i < 8 ? `var(--series-${i + 1})` : "var(--muted)";
}

const ALL = "all";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string, withYear = false) => {
  const [y, mo] = m.split("-");
  return `${MONTHS[Number(mo) - 1]}${withYear ? ` ${y}` : ""}`;
};

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref as React.RefObject<T>, w];
}

// 0 and 4–5 "nice" ticks up to at least `max`.
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(6)));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

type Series = { key: string; label: string; color: string };

const PAD = { top: 12, right: 64, bottom: 28, left: 44 };
const H = 220;

function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { label: string; value: string; color?: string }[] }) {
  const left = Math.min(Math.max(x + 12, 0), width - 190);
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-2 z-10 w-[180px] rounded border border-border bg-panel px-3 py-2 text-xs shadow-lg"
      style={{ left }}
    >
      <div className="mb-1 text-muted">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-muted">
            {r.color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />}
            {r.label}
          </span>
          <strong className="font-semibold text-fg">{r.value}</strong>
        </div>
      ))}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

type Selectable = { selected: string | null; onSelect: (month: string) => void };

function MergedChart({ data, series, selected, onSelect }: { data: TrendsData; series: Series[] } & Selectable) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const months = data.months;
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const totals = months.map((m) => series.reduce((n, s) => n + (m.merged[s.key] ?? 0), 0));
  const ticks = niceTicks(Math.max(1, ...totals));
  const yMax = ticks[ticks.length - 1];
  const band = plotW / Math.max(1, months.length);
  const barW = Math.max(4, Math.min(24, band * 0.6));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.ceil(months.length / Math.max(1, Math.floor(plotW / 48)));

  return (
    <div ref={ref} className="relative">
      <svg width={width} height={H} role="img" aria-label="Merged pull requests per month">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)">{t}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = PAD.left + band * i + band / 2;
          let base = 0;
          const segs = series.filter((s) => (m.merged[s.key] ?? 0) > 0);
          return (
            <g
              key={m.month}
              opacity={(hover != null ? hover === i : selected == null || selected === m.month) ? 1 : 0.45}
            >
              {segs.map((s, j) => {
                const v = m.merged[s.key] ?? 0;
                const top = y(base + v);
                // 2px surface gap between stacked segments.
                const bottom = y(base) - (j > 0 ? 2 : 0);
                base += v;
                const h = Math.max(0, bottom - top);
                const isTop = j === segs.length - 1;
                const r = isTop ? Math.min(4, h, barW / 2) : 0;
                const x0 = cx - barW / 2;
                const d = `M${x0},${bottom} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${bottom} Z`;
                return <path key={s.key} d={d} fill={s.color} />;
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {monthLabel(m.month, i === 0 || m.month.endsWith("-01"))}
                </text>
              )}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-pressed={selected === m.month}
                aria-label={`${monthLabel(m.month, true)}: ${totals[i]} merged. Show these PRs.`}
                style={{ cursor: "pointer" }}
                onClick={() => onSelect(m.month)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(m.month);
                  }
                }}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {hover != null && months[hover] && (
        <Tooltip
          x={PAD.left + band * hover + band / 2}
          width={width}
          title={monthLabel(months[hover].month, true)}
          rows={[
            ...series.map((s) => ({ label: s.label, value: String(months[hover].merged[s.key] ?? 0), color: s.color })),
            ...(series.length > 1 ? [{ label: "Total", value: String(totals[hover]) }] : []),
          ]}
        />
      )}
    </div>
  );
}

function ResponseChart({ data, series, selected, onSelect }: { data: TrendsData; series: Series[] } & Selectable) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const months = data.months;
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // Plot in days: medians range from minutes to weeks, and days read best.
  const val = (i: number, k: string) => {
    const h = months[i]?.medianFirstResponseH[k];
    return h == null ? null : h / 24;
  };
  const maxV = Math.max(0.1, ...months.flatMap((_, i) => series.map((s) => val(i, s.key) ?? 0)));
  const ticks = niceTicks(maxV);
  const yMax = ticks[ticks.length - 1];
  const step = plotW / Math.max(1, months.length);
  const x = (i: number) => PAD.left + step * i + step / 2;
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.ceil(months.length / Math.max(1, Math.floor(plotW / 48)));

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label="Median time to first response per month, in days"
        style={{ cursor: "pointer" }}
        onClick={() => hover != null && months[hover] && onSelect(months[hover].month)}
        onPointerMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.floor((e.clientX - box.left - PAD.left) / step);
          setHover(i >= 0 && i < months.length ? i : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)">{t}d</text>
          </g>
        ))}
        {months.map((m, i) =>
          i % labelEvery === 0 ? (
            <text key={m.month} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
              {monthLabel(m.month, i === 0 || m.month.endsWith("-01"))}
            </text>
          ) : null,
        )}
        {(() => {
          const si = months.findIndex((m) => m.month === selected);
          return si >= 0 ? <line x1={x(si)} x2={x(si)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--muted)" strokeWidth={1} /> : null;
        })()}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--axis)" strokeWidth={1} />}
        {series.map((s) => {
          // Break the line at months with no responses for this group.
          const segments: string[] = [];
          let cur = "";
          months.forEach((_, i) => {
            const v = val(i, s.key);
            if (v == null) {
              if (cur) segments.push(cur);
              cur = "";
            } else cur += `${cur ? "L" : "M"}${x(i)},${y(v)}`;
          });
          if (cur) segments.push(cur);
          let last = -1;
          months.forEach((_, i) => val(i, s.key) != null && (last = i));
          return (
            <g key={s.key}>
              {segments.map((d, j) => (
                <path key={j} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {months.map((_, i) => {
                const v = val(i, s.key);
                return v == null ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
                );
              })}
              {series.length > 1 && last >= 0 && (
                <text x={x(last) + 9} y={y(val(last, s.key)!)} dy="0.32em" fontSize={11} fill="var(--fg)">{s.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && months[hover] && (
        <Tooltip
          x={x(hover)}
          width={width}
          title={`${monthLabel(months[hover].month, true)} · median`}
          rows={series.map((s) => {
            const h = months[hover].medianFirstResponseH[s.key];
            const n = months[hover].responded[s.key] ?? 0;
            return { label: `${s.label} (${n})`, value: h == null ? "—" : formatHours(h), color: s.color };
          })}
        />
      )}
    </div>
  );
}

function pct(v: number | null) {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export function Trends({
  history,
  error,
  config,
  group,
  repo,
  now,
}: {
  history: HistoryFile | null;
  error: string | null;
  config: PrDeskConfig;
  group: string;
  repo: string | null;
  now: number;
}) {
  const [period, setPeriod] = useState<Period>("12m");
  const [showTable, setShowTable] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const monthPrs = useMemo(
    () => (history && month ? mergedInMonth(history, config, month, group, repo) : []),
    [history, config, month, group, repo],
  );
  const selectMonth = (m: string) => setMonth((cur) => (cur === m ? null : m));
  // Bring the list into view once it has rendered for the chosen month.
  useEffect(() => {
    if (month) listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [month]);
  const data = useMemo(() => (history ? computeTrends(history, config, now, period, repo) : null), [history, config, now, period, repo]);

  const all = groupKeys(config).map((k) => ({ key: k, label: groupLabel(config, k), color: seriesColor(config, k) }));
  const series = group === ALL ? all : all.filter((s) => s.key === group);

  if (error) return <div className="bg-panel border border-border rounded p-6 text-sm text-muted">Couldn&apos;t load history: {error}</div>;
  if (!history || !data) return <div className="bg-panel border border-border rounded p-6 text-sm text-muted">Loading merged-PR history…</div>;

  const stats = data.byGroup[group === ALL ? "all" : group];
  const incomplete = Object.entries(history.repos).filter(([, h]) => !h.backfilled).map(([r]) => r);
  const since = data.firstMergedAt ? new Date(data.firstMergedAt * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded border border-border overflow-hidden" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              aria-pressed={period === p.key}
              className={`px-3 py-1.5 text-sm ${period === p.key ? "bg-panel text-fg" : "text-muted hover:text-fg"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">
          {data.totalMerged.toLocaleString()} merged PRs in history{since ? ` since ${since}` : ""}
          {incomplete.length > 0 && ` · still backfilling ${incomplete.join(", ")}`}
        </span>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="Merged" value={stats ? stats.merged.toLocaleString() : "0"} />
        <Tile label="First response · median" value={formatHours(stats?.medianFirstResponseH ?? null)} />
        <Tile label="First response · p90" value={formatHours(stats?.p90FirstResponseH ?? null)} />
        <Tile
          label={`Responded within ${config.targets.firstReviewDays}d`}
          value={pct(stats?.withinTarget ?? null)}
          hint="Share of merged PRs whose first review or comment came within the first-review target (business days)"
        />
        <Tile label="Time to merge · median" value={formatHours(stats?.medianTimeToMergeH ?? null)} />
      </section>

      <section className="bg-panel border border-border rounded p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <h2 className="text-sm font-semibold">Merged pull requests per month</h2>
          <Legend series={series} />
        </div>
        <p className="text-xs text-muted mb-2">Click a month to list the PRs merged in it.</p>
        {data.months.length ? (
          <MergedChart data={data} series={series} selected={month} onSelect={selectMonth} />
        ) : (
          <p className="text-sm text-muted py-8 text-center">No merged PRs in this period.</p>
        )}
      </section>

      <section className="bg-panel border border-border rounded p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <h2 className="text-sm font-semibold">Median time to first response</h2>
          <Legend series={series} />
        </div>
        <p className="text-xs text-muted mb-2">
          From opening to the first review or comment by someone other than the author, for PRs merged that month.
        </p>
        {data.months.length ? (
          <ResponseChart data={data} series={series} selected={month} onSelect={selectMonth} />
        ) : (
          <p className="text-sm text-muted py-8 text-center">No merged PRs in this period.</p>
        )}
      </section>

      {month && (
        <section ref={listRef} className="bg-panel border border-border rounded scroll-mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
            <h2 className="text-sm font-semibold">
              {monthPrs.length} PR{monthPrs.length === 1 ? "" : "s"} merged in {monthLabel(month, true)}
              {group !== ALL ? <span className="font-normal text-muted"> · {groupLabel(config, group)}</span> : null}
            </h2>
            <button onClick={() => setMonth(null)} className="text-xs text-muted underline hover:text-fg">
              Close
            </button>
          </div>
          {monthPrs.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted">No PRs from this group were merged that month.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead className="text-muted text-xs border-y border-border">
                  <tr>
                    <th className="text-left font-normal px-3 py-2">Pull request</th>
                    <th className="text-left font-normal px-3 py-2 w-48">Author</th>
                    <th className="text-left font-normal px-3 py-2 w-24">Merged</th>
                    <th className="text-right font-normal px-3 py-2 w-28">First response</th>
                    <th className="text-right font-normal px-3 py-2 w-28">Time to merge</th>
                  </tr>
                </thead>
                <tbody>
                  {monthPrs.map((p) => (
                    <tr key={`${p.repo}#${p.number}`} className="border-b border-border last:border-b-0 align-top">
                      <td className="px-3 py-2 min-w-0">
                        <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline block truncate max-w-[480px]" title={p.title}>
                          <span className="text-muted font-mono text-xs mr-1.5">
                            {config.repos.length > 1 ? p.repo.split("/")[1] : ""}#{p.number}
                          </span>
                          {p.title}
                        </a>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span className="flex items-center gap-1.5">
                          <Avatar login={p.author} size={16} />
                          <span className="font-mono truncate">@{p.author}</span>
                        </span>
                        {group === ALL && <span className="text-muted">{groupLabel(config, p.group)}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted whitespace-nowrap" title={new Date(p.mergedAt * 1000).toLocaleString()}>
                        {new Date(p.mergedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        {p.mergedBy ? <span className="block">by @{p.mergedBy}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{p.firstResponseH == null ? "none" : formatHours(p.firstResponseH)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{formatHours(p.timeToMergeH)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {group === ALL && (
        <section className="bg-panel border border-border rounded overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="text-muted text-xs border-b border-border">
              <tr>
                <th className="text-left font-normal px-3 py-2">Group</th>
                <th className="text-right font-normal px-3 py-2">Merged</th>
                <th className="text-right font-normal px-3 py-2">First response · median</th>
                <th className="text-right font-normal px-3 py-2">First response · p90</th>
                <th className="text-right font-normal px-3 py-2">Within {config.targets.firstReviewDays}d</th>
                <th className="text-right font-normal px-3 py-2">Time to merge · median</th>
              </tr>
            </thead>
            <tbody>
              {all.map((s) => {
                const g = data.byGroup[s.key];
                return (
                  <tr key={s.key} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <span className="inline-block h-2 w-2 rounded-full mr-2" style={{ background: s.color }} />
                      {s.label}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{g?.merged ?? 0}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatHours(g?.medianFirstResponseH ?? null)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatHours(g?.p90FirstResponseH ?? null)}</td>
                    <td className="px-3 py-2 text-right font-mono">{pct(g?.withinTarget ?? null)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatHours(g?.medianTimeToMergeH ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <div>
        <button onClick={() => setShowTable((v) => !v)} className="text-xs text-muted underline hover:text-fg" aria-expanded={showTable}>
          {showTable ? "Hide" : "Show"} monthly data
        </button>
        {showTable && (
          <div className="mt-2 bg-panel border border-border rounded overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="text-left font-normal px-3 py-2">Month</th>
                  {series.map((s) => (
                    <Fragment key={s.key}>
                      <th className="text-right font-normal px-3 py-2">{s.label} merged</th>
                      <th className="text-right font-normal px-3 py-2">{s.label} first response (median)</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.months.slice().reverse().map((m) => (
                  <tr key={m.month} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-1.5">{monthLabel(m.month, true)}</td>
                    {series.map((s) => (
                      <Fragment key={s.key}>
                        <td className="px-3 py-1.5 text-right font-mono">{m.merged[s.key] ?? 0}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatHours(m.medianFirstResponseH[s.key] ?? null)}</td>
                      </Fragment>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint} className="rounded border border-border bg-panel px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-semibold mt-0.5">{value}</div>
    </div>
  );
}

