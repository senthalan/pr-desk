import type { DerivedPr, Stage, Turn } from "../lib/derive";
import { STAGE_HINTS, STAGE_LABELS } from "../lib/derive";
import type { RawPrEvent } from "../lib/snapshot";

export type Tone = "neutral" | "info" | "violet" | "ok" | "warn" | "danger";

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-border bg-bg text-muted",
  info: "border-info-border bg-info-bg text-info-fg",
  violet: "border-violet-border bg-violet-bg text-violet-fg",
  ok: "border-ok-border bg-ok-bg text-ok-fg",
  warn: "border-warn-border bg-warn-bg text-warn-fg",
  danger: "border-danger-border bg-danger-bg text-danger-fg",
};

export const STAGE_TONE: Record<Stage, Tone> = {
  new: "info",
  on_author: "neutral",
  updated: "violet",
  approved: "ok",
  approved_conflict: "danger",
  conflict: "warn",
  draft: "neutral",
};

export const TURN_LABELS: Record<Turn, string> = {
  reviewer: "Reviewer",
  maintainer: "Maintainer",
  team: "Us — can edit",
  author: "Author",
  none: "—",
};

export const TURN_HINTS: Record<Turn, string> = {
  reviewer: "Waiting on a reviewer",
  maintainer: "Waiting on a maintainer to merge",
  team: "Maintainers can push to this branch, so we can resolve the conflict ourselves",
  author: "Waiting on the PR author",
  none: "",
};

export function Pill({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] leading-none ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function StagePill({ stage }: { stage: Stage }) {
  return (
    <Pill tone={STAGE_TONE[stage]} title={STAGE_HINTS[stage]}>
      {STAGE_LABELS[stage]}
    </Pill>
  );
}

export function formatSpan(days: number | null): string {
  if (days == null) return "—";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 10) return `${days.toFixed(1).replace(/\.0$/, "")}d`;
  return `${Math.round(days)}d`;
}

export function formatHours(h: number | null): string {
  return h == null ? "—" : formatSpan(h / 24);
}

export function WaitChip({ pr }: { pr: DerivedPr }) {
  if (pr.sla) {
    const tone: Tone = pr.sla === "breach" ? "danger" : pr.sla === "warn" ? "warn" : "ok";
    return (
      <Pill
        tone={tone}
        title={`${pr.waitingBusinessDays?.toFixed(1)} business days waiting · target ${pr.slaDays}d · ${formatSpan(pr.waitingDays)} calendar`}
      >
        {formatSpan(pr.waitingBusinessDays)}
      </Pill>
    );
  }
  return (
    <Pill tone="neutral" title={pr.onUs ? "Waiting" : "Calendar days in the author's court"}>
      {formatSpan(pr.waitingDays)}
    </Pill>
  );
}

export function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  if (login.startsWith("team/")) {
    return (
      <span
        title={`@${login}`}
        className="inline-flex items-center justify-center rounded-full bg-border text-[9px] text-muted"
        style={{ width: size, height: size }}
      >
        T
      </span>
    );
  }
  return (
    <img
      src={`https://github.com/${login}.png?size=${size * 2}`}
      alt=""
      title={`@${login}`}
      width={size}
      height={size}
      loading="lazy"
      className="rounded-full bg-border shrink-0"
      style={{ width: size, height: size }}
    />
  );
}

export function AvatarStack({ logins, max = 4 }: { logins: string[]; max?: number }) {
  if (logins.length === 0) return <span className="text-xs text-muted">none</span>;
  return (
    <span className="inline-flex items-center">
      {logins.slice(0, max).map((l, i) => (
        <span key={l} className={i > 0 ? "-ml-1.5" : ""}>
          <Avatar login={l} size={20} />
        </span>
      ))}
      {logins.length > max && <span className="ml-1 text-xs text-muted">+{logins.length - max}</span>}
    </span>
  );
}

// Everyone on the review side, including pending requests. Used by the
// Reviewer filter so "my queue" also finds PRs I've been asked to review;
// the Reviewers column shows only `pr.reviewers`.
export function reviewSide(pr: DerivedPr): string[] {
  return Array.from(new Set([...pr.approvers, ...pr.reviewers, ...pr.requestedReviewers]));
}

export function PrBadges({ pr }: { pr: DerivedPr }) {
  const b = pr.badges;
  return (
    <>
      {pr.stage === "approved_conflict" && pr.maintainerCanModify && (
        <Pill tone="danger" title={TURN_HINTS.team}>we can rebase</Pill>
      )}
      {b.wasApproved && (
        <Pill tone="ok" title="This PR was approved before; the approval was dismissed or superseded by a later update">
          was approved
        </Pill>
      )}
      {b.conflictResolved && (
        <Pill tone="info" title="The conflict was resolved since a reviewer last looked">conflict resolved</Pill>
      )}
      {b.rebased && !b.conflictResolved && (
        <Pill tone="info" title="Force-pushed or merged the base branch after the last review">rebased</Pill>
      )}
      {b.pushedAfterApproval && pr.stage !== "approved_conflict" && (
        <Pill tone="warn" title="New commits landed after the approval">pushed after approval</Pill>
      )}
      {b.changesRequested && pr.stage !== "on_author" && (
        <Pill tone="warn" title="At least one reviewer's latest review requests changes">changes requested</Pill>
      )}
      {(pr.ciState === "FAILURE" || pr.ciState === "ERROR") && (
        <Pill tone="danger" title="Latest commit's checks failed">CI failing</Pill>
      )}
      {pr.mergeableUnknown && (
        <Pill tone="neutral" title="GitHub hadn't finished computing mergeability when this was fetched">
          merge status pending
        </Pill>
      )}
    </>
  );
}

export function eventLabel(e: RawPrEvent, author: string): { text: string; side: "author" | "reviewer" | "system" } {
  const isAuthor = "actor" in e && e.actor?.toLowerCase() === author.toLowerCase();
  switch (e.kind) {
    case "commit":
      return { text: e.merge ? "Merged the base branch in" : "Pushed a commit", side: "author" };
    case "force_push":
      return { text: `Force-pushed${e.actor ? ` (@${e.actor})` : ""}`, side: "author" };
    case "review": {
      const verb =
        e.state === "APPROVED"
          ? "Approved"
          : e.state === "CHANGES_REQUESTED"
            ? "Requested changes"
            : e.state === "DISMISSED"
              ? "Reviewed (later dismissed)"
              : "Reviewed";
      return { text: `${verb} — @${e.actor}`, side: isAuthor ? "author" : "reviewer" };
    }
    case "comment":
      return { text: `Commented — @${e.actor}`, side: isAuthor ? "author" : "reviewer" };
    case "ready":
      return { text: "Marked ready for review", side: "system" };
    case "dismissed":
      return {
        text: `Review dismissed${e.previousState ? ` (was ${e.previousState.toLowerCase().replace("_", " ")})` : ""}`,
        side: "system",
      };
  }
}

export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
