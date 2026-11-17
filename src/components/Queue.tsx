import type { DerivedPr } from "../lib/derive";
import {
  Avatar,
  ReviewActivity,
  PrBadges,
  StagePill,
  TONE_CLASSES,
  TURN_HINTS,
  TURN_LABELS,
  WaitChip,
  type Tone,
} from "./Parts";

export type QueueSection = {
  key: string;
  title: string;
  hint?: string;
  tone?: Tone;
  prs: DerivedPr[];
};

export function Queue({
  sections,
  groupLabel,
  showGroup,
  showRepo,
  onOpen,
}: {
  sections: QueueSection[];
  groupLabel: (key: string) => string;
  showGroup: boolean;
  showRepo: boolean;
  onOpen: (pr: DerivedPr) => void;
}) {
  const visible = sections.filter((s) => s.prs.length > 0);
  if (visible.length === 0) {
    return (
      <div className="bg-panel border border-border rounded p-8 text-center text-sm text-muted">
        No pull requests match these filters.
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {visible.map((s) => (
        <section key={s.key}>
          <div
            className={`flex items-baseline gap-2 mb-2 ${
              s.tone === "danger" ? "border-l-2 border-danger-border pl-2" : ""
            }`}
          >
            <h2 className="text-sm font-semibold">{s.title}</h2>
            <span className="text-xs text-muted">{s.prs.length}</span>
            {s.hint && <span className="text-xs text-muted truncate">· {s.hint}</span>}
          </div>
          <div
            className={`bg-panel border rounded overflow-x-auto ${
              s.tone ? TONE_CLASSES[s.tone].split(" ")[0] : "border-border"
            }`}
          >
            <table className="w-full text-sm min-w-[760px]">
              <thead className="text-muted text-xs border-b border-border">
                <tr>
                  <th className="text-left font-normal px-3 py-2">Pull request</th>
                  <th className="text-left font-normal px-3 py-2 w-40">Stage</th>
                  <th className="text-left font-normal px-3 py-2 w-28">Turn</th>
                  <th className="text-left font-normal px-3 py-2 w-20">Waiting</th>
                  <th className="text-left font-normal px-3 py-2 w-36" title="Submitted a review, then anyone who only commented">Reviewers</th>
                </tr>
              </thead>
              <tbody>
                {s.prs.map((pr) => (
                  <tr
                    key={pr.id}
                    onClick={() => onOpen(pr)}
                    className="border-b border-border last:border-b-0 hover:bg-bg/60 cursor-pointer align-top"
                  >
                    <td className="px-3 py-2.5 min-w-0">
                      <div className="truncate max-w-[520px]" title={pr.title}>
                        <span className="text-muted font-mono text-xs mr-1.5">{showRepo ? pr.repo.split("/")[1] : ""}#{pr.number}</span>
                        {pr.title}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <Avatar login={pr.author} size={16} />
                        <span className="font-mono">@{pr.author}</span>
                        {showGroup && <span>· {groupLabel(pr.group)}</span>}
                        <span className="font-mono">
                          · <span className="text-ok-fg">+{pr.additions}</span>{" "}
                          <span className="text-danger-fg">−{pr.deletions}</span>
                        </span>
                        <PrBadges pr={pr} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <StagePill stage={pr.stage} />
                    </td>
                    <td className="px-3 py-2.5 text-xs" title={TURN_HINTS[pr.turn]}>
                      <span className={pr.onUs ? "text-fg" : "text-muted"}>{TURN_LABELS[pr.turn]}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <WaitChip pr={pr} />
                    </td>
                    <td className="px-3 py-2.5">
                      <ReviewActivity pr={pr} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
