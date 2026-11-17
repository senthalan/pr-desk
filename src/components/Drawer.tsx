import { useEffect } from "react";
import { STAGE_HINTS, type DerivedPr } from "../lib/derive";
import {
  Avatar,
  AvatarStack,
  PrBadges,
  StagePill,
  TURN_HINTS,
  TURN_LABELS,
  WaitChip,
  eventLabel,
  formatSpan,
} from "./Parts";

const GROUP_SOURCE_LABEL = {
  member: "listed in config",
  profile: "guessed from GitHub profile",
  default: "not in any group",
} as const;

export function Drawer({
  pr,
  groupLabel,
  configUrl,
  onClose,
}: {
  pr: DerivedPr;
  groupLabel: string;
  configUrl: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const events = pr.timeline.slice().reverse();
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`Pull request ${pr.id}`}>
      <button aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative h-full w-full max-w-[460px] bg-panel border-l border-border overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-base font-semibold hover:underline">
            <span className="text-muted font-mono mr-1.5">#{pr.number}</span>
            {pr.title}
          </a>
          <button onClick={onClose} className="text-muted hover:text-fg text-lg leading-none" aria-label="Close">
            ×
          </button>
        </div>
        <p className="mt-1 text-xs text-muted font-mono">{pr.repo}</p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <StagePill stage={pr.stage} />
          <PrBadges pr={pr} />
        </div>
        <p className="mt-2 text-xs text-muted">{STAGE_HINTS[pr.stage]}</p>

        <dl className="mt-4 grid grid-cols-[110px_1fr] gap-y-2 text-sm">
          {pr.stage === "merged" ? (
            <>
              <dt className="text-muted">Merged</dt>
              <dd>
                {when(pr.mergedAt ?? null)}
                {pr.mergedBy ? ` by @${pr.mergedBy}` : ""}
                <span className="text-xs text-muted">
                  {" "}· open {formatSpan((Date.parse(pr.mergedAt ?? pr.createdAt) - Date.parse(pr.createdAt)) / 86_400_000)}
                </span>
              </dd>
            </>
          ) : (
            <>
              <dt className="text-muted">Turn</dt>
              <dd title={TURN_HINTS[pr.turn]}>{TURN_LABELS[pr.turn]}</dd>
              <dt className="text-muted">Waiting</dt>
              <dd className="flex items-center gap-2">
                <WaitChip pr={pr} />
                <span className="text-xs text-muted">
                  {pr.since ? `since ${when(pr.since)}` : ""}
                  {pr.slaDays != null ? ` · target ${pr.slaDays} business day${pr.slaDays === 1 ? "" : "s"}` : ""}
                </span>
              </dd>
              {pr.conflictSince && (
                <>
                  <dt className="text-muted">Conflict</dt>
                  <dd className="text-xs">since {when(pr.conflictSince)}</dd>
                </>
              )}
              {pr.conflictResolvedAt && !pr.conflictSince && (
                <>
                  <dt className="text-muted">Conflict</dt>
                  <dd className="text-xs">resolved {when(pr.conflictResolvedAt)}</dd>
                </>
              )}
            </>
          )}
          <dt className="text-muted">Author</dt>
          <dd className="flex items-center gap-1.5">
            <Avatar login={pr.author} />
            <a href={`https://github.com/${pr.author}`} target="_blank" rel="noreferrer" className="font-mono hover:underline">
              @{pr.author}
            </a>
          </dd>
          <dt className="text-muted">Group</dt>
          <dd>
            {groupLabel} <span className="text-xs text-muted">({GROUP_SOURCE_LABEL[pr.groupSource]})</span>
            {configUrl && pr.groupSource !== "member" && (
              <a href={configUrl} target="_blank" rel="noreferrer" className="block text-xs text-muted underline hover:text-fg mt-0.5">
                Wrong? Add @{pr.author} to a group in the config
              </a>
            )}
          </dd>
          {pr.stage !== "merged" && (
            <>
              <dt className="text-muted">Approved by</dt>
              <dd><AvatarStack logins={pr.approvers} max={8} /></dd>
              <dt className="text-muted">Reviewed by</dt>
              <dd><AvatarStack logins={pr.reviewers} max={8} /></dd>
              <dt className="text-muted">Requested</dt>
              <dd><AvatarStack logins={pr.requestedReviewers} max={8} /></dd>
              <dt className="text-muted">Size</dt>
              <dd className="font-mono text-xs">
                <span className="text-ok-fg">+{pr.additions}</span> <span className="text-danger-fg">−{pr.deletions}</span>
              </dd>
              <dt className="text-muted">Checks</dt>
              <dd className="text-xs">{pr.ciState ? pr.ciState.toLowerCase() : "none"}</dd>
            </>
          )}
          {pr.labels.length > 0 && (
            <>
              <dt className="text-muted">Labels</dt>
              <dd className="flex flex-wrap gap-1">
                {pr.labels.map((l) => (
                  <span key={l.name} className="text-xs rounded px-1.5 py-0.5 border border-border">
                    <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: `#${l.color}` }} />
                    {l.name}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>

        {events.length > 0 && (
          <>
            <h3 className="mt-6 mb-2 text-sm font-semibold">Recent activity</h3>
            <ol className="relative border-l border-border ml-1.5 space-y-2.5">
              {events.map((e, i) => {
                const { text, side } = eventLabel(e, pr.author);
                const dot = side === "author" ? "bg-violet-border" : side === "reviewer" ? "bg-info-border" : "bg-border";
                return (
                  <li key={i} className="pl-4 relative">
                    <span className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ${dot}`} />
                    <div className="text-sm">{text}</div>
                    <div className="text-xs text-muted">{when(e.at)}</div>
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-xs text-muted">
              <span className="inline-block w-2 h-2 rounded-full bg-violet-border mr-1" />author side
              <span className="inline-block w-2 h-2 rounded-full bg-info-border ml-3 mr-1" />reviewer side · last 60 events
            </p>
          </>
        )}

        <a href={pr.url} target="_blank" rel="noreferrer" className="mt-6 inline-block px-3 py-1.5 rounded border border-border hover:border-muted text-sm">
          Open on GitHub ↗
        </a>
      </aside>
    </div>
  );
}
