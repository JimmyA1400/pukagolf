"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";

import { getFormat, teamHoles, type Entry } from "@/lib/formats";
import { createClient } from "@/lib/supabase/client";
import { useEvent, type EventState } from "@/lib/useEvent";

import { teamLabel } from "./EventPanels";

/**
 * Remembers the unlocked admin token for this event on this device.
 *
 * The token, not the PIN: the PIN is exchanged once and never stored, so a
 * borrowed phone leaks access to one event that can be revoked, rather than the
 * secret itself.
 */
const tokenKey = (share: string) => `golf.event.${share}.admin`;

function readAdminToken(share: string): string | null {
  try {
    return sessionStorage.getItem(tokenKey(share));
  } catch {
    return null;
  }
}

function writeAdminToken(share: string, token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(tokenKey(share));
    else sessionStorage.setItem(tokenKey(share), token);
  } catch {
    // Not remembering just means unlocking again.
  }
}

export function EventAdmin({ token }: { token: string }) {
  const supabase = useMemo(() => createClient(), []);
  const { state, reload } = useEvent(token);
  const [adminToken, setAdminToken] = useState<string | null>(() =>
    readAdminToken(token),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedOut, setLockedOut] = useState(false);

  const run = useCallback(
    async (fn: string, args: Record<string, unknown>) => {
      const { error } = await supabase.rpc(
        fn as never,
        {
          admin_token: adminToken,
          ...args,
        } as never,
      );

      if (error) {
        // A PIN change from All outings issues a new admin token, so the one
        // this device remembers stops working. Ask for the PIN again rather
        // than failing every action with the same message.
        if (error.code === "42501" || /Not unlocked/.test(error.message)) {
          writeAdminToken(token, null);
          setAdminToken(null);
          setLockedOut(true);
          return;
        }

        setNotice(error.message);
        return;
      }

      setNotice(null);
      await reload();
    },
    [supabase, adminToken, reload, token],
  );

  if (state.status === "loading") return <Centered>Loading…</Centered>;
  if (state.status === "error") return <Centered>{state.message}</Centered>;

  const { data } = state;

  if (!adminToken) {
    return (
      <>
        {lockedOut && (
          <p
            role="alert"
            className="border-b border-clay bg-card px-4 py-3 text-center font-mono text-xs text-clay sm:px-8"
          >
            This outing&apos;s admin PIN was changed. Enter the new one to
            carry on.
          </p>
        )}
        <PinGate
          eventName={data.event.name}
          token={token}
          onUnlocked={(unlocked) => {
            writeAdminToken(token, unlocked);
            setAdminToken(unlocked);
            setLockedOut(false);
          }}
        />
      </>
    );
  }

  return (
    <div className="min-w-0">
      <header className="border-b-4 border-rule bg-cream px-4 py-4 sm:px-8">
        <p className="meta">Admin</p>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {data.event.name}
        </h1>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline pt-3">
          <Link
            href={`/event/${token}`}
            className="font-mono text-xs underline"
          >
            ← Back to scoring
          </Link>
          <button
            type="button"
            onClick={() => {
              writeAdminToken(token, null);
              setAdminToken(null);
            }}
            className="font-mono text-xs text-ink-soft underline"
          >
            Lock
          </button>
        </div>
      </header>

      <main className="min-w-0 space-y-8 bg-sand px-4 py-6 sm:px-8">
        {notice && (
          <p
            role="alert"
            className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
          >
            {notice}
          </p>
        )}

        <CompleteEvent data={data} run={run} />
        <SkinsEditor data={data} onSet={run} />
        <TeeTimeEditor data={data} onSet={run} />
        <PlayerEditor data={data} onSet={run} />
        <ScoreEditor data={data} onSet={run} />
      </main>
    </div>
  );
}

type Runner = (fn: string, args: Record<string, unknown>) => Promise<void>;

