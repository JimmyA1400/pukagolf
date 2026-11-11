import type { Score } from "./leaderboard";

/**
 * Scores waiting on this phone for a signal.
 *
 * Courses have dead spots. Every score goes into this queue first and is sent
 * from it, oldest first, so a hole entered with no signal isn't lost: it stays
 * here, shows on the card, and goes up when the connection comes back. Oldest
 * first matters, because the database refuses hole 6 before hole 5.
 *
 * Kept in localStorage, per round, so it survives the page being closed.
 * Where storage is blocked it falls back to memory: the queue then lasts only
 * as long as the page, but a score is never dropped on the floor.
 */
export type PendingScore = {
  id: string;
  playerId: string;
  hole: number;
  strokes: number;
  enteredBy: string;
  /**
   * Set in a scramble, where the whole tee time shares the score. Each card
   * still waits here separately, so every one of them shows the number; the
   * tag tells the sender they go up as one call, not one call each.
   */
  teeTimeId?: string;
  /**
   * How many times this score has been sent and got no answer. A score that
   * has waited is checked against the server before it goes, in case someone
   * else changed the hole in the meantime.
   */
  tries?: number;
  /** When the last of those tries got no answer, in ms since 1970. */
  triedAt?: number;
  /** When it was entered on this phone, in ms since 1970. */
  enteredAt?: number;
  /** Entered with the phone offline: it can't have gone up at once. */
  offline?: boolean;
  /**
   * Corrects a hole that was already waiting, offline or after a try that
   * got no answer: it waited too, however it was entered.
   */
  held?: boolean;
  /**
   * Numbers entered before the last one, kept by phones from round 7. Never
   * written now: a hole goes up as its net change (round 9), and these are
   * left unsent.
   */
  earlier?: { strokes: number; enteredAt: number }[];
};

const key = (roundId: string) => `pukagolf:pending-scores:${roundId}`;

/** Used only when localStorage itself can't be reached. */
const memory = new Map<string, PendingScore[]>();

export function readPending(roundId: string): PendingScore[] {
  let raw: string | null;

  try {
    raw = localStorage.getItem(key(roundId));
  } catch {
    return [...(memory.get(key(roundId)) ?? [])];
  }

  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? (parsed as PendingScore[]) : [];
  } catch {
    return [];
  }
}

function write(roundId: string, items: PendingScore[]) {
  try {
    if (items.length > 0) localStorage.setItem(key(roundId), JSON.stringify(items));
    else localStorage.removeItem(key(roundId));
  } catch {
    if (items.length > 0) memory.set(key(roundId), items);
    else memory.delete(key(roundId));
  }
}

/**
 * Queue a score. Entering the same hole again replaces the waiting one in its
 * place in line, so a correction can't jump ahead of the holes before it.
 */
/**
 * A score that couldn't go up at once: entered offline, tried with no
 * answer (PukaGolf down, or a reply that never came), or correcting one
 * that had.
 */
export function hasWaited(item: PendingScore): boolean {
  return Boolean(item.offline || item.held || (item.tries ?? 0) > 0);
}

export function addPending(
  roundId: string,
  score: Omit<PendingScore, "id">,
): PendingScore[] {
  const items = readPending(roundId);
  const item: PendingScore = {
    ...score,
    id: crypto.randomUUID(),
    enteredAt: score.enteredAt ?? Date.now(),
    // A correction made offline is offline too, whatever its first entry was.
    offline: score.offline ?? (typeof navigator !== "undefined" && navigator.onLine === false),
  };
  delete item.tries;
  delete item.triedAt;
  delete item.earlier;
  delete item.held;
  const at = items.findIndex((i) => i.playerId === score.playerId && i.hole === score.hole);

  // A correction of a hole that waited, for signal or for PukaGolf to
  // answer, waited too. So did anything entered behind a hole that is
  // waiting: it can't go before it, so one held batch is marked the same
  // all through (round 9). Only the last number goes: the net change, as
  // 5, then 6, then 5 again is no change at all.
  const was = at >= 0 ? items[at] : null;
  if ((was && hasWaited(was)) || items.some((i) => i !== was && hasWaited(i))) item.held = true;

  if (at >= 0) items[at] = item;
  else items.push(item);

  write(roundId, items);
  return items;
}

