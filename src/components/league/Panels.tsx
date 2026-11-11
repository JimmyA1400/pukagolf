"use client";

import { useState } from "react";

import {
  initials,
  shortName,
  type FeedItem,
  type Player,
  type TeeGroup,
} from "@/lib/demo-round";
import type { Score } from "@/lib/leaderboard";
import type { CoursePars } from "@/lib/scorecard";
import { playSkins } from "@/lib/skins";

export function Panel({
  icon,
  title,
  subtitle,
  right,
  children,
}: {
  icon: string;
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-hairline bg-card px-5 py-4">
      <header className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-bold">
            <span aria-hidden className="mr-2">
              {icon}
            </span>
            {title}
          </h3>
          {subtitle && (
            <div className="mt-0.5 font-mono text-xs text-ink-soft">
              {subtitle}
            </div>
          )}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

/** Reads as text; becomes an input once the admin is editing. */
function EditableText({
  value,
  onChange,
  editable,
  className = "",
  width = "6rem",
}: {
  value: string;
  onChange: (next: string) => void;
  editable: boolean;
  className?: string;
  width?: string;
}) {
  if (!editable) return <span className={className}>{value}</span>;

  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width }}
      className={`rounded-sm border border-dashed border-forest bg-cream px-1 focus:outline-2 focus:outline-forest ${className}`}
    />
  );
}