function PinGate({
  eventName,
  token,
  onUnlocked,
}: {
  eventName: string;
  token: string;
  onUnlocked: (adminToken: string) => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { data, error: rpcError } = await createClient().rpc(
      "event_admin_unlock",
      { token, pin },
    );

    setBusy(false);

    if (rpcError) {
      setError(rpcError.message);
      setPin("");
      return;
    }

    onUnlocked(data as unknown as string);
  };

  return (
    <main className="mx-auto w-full max-w-sm space-y-5 p-6 sm:p-8">
      <div>
        <p className="meta">Admin</p>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {eventName}
        </h1>
      </div>

      <form onSubmit={unlock} className="space-y-3">
        <label className="block">
          <span className="meta mb-1 block">8-digit PIN</span>
          <input
            value={pin}
            onChange={(e) =>
              setPin(e.target.value.replace(/\D/g, "").slice(0, 8))
            }
            inputMode="numeric"
            autoComplete="off"
            placeholder="••••••••"
            className="min-h-14 w-full border border-hairline bg-cream px-3 text-center font-display text-2xl tracking-widest tabular-nums focus:outline-2 focus:outline-forest"
          />
        </label>

        {error && (
          <p role="alert" className="font-mono text-xs text-clay">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || pin.length !== 8}
          className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>

      <p className="font-mono text-xs text-ink-soft">
        The PIN was shown once when the outing was created. It can&apos;t be
        looked up — only its hash is stored.
      </p>
    </main>
  );
}

/**
 * Close the event out once every team's card is full.
 *
 * The check is per TEAM, not per player: a scramble posts one score per hole
 * for the whole team, so counting player cards would never reach the hole
 * count and the button would never enable.
 */
function CompleteEvent({ data, run }: { data: EventState; run: Runner }) {
  const holes = data.event.hole_count;

  const short = data.teams
    .map((team) => ({
      team,
      posted: new Set(
        data.scores.filter((s) => s.teamId === team.id).map((s) => s.hole),
      ).size,
    }))
    .filter((t) => t.posted < holes);

  const everyoneIn = data.teams.length > 0 && short.length === 0;

  return (
    <section>
      <div className="section-head mb-3 flex items-baseline justify-between pb-2">
        <h2 className="text-xl">Finish</h2>
        <span className="meta">
          {everyoneIn ? "All cards full" : `${short.length} still open`}
        </span>
      </div>

      <div className="border border-hairline bg-card p-4">
        {short.length > 0 && (
          <ul className="mb-3">
            {short.map(({ team, posted }) => (
              <li
                key={team.id}
                className="flex justify-between border-b border-dashed border-hairline py-1.5 font-mono text-xs last:border-0"
              >
                <span className="font-display text-[0.95rem]">
                  {teamLabel(data, team.id)}
                </span>
                <span className="text-ink-soft tabular-nums">
                  {posted} of {holes}
                </span>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          disabled={!everyoneIn}
          onClick={() => void run("event_admin_complete", { force: false })}
          className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
        >
          Complete outing
        </button>

        {short.length > 0 && (
          <button
            type="button"
            onClick={() => void run("event_admin_complete", { force: true })}
            className="mt-2 min-h-11 w-full border border-hairline px-4 font-mono text-xs tracking-wider uppercase hover:border-clay"
          >
            Complete anyway — someone walked in
          </button>
        )}
      </div>
    </section>
  );
}

/** Common stakes as one-tap buttons, with a free field for anything else. */
const STAKE_PRESETS = [0, 5, 10, 20, 30, 50];

function SkinsEditor({ data, onSet }: { data: EventState; onSet: Runner }) {
  const enabled = data.event.skins_enabled;
  const stake = data.event.skins_stake;

  const set = (nextEnabled: boolean, nextStake: number) =>
    void onSet("event_admin_set_skins", {
      in_enabled: nextEnabled,
      in_stake: nextStake,
    });

  return (
    <section>
      <div className="section-head mb-3 flex items-baseline justify-between pb-2">
        <h2 className="text-xl">Skins</h2>
        <span className="meta">{enabled ? `$${stake} a hole` : "Off"}</span>
      </div>

      <div className="border border-hairline bg-card p-4">
        <button
          type="button"
          onClick={() => set(!enabled, stake)}
          aria-pressed={enabled}
          className={`min-h-12 w-full border font-mono text-xs tracking-wider uppercase transition-colors ${
            enabled
              ? "border-forest bg-forest text-cream"
              : "border-hairline bg-cream"
          }`}
        >
          {enabled
            ? "Skins on — tap to turn off"
            : "Skins off — tap to turn on"}
        </button>

        {enabled && (
          <>
            <p className="meta mt-4 mb-2">Stake per hole</p>

            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {STAKE_PRESETS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => set(true, amount)}
                  aria-pressed={stake === amount}
                  className={`min-h-12 border font-display text-lg font-bold transition-colors ${
                    stake === amount
                      ? "border-forest bg-forest text-cream"
                      : "border-hairline bg-cream hover:border-forest"
                  }`}
                >
                  ${amount}
                </button>
              ))}
            </div>

            <label className="mt-3 block">
              <span className="meta mb-1 block">Or set your own</span>
              <input
                type="number"
                min={0}
                max={1000}
                inputMode="numeric"
                defaultValue={stake}
                key={stake}
                onBlur={(e) => {
                  const next = Number(e.target.value);
                  if (!Number.isInteger(next) || next === stake) return;

                  set(true, next);
                }}
                className="min-h-12 w-full border border-hairline bg-cream px-3 text-center font-mono text-sm tabular-nums focus:outline-2 focus:outline-forest"
              />
            </label>
          </>
        )}

        <p className="mt-3 font-mono text-xs text-ink-soft">
          Turning skins off hides the panel for everyone on the link. Scores
          already entered are untouched, so turning it back on restores the
          running pot exactly.
        </p>
      </div>
    </section>
  );
}

function TeeTimeEditor({ data, onSet }: { data: EventState; onSet: Runner }) {
  return (
    <section>
      <h2 className="section-head mb-3 pb-2 text-xl">Tee times</h2>

      {data.teeTimes.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">No tee times set.</p>
      ) : (
        <div className="space-y-2">
          {data.teeTimes.map((slot) => (
            <div
              key={slot.id}
              className="flex items-center justify-between gap-3 border border-hairline bg-card px-4 py-3"
            >
              <span className="min-w-0 truncate font-display text-[0.95rem]">
                {slot.teamIds.map((id) => teamLabel(data, id)).join(" · ")}
              </span>

              <label className="shrink-0">
                <span className="sr-only">Tee time</span>
                <input
                  type="time"
                  defaultValue={to24Hour(slot.teeAt)}
                  onBlur={(e) =>
                    void onSet("event_admin_set_tee_time", {
                      in_tee_time_id: slot.id,
                      in_tee_at: e.target.value,
                    })
                  }
                  className="min-h-11 border border-hairline bg-cream px-2 font-mono text-sm"
                />
              </label>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PlayerEditor({ data, onSet }: { data: EventState; onSet: Runner }) {
  return (
    <section>
      <h2 className="section-head mb-3 pb-2 text-xl">Players</h2>

      <div className="divide-y divide-hairline border border-hairline bg-card">
        {data.players.map((player) => (
          <div key={player.id} className="px-4 py-2">
            <label className="block">
              <span className="sr-only">Name</span>
              <input
                defaultValue={player.name}
                onBlur={(e) => {
                  if (e.target.value.trim() === player.name) return;

                  void onSet("event_admin_rename_player", {
                    in_player_id: player.id,
                    in_name: e.target.value,
                  });
                }}
                className="min-h-11 w-full bg-transparent font-display text-[0.95rem] focus:outline-2 focus:outline-forest"
              />
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoreEditor({ data, onSet }: { data: EventState; onSet: Runner }) {
  const spec = getFormat(data.event.format);
  const [teamId, setTeamId] = useState(data.teams[0]?.id ?? "");

  const team = data.teams.find((t) => t.id === teamId);
  const holes = team
    ? teamHoles(
        data.event.format,
        data.scores as Entry[],
        team.id,
        team.memberIds,
        data.event.hole_count,
      )
    : [];

  // In a scramble the team owns one card; otherwise each player has their own.
  const [playerId, setPlayerId] = useState<string | null>(null);
  const target =
    spec.entry === "team" ? null : (playerId ?? team?.memberIds[0] ?? null);

  const scoreFor = (hole: number) =>
    data.scores.find(
      (s) =>
        s.teamId === teamId &&
        s.hole === hole &&
        (spec.entry === "team" ? s.playerId === null : s.playerId === target),
    )?.strokes ?? "";

  return (
    <section>
      <h2 className="section-head mb-3 pb-2 text-xl">Scores</h2>

      <div className="mb-3 flex flex-wrap gap-2">
        <label>
          <span className="sr-only">Team</span>
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setPlayerId(null);
            }}
            className="min-h-11 border border-hairline bg-cream px-2 font-mono text-xs"
          >
            {data.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {teamLabel(data, t.id)}
              </option>
            ))}
          </select>
        </label>

        {spec.entry === "player" && team && (
          <label>
            <span className="sr-only">Player</span>
            <select
              value={target ?? ""}
              onChange={(e) => setPlayerId(e.target.value)}
              className="min-h-11 border border-hairline bg-cream px-2 font-mono text-xs"
            >
              {team.memberIds.map((id) => (
                <option key={id} value={id}>
                  {data.players.find((p) => p.id === id)?.name ?? id}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-9">
        {holes.map((cell) => (
          <label key={cell.hole} className="block text-center">
            <span className="block font-mono text-[0.6rem] text-ink-soft">
              {cell.hole}
            </span>
            <input
              type="number"
              min={1}
              max={20}
              inputMode="numeric"
              defaultValue={scoreFor(cell.hole)}
              key={`${teamId}-${target}-${cell.hole}-${scoreFor(cell.hole)}`}
              onBlur={(e) => {
                const strokes = Number(e.target.value);
                if (!e.target.value || !Number.isInteger(strokes)) return;

                void onSet("event_admin_set_score", {
                  in_team_id: teamId,
                  in_player_id: target,
                  in_hole: cell.hole,
                  in_strokes: strokes,
                });
              }}
              className="mt-0.5 min-h-11 w-full border border-hairline bg-cream text-center font-mono text-sm tabular-nums focus:outline-2 focus:outline-forest"
            />
          </label>
        ))}
      </div>
    </section>
  );
}

/** "8:10a" -> "08:10" for a native time input. */
function to24Hour(label: string): string {
  const match = /^(\d{1,2}):(\d{2})([ap])$/i.exec(label);
  if (!match) return "";

  const [, rawHour, minute, meridiem] = match;
  let hour = Number(rawHour);
  const pm = meridiem.toLowerCase() === "p";

  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;

  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}
