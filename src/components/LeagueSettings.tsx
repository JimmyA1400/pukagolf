"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Announcement } from "@/components/league/Announcement";
import { useClub } from "@/lib/club";
import { createClient } from "@/lib/supabase/client";
import { teeGaps } from "@/lib/teetimes";

type Settings = { skins: boolean; firstTee: string; interval: number };


/**
 * League-wide switches, for the owner.
 *
 * Skins could already be turned off for one week from the 19th Hole tab; this
 * turns them off for the whole league. Off, the pot, the Skins tab and the
 * season skins column disappear for everyone, and no week pays out — but no
 * score is touched, so turning it back on restores everything as it was.
 *
 * The tee time defaults seed "Build groups" and the re-time form on Groups &
 * tee times; the announcement is the banner at the top of the league page.
 */
export function LeagueSettings() {
  const leagueId = useClub().league?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [firstTee, setFirstTee] = useState("08:00");
  const [interval, setGap] = useState(10);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("league_rules")
      .select("skins_enabled, first_tee_time, tee_interval_minutes")
      .eq("league_id", leagueId)
      .maybeSingle();

    const next = {
      skins: data?.skins_enabled ?? true,
      firstTee: (data?.first_tee_time ?? "08:00").slice(0, 5),
      interval: data?.tee_interval_minutes ?? 10,
    };

    setSettings(next);
    setFirstTee(next.firstTee);
    setGap(next.interval);
  }, [supabase, leagueId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const act = async (
    call: () => PromiseLike<{ error: { message: string } | null }>,
    success: string,
  ) => {
    setBusy(true);
    const { error } = await call();
    setBusy(false);
    setNotice(error ? { ok: false, text: error.message } : { ok: true, text: success });
    if (!error) await load();
  };

  const skins = settings?.skins ?? null;

  return (
    <div className="space-y-3">
      <div className="border border-hairline bg-card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-base font-bold">Skins</p>
            <p className="font-mono text-xs text-ink-soft">
              {skins === null
                ? "Loading…"
                : skins
                  ? "On for the league. Each week can still be switched off on its own."
                  : "Off for the whole league. Nobody sees a pot, a bracket or season skins."}
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-label="Skins for the league"
            aria-checked={skins === true}
            disabled={busy || skins === null}
            onClick={() =>
              void act(
                () => supabase.rpc("owner_set_league_skins", { in_league_id: leagueId, in_enabled: !skins }),
                skins ? "Skins are off for the league." : "Skins are on for the league.",
              )
            }
            className={`min-h-10 border px-4 font-mono text-xs tracking-wider uppercase disabled:opacity-40 ${
              skins ? "border-forest bg-forest-deep text-cream" : "border-hairline"
            }`}
          >
            {skins ? "On" : "Off"}
          </button>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            () =>
              supabase.rpc("admin_set_tee_defaults", {
                in_league_id: leagueId,
                in_first_tee: firstTee,
                in_interval: interval,
              }),
            "Tee time defaults saved.",
          );
        }}
        className="space-y-3 border border-hairline bg-card px-4 py-3"
      >
        <div>
          <p className="font-display text-base font-bold">Tee times</p>
          <p className="font-mono text-xs text-ink-soft">
            Where a new week&apos;s groups start, and how far apart they go.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="meta mb-1 block">First tee time</span>
            <input
              type="time"
              value={firstTee}
              onChange={(e) => setFirstTee(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="meta mb-1 block">Minutes apart</span>
            <select
              value={interval}
              onChange={(e) => setGap(Number(e.target.value))}
              className={inputClass}
            >
              {teeGaps(interval)
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={
            busy ||
            !firstTee ||
            (settings !== null && firstTee === settings.firstTee && interval === settings.interval)
          }
          className="min-h-10 border border-forest px-4 font-mono text-xs tracking-wider text-forest uppercase disabled:opacity-40"
        >
          Save defaults
        </button>
      </form>

      <Announcement canEdit manage />

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

const inputClass =
  "min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest";