/**
 * Queue one score for a whole side, in a scramble: the same number on every
 * card in the group, all tagged with the tee time that played the ball.
 */
export function addPendingTeam(
  roundId: string,
  score: {
    teeTimeId: string;
    playerIds: readonly string[];
    hole: number;
    strokes: number;
    enteredBy: string;
  },
): PendingScore[] {
  let items = readPending(roundId);

  for (const playerId of score.playerIds) {
    items = addPending(roundId, {
      playerId,
      hole: score.hole,
      strokes: score.strokes,
      enteredBy: score.enteredBy,
      teeTimeId: score.teeTimeId,
    });
  }

  return items;
}

export function removePending(roundId: string, id: string): PendingScore[] {
  const items = readPending(roundId).filter((i) => i.id !== id);
  write(roundId, items);
  return items;
}

/** Everything queued for one side's hole, which goes up in a single call. */
export function removePendingTeam(
  roundId: string,
  teeTimeId: string,
  hole: number,
): PendingScore[] {
  const items = readPending(roundId).filter(
    (i) => !(i.teeTimeId === teeTimeId && i.hole === hole),
  );
  write(roundId, items);

  return items;
}

/** One more unanswered try for these queued scores, kept with the queue. */
/**
 * Every score still waiting, marked as held: what one try found down, the
 * rest behind it waited for as well, whichever of them was tried.
 */
export function markHeld(roundId: string): PendingScore[] {
  const items = readPending(roundId).map((i) => ({ ...i, held: true }));
  write(roundId, items);
  return items;
}

export function markTried(roundId: string, ids: readonly string[]): PendingScore[] {
  const items = readPending(roundId).map((i) =>
    ids.includes(i.id) ? { ...i, tries: (i.tries ?? 0) + 1, triedAt: Date.now() } : i,
  );
  write(roundId, items);

  return items;
}

/**
 * How many hole scores are still to go up, as a golfer counts them: a
 * scramble hole is one score for the whole side, not one per card.
 */
export function unsentCount(pending: readonly PendingScore[]): number {
  return new Set(
    pending.map((p) => (p.teeTimeId ? `team:${p.teeTimeId}:${p.hole}` : `${p.playerId}:${p.hole}`)),
  ).size;
}

/** The most times any waiting score has gone unanswered: how long it has been struggling. */
export function mostTries(pending: readonly PendingScore[]): number {
  return pending.reduce((most, p) => Math.max(most, p.tries ?? 0), 0);
}

/** When the latest unanswered try was, or null if none has failed. */
export function lastTried(pending: readonly PendingScore[]): number | null {
  const at = pending.reduce((latest, p) => Math.max(latest, p.triedAt ?? 0), 0);
  return at > 0 ? at : null;
}

/** What the database said to one send. */
export type SendResult = {
  error: { code?: string; message: string; hint?: string } | null;
  status: number;
};

/**
 * No answer, or an answer that means "not now" rather than "no": the score
 * stays on the phone and is tried again. A refusal is anything else.
 *
 * An expired sign-in counts as "not now". After a long spell with no signal
 * the phone's session has lapsed; it renews itself once the signal is back,
 * and the score must still be there when it does.
 */
export function isTemporary({ error, status }: SendResult, online: boolean): boolean {
  if (!error) return false;
  if (!online || status === 0) return true;
  if (status === 408 || status === 429 || status >= 500) return true;

  return (
    error.code === "PGRST301" ||
    error.code === "PGRST302" ||
    error.code === "PGRST303" ||
    /JWT/i.test(error.message)
  );
}

/** The hole as it stands on the server now, or "no-signal" when it couldn't be asked. */
export type ServerHole = { strokes: number; enteredBy: string | null } | null | "no-signal";

