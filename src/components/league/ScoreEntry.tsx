"use client";

import { useEffect, useState } from "react";

import { BigScorer } from "@/components/league/BigScorer";
import { useOnline } from "@/components/league/UnsentScores";
import { Scorecard } from "@/components/Scorecard";
import { shortName, type Player } from "@/lib/demo-round";
import { getGame } from "@/lib/games";
import { formatToPar, type Score } from "@/lib/leaderboard";
import type { CoursePars, ScorecardExtras } from "@/lib/scorecard";
import {
  assignedTo,
  cardKeeper,
  keptBy,
  PARTNER_OWN_CARD,
  type Assignment,
  type ScoringMode,
} from "@/lib/scoring-rules";
import {
  lockedWhen,
  lockReasons,
  lowerFirst,
  lockSummary,
  lockWarning,
  type CardLock,
  type LockReason,
} from "@/lib/card-locks";
import type { CardHistoryEntry } from "@/lib/useLiveRound";

/** This phone's choice of scoring view. */
const VIEW_KEY = "pukagolf:score-view";

type ScoreEntryProps = {
  players: readonly Player[];
  scores: readonly Score[];
  pars: CoursePars;
  holeCount: number;
  /** 10 for a back-nine week. */
  startHole?: number;
  assignments: readonly Assignment[];
  viewerId: string;
  /** A club admin: fixes any card, and is the only one who changes a signed-off one. */
  isAdmin: boolean;
  /** Staff the admin has let fix scores. Defaults to isAdmin. */
  canFix?: boolean;
  /** Who enters scores in this league. */
  mode?: ScoringMode;
  /** Cards signed off or locked. Nobody but a club admin changes these. */
  lockedIds?: readonly string[];
  /** Yardage and stroke index per hole, shared by every card shown here. */
  extras?: ScorecardExtras;
  /** The week's game. A scramble is kept as one card for the whole side. */
  game?: string;
  /** The viewer's tee time, which is their side in a team game. */
  team?: { id: string; label: string; playerIds: readonly string[] } | null;
  /** Returns a refusal message, or null when the score was accepted. */
  onSubmit: (targetId: string, hole: number, strokes: number) => string | null;
  /** One score for the whole side, in a scramble. */
  onSubmitTeam?: (hole: number, strokes: number) => string | null;
  /** The group signs its cards. Resolves to a refusal, or null. */
  onSignOff?: (teeTimeId: string) => Promise<string | null>;
  /** A club admin locks or unlocks a card. Resolves to a refusal, or null. */
  onSetLock?: (playerId: string, locked: boolean) => Promise<string | null>;
  /**
   * A club admin takes back the sign-off of the group a card is in, with a
   * reason in a final week. Resolves to a refusal, or null.
   */
  onTakeBack?: (playerId: string, reason?: string) => Promise<string | null>;
  /** Every group this week, for saying whose cards a sign-off covers. */
  groups?: readonly { id: string; playerIds: readonly string[] }[];
  /** Every change to a card, for a club admin, or a refusal. */
  onHistory?: (playerId: string) => Promise<CardHistoryEntry[] | string>;
  /** Players in the week with no login, who can't keep anybody's card. */
  noLogin?: readonly string[];
  /** The week is in a season the league has closed. */
  seasonClosed?: boolean;
  /** The week is marked final, which locks every card in it. */
  weekFinal?: boolean;
  /** Cards locked on their own: signed by the group or locked by an admin, and by whom. */
  cardLocks?: Readonly<Record<string, CardLock>>;
  /** A club admin changes a signed-off card, saying why. Resolves to a refusal, or null. */
  onFixSigned?: (
    playerId: string,
    hole: number,
    strokes: number,
    reason: string,
  ) => Promise<string | null>;
  /** Handicap strokes each player gets, by hole, in a net week: dots on the card. */
  strokesReceived?: Readonly<Record<string, Readonly<Record<number, number>>>>;
  /** Cards kept by their own player, every hole: flagged, as nobody else attested them. */
  selfKept?: readonly string[];
  /** Hole scores still on this phone. The group signs once they're all up. */
  unsent?: number;
  /** Which holes are still on this phone, so a change is never called saved before it goes. */
  waiting?: readonly { playerId: string; hole: number }[];
  /** The league's pick-up rule: the pad stops a hole at double par. */
  doubleParCap?: boolean;
};


