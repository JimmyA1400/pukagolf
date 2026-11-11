"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import { formatLabel, getFormat } from "@/lib/formats/registry";
import { buildGameBoard, formatGameScore } from "@/lib/games";
import { scoresFromEvent, teamsFromEvent, type EventScoreRow } from "@/lib/formats/teams";
import { roundHoles } from "@/lib/holes";
import { createClient } from "@/lib/supabase/client";

type TeamEvent = {
  eventId: string;
  name: string;
  playedOn: string;
  courseName: string | null;
  formatId: string;
  teamSize: number;
  holeCount: number;
  startHole: number;
  isSimulator: boolean;
  myTeamId: string;
  pars: Record<string, number>;
  teams: {
    id: string;
    name: string | null;
    position: number;
    members: { id: string; name: string }[];
  }[];
  scores: EventScoreRow[];
};

/**
 * Events the player played on a side.
 *
 * Kept apart from their rounds, because a side's card is not their round —
 * that is exactly why a scramble never reaches their handicap. What belongs
 * on a profile is the result: who they played with, and where the side came.
 *
 * The ranking is worked out here by the same engine that draws the event
 * leaderboard, from the event's own scores, so a profile cannot put a side in
 * a different place from the event itself.
 */
export function TeamEventResults({ playerId }: { playerId: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const [events, setEvents] = useState<TeamEvent[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!playerId) return;

    const { data } = await supabase.rpc("player_team_events", {
      in_player_id: playerId,
    });

    setEvents((data as unknown as TeamEvent[]) ?? []);
  }, [supabase, playerId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!events || events.length === 0) return null;

  return (
    <section>
      <h2 className="section-head mb-3 pb-2 text-xl">Team events</h2>
      <div className="space-y-2">
        {events.map((event) => (
          <Result
            key={event.eventId}
            event={event}
            open={openId === event.eventId}
            onToggle={() => setOpenId(openId === event.eventId ? null : event.eventId)}
          />
        ))}
      </div>
    </section>
  );
}

function Result({
  event,
  open,
  onToggle,
}: {
  event: TeamEvent;
  open: boolean;
  onToggle: () => void;
}) {
  const spec = getFormat(event.formatId);
  const pars = Object.fromEntries(
    Object.entries(event.pars).map(([hole, par]) => [Number(hole), par]),
  );

  // The side list and the scores, in the shapes the engine reads.
  const source = teamsFromEvent({
    eventId: event.eventId,
    teams: event.teams.map((t) => ({ id: t.id, name: t.name, position: t.position })),
    members: event.teams.flatMap((t) =>
      t.members.map((m) => ({ team_id: t.id, player_id: m.id })),
    ),
    players: event.teams.flatMap((t) =>
      t.members.map((m, i) => ({ id: m.id, name: m.name, position: i })),
    ),
  });

  const board = buildGameBoard({
    game: event.formatId,
    sides: source.teams.map((t) => ({ id: t.id, playerIds: t.players.map((p) => p.id) })),
    scores: scoresFromEvent(event.scores, source.teams),
    pars,
    holeCount: event.holeCount,
    startHole: event.startHole,
  });

  const mine = board.find((row) => row.id === event.myTeamId);
  const side = source.teams.find((t) => t.id === event.myTeamId);
  const ranked = board.filter((row) => row.thru > 0).length;
  const holes = roundHoles(event.holeCount, event.startHole);

  return (
    <div className="border border-hairline bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-[0.95rem] font-semibold">
            {event.name}
          </span>
          <span className="block font-mono text-xs text-ink-soft">
            {event.playedOn}
            {event.courseName && ` · ${event.courseName}`} ·{" "}
            {formatLabel(spec, event.teamSize)}
            {event.isSimulator && " · sim"}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block font-display text-lg font-bold">
            {mine && mine.position > 0 ? ordinal(mine.position) : "—"}
          </span>
          <span className="block font-mono text-xs text-ink-soft">
            {ranked > 0 ? `of ${ranked}` : "no scores"}
          </span>
        </span>

        <span
          className={`w-10 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${
            mine && mine.toPar !== null && mine.toPar < 0 ? "text-clay" : ""
          }`}
        >
          {mine ? formatGameScore(mine, event.formatId) : "—"}
        </span>
      </button>

      {open && (
        <div className="border-t border-hairline px-4 py-3">
          <p className="mb-2 font-mono text-xs text-ink-soft">
            {side ? side.players.map((p) => p.name).join(", ") : "Side unknown"}
            {spec.ball === "one" &&
              " — one ball between you, so this is the side's card, not yours."}
          </p>

          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[38rem] border-collapse text-center">
              <thead>
                <tr>
                  <th className="pb-1 text-left font-mono text-[0.65rem] font-normal text-ink-soft">
                    Hole
                  </th>
                  {holes.map((hole) => (
                    <th
                      key={hole}
                      className="pb-1 font-mono text-[0.65rem] font-normal text-ink-soft"
                    >
                      {hole}
                    </th>
                  ))}
                  <th className="pb-1 text-right font-mono text-[0.65rem] font-normal text-ink-soft">
                    Tot
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-left font-mono text-[0.7rem] font-bold">Par</td>
                  {holes.map((hole) => (
                    <td key={hole} className="font-mono text-[0.7rem] font-bold tabular-nums">
                      {pars[hole] ?? "–"}
                    </td>
                  ))}
                  <td className="text-right font-mono text-[0.7rem] font-bold tabular-nums">
                    {holes.reduce((sum, hole) => sum + (pars[hole] ?? 0), 0) || "–"}
                  </td>
                </tr>
                <tr>
                  <td className="text-left font-mono text-[0.7rem]">Side</td>
                  {holes.map((hole) => (
                    <td key={hole} className="py-0.5">
                      <ScoreCell
                        strokes={mine?.holes[hole] ?? null}
                        par={pars[hole]}
                        size="sm"
                      />
                    </td>
                  ))}
                  <td className="text-right font-mono text-sm font-bold tabular-nums">
                    {mine?.strokes || "–"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {board.length > 1 && (
            <ol className="mt-3 border-t border-dashed border-hairline pt-2">
              {board
                .filter((row) => row.thru > 0)
                .map((row) => {
                  const them = source.teams.find((t) => t.id === row.id);

                  return (
                    <li
                      key={row.id}
                      className={`flex items-baseline justify-between gap-3 py-1 font-mono text-xs ${
                        row.id === event.myTeamId ? "font-bold" : "text-ink-soft"
                      }`}
                    >
                      <span className="min-w-0 truncate">
                        {row.position}.{" "}
                        {them?.players.map((p) => shortish(p.name)).join(", ") ?? "Side"}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatGameScore(row, event.formatId)}
                      </span>
                    </li>
                  );
                })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** 1st, 2nd, 3rd, 4th — including the teens, which break the pattern. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;

  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "Jamie Caddie" -> "Jamie C.", so a side fits on one line. */
function shortish(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);

  return last ? `${first} ${last[0]}.` : first;
}
