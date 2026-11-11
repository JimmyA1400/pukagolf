import { ScoreCell } from "@/components/ScoreCell";
import type { Player } from "@/lib/demo-round";
import { buildGameBoard, getGame, formatGameScore, sidesFor, type SideScore } from "@/lib/games";
import { roundHoles } from "@/lib/holes";
import { placeLabel, type Score } from "@/lib/leaderboard";
import type { CoursePars } from "@/lib/scorecard";

/** What a row is called: the player, or the side and who is on it. */
export type SideLabel = { title: string; note?: string };

/**
 * The week's board and what to call each row.
 *
 * One place works this out so the leader card, the table and the season
 * standings are all reading the same ranking.
 */
export function buildBoard({
  game = "stroke",
  players,
  scores,
  pars,
  holeCount,
  startHole = 1,
  groups = [],
  stableford,
  selfKept = [],
}: {
  game?: string;
  players: readonly Player[];
  scores: readonly Score[];
  pars: CoursePars;
  holeCount: number;
  startHole?: number;
  /** The week's tee times, which are the sides in a team game. */
  groups?: readonly { id: string; label: string; time: string; playerIds: readonly string[] }[];
  stableford?: readonly number[];
  /** Cards their own player kept, which nobody else attested: said under the name. */
  selfKept?: readonly string[];
}): { rows: SideScore[]; label: (row: SideScore) => SideLabel } {
  const rows = buildGameBoard({
    game,
    sides: sidesFor(
      game,
      players.map((p) => p.id),
      groups,
    ),
    scores,
    pars,
    holeCount,
    startHole,
    stableford,
  });

  const byId = new Map(players.map((p) => [p.id, p]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const label = (row: SideScore): SideLabel => {
    if (!getGame(game).team) {
      return {
        title: byId.get(row.id)?.name ?? "Player",
        ...(selfKept.includes(row.id) ? { note: "Kept own card" } : {}),
      };
    }

    const group = groupById.get(row.id);

    return {
      title: row.playerIds.map((id) => byId.get(id)?.short ?? "?").join(", "),
      note: group ? `${group.label} · ${group.time}` : "On their own",
    };
  };

  return { rows, label };
}

type LeaderboardProps = {
  /** Already ranked under the week's game — see src/lib/games.ts. */
  rows: readonly SideScore[];
  game: string;
  label: (row: SideScore) => SideLabel;
  pars: CoursePars;
  holeCount: number;
  viewerId: string;
  /** 10 for a back-nine week. */
  startHole?: number;
};

export function Leaderboard({
  rows,
  game,
  label,
  pars,
  holeCount,
  viewerId,
  startHole = 1,
}: LeaderboardProps) {
  const holes = roundHoles(holeCount, startHole);
  const points = getGame(game).rankedBy === "points";

  return (
    <>
      <PhoneBoard
        rows={rows}
        game={game}
        label={label}
        pars={pars}
        holes={holes}
        viewerId={viewerId}
      />
      <div className="-mx-1 hidden overflow-x-auto px-1 pb-2 sm:block">
        <table className="w-full min-w-[49rem] border-collapse text-left">
          <thead>
            <tr>
              <Th className="w-8" />
              <Th className="min-w-[9rem]">{getGame(game).team ? "Side" : "Player"}</Th>
              <Th className="pr-4 text-right">{points ? "Points" : "Score"}</Th>
              <Th className="pr-3 text-right">Thru</Th>
              {holes.map((hole) => (
                <Th key={hole} className="w-9 text-center">
                  {hole}
                </Th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const { title, note } = label(row);
              const isViewer = row.playerIds.includes(viewerId);
              // Under par is worth pointing out; a high Stableford score is too.
              const good = points ? false : row.toPar !== null && row.toPar < 0;

              return (
                <tr
                  key={row.id}
                  className={`border-b border-hairline/60 ${isViewer ? "bg-highlight" : ""}`}
                >
                  <td className="py-2 pr-1 text-center font-mono text-sm text-ink-soft">
                    {shownPlace(row, rows)}
                  </td>
                  <td className="py-2 pr-3 font-display text-[0.95rem] font-semibold whitespace-nowrap">
                    {title}
                    {note && (
                      <span className="block font-mono text-[0.7rem] font-normal text-ink-soft">
                        {note}
                      </span>
                    )}
                  </td>
                  <td
                    className={`py-2 pr-4 text-right font-mono text-sm font-bold tabular-nums ${
                      good ? "text-clay" : ""
                    }`}
                  >
                    {formatGameScore(row, game)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-sm tabular-nums text-ink-soft">
                    {row.thru}
                  </td>

                  {holes.map((hole) => (
                    <td key={hole} className="px-0 py-1 text-center">
                      <ScoreCell strokes={row.holes[hole] ?? null} par={pars[hole]} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The board on a phone: place, name and score on one line, with nothing to
 * scroll sideways. Tap a row for that card hole by hole. The full table,
 * with every hole in a column, is for wider screens.
 */
function PhoneBoard({
  rows,
  game,
  label,
  pars,
  holes,
  viewerId,
}: {
  rows: readonly SideScore[];
  game: string;
  label: (row: SideScore) => SideLabel;
  pars: CoursePars;
  holes: readonly number[];
  viewerId: string;
}) {
  const points = getGame(game).rankedBy === "points";
  // Nine to a line, so an 18-hole card is two rows of nine: out and in.
  const nines = [holes.slice(0, 9), holes.slice(9)].filter((nine) => nine.length > 0);

  return (
    <div className="sm:hidden">
      {/* A gap between the columns: in the fallback font "SCORE" and
          "THRU" met as one word. */}
      <div className="grid grid-cols-[2rem_1fr_auto_3rem] gap-x-3 border-b border-hairline pb-2 font-mono text-xs tracking-wider text-ink-soft uppercase">
        <span />
        <span>{getGame(game).team ? "Side" : "Player"}</span>
        <span className="text-right">{points ? "Points" : "Score"}</span>
        <span className="text-right">Thru</span>
      </div>
      <ol aria-label="Leaderboard">
        {rows.map((row) => {
          const { title, note } = label(row);
          const isViewer = row.playerIds.includes(viewerId);
          const good = points ? false : row.toPar !== null && row.toPar < 0;

          return (
            <li
              key={row.id}
              className={`border-b border-hairline/60 ${isViewer ? "bg-highlight" : ""}`}
            >
              <details className="group">
                <summary
                  aria-label={`${shownPlace(row, rows)}. ${title}, ${formatGameScore(row, game)}, thru ${row.thru}`}
                  className="grid min-h-12 cursor-pointer list-none grid-cols-[2rem_1fr_auto_3rem] items-center gap-x-3 py-2 [&::-webkit-details-marker]:hidden"
                >
                  <span className="text-center font-mono text-sm text-ink-soft">{shownPlace(row, rows)}</span>
                  <span className="min-w-0 pr-2 font-display text-[0.95rem] font-semibold">
                    <span className="block truncate">{title}</span>
                    {note && (
                      <span className="block truncate font-mono text-[0.7rem] font-normal text-ink-soft">
                        {note}
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-right font-mono text-base font-bold tabular-nums ${
                      good ? "text-clay" : ""
                    }`}
                  >
                    {formatGameScore(row, game)}
                  </span>
                  <span className="text-right font-mono text-sm tabular-nums text-ink-soft">
                    {row.thru}
                  </span>
                </summary>
                <div className="space-y-1 pb-3 pl-8">
                  {nines.map((nine) => (
                    <div key={nine[0]} className="grid grid-cols-9 gap-0.5">
                      {nine.map((hole) => (
                        <span key={hole} className="flex flex-col items-center">
                          <span className="font-mono text-[0.6rem] text-ink-soft">{hole}</span>
                          <ScoreCell size="sm" strokes={row.holes[hole] ?? null} par={pars[hole]} />
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {rows.length > 0 && (
        <p className="mt-2 font-mono text-xs text-ink-soft">Tap a name for the card hole by hole.</p>
      )}
    </div>
  );
}

type LeaderCardProps = {
  rows: readonly SideScore[];
  game: string;
  label: (row: SideScore) => SideLabel;
  holeCount: number;
  /**
   * Appended after the hole number, e.g. "Fairway · 168yd to pin". Nothing in
   * the app produces this — it needs shot-level tracking, which we don't store.
   */
  lie?: string;
  /** 10 for a back-nine week, so "Hole 12" is the hole they're on. */
  startHole?: number;
};

export function LeaderCard({
  rows,
  game,
  label,
  holeCount,
  lie,
  startHole = 1,
}: LeaderCardProps) {
  const [leader] = rows;

  if (!leader) return null;

  const { title, note } = label(leader);

  return (
    <div className="border border-hairline bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            {title}
          </h3>
          <p className="mt-1 font-mono text-sm text-ink-soft">
            {note && `${note} · `}
            {leader.thru >= holeCount
              ? "Finished"
              : `Hole ${startHole + leader.thru}${lie ? ` · ${lie}` : ""}`}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <div className="font-display text-4xl font-bold text-clay sm:text-5xl">
            {formatGameScore(leader, game)}
          </div>
          <p className="meta mt-1">Thru {leader.thru}</p>
        </div>
      </div>
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`border-b border-hairline pb-2 font-mono text-xs font-normal tracking-wider text-ink-soft uppercase ${className}`}
    >
      {children}
    </th>
  );
}

/**
 * A row's place as the board shows it: "—" until the player has a hole in,
 * so a field that hasn't started isn't "T1" all the way down. Ties are
 * counted among those who have started.
 */
function shownPlace(row: SideScore, rows: readonly SideScore[]): string {
  if (row.thru === 0) return "—";

  return placeLabel(
    row.position,
    rows.filter((r) => r.thru > 0).map((r) => r.position),
  );
}