function LineItem({
  label,
  value,
  emphasis,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-hairline py-2 last:border-0">
      <span className="font-display text-[0.95rem]">{label}</span>
      <span
        className={`shrink-0 font-mono text-sm ${
          emphasis ? "font-bold text-clay" : "text-ink-soft"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function SkinsPot({
  players,
  groupIds,
  scores,
  pars,
  stake,
  enabled,
  onStakeChange,
  onEnabledChange,
  isAdmin,
  holeCount = 18,
  startHole = 1,
}: {
  players: readonly Player[];
  groupIds: readonly string[];
  scores: readonly Score[];
  pars: CoursePars;
  stake: number;
  enabled: boolean;
  onStakeChange: (next: number) => void;
  onEnabledChange: (next: boolean) => void;
  isAdmin: boolean;
  holeCount?: number;
  /** 10 for a back-nine week, where the game starts on hole 10. */
  startHole?: number;
}) {
  const game = playSkins(scores, groupIds, { stake, pars, holeCount, startHole });
  const nameOf = (id: string) =>
    shortName(players.find((p) => p.id === id)?.name ?? id);

  // Switched off and not the admin: the panel is absent, not merely empty.
  if (!enabled && !isAdmin) return null;

  if (!enabled) {
    return (
      <Panel
        icon="🏌"
        title="Skins"
        subtitle="Off for this round"
        right={
          <button
            type="button"
            onClick={() => onEnabledChange(true)}
            className="shrink-0 font-mono text-xs text-forest underline"
          >
            Turn on
          </button>
        }
      >
        <p className="py-2 font-mono text-sm text-ink-soft">
          Nobody sees a skins panel. Scores are untouched, so turning it back on
          restores the running pot exactly.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      icon="🏌"
      title="Skins pot — live"
      subtitle={
        <>
          ${isAdmin ? (
            <EditableText
              editable
              value={String(stake)}
              width="3rem"
              onChange={(next) => onStakeChange(Number(next.replace(/\D/g, "")) || 0)}
            />
          ) : (
            stake
          )}
          /hole · carries on a tie
        </>
      }
      right={
        isAdmin && (
          <button
            type="button"
            onClick={() => onEnabledChange(false)}
            className="shrink-0 font-mono text-xs text-ink-soft underline"
          >
            Turn off
          </button>
        )
      }
    >
      {game.holes.length === 0 ? (
        <p className="py-2 font-mono text-sm text-ink-soft">
          No holes settled yet.
        </p>
      ) : (
        game.holes.map((hole) => {
          if (hole.status === "in_progress") {
            return (
              <LineItem
                key={hole.hole}
                label={`Hole ${hole.hole} — in progress`}
                value={`$${hole.pot}`}
                emphasis
              />
            );
          }

          if (hole.status === "carried") {
            return (
              <LineItem
                key={hole.hole}
                label={`Hole ${hole.hole} (tied, carries)`}
                value="carry"
                emphasis
              />
            );
          }

          return (
            <LineItem
              key={hole.hole}
              label={`Hole ${hole.hole} (${hole.result})`}
              value={`${nameOf(hole.winnerId!)} — $${hole.pot}`}
              emphasis
            />
          );
        })
      )}
    </Panel>
  );
}

export function TeeSheet({
  groups,
  players,
  onChange,
  isAdmin,
  subtitle = "",
}: {
  groups: readonly TeeGroup[];
  players: readonly Player[];
  onChange: (id: string, patch: Partial<TeeGroup>) => void;
  isAdmin: boolean;
  /** The week and its group count. Used to be a hardcoded "Sat, Oct 3". */
  subtitle?: string;
}) {
  const describe = (group: TeeGroup) => {
    const names = group.playerIds
      .map((id) => shortName(players.find((p) => p.id === id)?.name ?? id))
      .map((name) => name.split(" ").at(-1))
      .join(", ");

    return `${group.label} — ${names}${group.open ? " · open slot" : ""}`;
  };

  return (
    <Panel
      icon="⛳"
      title="Tee sheet — this week"
      subtitle={subtitle}
    >
      {groups.map((group) => (
        <div
          key={group.id}
          className="flex items-center justify-between gap-3 border-b border-dashed border-hairline py-2.5 last:border-0"
        >
          <span
            className={`font-display text-[0.95rem] ${
              group.open ? "text-ink-soft" : ""
            }`}
          >
            {describe(group)}
          </span>

          <span className="shrink-0 bg-forest-deep px-2.5 py-1 font-mono text-xs text-cream">
            <EditableText
              editable={isAdmin}
              width="3.5rem"
              className="text-cream"
              value={group.time}
              onChange={(next) => onChange(group.id, { time: next })}
            />
          </span>
        </div>
      ))}
    </Panel>
  );
}

function ageLabel(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  return `${Math.round(minutes / 60)}h`;
}

export function ClubhouseFeed({
  items,
  players,
  viewerId,
  onPost,
  onDelete,
  isAdmin,
}: {
  items: readonly FeedItem[];
  players: readonly Player[];
  viewerId: string;
  onPost: (text: string) => void;
  onDelete: (id: string) => void;
  isAdmin: boolean;
}) {
  const [draft, setDraft] = useState("");
  const viewer = players.find((p) => p.id === viewerId);

  const post = () => {
    const text = draft.trim();
    if (text) onPost(text);
    setDraft("");
  };

  return (
    <Panel icon="💬" title="Clubhouse feed" subtitle="latest from the group">
      {/* Never left under the unsent bar (UnsentScores), tapped or not. */}
      <form
        data-keep-clear
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          post();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={140}
          placeholder={`Post as ${shortName(viewer?.name ?? "you")}…`}
          aria-label="Post to the clubhouse feed"
          className="min-w-0 flex-1 border border-hairline bg-cream px-3 py-2 font-mono text-xs focus:outline-2 focus:outline-forest"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="min-h-11 min-w-16 shrink-0 bg-forest-deep px-4 py-2 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          Post
        </button>
      </form>

      {items.length === 0 ? (
        <p className="py-2 font-mono text-sm text-ink-soft">Nothing yet.</p>
      ) : (
        items.map((item) => {
          const author = players.find((p) => p.id === item.authorId);
          const name = shortName(author?.name ?? item.authorId);

          return (
            <div
              key={item.id}
              className="flex items-center gap-3 border-b border-dashed border-hairline py-2.5 last:border-0"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sand font-mono text-[0.65rem] text-ink-soft">
                {initials(name)}
              </span>

              <p className="min-w-0 flex-1 font-display text-[0.95rem]">
                <span className="font-bold">{name}</span>{" "}
                <span className="text-ink-soft">{item.what}</span>{" "}
                <span className="font-mono text-xs text-ink-soft">
                  · {ageLabel(item.ageMinutes)}
                </span>
              </p>

              {isAdmin && (
                <button
                  type="button"
                  onClick={() => onDelete(item.id)}
                  aria-label={`Delete post by ${name}`}
                  className="shrink-0 font-mono text-xs text-clay hover:underline"
                >
                  delete
                </button>
              )}
            </div>
          );
        })
      )}
    </Panel>
  );
}