export type DrainDeps = {
  send: (item: PendingScore) => Promise<SendResult>;
  /** The hole's score on the server, for a queued score that has waited. */
  current: (item: PendingScore) => Promise<ServerHole>;
  online: () => boolean;
  /** Plain words for a refused score. */
  refused: (item: PendingScore, error: NonNullable<SendResult["error"]>) => string;
  /** Plain words for a waiting score that somebody else's newer one beat. */
  overtaken: (item: PendingScore, theirs: number) => string;
  /**
   * Told the moment scores go up, before the next one is sent. The page has
   * to hold them on screen from then: they have left the queue, and a hole
   * entered while the rest are going would otherwise redraw the card without
   * them, showing the old number for a moment.
   */
  landed?: (items: PendingScore[]) => void;
};

export type DrainResult = {
  sent: number;
  /**
   * The scores that went up, every card of a scramble hole included. The page
   * keeps showing them until it has reloaded the card from after they landed:
   * dropping them sooner left the hole blank for a moment, and a Save in that
   * moment wrote over it.
   */
  landed: PendingScore[];
  /** One line for each score that didn't go up, and why. */
  problems: string[];
  /** Stopped for want of signal, with scores still waiting. */
  waiting: boolean;
};

/**
 * Send whatever is waiting, oldest first. Stops at the first sign of no
 * signal and leaves the rest for later; a score the database refuses, or
 * one somebody else has since replaced, leaves the queue with a line saying
 * so. Nothing leaves it any other way.
 *
 * Reads the queue afresh each time round, so a score entered while this is
 * running goes out in the same pass, behind the ones before it.
 */
export async function drainQueue(roundId: string, deps: DrainDeps): Promise<DrainResult> {
  const problems: string[] = [];
  const landed: PendingScore[] = [];
  let sent = 0;

  // A scramble's hole was played with one ball, so it goes up as one call and
  // every card in the group leaves the queue with it.
  const leave = (item: PendingScore) =>
    item.teeTimeId
      ? removePendingTeam(roundId, item.teeTimeId, item.hole)
      : removePending(roundId, item.id);

  const together = (item: PendingScore) =>
    item.teeTimeId
      ? readPending(roundId)
          .filter((i) => i.teeTimeId === item.teeTimeId && i.hole === item.hole)
          .map((i) => i.id)
      : [item.id];

  // Every card the item stands for, read before it leaves the queue.
  const cardsOf = (item: PendingScore) =>
    item.teeTimeId
      ? readPending(roundId).filter((i) => i.teeTimeId === item.teeTimeId && i.hole === item.hole)
      : [item];

  for (;;) {
    const [item] = readPending(roundId);
    if (!item) return { sent, landed, problems, waiting: false };

    // Waited a while: has somebody else put a newer score on this hole since?
    // A different number from a different phone is theirs to keep. Our own
    // number already there means an earlier try did land after all.
    if ((item.tries ?? 0) > 0) {
      const now = await deps.current(item);

      if (now === "no-signal") {
        markTried(roundId, together(item));
        markHeld(roundId);
        return { sent, landed, problems, waiting: true };
      }

      if (now && now.strokes === item.strokes) {
        const cards = cardsOf(item);
        landed.push(...cards);
        leave(item);
        deps.landed?.(cards);
        sent += 1;
        continue;
      }

      if (now && now.enteredBy !== item.enteredBy) {
        leave(item);
        problems.push(deps.overtaken(item, now.strokes));
        continue;
      }
    }

    const result = await deps.send(item);

    if (isTemporary(result, deps.online())) {
      markTried(roundId, together(item));
      markHeld(roundId);
      return { sent, landed, problems, waiting: true };
    }

    const cards = cardsOf(item);
    leave(item);

    if (result.error) problems.push(deps.refused(item, result.error));
    else {
      sent += 1;
      landed.push(...cards);
      deps.landed?.(cards);
    }
  }
}

/** What the cards should show: saved scores, with anything waiting on top. */
export function withPending(
  scores: readonly Score[],
  pending: readonly PendingScore[],
): Score[] {
  if (pending.length === 0) return [...scores];

  // One per hole, the latest on top: a hole re-entered while its first
  // number is still on its way shows the newer one.
  const latest = new Map<string, Score>();
  for (const p of pending) {
    latest.set(`${p.playerId}:${p.hole}`, { playerId: p.playerId, hole: p.hole, strokes: p.strokes });
  }

  return [...scores.filter((s) => !latest.has(`${s.playerId}:${s.hole}`)), ...latest.values()];
}