export function ScoreEntry({
  players,
  scores,
  pars,
  holeCount,
  startHole = 1,
  assignments,
  viewerId,
  isAdmin,
  canFix = isAdmin,
  mode = "partner",
  lockedIds = [],
  extras,
  game,
  team,
  onSubmit,
  onSubmitTeam,
  onSignOff,
  onSetLock,
  onTakeBack,
  groups = [],
  onHistory,
  noLogin = [],
  seasonClosed = false,
  weekFinal = false,
  cardLocks = {},
  onFixSigned,
  strokesReceived,
  selfKept = [],
  unsent = 0,
  waiting = [],
  doubleParCap = true,
}: ScoreEntryProps) {
  const [refusal, setRefusal] = useState<string | null>(null);
  // What the fix-any-card editor was refused, said beside it rather than at
  // the top of the page, out of sight of the card being fixed.
  const [fixRefusal, setFixRefusal] = useState<string | null>(null);
  // Taking back a sign-off asks first, naming every card it opens, and in a
  // final week, why.
  const [askTakeBack, setAskTakeBack] = useState(false);
  const [takeBackWhy, setTakeBackWhy] = useState("");
  // Said back once it's done, beside the card: the caption changing is easy
  // to miss.
  const [takenBack, setTakenBack] = useState<{ playerId: string; text: string } | null>(null);
  // Nobody's card to start: one stray tap shouldn't change a live card.
  const [adminTarget, setAdminTarget] = useState("");
  // Whose card this phone is on, when it keeps more than one.
  const [chosen, setChosen] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // The last change made from the fix-any-card editor, said back, since the
  // grid itself gives no sign a number was taken. Not "Saved" while it is
  // still on this phone: offline, it hasn't gone anywhere yet.
  const [saved, setSaved] = useState<{
    playerId: string;
    hole: number;
    strokes: number;
    withReason?: boolean;
  } | null>(null);
  const savedText = (change: NonNullable<typeof saved>) =>
    waiting.some((w) => w.playerId === change.playerId && w.hole === change.hole)
      ? `Hole ${change.hole}: ${change.strokes}, not sent yet. It goes by itself when there\u2019s signal.`
      : `Saved: hole ${change.hole} is ${change.strokes}${change.withReason ? ", with your reason" : ""}.`;
  // Hole by hole unless this phone has asked for the full card before.
  const [fullCard, setFullCard] = useState(false);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFullCard(localStorage.getItem(VIEW_KEY) === "card");
    } catch {
      // Blocked storage: hole by hole, every time.
    }
  }, []);

  // A "no signal" refusal is out of date the moment the signal is back.
  useEffect(() => {
    const stale = (now: string | null) => (now && /no signal/i.test(now) ? null : now);
    const clear = () => {
      setRefusal(stale);
      setFixRefusal(stale);
    };
    window.addEventListener("online", clear);
    return () => window.removeEventListener("online", clear);
  }, []);

  const toggleView = () => {
    const next = !fullCard;
    setFullCard(next);
    try {
      if (next) localStorage.setItem(VIEW_KEY, "card");
      else localStorage.removeItem(VIEW_KEY);
    } catch {
      // As above.
    }
  };

  const nameOf = (id: string) =>
    shortName(players.find((p) => p.id === id)?.name ?? id);
  const cardFor = (id: string) => scores.filter((s) => s.playerId === id);

  // Every reason a card can't be changed. A card listed as locked with no
  // record of how is treated as signed, as it was before that was recorded.
  const reasonsFor = (id: string): LockReason[] =>
    lockReasons({
      cardLock:
        cardLocks[id] ?? (lockedIds.includes(id) && !weekFinal ? { how: "signed", by: null } : null),
      weekFinal,
      seasonClosed,
    });
  const isLocked = (id: string) => reasonsFor(id).length > 0;
  // A card only a club admin changes, and only with a reason.
  const needsReason = isLocked;
  const signerOf = (id: string) => {
    const by = cardLocks[id]?.by;
    return by ? nameOf(by) : null;
  };
  const lockAt = (id: string) => cardLocks[id]?.at ?? null;
  // Under Self Scoring everyone keeps their own; anywhere else it's worth saying.
  const ownCard = (id: string) => mode !== "self" && selfKept.includes(id);
  const ownNote = (id: string) => (ownCard(id) ? " \u00b7 kept by the player" : "");
  const lockCaption = (id: string) =>
    `${lockSummary(reasonsFor(id), signerOf(id), lockAt(id))}${ownNote(id)} \u2014 ${
      // An admin's own card is changed by another admin, not "a club admin".
      isAdmin && id === viewerId ? "only another club admin can change it" : "only a club admin can change it"
    }`;
  const dots = (id: string) => strokesReceived?.[id];

  // An admin running the week needn't be playing in it.
  const viewerPlays = players.some((p) => p.id === viewerId);
  const assigned = assignedTo(assignments, viewerId);
  const myScorer = keptBy(assignments, viewerId);
  // Partner Scoring, with a keeper who can't sign in: your own card is yours
  // too. The same rule the Groups page says "keeps their own card" by.
  const ownToo =
    mode === "partner" &&
    viewerPlays &&
    cardKeeper(viewerId, { mode, assignments, noLogin }).kind === "self";

  // The cards this phone keeps, by the league's way of scoring.
  const choices: string[] =
    mode === "self"
      ? viewerPlays
        ? [viewerId]
        : []
      : mode === "team"
        ? [...(team?.playerIds ?? [])]
        : [assigned, ownToo ? viewerId : null].filter((id): id is string => id !== null);
  const keeping =
    chosen && choices.includes(chosen)
      ? chosen
      : mode === "team" && choices.includes(viewerId)
        ? viewerId
        : (choices[0] ?? null);

  // Fix any card: everyone's. Your own is in the list so its sign-off can be
  // taken back and its history read, but its scores are kept the league's
  // way, like anyone's: nobody posts their own score through the admin tools.
  const fixable = [
    ...players.filter((p) => p.id !== viewerId),
    ...(isAdmin ? players.filter((p) => p.id === viewerId) : []),
  ];
  const fixTarget = fixable.some((p) => p.id === adminTarget) ? adminTarget : null;
  const fixingOwn = fixTarget !== null && fixTarget === viewerId;
  // The cards a group's sign-off covers: the group the card is in.
  const groupOf = (id: string) => groups.find((g) => g.playerIds.includes(id))?.playerIds ?? [id];
  const signedWith = (id: string) => groupOf(id).filter((other) => cardLocks[other]?.how === "signed");

  const submit = (targetId: string) => (hole: number, strokes: number) => {
    setRefusal(onSubmit(targetId, hole, strokes));
  };

  // One ball between the side, so there is one card rather than one each and
  // whoever is holding the phone keeps it.
  const sharedBall = getGame(game).sharedBall && team != null && onSubmitTeam != null;
  const submitTeam = (hole: number, strokes: number) => {
    setRefusal(onSubmitTeam!(hole, strokes));
  };
  const sideName = team ? team.playerIds.map(nameOf).join(", ") : "";

  return (
    <div className="space-y-4">
      {refusal && (
        <p
          role="alert"
          className="border border-clay bg-card px-4 py-3 font-mono text-xs text-clay"
        >
          {refusal}
        </p>
      )}

      {sharedBall ? (
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="meta">
              Your side&rsquo;s card &mdash; {sideName}
            </p>
            <button
              type="button"
              onClick={toggleView}
              className="min-h-11 px-1 font-mono text-xs text-forest underline"
            >
              {fullCard ? "Hole by hole" : "Full card"}
            </button>
          </div>
          <p className="mb-2 font-mono text-xs text-ink-soft">
            One ball between you: whoever has the phone writes the score down,
            and it goes on every card in the group.
          </p>
          {fullCard ? (
            <Scorecard
              playerName={team!.label}
              pars={pars}
              scores={cardFor(viewerId)}
              received={dots(viewerId)}
              holeCount={holeCount} startHole={startHole}
              extras={extras}
              onSubmit={submitTeam}
            />
          ) : (
            <BigScorer
              doubleParCap={doubleParCap}
              playerName={team!.label}
              pars={pars}
              scores={cardFor(viewerId)}
              received={dots(viewerId)}
              holeCount={holeCount} startHole={startHole}
              extras={extras}
              onSubmit={submitTeam}
            />
          )}
        </div>
      ) : keeping ? (
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="meta">
              {keeping === viewerId
                ? "Your card"
                : `You are keeping ${nameOf(keeping)}\u2019s card`}
            </p>
            <button
              type="button"
              onClick={toggleView}
              className="min-h-11 px-1 font-mono text-xs text-forest underline"
            >
              {fullCard ? "Hole by hole" : "Full card"}
            </button>
          </div>
          {ownToo && myScorer && !choices.every(isLocked) && (
            <p className="mb-2 border border-forest bg-card px-4 py-3 font-mono text-xs text-forest">
              {nameOf(myScorer)} keeps your card but has no login, so you keep your own
              card this week{assigned ? `, as well as ${nameOf(assigned)}’s` : ""}.
              Pick whose card below.
            </p>
          )}
          {choices.length > 1 && (
            <div role="group" aria-label="Whose card" className="mb-2 flex flex-wrap gap-2">
              {choices.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={id === keeping}
                  onClick={() => setChosen(id)}
                  className={`min-h-11 min-w-16 border px-3 font-mono text-xs ${
                    id === keeping
                      ? "border-forest bg-forest text-cream"
                      : "border-hairline bg-card"
                  }`}
                >
                  {id === viewerId ? "You" : nameOf(id)}
                </button>
              ))}
            </div>
          )}
          {needsReason(keeping) ? (
            <Scorecard
              playerName={nameOf(keeping)}
              pars={pars}
              scores={cardFor(keeping)}
              received={dots(keeping)}
              holeCount={holeCount} startHole={startHole}
              extras={extras}
              caption={lockCaption(keeping)}
            />
          ) : fullCard ? (
            <Scorecard
              playerName={nameOf(keeping)}
              pars={pars}
              scores={cardFor(keeping)}
              received={dots(keeping)}
              holeCount={holeCount} startHole={startHole}
              extras={extras}
              onSubmit={submit(keeping)}
            />
          ) : (
            <BigScorer
              doubleParCap={doubleParCap}
              playerName={nameOf(keeping)}
              pars={pars}
              scores={cardFor(keeping)}
              received={dots(keeping)}
              holeCount={holeCount} startHole={startHole}
              extras={extras}
              onSubmit={submit(keeping)}
            />
          )}
        </div>
      ) : (
        <p className="border border-hairline bg-card px-4 py-3 font-mono text-xs text-ink-soft">
          You have no card to keep in this round.
        </p>
      )}

      {!sharedBall && mode === "partner" && viewerPlays && !ownToo && (
        <div>
          <p className="meta mb-2">
            Your card &mdash;{" "}
            {myScorer ? `kept by ${nameOf(myScorer)}` : "nobody keeping it yet"}
          </p>
          <p className="mb-2 font-mono text-xs text-ink-soft">
            {myScorer
              ? PARTNER_OWN_CARD
              : "Nobody has been given your card yet. Ask the pro shop to set who keeps it."}
          </p>
          <Scorecard
            playerName={nameOf(viewerId)}
            pars={pars}
            scores={cardFor(viewerId)}
            received={dots(viewerId)}
            holeCount={holeCount} startHole={startHole}
            extras={extras}
            caption={isLocked(viewerId) ? lockCaption(viewerId) : undefined}
          />
        </div>
      )}

      {team && onSignOff && (
        <SignOff
          team={team}
          holeCount={holeCount}
          pars={pars}
          cards={team.playerIds.map((id) => ({
            id,
            name: nameOf(id),
            scores: cardFor(id),
            ownCard: ownCard(id),
          }))}
          viewerSignsOwn={team.playerIds.includes(viewerId)}
          finished={team.playerIds.every((id) => cardFor(id).length >= holeCount)}
          signed={team.playerIds.every((id) => cardLocks[id] || lockedIds.includes(id))}
          signer={team.playerIds.map(signerOf).find((name) => name !== null) ?? null}
          weekFinal={weekFinal}
          unsent={unsent}
          onSignOff={async () => setRefusal(await onSignOff(team.id))}
        />
      )}

      {canFix && (
        <div>
          {/* Self Scoring: nobody can keep a card whose player can't sign in.
              The pro shop does, from here; the group is told the same. */}
          {mode === "self" && players.some((p) => noLogin.includes(p.id)) && (
            <p className="mb-2 border border-clay bg-card px-4 py-3 font-mono text-xs text-clay">
              Self Scoring, and{" "}
              {players
                .filter((p) => noLogin.includes(p.id))
                .map((p) => shortName(p.name))
                .join(", ")}{" "}
              {players.filter((p) => noLogin.includes(p.id)).length === 1 ? "has" : "have"} no
              login, so nobody keeps{" "}
              {players.filter((p) => noLogin.includes(p.id)).length === 1 ? "that card" : "those cards"}.
              Enter them below from the paper card, or give them a login.
            </p>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="meta">
              {isAdmin ? "Admin" : "Staff"} &mdash; fix any card
            </span>
            <select
              value={fixTarget ?? ""}
              onChange={(e) => {
                setAdminTarget(e.target.value);
                setFixRefusal(null);
                setAskTakeBack(false);
              }}
              aria-label="Choose a player to edit"
              className="min-h-9 border border-hairline bg-cream px-2 py-1 font-mono text-xs"
            >
              <option value="">Pick a card&hellip;</option>
              {fixable.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.id === viewerId ? "You (your own card)" : shortName(player.name)}
                </option>
              ))}
            </select>
          </div>

          {!fixTarget ? (
            <p className="font-mono text-xs text-ink-soft">
              Pick whose card to fix.
            </p>
          ) : fixingOwn ? (
            <div className="space-y-2">
              <p className="font-mono text-xs text-ink-soft">
                Your own card is here so you can take back its sign-off, lock it, or read its
                history. Its scores are kept the league&rsquo;s way, like everyone&rsquo;s: you
                can&rsquo;t enter or change them from here.
              </p>
              <Scorecard
                playerName={nameOf(fixTarget)}
                pars={pars}
                scores={cardFor(fixTarget)}
                received={dots(fixTarget)}
                holeCount={holeCount} startHole={startHole}
                extras={extras}
                caption={isLocked(fixTarget) ? lockCaption(fixTarget) : "Your own card"}
              />
            </div>
          ) : needsReason(fixTarget) && !isAdmin ? (
            <Scorecard
              playerName={nameOf(fixTarget)}
              pars={pars}
              scores={cardFor(fixTarget)}
              received={dots(fixTarget)}
              holeCount={holeCount} startHole={startHole}
              extras={extras}
              caption={lockCaption(fixTarget)}
            />
          ) : needsReason(fixTarget) ? (
            <SignedChange
              // Not the bare id: the history beside it is keyed by player too,
              // and two siblings sharing a key left an old box on screen.
              key={`reason:${fixTarget}`}
              warning={lockWarning(reasonsFor(fixTarget), nameOf(fixTarget), signerOf(fixTarget))}
              seasonClosed={reasonsFor(fixTarget).includes("season_closed")}
              // The card as it stands, so the scores can be read before deciding.
              preview={
                <Scorecard
                  playerName={nameOf(fixTarget)}
                  pars={pars}
                  scores={cardFor(fixTarget)}
                  received={dots(fixTarget)}
                  holeCount={holeCount} startHole={startHole}
                  extras={extras}
                  caption={lockCaption(fixTarget)}
                />
              }
            >
              {(reason) => (
                <Scorecard
                  playerName={nameOf(fixTarget)}
                  pars={pars}
                  scores={cardFor(fixTarget)}
                  received={dots(fixTarget)}
                  holeCount={holeCount} startHole={startHole}
                  extras={extras}
                  allowAnyHole
                  caption={`Editing as admin \u00b7 ${lowerFirst(
                    lockSummary(reasonsFor(fixTarget), signerOf(fixTarget), lockAt(fixTarget)),
                  )}`}
                  onSubmit={(hole, strokes) => {
                    if (!onFixSigned) return;
                    setSaved(null);
                    void onFixSigned(fixTarget, hole, strokes, reason).then((refused) => {
                      setFixRefusal(refused);
                      if (!refused) {
                        setSaved({ playerId: fixTarget, hole, strokes, withReason: true });
                      }
                    });
                  }}
                />
              )}
            </SignedChange>
          ) : (
            <Scorecard
              playerName={nameOf(fixTarget)}
              pars={pars}
              scores={cardFor(fixTarget)}
              received={dots(fixTarget)}
              holeCount={holeCount} startHole={startHole}
              extras={extras}
              allowAnyHole
              caption={`${isAdmin ? "Editing as admin" : "Fixing as staff"}${ownNote(fixTarget)} \u00b7 a change saves when you leave the box`}
              onSubmit={(hole, strokes) => {
                const refused = onSubmit(fixTarget, hole, strokes);
                setFixRefusal(refused);
                if (!refused) setSaved({ playerId: fixTarget, hole, strokes });
              }}
            />
          )}

          {fixTarget && fixRefusal && (
            <p role="alert" className="mt-2 border border-clay bg-card px-4 py-3 font-mono text-xs text-clay">
              {fixRefusal}
            </p>
          )}

          {takenBack && takenBack.playerId === fixTarget && !fixRefusal && (
            <p role="status" className="mt-2 font-mono text-xs text-forest">
              {takenBack.text}
            </p>
          )}
          {saved && saved.playerId === fixTarget && !fixRefusal && (
            <p role="status" data-keep-clear className="mt-2 font-mono text-xs text-forest">
              {savedText(saved)}
            </p>
          )}

          {isAdmin && fixTarget && (
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {/* Only a card's own lock comes off; a final week or a closed
                  season locks every card, and is undone where it was set. */}
              {onSetLock && !weekFinal && !seasonClosed && (cardLocks[fixTarget] || !isLocked(fixTarget)) &&
                cardLocks[fixTarget]?.how !== "signed" && (
                <button
                  type="button"
                  onClick={async () =>
                    setFixRefusal(await onSetLock(fixTarget, !cardLocks[fixTarget]))
                  }
                  className="min-h-9 font-mono text-xs text-forest underline"
                >
                  {!cardLocks[fixTarget] ? "Lock this card" : "Unlock this card"}
                </button>
              )}
              {onTakeBack && !seasonClosed && cardLocks[fixTarget]?.how === "signed" && (
                <button
                  type="button"
                  aria-expanded={askTakeBack}
                  onClick={() => setAskTakeBack(true)}
                  className="min-h-9 font-mono text-xs text-forest underline"
                >
                  Take back the group&rsquo;s sign-off
                </button>
              )}
              {onHistory && (
                <button
                  type="button"
                  aria-expanded={showHistory}
                  onClick={() => setShowHistory((open) => !open)}
                  className="font-mono text-xs text-forest underline"
                >
                  {showHistory ? "Hide the card\u2019s history" : "The card\u2019s history"}
                </button>
              )}
            </div>
          )}

          {isAdmin && fixTarget && askTakeBack && cardLocks[fixTarget]?.how === "signed" && onTakeBack && (
            <div role="alert" className="mt-2 space-y-2 border-2 border-clay bg-card px-4 py-3">
              <p className="font-mono text-xs text-clay">
                Take back the group&rsquo;s sign-off?{" "}
                {weekFinal ? "Every card the group signed is no longer signed off:" : "Every card the group signed opens again:"}{" "}
                {signedWith(fixTarget)
                  // Yours last: "Rita R., yours".
                  .sort((a, b) => Number(a === viewerId) - Number(b === viewerId))
                  .map((id) => (id === viewerId ? "yours" : nameOf(id)))
                  .join(", ")}
                .{" "}
                {weekFinal
                  ? "The week is final, so the cards stay locked: change a hole with \u201cChange it anyway\u201d. The reason is kept in the card\u2019s history."
                  : "The group checks them and signs again."}
              </p>
              {weekFinal && (
                <label className="block font-mono text-xs">
                  Why (kept in the card&rsquo;s history)
                  <input
                    value={takeBackWhy}
                    onChange={(e) => setTakeBackWhy(e.target.value)}
                    maxLength={300}
                    className="mt-1 block min-h-11 w-full border border-hairline bg-cream px-2"
                  />
                </label>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={weekFinal && takeBackWhy.trim() === ""}
                  onClick={async () => {
                    setAskTakeBack(false);
                    const names = signedWith(fixTarget)
                      .sort((a, b) => Number(a === viewerId) - Number(b === viewerId))
                      .map((id) => (id === viewerId ? "yours" : nameOf(id)))
                      .join(", ");
                    const refused = await onTakeBack(fixTarget, weekFinal ? takeBackWhy.trim() : undefined);
                    setFixRefusal(refused);
                    setTakenBack(
                      refused
                        ? null
                        : {
                            playerId: fixTarget,
                            text: `The group’s sign-off is taken back: ${names}.${
                              weekFinal
                                ? " The week is still final, so the cards stay locked."
                                : " The group can score and sign again."
                            }`,
                          },
                    );
                    setTakeBackWhy("");
                  }}
                  className="min-h-11 flex-1 bg-clay px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
                >
                  Take it back
                </button>
                <button
                  type="button"
                  onClick={() => setAskTakeBack(false)}
                  className="min-h-11 flex-1 border border-hairline px-4 font-mono text-xs tracking-wider uppercase"
                >
                  Keep it signed
                </button>
              </div>
            </div>
          )}

          {isAdmin && fixTarget && (weekFinal || seasonClosed) && (
            <p className="mt-2 font-mono text-xs text-ink-soft">
              {weekFinal
                ? "The week is marked final, so every card in it stays locked: unlocking one card can\u2019t change that. To change a hole, press \u201cChange it anyway\u201d and give a reason: the week\u2019s results and everyone\u2019s season points are worked out again from the cards. Or set the week back to Live on the admin page."
                : "The season is closed, so every card in it stays locked. To change a hole, press \u201cChange it anyway\u201d and give a reason, or reopen the season on the admin page."}
            </p>
          )}

          {isAdmin && onHistory && showHistory && fixTarget && (
            <CardHistory
              key={`history:${fixTarget}`}
              playerName={nameOf(fixTarget)}
              load={() => onHistory(fixTarget)}
              // Reloaded when the card changes, so a fix shows up in it.
              version={
                cardFor(fixTarget).map((s) => `${s.hole}:${s.strokes}`).join(",") +
                reasonsFor(fixTarget).join(",")
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A signed-off card, or one in a closed season: a warning first, then the
 * card only once the admin has said why it is changing. The database refuses
 * the change without a reason too; this is so the admin is asked before.
 */
function SignedChange({
  warning,
  seasonClosed,
  preview,
  children,
}: {
  /** What locked the card, from lockWarning(). */
  warning: string;
  seasonClosed: boolean;
  /** The card, read only, shown above the warning until a reason is given. */
  preview?: React.ReactNode;
  children: (reason: string) => React.ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState<string | null>(null);

  if (reason !== null) {
    return (
      <div className="space-y-2">
        <p className="font-mono text-xs text-ink-soft">
          Reason saved with each change: &ldquo;{reason}&rdquo;{" "}
          <button
            type="button"
            onClick={() => setReason(null)}
            className="text-forest underline"
          >
            Change the reason
          </button>
        </p>
        {children(reason)}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {preview}
      <div role="alert" className="space-y-3 border-2 border-clay bg-card px-4 py-3">
        <p className="font-mono text-xs text-clay">
          {warning} Any change is saved in the card&rsquo;s history with your name and your
          reason{seasonClosed ? ", and in the season’s record" : ""}.
        </p>
        <label className="block">
          <span className="meta mb-1 block">Why is the card changing?</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder="For example: hole 4 was written as 5, the group agrees it was 4"
            className="w-full border border-hairline bg-cream px-2 py-1.5 font-mono text-xs"
          />
        </label>
        <button
          type="button"
          disabled={draft.trim().length < 3}
          onClick={() => setReason(draft.trim())}
          className="min-h-11 bg-clay px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          Change it anyway
        </button>
      </div>
    </div>
  );
}

function SignOff({
  team,
  holeCount,
  pars,
  cards,
  viewerSignsOwn,
  finished,
  signed,
  signer,
  weekFinal,
  unsent,
  onSignOff,
}: {
  team: { label: string };
  holeCount: number;
  pars: CoursePars;
  cards: { id: string; name: string; scores: readonly Score[]; ownCard: boolean }[];
  /** The one signing has a card in the group: they attest their own too. */
  viewerSignsOwn: boolean;
  finished: boolean;
  signed: boolean;
  /** Who signed for the group, once someone has. */
  signer: string | null;
  weekFinal: boolean;
  unsent: number;
  onSignOff: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  // Signing what the pro shop hasn't got yet would sign a different card.
  const notYet =
    unsent > 0
      ? `${unsent} ${unsent === 1 ? "hole score hasn't" : "hole scores haven't"} gone up yet. Sign once they're sent.`
      : !online
        ? "No signal. Sign once there's signal."
        : null;

  if (signed) {
    return (
      <p className="border border-forest bg-card px-4 py-3 font-mono text-xs text-forest">
        {team.label}&rsquo;s cards are signed off
        {signer ? `, by ${signer} for the group` : ""}. Only a club admin can change them now.
      </p>
    );
  }

  // A final week locks the cards without anyone signing; nothing to do here.
  if (weekFinal) return null;

  if (!finished) {
    return (
      <div className="border border-hairline bg-card px-4 py-3">
        <p className="meta mb-1">Signing the cards</p>
        <p className="font-mono text-xs text-ink-soft">
          Once every card in the group has all {holeCount} holes, the group signs them here.
        </p>
      </div>
    );
  }

  if (!checking) {
    return (
      <div className="border-2 border-forest bg-card px-4 py-3">
        <p className="meta mb-1">Every card is complete</p>
        <p className="mb-3 font-mono text-xs text-ink-soft">
          Check the cards together, then sign them. After that only a club admin can change them.
        </p>
        {notYet && <p className="mb-2 font-mono text-xs text-clay">{notYet}</p>}
        <button
          type="button"
          disabled={notYet !== null}
          onClick={() => setChecking(true)}
          className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
        >
          Sign the group&rsquo;s cards
        </button>
      </div>
    );
  }

  return (
    <section aria-label="The cards being signed" className="border-2 border-forest bg-card px-4 py-3">
      <p className="meta mb-2">You&rsquo;re signing {team.label}&rsquo;s cards</p>
      <ul className="mb-3 space-y-2">
        {cards.map((card) => {
          const gross = card.scores.reduce((sum, s) => sum + s.strokes, 0);
          const par = card.scores.reduce((sum, s) => sum + (pars[s.hole] ?? 0), 0);
          const byHole = [...card.scores].sort((a, b) => a.hole - b.hole);

          return (
            <li key={card.id} className="border-b border-dashed border-hairline pb-2 last:border-b-0">
              <p className="flex justify-between font-display text-base font-bold">
                <span>{card.name}</span>
                <span className="tabular-nums">
                  {gross} <span className="font-mono text-xs font-normal">({formatToPar(gross - par)})</span>
                </span>
              </p>
              <p className="font-mono text-xs text-ink-soft tabular-nums">
                {byHole.map((s) => s.strokes).join(" \u00b7 ")}
              </p>
              {card.ownCard && (
                <p className="font-mono text-xs text-clay">
                  Kept by the player: nobody else entered these scores.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mb-3 font-mono text-xs text-ink-soft">
        Signing says the group agrees these scores. Your name goes in each card&rsquo;s history as
        the one who signed{viewerSignsOwn ? ", your own card included" : ""}. After that only a
        club admin can change them.
      </p>
      <div className="flex flex-wrap gap-2">
        {notYet && <p className="w-full font-mono text-xs text-clay">{notYet}</p>}
        <button
          type="button"
          disabled={busy || notYet !== null}
          onClick={async () => {
            setBusy(true);
            await onSignOff();
            setBusy(false);
            setChecking(false);
          }}
          className="min-h-12 flex-1 bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Signing\u2026" : "Sign them"}
        </button>
        <button
          type="button"
          onClick={() => setChecking(false)}
          className="min-h-12 flex-1 border border-hairline px-4 font-mono text-sm tracking-wider uppercase"
        >
          Not yet
        </button>
      </div>
    </section>
  );
}

/** Every change to one card, oldest first. Club admins only. */
function CardHistory({
  playerName,
  load,
  version,
}: {
  playerName: string;
  load: () => Promise<CardHistoryEntry[] | string>;
  version: string;
}) {
  const [entries, setEntries] = useState<CardHistoryEntry[] | string | null>(null);
  const [byHole, setByHole] = useState(false);

  useEffect(() => {
    let live = true;
    void load().then((result) => {
      if (live) setEntries(result);
    });
    return () => {
      live = false;
    };
    // `load` is a new function each render; the card's contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  if (entries === null) {
    return <p className="mt-2 font-mono text-xs text-ink-soft">Loading the history…</p>;
  }

  if (typeof entries === "string") {
    return (
      <p role="alert" className="mt-2 font-mono text-xs text-clay">
        {entries}
      </p>
    );
  }

  return (
    <div className="mt-2 border border-hairline bg-card px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="meta">{playerName}&rsquo;s card, every change</p>
        {entries.length > 1 && (
          <button
            type="button"
            onClick={() => setByHole((now) => !now)}
            className="min-h-9 font-mono text-xs text-forest underline"
          >
            {byHole ? "In the order it happened" : "Hole by hole"}
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">Nothing written on this card yet.</p>
      ) : (
        <ol className="space-y-1 font-mono text-xs">
          {orderHistory(entries, byHole ? "hole" : "time").map((entry, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-x-3">
              <span>{describeChange(entry)}</span>
              {/* When the database got it: a hole entered with no signal
                  arrives when the signal does, so it isn't called "entered".
                  One that waited on the phone says so, to the second. */}
              <span className="text-ink-soft">
                {waitedOnPhone(entry)
                  ? `offline: entered ${formatWhen(entry.phoneAt!, true)}, received ${formatWhen(entry.at, true)}`
                  : `${entry.entity === "card" ? "" : "received "}${formatWhen(entry.at, true)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The history in the order it happened: by when each hole was entered,
 * which for one that waited offline is its phone's time, not when it
 * arrived, since a burst of them arrives together in hole order. Or hole by
 * hole, each hole's changes in order, with the card's sign-offs last.
 */
export function orderHistory(
  entries: readonly CardHistoryEntry[],
  by: "time" | "hole",
): CardHistoryEntry[] {
  const when = (e: CardHistoryEntry) => Date.parse(waitedOnPhone(e) ? e.phoneAt! : e.at);
  return entries
    // "Changed hole 2 from 5 to 5" changed nothing; lines from before 0061 have it.
    .filter((e) => !(e.entity === "score" && e.action === "update" && e.from === e.to))
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) =>
      by === "hole"
        ? (a.entry.hole ?? Infinity) - (b.entry.hole ?? Infinity) ||
          when(a.entry) - when(b.entry) ||
          a.i - b.i
        : // A clear or a put-back writes every hole in the same moment:
          // those go in hole order.
          when(a.entry) - when(b.entry) ||
          (a.entry.hole ?? Infinity) - (b.entry.hole ?? Infinity) ||
          a.i - b.i,
    )
    .map(({ entry }) => entry);
}

/**
 * A hole that really waited on the phone: entered a few seconds or more
 * before it arrived. Before 0059 every first entry carried a phone time, the
 * moment it arrived, and was marked "offline" though it went up at once.
 */
export function waitedOnPhone(entry: Pick<CardHistoryEntry, "at" | "phoneAt">): boolean {
  if (!entry.phoneAt) return false;
  return Date.parse(entry.at) - Date.parse(entry.phoneAt) >= OFFLINE_AFTER_MS;
}

/** Entered and received closer together than this went up at once. */
const OFFLINE_AFTER_MS = 3_000;

/** One history line in words: who did what to which hole. */
export function describeChange(entry: CardHistoryEntry): string {
  if (entry.entity === "card") {
    if (entry.action === "sign_off") return `${entry.by} signed off the group's cards`;
    if (entry.action === "lock") return `${entry.by} locked the card`;
    if (entry.action === "unlock") return `${entry.by} unlocked the card`;
    // With the reason a final week's take-back needs: the confirm promises
    // it is kept in the card's history.
    if (entry.action === "take_back") {
      return entry.reason
        ? `${entry.by} took back the group's sign-off. Reason: “${entry.reason}”`
        : `${entry.by} took back the group's sign-off`;
    }
    return `${entry.by}: ${entry.action}`;
  }

  const what =
    entry.action === "update"
      ? `${entry.by} changed hole ${entry.hole} from ${entry.from} to ${entry.to}`
      : entry.action === "delete"
        ? `${entry.by} removed hole ${entry.hole} (${entry.strokes})`
        : `${entry.by} entered ${entry.strokes} on hole ${entry.hole}`;

  // A change to a locked card says what had locked it.
  const state = lockedWhen(entry.cardWas);

  return entry.reason ? `${what}${state}. Reason: “${entry.reason}”` : `${what}${state}`;
}

function formatWhen(at: string, seconds = false): string {
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}
