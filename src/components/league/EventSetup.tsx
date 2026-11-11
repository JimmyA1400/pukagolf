"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { checkField, pairMatches, type FieldFix, type WarningKind } from "@/lib/formats/field";
import {
  formatLabel,
  formatsForSize,
  getFormat,
  PLAYABLE_SIZES,
  type FormatSpec,
} from "@/lib/formats/registry";
import { scoresFromEvent, teamsFromEvent, type Team } from "@/lib/formats/teams";
import { buildGameBoard, formatGameScore, type SideScore } from "@/lib/games";
import { createClient } from "@/lib/supabase/client";
import { useLeagueEvent, type LeagueEvent, type RosterEntry } from "@/lib/useLeagueEvent";
import { useClub } from "@/lib/club";

type Member = { id: string; name: string; handicapIndex: number | null };

/**
 * Setting an event up: who is playing, in what sides, under what game.
 *
 * The order is the one the admin thinks in — the roster first, because a
 * league event is people rather than a headcount, then the size, then the
 * game, then the sides, and last what the board becomes. Every step
 * recalculates the ones after it.
 *
 * Nothing here blocks. An uneven field is a fact about the evening, not a
 * mistake: the admin is told what it makes, offered the things that would
 * settle it, and left to decide. The event saves either way.
 */
