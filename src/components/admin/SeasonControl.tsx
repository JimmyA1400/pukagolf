"use client";

import { useMemo, useState } from "react";

import { useClub } from "@/lib/club";
import { createClient } from "@/lib/supabase/client";
import { useSeason } from "@/lib/useSeason";

/**
 * Closing out the season: crown the champion, and stop weeks being added to
 * that year by mistake. Reopening undoes both. Rained-out weeks are marked on
 * each week above.
 */
export function SeasonControl() {
  const leagueId = useClub().league?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const { state, reload } = useSeason();
  const [pick, setPick] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  if (state.status === "loading") {
    return <p className="font-mono text-xs text-ink-soft">Loading the season…</p>;
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="font-mono text-xs text-clay">
        {state.message}
      </p>
    );
  }

  const { season } = state;
  const ranked = season.standings.filter((r) => r.qualified);
  const leaders = ranked.filter((r) => r.position === 1);
  // The leader is the obvious pick once every counted week is final. While
  // one is still being played the table can change, so nobody is picked.
  const championId = pick || (season.provisional ? "" : leaders[0]?.playerId) || "";
  const champion = ranked.find((r) => r.playerId === championId) ?? null;
  const counted = season.weeks.filter((w) => w.counts).length;

  const act = async (
    call: () => PromiseLike<{ error: { message: string } | null }>,
    success: string,
  ) => {
    setBusy(true);
    const { error } = await call();
    setBusy(false);
    setConfirming(false);
    setNotice(error ? { ok: false, text: error.message } : { ok: true, text: success });
    if (!error) await reload();
  };

  return (
    <div className="space-y-3 border border-hairline bg-card p-4">
      {season.closed ? (
        <>
          <p className="font-display text-lg font-bold">The {season.year} season is closed.</p>
          <p className="font-mono text-xs text-ink-soft">
            Champion: {season.closed.championName ?? "none recorded"}. Closed{" "}
            {new Date(season.closed.closedAt).toLocaleDateString()}. No new weeks
            can be added to {season.year} while it&apos;s closed.
          </p>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-xs text-clay">
                Reopen {season.year}? {season.closed.championName ?? "The champion"} stops
                being the recorded champion, and you&apos;ll pick one again when you
                close it. No scores change.
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => supabase.rpc("owner_reopen_season", { in_league_id: leagueId, in_year: season.year }),
                    `The ${season.year} season is open again.`,
                  )
                }
                className="font-mono text-xs font-bold text-clay underline disabled:opacity-40"
              >
                Reopen it
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="font-mono text-xs text-ink-soft underline"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
              className="font-mono text-xs text-clay underline disabled:opacity-40"
            >
              Reopen the season
            </button>
          )}
        </>
      ) : (
        <>
          <p className="font-display text-lg font-bold">{season.year} season</p>
          <p className="font-mono text-xs text-ink-soft">
            {counted} {counted === 1 ? "week" : "weeks"} counted.{" "}
            {leaders.length > 0
              ? `${
                  season.provisional
                    ? "Current leader, provisional while a week is being played"
                    : leaders.length > 1
                      ? "Tied at the top"
                      : "Leading"
                }: ${leaders.map((l) => l.name).join(" & ")}, ${leaders[0].points} points.`
              : "Nobody is ranked yet."}
            {season.waiting.length > 0 &&
              ` Not counted yet: ${season.waiting.map((w) => w.name).join(", ")}.`}
          </p>

          {ranked.length > 0 && (
            <>
              <label className="block">
                <span className="meta mb-1 block">When you close the season, its champion is</span>
                <select
                  value={championId}
                  onChange={(e) => setPick(e.target.value)}
                  className="min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm"
                >
                  {championId === "" && <option value="">Pick the champion&hellip;</option>}
                  {ranked.map((r) => (
                    <option key={r.playerId} value={r.playerId}>
                      {r.position}. {r.name} · {r.points} pts
                    </option>
                  ))}
                </select>
              </label>

              {season.provisional && (
                <p className="font-mono text-xs text-clay">
                  A week is still being played, so these standings aren&apos;t final yet. Mark
                  it final before closing the season, or pick the champion yourself.
                </p>
              )}

              {confirming ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-clay">
                    Close {season.year} with {champion?.name} as champion? New weeks
                    can&apos;t be added to it until it&apos;s reopened.
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          supabase.rpc("owner_close_season", {
                            in_league_id: leagueId,
                            in_year: season.year,
                            in_champion_id: championId || null,
                          }),
                        `The ${season.year} season is closed. Congratulations, ${champion?.name}.`,
                      )
                    }
                    className="font-mono text-xs font-bold text-clay underline disabled:opacity-40"
                  >
                    Close it
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="font-mono text-xs text-ink-soft underline"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={championId === ""}
                  onClick={() => setConfirming(true)}
                  className="min-h-11 w-full border border-forest px-4 font-mono text-xs tracking-wider text-forest uppercase disabled:opacity-40"
                >
                  Close the season
                </button>
              )}
            </>
          )}
        </>
      )}

      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`font-mono text-xs ${notice.ok ? "text-forest" : "text-clay"}`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
