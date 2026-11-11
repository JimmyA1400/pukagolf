"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useClub } from "@/lib/club";
import { createClient } from "@/lib/supabase/client";

type Choice = {
  id: string;
  name: string;
  status: "active" | "requested" | "removed" | null;
  /** The day its latest week was played, "Thursday"; missing before any week. */
  day?: string | null;
  /** Its first tee time, "17:00". */
  firstTee?: string | null;
  /** The course of its latest week. */
  course?: string | null;
};

/** "Thursdays · first tee 5:00 PM · Practice Ridge Course", or what's known of it. */
export function whenAndWhere(choice: Pick<Choice, "day" | "firstTee" | "course">): string {
  const parts: string[] = [];
  // The day comes from the league's weeks; before the first one, say so.
  parts.push(choice.day ? `${choice.day}s` : "No weeks yet");
  if (choice.firstTee) {
    const [h, m] = choice.firstTee.split(":").map(Number);
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    parts.push(`first tee ${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`);
  }
  if (choice.course) parts.push(choice.course);

  return parts.join(" · ");
}

/**
 * A member who isn't in a league yet: the club's leagues, and a way to ask
 * for one. The pro shop puts players in leagues; asking only tells them.
 */
export function AskForLeague() {
  const { club } = useClub();

  return (
    <main className="mx-auto w-full max-w-md p-6 sm:p-8">
      <p className="meta">{club.name}</p>
      <h1 className="font-display text-2xl font-bold">You&apos;re not in a league yet</h1>
      <p className="mt-2 font-mono text-sm text-ink-soft">
        The pro shop puts players in leagues. Ask for one and they&apos;ll see it.
      </p>

      <LeagueChoices clubId={club.id} clubName={club.name} />
    </main>
  );
}

/**
 * The club's leagues, each with where the member stands: playing, asked, or
 * a button to ask. Asking goes to the pro shop, who approve it like any
 * request; nobody is put in a league by asking.
 *
 * `othersOnly` leaves out the leagues the member already plays in, for the
 * league page, and shows nothing at all when there is nothing else to ask for.
 */
export function LeagueChoices({
  clubId,
  clubName,
  othersOnly = false,
  exclude,
  intro,
}: {
  clubId: string;
  clubName: string;
  othersOnly?: boolean;
  /** The league being looked at, left out of a list of the others. */
  exclude?: string;
  /** A heading and a line above the list, shown only when the list is. */
  intro?: React.ReactNode;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { club, reloadClub } = useClub();
  // A club admin puts players in leagues, themselves included, so asking
  // their own pro shop would be asking themselves.
  const isAdmin = club.role === "admin";
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("club_league_choices", { in_club_id: clubId });
    if (error) setMessage(error.message);
    setChoices((data as unknown as Choice[]) ?? []);
  }, [supabase, clubId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const ask = async (league: Choice) => {
    setMessage(null);
    const { error } = await supabase.rpc("league_request_join", { in_league_id: league.id });
    if (error) {
      setMessage(error.message);
      return;
    }
    await load();
  };

  const addMe = async (league: Choice) => {
    setMessage(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.rpc("league_set_member", {
      in_league_id: league.id,
      in_profile_id: user.id,
      in_playing: true,
    });
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage(`You're in ${league.name} now. Pick it from the league list above to see it.`);
    await Promise.all([load(), reloadClub()]);
  };

  const shown = (
    othersOnly ? (choices ?? []).filter((c) => c.status !== "active") : choices
  )?.filter((c) => c.id !== exclude) ?? null;

  if (othersOnly && (!shown || shown.length === 0) && !message) return null;

  return (
    <div className={intro ? "min-w-0" : "mt-6"}>
      {intro}
      {shown === null && <p className="font-mono text-sm text-ink-soft">Loading…</p>}

      {shown?.length === 0 && (
        <p className="font-mono text-sm text-ink-soft">{clubName} hasn&apos;t started a league yet.</p>
      )}

      {shown && shown.length > 0 && (
        <ul className="border-t border-hairline">
          {shown.map((league) => (
            <li
              key={league.id}
              className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline py-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-display text-lg font-bold">{league.name}</span>
                {whenAndWhere(league) && (
                  <span className="block font-mono text-xs text-ink-soft">{whenAndWhere(league)}</span>
                )}
              </span>
              {league.status === "active" ? (
                <span className="font-mono text-xs whitespace-nowrap text-ink-soft">You play</span>
              ) : league.status === "requested" ? (
                <span className="basis-full font-mono text-xs text-forest">
                  Asked. The pro shop will add you, and the league shows up in your league
                  list when they do.
                </span>
              ) : isAdmin ? (
                <button
                  type="button"
                  onClick={() => void addMe(league)}
                  className="min-h-11 px-2 font-mono text-xs whitespace-nowrap text-forest underline"
                >
                  Add me
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void ask(league)}
                  className="min-h-11 px-2 font-mono text-xs whitespace-nowrap text-forest underline"
                >
                  Ask to play
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {message && (
        <p role="alert" className="mt-4 border border-clay bg-card px-4 py-3 font-mono text-xs text-clay">
          {message}
        </p>
      )}
    </div>
  );
}