export function EventSetup({ eventId }: { eventId: string }) {
  const { href } = useClub();
  const supabase = useMemo(() => createClient(), []);
  const {
    state,
    invite,
    addGuest,
    removePlayer,
    setAnswer,
    setTee,
    setFormat,
    setFlags,
    buildTeams,
    swapPlayers,
  } = useLeagueEvent(eventId);

  const [members, setMembers] = useState<Member[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Warnings the admin has set aside. Cleared whenever the field changes. */
  const [waived, setWaived] = useState<WarningKind[]>([]);
  /** The seat waiting for a partner to change places with. */
  const [picked, setPicked] = useState<string | null>(null);
  const rosterRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void supabase
      .from("profiles")
      .select("id, full_name, handicap_index")
      .order("full_name")
      .then(({ data }) =>
        setMembers(
          (data ?? []).map((p) => ({
            id: p.id,
            name: p.full_name,
            handicapIndex: p.handicap_index,
          })),
        ),
      );
  }, [supabase]);

  if (state.status === "loading") {
    return <Centered>Loading the event…</Centered>;
  }

  if (state.status === "error") {
    return (
      <Centered>
        <p>{state.message}</p>
        <Link href={href("/league/events")} className="mt-3 inline-block underline">
          League events
        </Link>
      </Centered>
    );
  }

  const { data, isAdmin } = state;
  const { event, roster, teams } = data;
  const spec = getFormat(event.formatId);

  const playing = roster.filter((r) => r.status === "in" || r.isGuest);
  const check = checkField({
    players: playing.length,
    teamSize: event.teamSize,
    format: spec,
  });
  const warnings = check.warnings.filter((w) => !waived.includes(w.kind));

  const uninvited = members.filter((m) => !roster.some((r) => r.profileId === m.id));

  // The sides in the shape the scoring engine reads them, so the board below
  // is drawn by the same code that will draw it on the day.
  const source = teamsFromEvent({
    eventId: event.id,
    teams: teams.map((t) => ({ id: t.id, name: t.name, position: t.position })),
    members: teams.flatMap((t) => t.memberIds.map((id) => ({ team_id: t.id, player_id: id }))),
    players: roster.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      profile_id: r.profileId,
      handicap_index: r.handicapIndex,
    })),
  });

  const seated = new Set(teams.flatMap((t) => t.memberIds));
  const leftOver = playing.filter((p) => !seated.has(p.id));

  /** Every action returns a refusal or null; this is the one place it shows. */
  const act = async (run: Promise<string | null>, done: string) => {
    setBusy(true);
    const refusal = await run;
    setBusy(false);
    setNotice(refusal ? { ok: false, text: refusal } : { ok: true, text: done });
  };

  /** Changing the field invalidates anything the admin had set aside. */
  const changeGame = (formatId: string, size: number, done: string) => {
    setWaived([]);
    setPicked(null);
    void act(setFormat(formatId, size), done);
  };

  const applyFix = (fix: FieldFix, kind: WarningKind) => {
    if (fix.kind === "team_size") {
      const next = formatsForSize(fix.size);
      const keep = next.some((f) => f.id === spec.id) ? spec.id : next[0].id;
      changeGame(keep, fix.size, `Sides of ${fix.size}.`);
      return;
    }

    if (fix.kind === "add_players") {
      rosterRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setNotice({
        ok: true,
        text: `Invite ${fix.count} more, or add ${fix.count === 1 ? "a guest" : "guests"}.`,
      });
      return;
    }

    // A bye and a blind draw are settled on the first tee, not in the
    // database. Setting the warning aside is the whole of what happens, and
    // saying so is better than a button that looks like it did more.
    setWaived((now) => [...now, kind]);
    setNotice({
      ok: true,
      text:
        fix.kind === "bye"
          ? "Set aside. Nothing is enforced — the bye is yours to give on the first tee."
          : "Set aside. A blind draw is played as you agree it; the board has no ghost score in it.",
    });
  };

  /** Tap one seat, tap another: they change places. */
  const tapSeat = (playerId: string) => {
    if (picked === null) return setPicked(playerId);
    if (picked === playerId) return setPicked(null);

    const a = roster.find((r) => r.id === picked);
    const b = roster.find((r) => r.id === playerId);
    const both = picked;
    setPicked(null);
    void act(
      swapPlayers(both, playerId),
      `${a?.name ?? "They"} and ${b?.name ?? "they"} changed places.`,
    );
  };

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-5 sm:p-8">
      <header>
        <Link href={href("/league/events")} className="font-mono text-xs underline">
          ← League events
        </Link>
        <p className="meta mt-2">Event setup</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">{event.name}</h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          {event.playedOn}
          {event.courseName && ` · ${event.courseName}`} · {event.holeCount} holes
          {event.isSimulator && " · simulator"}
        </p>
      </header>

      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`border bg-card px-4 py-3 font-mono text-xs break-words ${
            notice.ok ? "border-forest text-forest" : "border-clay text-clay"
          }`}
        >
          {notice.text}
        </p>
      )}

      <Step n={1} title="How many are playing" sectionRef={rosterRef}>
        <div className="border border-hairline bg-card p-4">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-display text-[2.6rem] leading-none font-bold tabular-nums">
              {playing.length}
            </span>
            <span className="min-w-[12ch] flex-1 font-mono text-xs text-ink-soft">
              No ceiling. Starts at the number who said they&rsquo;re in
              {roster.length > playing.length &&
                ` — ${roster.length - playing.length} of ${roster.length} invited haven’t`}
              .
            </span>
          </div>
        </div>

        {roster.length === 0 ? (
          <p className="mt-3 font-mono text-xs text-ink-soft">
            Nobody invited yet. Only the players you invite are in this event.
          </p>
        ) : (
          <ul className="mt-3 border border-hairline bg-card px-4">
            {roster.map((r) => (
              <RosterRow
                key={r.id}
                player={r}
                isAdmin={isAdmin}
                busy={busy}
                tees={data.tees.map((t) => t.tee)}
                onAnswer={(status) => {
                  setWaived([]);
                  void act(setAnswer(r.id, status), `${r.name} is ${status}.`);
                }}
                onTee={(tee) =>
                  void act(
                    setTee(r.id, tee),
                    tee ? `${r.name} played the ${tee} tees.` : `${r.name}'s tee cleared.`,
                  )
                }
                onRemove={() => {
                  setWaived([]);
                  void act(removePlayer(r.id), `${r.name} taken off.`);
                }}
              />
            ))}
          </ul>
        )}

        {isAdmin && (
          <div className="mt-3 space-y-3">
            <InviteControl
              members={uninvited}
              busy={busy}
              onInvite={(ids) => {
                setWaived([]);
                void act(invite(ids), `${ids.length} invited.`);
              }}
            />
            <GuestControl
              busy={busy}
              onAdd={(name, hcp) => {
                setWaived([]);
                void act(addGuest(name, hcp), `${name} is in as a guest.`);
              }}
            />
          </div>
        )}
      </Step>

      <Step n={2} title="Team size">
        <div role="group" aria-label="Team size" className="flex flex-wrap border border-hairline">
          {PLAYABLE_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              disabled={!isAdmin || busy}
              aria-pressed={event.teamSize === size}
              onClick={() => {
                const next = formatsForSize(size);
                const keep = next.some((f) => f.id === spec.id) ? spec.id : next[0].id;
                changeGame(keep, size, size === 1 ? "Each for themselves." : `Sides of ${size}.`);
              }}
              className={`min-h-12 flex-1 border-r border-hairline px-3 font-mono text-xs tracking-wider uppercase last:border-r-0 disabled:opacity-40 ${
                event.teamSize === size ? "bg-forest-deep text-cream" : "bg-card"
              }`}
            >
              {size === 1 ? "Individual" : `${size}-Man`}
            </button>
          ))}
        </div>
      </Step>

      <Step n={3} title="Format">
        <div className="grid gap-2">
          {formatsForSize(event.teamSize).map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={!isAdmin || busy}
              aria-pressed={option.id === spec.id}
              onClick={() =>
                changeGame(option.id, event.teamSize, `${formatLabel(option, event.teamSize)} it is.`)
              }
              className={`flex w-full gap-3 border bg-card px-3 py-3 text-left disabled:opacity-40 ${
                option.id === spec.id ? "border-forest ring-1 ring-forest" : "border-hairline"
              }`}
            >
              <span
                aria-hidden
                className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-forest ${
                  option.id === spec.id ? "bg-forest ring-2 ring-card ring-inset" : ""
                }`}
              />
              <span className="min-w-0">
                <span className="block font-display text-[0.98rem] font-bold">
                  {formatLabel(option, event.teamSize)}
                </span>
                <span className="block font-mono text-xs text-ink-soft">{option.blurb}</span>
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  <Tag tone="ball">{option.ball === "one" ? "one ball" : "own ball"}</Tag>
                  {option.counts > 1 && <Tag>{option.counts} count</Tag>}
                  <Tag>{option.scoring}</Tag>
                  {option.evenSides && <Tag>even sides</Tag>}
                </span>
              </span>
            </button>
          ))}
        </div>

        {warnings.map((w) => (
          <div key={w.kind} className="mt-3 border border-l-5 border-clay bg-card px-4 py-3">
            <p className="font-display text-base font-bold text-clay">{w.headline}</p>
            <p className="mt-0.5 font-mono text-xs">{w.message}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {w.fixes.map((fix, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={!isAdmin || busy}
                  onClick={() => applyFix(fix, w.kind)}
                  className="min-h-10 border border-forest bg-cream px-2.5 font-mono text-xs text-forest-deep disabled:opacity-40"
                >
                  {fixLabel(fix)}
                </button>
              ))}
            </div>
          </div>
        ))}

        {warnings.length === 0 && (
          <p className="mt-3 border border-l-5 border-forest bg-card px-4 py-3 font-mono text-xs text-forest-deep">
            {playing.length} playing →{" "}
            {event.teamSize === 1
              ? `${check.teams} in the field`
              : `${check.teams} sides of ${event.teamSize}`}
            , none left over. Ready for tee times.
          </p>
        )}
      </Step>

      <Step
        n={4}
        title={
          spec.scoring === "match"
            ? "Review the matches"
            : event.teamSize === 1
              ? "Review the field"
              : "Review the teams"
        }
      >
        <p className="mb-2.5 font-mono text-xs text-ink-soft">
          {teams.length === 0
            ? "Drafting spreads the handicaps so no side collects all the low numbers. Nothing is fixed — you can move anyone afterwards."
            : spec.scoring === "match"
              ? // No seats to tap here: a match is two sides, and moving one
                // player would change both. Drafting again re-pairs them.
                "Paired strongest against strongest, so the closest games are the ones that decide it. Draft again to re-pair."
              : event.teamSize === 1
                ? "Everyone plays their own ball. Tee times come next, in the flow you already have."
                : "Snake-drafted by handicap so no side gets all the low numbers. Tap a player, then tap another, to swap them."}
        </p>

        {isAdmin && (
          <button
            type="button"
            disabled={busy || playing.length < 2}
            onClick={() => {
              setPicked(null);
              void act(buildTeams(), "Sides drafted.");
            }}
            className="mb-3 min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
          >
            {teams.length > 0 ? "Draft them again" : "Draft the sides"}
          </button>
        )}

        {teams.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">No sides yet.</p>
        ) : spec.scoring === "match" ? (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {pairMatches(
              source.teams.map((t) => ({
                position: t.position,
                players: t.players.map((p) => ({
                  id: p.id,
                  name: p.name,
                  handicapIndex: p.handicapIndex,
                })),
              })),
            ).map((match) => (
              <div key={match.position} className="border border-hairline bg-card px-3 py-3">
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <span className="font-display text-[0.9rem]">
                    {match.home.players.map((p) => shortish(p.name)).join(" & ")}
                    <span className="meta mt-0.5 block">Match {match.position}</span>
                  </span>
                  <span className="meta">v</span>
                  <span className="text-right font-display text-[0.9rem]">
                    {match.away ? (
                      match.away.players.map((p) => shortish(p.name)).join(" & ")
                    ) : (
                      <span className="text-clay">bye</span>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {source.teams.map((team) => (
              <SideCard
                key={team.id}
                team={team}
                size={event.teamSize}
                picked={picked}
                disabled={!isAdmin || busy}
                onTap={tapSeat}
              />
            ))}

            {leftOver.length > 0 && (
              <article className="border border-hairline bg-card">
                <p className="flex items-baseline justify-between gap-2 bg-clay px-2.5 py-1.5 text-cream">
                  <span className="font-display text-[0.9rem] font-bold">Left over</span>
                  <span className="font-mono text-[0.66rem] tracking-wider">
                    {leftOver.length} waiting
                  </span>
                </p>
                <ul>
                  {leftOver.map((p) => (
                    <li key={p.id}>
                      <Seat
                        name={p.name}
                        handicap={p.handicapIndex}
                        ghost
                        picked={picked === p.id}
                        disabled={!isAdmin || busy}
                        onTap={() => tapSeat(p.id)}
                      />
                    </li>
                  ))}
                </ul>
              </article>
            )}
          </div>
        )}
      </Step>

      <Step badge="→" title="What the leaderboard becomes">
        <BoardPreview
          spec={spec}
          event={event}
          teams={source.teams}
          scores={data.scores}
          pars={data.pars}
          playing={playing.length}
        />
      </Step>

      {isAdmin && (
        <section className="space-y-3 border-t border-hairline pt-5">
          <Toggle
            label="Counts towards the season"
            hint="Off, an event is its own competition and still shows on every player's profile."
            on={event.countsForStandings}
            busy={busy}
            onChange={(v) =>
              void act(
                setFlags({ counts: v }),
                v ? "It counts towards the season." : "It stands on its own.",
              )
            }
          />
          <Toggle
            label="Simulator round"
            hint="A sim score is real, but it rolls perfectly. It moves a handicap by the league's simulator weight and is labelled everywhere."
            on={event.isSimulator}
            busy={busy}
            onChange={(v) =>
              void act(
                setFlags({ simulator: v }),
                v ? "Marked as a simulator round." : "Marked as outdoors.",
              )
            }
          />
          <p className="font-mono text-xs text-ink-soft">
            Tee times are set on the event page once the sides are settled.
            Sides go off in the order they were drafted.
          </p>
        </section>
      )}
    </main>
  );
}

/** What a fix offers to do, in the admin's words. */
function fixLabel(fix: FieldFix): string {
  switch (fix.kind) {
    case "add_players":
      return `Invite ${fix.count} more`;
    case "team_size":
      return `Use sides of ${fix.size}`;
    case "bye":
      return "Give them a bye";
    case "blind_draw":
      return "Blind draw";
  }
}

// -------------------------------------------------------------------- sides

function SideCard({
  team,
  size,
  picked,
  disabled,
  onTap,
}: {
  team: Team;
  size: number;
  picked: string | null;
  disabled: boolean;
  onTap: (playerId: string) => void;
}) {
  const known = team.players.filter((p) => p.handicapIndex !== null);
  const total = known.reduce((sum, p) => sum + (p.handicapIndex ?? 0), 0);

  return (
    <article className="border border-hairline bg-card">
      <p className="flex items-baseline justify-between gap-2 bg-forest-deep px-2.5 py-1.5 text-cream">
        <span className="font-display text-[0.9rem] font-bold">
          {size === 1 ? (team.players[0]?.name ?? team.name) : team.name}
        </span>
        <span className="font-mono text-[0.66rem] tracking-wider">
          {known.length === 0 ? "No index" : `HCP ${total.toFixed(1)}`}
        </span>
      </p>
      <ul>
        {team.players.map((p) => (
          <li key={p.id}>
            <Seat
              name={p.name}
              handicap={p.handicapIndex}
              picked={picked === p.id}
              disabled={disabled}
              onTap={() => onTap(p.id)}
            />
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * One player in a side.
 *
 * A button rather than a draggable row: this is used one-handed, outdoors,
 * sometimes with a glove on. Tap one, tap another, and they change places.
 */
function Seat({
  name,
  handicap,
  ghost = false,
  picked,
  disabled,
  onTap,
}: {
  name: string;
  handicap: number | null;
  ghost?: boolean;
  picked: boolean;
  disabled: boolean;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={picked}
      onClick={onTap}
      className={`flex min-h-11 w-full items-center justify-between gap-2 border-b border-dashed border-hairline px-2.5 py-2 text-left last:border-b-0 disabled:opacity-60 ${
        picked ? "bg-highlight" : ""
      }`}
    >
      <span className={`font-display text-[0.92rem] ${ghost ? "text-clay italic" : ""}`}>
        {name}
      </span>
      <span className="font-mono text-xs text-ink-soft tabular-nums">
        {handicap === null ? "—" : handicap.toFixed(1)}
      </span>
    </button>
  );
}

// -------------------------------------------------------------- leaderboard

/** The scoring rules buildGameBoard actually works out today. */
function ranksLive(spec: FormatSpec): boolean {
  return spec.counts === 1 && (spec.scoring === "strokes" || spec.scoring === "points");
}

/**
 * The board this format produces, from the sides that exist and the scores
 * posted so far.
 *
 * Drawn by buildGameBoard — the same call the live board makes — so this is
 * the board and not a picture of one. Where the engine hasn't learned a
 * scoring rule yet it says so, rather than showing stroke play under another
 * name and letting the admin find out on the day.
 */
function BoardPreview({
  spec,
  event,
  teams,
  scores,
  pars,
  playing,
}: {
  spec: FormatSpec;
  event: LeagueEvent;
  teams: readonly Team[];
  scores: readonly { teamId: string; playerId: string | null; hole: number; strokes: number }[];
  pars: Record<string, number>;
  playing: number;
}) {
  const size = event.teamSize;
  const live = ranksLive(spec);

  if (teams.length === 0) {
    return (
      <p className="font-mono text-xs text-ink-soft">
        Draft the sides and the board takes its shape. {legendFor(spec, size, event, playing)}
      </p>
    );
  }

  const parByHole = Object.fromEntries(
    Object.entries(pars).map(([hole, par]) => [Number(hole), par]),
  );

  const board = buildGameBoard({
    game: spec.id,
    sides: teams.map((t) => ({ id: t.id, playerIds: t.players.map((p) => p.id) })),
    scores: scoresFromEvent(scores, teams),
    pars: parByHole,
    holeCount: event.holeCount,
    startHole: event.startHole,
  });

  const nameOf = (id: string) => {
    const team = teams.find((t) => t.id === id);
    if (!team) return "Side";

    return size === 1
      ? (team.players[0]?.name ?? team.name)
      : team.players.map((p) => shortish(p.name)).join(", ");
  };

  const who = size === 1 ? "Player" : "Team";

  return (
    <>
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full border-collapse tabular-nums">
          {spec.scoring === "match" ? (
            <MatchBody board={board} nameOf={nameOf} />
          ) : spec.scoring === "skins" ? (
            <SkinsBody board={board} nameOf={nameOf} who={who} />
          ) : spec.scoring === "points" || spec.scoring === "nines" ? (
            <PointsBody
              board={board}
              nameOf={nameOf}
              who={who}
              live={live}
              unit={spec.scoring === "nines" ? "Nines" : "Points"}
            />
          ) : (
            <StrokesBody
              board={board}
              nameOf={nameOf}
              who={who}
              net={spec.scoring === "net"}
              live={live}
              formatId={spec.id}
              oneBall={spec.ball === "one" && size > 1}
            />
          )}
        </table>
      </div>

      <p className="mt-2.5 font-mono text-xs text-ink-soft">
        {legendFor(spec, size, event, playing)}
      </p>

      {!live && (
        <p className="mt-2 border border-l-5 border-clay bg-card px-4 py-3 font-mono text-xs text-clay">
          {spec.counts > 1
            ? "Two balls counting isn’t worked out yet, so that column is empty. Everything else is saved — the sides, the cards, the format."
            : `${spec.scoring} scoring isn’t worked out yet, so that column is left empty rather than filled with stroke play under another name. The sides, the cards and the format are all saved; it is the ranking that lands with the score entry.`}
        </p>
      )}
    </>
  );
}

function Head({ cells }: { cells: { label: string; right?: boolean; grow?: boolean }[] }) {
  return (
    <thead>
      <tr>
        {cells.map((cell) => (
          <th
            key={cell.label}
            // The same left padding the cells below carry, or two right-hand
            // columns of headings butt together and read as one word.
            className={`meta border-b border-hairline pb-2 font-normal whitespace-nowrap ${
              cell.right ? "pl-3 text-right" : "pr-3 text-left"
            } ${cell.grow ? "w-full" : ""}`}
          >
            {cell.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

const cellClass = "border-b border-dashed border-hairline py-2.5";
const whoClass = `${cellClass} pr-3 font-display text-[0.95rem]`;
const numClass = `${cellClass} pl-3 text-right font-mono text-sm`;

function MatchBody({
  board,
  nameOf,
}: {
  board: SideScore[];
  nameOf: (id: string) => string;
}) {
  const pairs: SideScore[][] = [];
  for (let i = 0; i < board.length; i += 2) pairs.push(board.slice(i, i + 2));

  return (
    <>
      <Head
        cells={[{ label: "Match" }, { label: "Side", grow: true }, { label: "Status", right: true }]}
      />
      <tbody>
        {pairs.map((pair, i) => (
          <tr key={pair[0].id}>
            <td className={`${cellClass} pr-3 font-mono text-sm`}>{i + 1}</td>
            <td className={whoClass}>
              {nameOf(pair[0].id)}
              <span className="block font-mono text-xs text-ink-soft">
                {pair[1] ? `v ${nameOf(pair[1].id)}` : "no opponent — a bye"}
              </span>
            </td>
            <td className={`${numClass} font-display font-bold`}>
              —
              <span className="block font-mono text-xs font-normal text-ink-soft">
                thru {pair[0].thru}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </>
  );
}

function SkinsBody({
  board,
  nameOf,
  who,
}: {
  board: SideScore[];
  nameOf: (id: string) => string;
  who: string;
}) {
  return (
    <>
      <Head
        cells={[
          { label: who, grow: true },
          { label: "Thru", right: true },
          { label: "Skins", right: true },
        ]}
      />
      <tbody>
        {board.map((row) => (
          <tr key={row.id}>
            <td className={whoClass}>{nameOf(row.id)}</td>
            <td className={numClass}>{row.thru}</td>
            <td className={`${numClass} font-bold`}>—</td>
          </tr>
        ))}
      </tbody>
    </>
  );
}

function PointsBody({
  board,
  nameOf,
  who,
  unit,
  live,
}: {
  board: SideScore[];
  nameOf: (id: string) => string;
  who: string;
  unit: string;
  live: boolean;
}) {
  return (
    <>
      <Head
        cells={[
          { label: who, grow: true },
          { label: "Thru", right: true },
          { label: unit, right: true },
        ]}
      />
      <tbody>
        {board.map((row) => (
          <tr key={row.id}>
            <td className={whoClass}>{nameOf(row.id)}</td>
            <td className={numClass}>{row.thru}</td>
            <td className={`${numClass} font-bold`}>
              {!live || row.thru === 0 ? "—" : (row.points ?? 0)}
            </td>
          </tr>
        ))}
      </tbody>
    </>
  );
}

function StrokesBody({
  board,
  nameOf,
  who,
  net,
  live,
  formatId,
  oneBall,
}: {
  board: SideScore[];
  nameOf: (id: string) => string;
  who: string;
  net: boolean;
  live: boolean;
  formatId: string;
  oneBall: boolean;
}) {
  return (
    <>
      <Head
        cells={[
          { label: who, grow: true },
          { label: "Thru", right: true },
          ...(net ? [{ label: "Gross", right: true }] : []),
          { label: net ? "Net" : "Score", right: true },
        ]}
      />
      <tbody>
        {board.map((row) => (
          <tr key={row.id}>
            <td className={whoClass}>
              {nameOf(row.id)}
              {oneBall && (
                <span className="block font-mono text-xs text-ink-soft">
                  one card for the side
                </span>
              )}
            </td>
            <td className={numClass}>{row.thru}</td>
            {net && <td className={numClass}>{row.thru === 0 ? "—" : row.strokes}</td>}
            <td
              className={`${numClass} font-bold ${
                live && row.toPar !== null && row.toPar < 0 ? "text-clay" : ""
              }`}
            >
              {live ? formatGameScore(row, formatId) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </>
  );
}

/** What this board means, in one line. */
function legendFor(spec: FormatSpec, size: number, event: LeagueEvent, playing: number): string {
  if (spec.scoring === "match") {
    return "Each match stands on its own. A side that closes one out shows the winning margin — 4 & 3 — instead of a running total.";
  }

  if (spec.scoring === "skins") {
    const stake = event.skinsStake || 0;

    return stake > 0
      ? `Stake is per player per hole, so the pot scales with the field: ${playing} playing at $${stake} puts $${stake * playing} on every hole, and a tie carries it into the next.`
      : "The lowest unique score takes the hole. A tie carries it into the next, so a halved hole is worth double.";
  }

  if (spec.scoring === "nines") {
    return "Nine points a hole, split 5 / 3 / 1 inside each threesome. Ties share, so two matching scores take 4 apiece.";
  }

  if (spec.scoring === "points") {
    return "Points against par, highest first. A blow-up hole costs you the hole, not the round.";
  }

  if (spec.ball === "one") {
    return "One score per side per hole, entered once by whoever has the phone. The card belongs to the team and not to a player, which is why it never reaches anyone’s index.";
  }

  if (spec.counts > 1) {
    return `The ${spec.counts} lowest cards on each hole add up. A hole waits until everyone on the side has posted it.`;
  }

  if (size > 1) {
    return "The lowest card on each hole counts. A hole waits until everyone on the side has posted it, so the board never walks backwards.";
  }

  return spec.scoring === "net"
    ? "Strokes less the handicap strokes each player gets, lowest first."
    : "Strokes against par, lowest first — the board you have today.";
}

// ------------------------------------------------------------------- roster

function RosterRow({
  player,
  isAdmin,
  busy,
  tees,
  onAnswer,
  onTee,
  onRemove,
}: {
  player: RosterEntry;
  isAdmin: boolean;
  busy: boolean;
  tees: string[];
  onAnswer: (status: "in" | "out" | "undecided") => void;
  onTee: (tee: string | null) => void;
  onRemove: () => void;
}) {
  // Without a rated set there is no differential, so the round shows on their
  // profile and never reaches their index. Say so rather than let it vanish.
  const needsTee = !player.isGuest && !player.playedTee;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-hairline py-2.5 last:border-b-0">
      <span className="min-w-0">
        <span className="block font-display text-base font-bold">
          {player.name}
          {player.isGuest && (
            <span className="ml-2 border border-hairline px-1.5 font-mono text-[0.6rem] tracking-wider text-ink-soft uppercase">
              Guest
            </span>
          )}
        </span>
        <span className="font-mono text-xs text-ink-soft">
          {player.handicapIndex === null ? "No index" : `HCP ${player.handicapIndex}`}
          {player.isGuest
            ? " · no account, so this round won't reach a handicap"
            : needsTee
              ? " · no tee set, so this round won't count towards their index"
              : ` · ${player.playedTee} tees`}
        </span>
      </span>

      <span className="flex items-center gap-2">
        {isAdmin && !player.isGuest && tees.length > 0 && (
          <select
            value={player.playedTee ?? ""}
            disabled={busy}
            onChange={(e) => onTee(e.target.value || null)}
            aria-label={`Tee ${player.name} played`}
            className={`min-h-9 border bg-cream px-2 font-mono text-xs ${
              needsTee ? "border-clay text-clay" : "border-hairline"
            }`}
          >
            <option value="">Tee?</option>
            {tees.map((tee) => (
              <option key={tee} value={tee}>
                {tee}
              </option>
            ))}
          </select>
        )}
        {isAdmin && !player.isGuest && (
          <select
            value={player.status ?? "undecided"}
            disabled={busy}
            onChange={(e) => onAnswer(e.target.value as "in" | "out" | "undecided")}
            aria-label={`${player.name}'s answer`}
            className="min-h-9 border border-hairline bg-cream px-2 font-mono text-xs"
          >
            <option value="in">In</option>
            <option value="out">Out</option>
            <option value="undecided">No answer</option>
          </select>
        )}
        {isAdmin && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="font-mono text-xs text-clay underline disabled:opacity-40"
          >
            Remove
          </button>
        )}
      </span>
    </li>
  );
}

