"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel } from "./Panels";
import { finalQuestion, finalWarnings, localToday } from "@/lib/final-week";
import { createClient } from "@/lib/supabase/client";

type Completion = {
  holeCount: number;
  players: { playerId: string; name: string; posted: number }[];
};

/**
 * Close out a round once every card is full.
 *
 * A round only counts toward a handicap when it is final, so this is the moment
 * the scoring record changes — worth being deliberate about rather than
 * inferring from the last score entered.
 */
export function CompleteRound({
  roundId,
  roundName,
  playedOn,
  status,
  onCompleted,
}: {
  roundId: string;
  roundName: string;
  playedOn: string;
  status: "setup" | "live" | "final";
  onCompleted: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Asked first: completing makes the points official and locks every card.
  const [asking, setAsking] = useState<boolean>(false);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc("round_completion", {
      in_round_id: roundId,
    });

    setCompletion(data as unknown as Completion);
  }, [supabase, roundId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const complete = async (force: boolean) => {
    setBusy(true);
    const { error } = await supabase.rpc("complete_round", {
      in_round_id: roundId,
      force,
    });
    setBusy(false);

    if (error) {
      setNotice(error.message);
      return;
    }

    setNotice(null);
    onCompleted();
  };

  if (status === "final") {
    return (
      <Panel icon="🏁" title="Round complete" subtitle="Counts toward handicaps">
        <p className="py-2 font-mono text-sm text-ink-soft">
          Scores are final and included in every player&apos;s scoring record.
        </p>
      </Panel>
    );
  }

  const short = (completion?.players ?? []).filter(
    (p) => p.posted < (completion?.holeCount ?? 0),
  );
  const everyoneIn = completion !== null && short.length === 0 &&
    completion.players.length > 0;
  const warnings = finalWarnings({
    playedOn,
    status,
    holeCount: completion?.holeCount ?? 0,
    open: short,
    today: localToday(),
  });

  return (
    <Panel
      icon="🏁"
      title="Complete round"
      subtitle={
        completion === null
          ? "Checking cards…"
          : everyoneIn
            ? "Every card is full"
            : `${short.length} card${short.length === 1 ? "" : "s"} still open`
      }
    >
      {notice && (
        <p role="alert" className="mb-2 font-mono text-xs text-clay">
          {notice}
        </p>
      )}

      {short.length > 0 && (
        <ul className="mb-3">
          {short.map((player) => (
            <li
              key={player.playerId}
              className="flex justify-between border-b border-dashed border-hairline py-1.5 last:border-0 font-mono text-xs"
            >
              <span className="font-display text-[0.95rem]">{player.name}</span>
              <span className="text-ink-soft tabular-nums">
                {player.posted} of {completion?.holeCount}
              </span>
            </li>
          ))}
        </ul>
      )}

      {asking ? (
        <div role="alert" className="space-y-2 border-2 border-clay bg-cream px-3 py-3">
          <p className="font-mono text-xs text-clay">{finalQuestion(roundName)}</p>
          {warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 font-mono text-xs text-clay">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void complete(short.length > 0)}
              className="min-h-12 flex-1 bg-clay px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
            >
              {busy ? "Completing…" : warnings.length > 0 ? "Make it final anyway" : "Make it final"}
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="min-h-12 flex-1 border border-hairline px-4 font-mono text-xs tracking-wider uppercase"
            >
              Not yet
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setAsking(true)}
            disabled={busy || !everyoneIn}
            className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
          >
            Complete round
          </button>

          {short.length > 0 && (
            <button
              type="button"
              onClick={() => setAsking(true)}
              disabled={busy}
              className="mt-2 min-h-11 w-full border border-hairline px-4 font-mono text-xs tracking-wider uppercase hover:border-clay"
            >
              Complete anyway — someone walked in
            </button>
          )}
        </>
      )}

      <p className="mt-3 font-mono text-xs text-ink-soft">
        Completing makes the scores final and adds the round to every
        player&apos;s handicap record.
      </p>
    </Panel>
  );
}
