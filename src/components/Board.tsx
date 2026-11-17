import { STAGE_HINTS, STAGE_LABELS, type DerivedPr, type Stage } from "../lib/derive";
import { Avatar, AvatarStack, PrBadges, STAGE_TONE, TONE_CLASSES, TURN_LABELS, WaitChip } from "./Parts";

const MERGED_CAP = 30;

export function Board({
  columns,
  showRepo,
  onOpen,
}: {
  columns: { stage: Stage; prs: DerivedPr[] }[];
  showRepo: boolean;
  onOpen: (pr: DerivedPr) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {columns.map(({ stage, prs }) => {
        const tone = STAGE_TONE[stage];
        const shown = stage === "merged" ? prs.slice(0, MERGED_CAP) : prs;
        return (
          <section key={stage} className="w-[260px] shrink-0 flex flex-col">
            <header
              title={STAGE_HINTS[stage]}
              className={`rounded-t border px-3 py-2 flex items-baseline justify-between ${TONE_CLASSES[tone]}`}
            >
              <span className="text-xs font-semibold">{STAGE_LABELS[stage]}</span>
              <span className="text-xs">{prs.length}</span>
            </header>
            <div
              className={`flex-1 border border-t-0 rounded-b p-2 space-y-2 bg-bg ${
                stage === "approved_conflict" ? "border-danger-border" : "border-border"
              }`}
            >
              {shown.length === 0 && <p className="text-xs text-muted px-1 py-2">Nothing here</p>}
              {shown.map((pr) => (
                <button
                  key={pr.id}
                  onClick={() => onOpen(pr)}
                  className="w-full text-left bg-panel border border-border hover:border-muted rounded p-2.5"
                >
                  <div className="text-sm leading-snug line-clamp-2" title={pr.title}>
                    {pr.title}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                    <Avatar login={pr.author} size={16} />
                    <span className="font-mono truncate">{showRepo ? pr.repo.split("/")[1] : ""}#{pr.number} · @{pr.author}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs">
                      <WaitChip pr={pr} />
                      {pr.stage !== "merged" && (
                        <span className={pr.onUs ? "text-fg" : "text-muted"}>{TURN_LABELS[pr.turn]}</span>
                      )}
                    </span>
                    {pr.stage !== "merged" && <AvatarStack logins={pr.reviewers} max={3} />}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1 empty:hidden">
                    <PrBadges pr={pr} />
                  </div>
                </button>
              ))}
              {prs.length > shown.length && (
                <p className="text-xs text-muted px-1">+{prs.length - shown.length} more — switch to the queue view to see all</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