function InviteControl({
  members,
  busy,
  onInvite,
}: {
  members: Member[];
  busy: boolean;
  onInvite: (ids: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);

  if (members.length === 0) {
    return (
      <p className="font-mono text-xs text-ink-soft">
        Everyone in the league is already on this roster.
      </p>
    );
  }

  return (
    <div className="border border-hairline bg-card p-3">
      <p className="meta mb-2">Invite from the league</p>
      <div className="flex flex-wrap gap-2">
        {members.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={picked.includes(m.id)}
            onClick={() =>
              setPicked((now) =>
                now.includes(m.id) ? now.filter((x) => x !== m.id) : [...now, m.id],
              )
            }
            className={`min-h-10 border px-2.5 font-mono text-xs ${
              picked.includes(m.id)
                ? "border-forest bg-forest-deep text-cream"
                : "border-hairline bg-cream"
            }`}
          >
            {m.name}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={busy || picked.length === 0}
        onClick={() => {
          onInvite(picked);
          setPicked([]);
        }}
        className="mt-3 min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
      >
        Invite {picked.length > 0 ? picked.length : ""}
      </button>
    </div>
  );
}

function GuestControl({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string, handicap: number | null) => void;
}) {
  const [name, setName] = useState("");
  const [hcp, setHcp] = useState("");

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd(name.trim(), hcp.trim() === "" ? null : Number(hcp));
        setName("");
        setHcp("");
      }}
      className="flex flex-wrap items-end gap-2 border border-hairline bg-card p-3"
    >
      <label className="min-w-[10rem] flex-1">
        <span className="meta mb-1 block">Add a guest</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm"
        />
      </label>
      <label className="w-24">
        <span className="meta mb-1 block">HCP</span>
        <input
          value={hcp}
          inputMode="decimal"
          onChange={(e) => setHcp(e.target.value)}
          className="min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
      >
        Add
      </button>
    </form>
  );
}

// ------------------------------------------------------------------- chrome

function Toggle({
  label,
  hint,
  on,
  busy,
  onChange,
}: {
  label: string;
  hint: string;
  on: boolean;
  busy: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-forest"
      />
      <span>
        <span className="block font-display text-[0.95rem] font-bold">{label}</span>
        <span className="block font-mono text-xs text-ink-soft">{hint}</span>
      </span>
    </label>
  );
}

function Step({
  n,
  badge,
  title,
  sectionRef,
  children,
}: {
  n?: number;
  /** For a step that isn't numbered, like the board the others produce. */
  badge?: string;
  title: string;
  sectionRef?: React.Ref<HTMLElement>;
  children: React.ReactNode;
}) {
  return (
    <section ref={sectionRef} className="scroll-mt-4">
      <div className="section-head mb-3.5 flex items-baseline gap-2.5 pb-1.5">
        <span className="bg-forest-deep px-2 py-0.5 font-mono text-xs font-bold text-cream">
          {badge ?? n}
        </span>
        <h2 className="text-xl">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Tag({
  children,
  tone = "plain",
}: {
  children: React.ReactNode;
  tone?: "plain" | "ball";
}) {
  return (
    <span
      className={`border px-1.5 font-mono text-[0.62rem] tracking-wider uppercase ${
        tone === "ball" ? "border-forest text-forest" : "border-hairline text-ink-soft"
      }`}
    >
      {children}
    </span>
  );
}

/** "Jamie Caddie" -> "Jamie C.", so a side fits on one line. */
function shortish(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);

  return last ? `${first} ${last[0]}.` : first;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}
