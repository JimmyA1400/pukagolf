import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addPending,
  addPendingTeam,
  drainQueue,
  hasWaited,
  isTemporary,
  lastTried,
  markHeld,
  markTried,
  mostTries,
  readPending,
  removePending,
  unsentCount,
  withPending,
  type DrainDeps,
  type PendingScore,
  type SendResult,
} from "./score-queue";

class MemoryStorage {
  store = new Map<string, string>();
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});

const score = (hole: number, strokes: number, playerId = "riley") => ({
  playerId,
  hole,
  strokes,
  enteredBy: "casey",
});

describe("the score queue", () => {
  it("keeps scores in the order they were entered", () => {
    addPending("r1", score(1, 5));
    addPending("r1", score(2, 4));

    expect(readPending("r1").map((p) => p.hole)).toEqual([1, 2]);
  });

  it("replaces a re-entered hole in its place in line", () => {
    addPending("r1", score(1, 5));
    addPending("r1", score(2, 4));
    addPending("r1", score(1, 6));

    expect(readPending("r1").map((p) => [p.hole, p.strokes])).toEqual([
      [1, 6],
      [2, 4],
    ]);
  });

  it("removes by id, and forgets the round once it's empty", () => {
    const [first] = addPending("r1", score(1, 5));

    expect(removePending("r1", first.id)).toEqual([]);
    expect(storage.store.size).toBe(0);
  });

  it("keeps each round's queue apart", () => {
    addPending("r1", score(1, 5));

    expect(readPending("r2")).toEqual([]);
  });

  it("reads a damaged queue as empty rather than failing", () => {
    storage.setItem("pukagolf:pending-scores:r1", "{not json");

    expect(readPending("r1")).toEqual([]);
  });
});

describe("withPending", () => {
  it("shows one score per hole, the latest, when a hole is waiting twice", () => {
    const shown = withPending(
      [{ playerId: "a", hole: 1, strokes: 6 }],
      [
        { ...score(1, 5, "a"), id: "x1" },
        { ...score(1, 4, "a"), id: "x2" },
      ],
    );
    expect(shown).toEqual([{ playerId: "a", hole: 1, strokes: 4 }]);
  });

  it("shows a waiting score in place of the saved one", () => {
    const saved = [
      { playerId: "riley", hole: 1, strokes: 5 },
      { playerId: "riley", hole: 2, strokes: 4 },
    ];
    const waiting = [{ id: "a", ...score(2, 3) }, { id: "b", ...score(3, 4) }];

    expect(withPending(saved, waiting)).toEqual([
      { playerId: "riley", hole: 1, strokes: 5 },
      { playerId: "riley", hole: 2, strokes: 3 },
      { playerId: "riley", hole: 3, strokes: 4 },
    ]);
  });

  it("leaves saved scores alone when nothing is waiting", () => {
    const saved = [{ playerId: "riley", hole: 1, strokes: 5 }];

    expect(withPending(saved, [])).toEqual(saved);
  });
});

describe("counting what hasn't gone up", () => {
  it("counts a scramble hole once, however many cards share it", () => {
    addPendingTeam("r1", {
      teeTimeId: "g1",
      playerIds: ["a", "b", "c"],
      hole: 1,
      strokes: 4,
      enteredBy: "casey",
    });
    addPending("r1", score(1, 5));
    addPending("r1", score(2, 5));

    expect(readPending("r1")).toHaveLength(5);
    expect(unsentCount(readPending("r1"))).toBe(3);
  });

  it("remembers unanswered tries, and a re-entered hole starts again at none", () => {
    const [first] = addPending("r1", score(1, 5));
    markTried("r1", [first.id]);
    markTried("r1", [first.id]);

    expect(mostTries(readPending("r1"))).toBe(2);

    addPending("r1", score(1, 6));
    expect(mostTries(readPending("r1"))).toBe(0);
  });
});

describe("isTemporary", () => {
  const refused = (status: number, code = "", message = "no"): SendResult => ({
    status,
    error: { code, message },
  });

  it("keeps a score with no answer, or a server that's struggling", () => {
    expect(isTemporary(refused(0), true)).toBe(true);
    expect(isTemporary(refused(503), true)).toBe(true);
    expect(isTemporary(refused(429), true)).toBe(true);
    expect(isTemporary(refused(408), true)).toBe(true);
    // The phone knows it's offline, whatever the answer looked like.
    expect(isTemporary(refused(400), false)).toBe(true);
  });

  it("keeps a score when only the sign-in has lapsed", () => {
    expect(isTemporary(refused(401, "PGRST303", "JWT expired"), true)).toBe(true);
  });

  it("lets go of a real refusal", () => {
    expect(isTemporary(refused(403, "42501"), true)).toBe(false);
    expect(isTemporary(refused(400, "23514", "Hole 6 cannot be entered yet"), true)).toBe(false);
  });

  it("never calls a success temporary", () => {
    expect(isTemporary({ status: 201, error: null }, false)).toBe(false);
  });
});

describe("drainQueue", () => {
  type Row = { strokes: number; enteredBy: string };

  /** A server with one row per hole, and a switch for the signal. */
  function server(rows: Record<string, Row> = {}) {
    const sent: PendingScore[] = [];
    let signal = true;
    let answer: (item: PendingScore) => SendResult = () => ({ status: 201, error: null });

    const deps: DrainDeps = {
      send: async (item) => {
        if (!signal) return { status: 0, error: { message: "TypeError: Failed to fetch" } };
        const result = answer(item);
        if (!result.error) {
          sent.push(item);
          rows[`${item.playerId}:${item.hole}`] = { strokes: item.strokes, enteredBy: item.enteredBy };
        }
        return result;
      },
      current: async (item) => {
        if (!signal) return "no-signal";
        return rows[`${item.playerId}:${item.hole}`] ?? null;
      },
      online: () => signal,
      refused: (item, error) => `hole ${item.hole}: ${error.message}`,
      overtaken: (item, theirs) => `hole ${item.hole}: they said ${theirs}`,
    };

    return {
      deps,
      sent,
      rows,
      signal: (on: boolean) => {
        signal = on;
      },
      answer: (next: (item: PendingScore) => SendResult) => {
        answer = next;
      },
    };
  }

  it("sends everything, oldest first, and empties the queue", async () => {
    const s = server();
    addPending("r1", score(1, 5));
    addPending("r1", score(2, 4));

    expect(await drainQueue("r1", s.deps)).toMatchObject({ sent: 2, problems: [], waiting: false });
    expect(s.sent.map((i) => i.hole)).toEqual([1, 2]);
    expect(readPending("r1")).toEqual([]);
  });

  it("hands back what landed, so the page can keep showing it until the card reloads", async () => {
    const s = server();
    addPending("r1", score(1, 5));
    addPending("r1", score(2, 4));
    s.answer((item) =>
      item.hole === 2 ? { status: 403, error: { message: "no" } } : { status: 201, error: null },
    );

    const result = await drainQueue("r1", s.deps);
    // The refused one isn't shown as landed: it never went in.
    expect(result.landed.map((i) => [i.hole, i.strokes])).toEqual([[1, 5]]);
  });

  it("counts every card of a scramble hole as landed", async () => {
    const s = server();
    addPendingTeam("r1", { teeTimeId: "g1", playerIds: ["a", "b"], hole: 3, strokes: 4, enteredBy: "casey" });

    const result = await drainQueue("r1", s.deps);
    expect(result.landed.map((i) => i.playerId).sort()).toEqual(["a", "b"]);
  });

  it("keeps every score through a dead spot and sends each once when it ends", async () => {
    const s = server();
    s.signal(false);
    addPending("r1", score(1, 5));
    addPending("r1", score(2, 4));

    expect(await drainQueue("r1", s.deps)).toMatchObject({ sent: 0, waiting: true });
    expect(await drainQueue("r1", s.deps)).toMatchObject({ sent: 0, waiting: true });
    expect(readPending("r1").map((i) => [i.hole, i.tries ?? 0])).toEqual([
      [1, 2],
      [2, 0],
    ]);

    s.signal(true);

    expect(await drainQueue("r1", s.deps)).toMatchObject({ sent: 2, problems: [], waiting: false });
    expect(s.sent.map((i) => i.hole)).toEqual([1, 2]);
    expect(readPending("r1")).toEqual([]);
  });

  it("keeps a score the server was too busy to take", async () => {
    const s = server();
    s.answer(() => ({ status: 503, error: { message: "Service unavailable" } }));
    addPending("r1", score(1, 5));

    expect(await drainQueue("r1", s.deps)).toMatchObject({ waiting: true, problems: [] });
    expect(readPending("r1")).toHaveLength(1);
  });

  it("lets go of a refused score with a line saying so, and carries on", async () => {
    const s = server();
    s.answer((item) =>
      item.playerId === "riley"
        ? { status: 403, error: { code: "42501", message: "card signed off" } }
        : { status: 201, error: null },
    );
    addPending("r1", score(1, 5));
    addPending("r1", score(1, 4, "jordan"));

    expect(await drainQueue("r1", s.deps)).toMatchObject({
      sent: 1,
      problems: ["hole 1: card signed off"],
      waiting: false,
    });
    expect(readPending("r1")).toEqual([]);
  });

  it("doesn't overwrite a newer score somebody else entered while this one waited", async () => {
    const s = server();
    s.signal(false);
    addPending("r1", score(3, 6));
    await drainQueue("r1", s.deps);

    // The pro shop puts a 5 on the card in the meantime.
    s.rows["riley:3"] = { strokes: 5, enteredBy: "admin" };
    s.signal(true);

    expect(await drainQueue("r1", s.deps)).toMatchObject({
      sent: 0,
      problems: ["hole 3: they said 5"],
      waiting: false,
    });
    expect(s.sent).toEqual([]);
    expect(s.rows["riley:3"].strokes).toBe(5);
  });

  it("still sends a waiting correction over this scorer's own earlier number", async () => {
    const s = server({ "riley:3": { strokes: 4, enteredBy: "casey" } });
    s.signal(false);
    addPending("r1", score(3, 6));
    await drainQueue("r1", s.deps);
    s.signal(true);

    expect(await drainQueue("r1", s.deps)).toMatchObject({ sent: 1, problems: [] });
    expect(s.rows["riley:3"].strokes).toBe(6);
  });

  it("doesn't send twice when an earlier try landed after all", async () => {
    const s = server();
    s.signal(false);
    addPending("r1", score(1, 5));
    await drainQueue("r1", s.deps);

    // The request got through but the answer was lost on the way back.
    s.rows["riley:1"] = { strokes: 5, enteredBy: "casey" };
    s.signal(true);

    expect(await drainQueue("r1", s.deps)).toMatchObject({ sent: 1, problems: [] });
    expect(s.sent).toEqual([]);
    expect(readPending("r1")).toEqual([]);
  });

  it("sends a scramble hole once and clears every card that shares it", async () => {
    const s = server();
    addPendingTeam("r1", {
      teeTimeId: "g1",
      playerIds: ["a", "b"],
      hole: 1,
      strokes: 4,
      enteredBy: "casey",
    });

    expect(await drainQueue("r1", s.deps)).toMatchObject({ sent: 1, waiting: false });
    expect(s.sent).toHaveLength(1);
    expect(readPending("r1")).toEqual([]);
  });

  it("marks every card of a scramble hole as tried when it can't go", async () => {
    const s = server();
    s.signal(false);
    addPendingTeam("r1", {
      teeTimeId: "g1",
      playerIds: ["a", "b"],
      hole: 1,
      strokes: 4,
      enteredBy: "casey",
    });

    await drainQueue("r1", s.deps);
    expect(readPending("r1").map((i) => i.tries)).toEqual([1, 1]);
  });
});

describe("round-5: three quick corrections", () => {
  it("says each score has landed before the next one goes, not at the end of the pass", async () => {
    const order: string[] = [];
    addPending("r1", score(7, 5));
    addPending("r1", score(8, 4));
    addPending("r1", score(6, 6));

    await drainQueue("r1", {
      send: async (item) => {
        order.push(`send ${item.hole}`);
        return { status: 201, error: null };
      },
      current: async () => null,
      online: () => true,
      refused: () => "refused",
      overtaken: () => "overtaken",
      landed: (items) => {
        order.push(`landed ${items.map((i) => i.hole).join(",")}`);
        // By then it has left the queue, so the page has to hold it.
        expect(readPending("r1").some((i) => i.hole === items[0].hole)).toBe(false);
      },
    });

    expect(order).toEqual(["send 7", "landed 7", "send 8", "landed 8", "send 6", "landed 6"]);
  });
});

describe("round-5: when a waiting score was entered and last tried", () => {
  it("stamps the time it was entered, and keeps it through a correction's replacement", () => {
    const [first] = addPending("r1", { ...score(1, 5), enteredAt: 1_000 });
    expect(first.enteredAt).toBe(1_000);
    const [fresh] = addPending("r1", score(2, 4)).slice(-1);
    expect(fresh.enteredAt).toEqual(expect.any(Number));
  });

  it("knows when the last unanswered try was", () => {
    addPending("r1", score(1, 5));
    expect(lastTried(readPending("r1"))).toBeNull();
    const ids = readPending("r1").map((i) => i.id);
    markTried("r1", ids);
    expect(lastTried(readPending("r1"))).toEqual(expect.any(Number));
  });
});

describe("round-6: offline entries are marked", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks a hole entered with no signal, and one entered with signal not", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const [offline] = addPending("r1", score(1, 5));
    expect(offline.offline).toBe(true);
    vi.stubGlobal("navigator", { onLine: true });
    const online = addPending("r1", score(2, 4)).find((i) => i.hole === 2)!;
    expect(online.offline).toBe(false);
  });
});

describe("round-9: a hole goes up as its net change", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only the last number entered offline: 5, then 6, then 5 is 5", () => {
    vi.stubGlobal("navigator", { onLine: false });
    addPending("r1", { ...score(1, 5), enteredAt: 1_000 });
    addPending("r1", { ...score(1, 6), enteredAt: 2_000 });
    const [item] = addPending("r1", { ...score(1, 5), enteredAt: 3_000 });
    expect(readPending("r1")).toHaveLength(1);
    expect(item.strokes).toBe(5);
    expect(item.earlier).toBeUndefined();
  });
});

describe("round-9: one held batch, one mark", () => {
  it("marks everything waiting when a try finds PukaGolf down", () => {
    addPending("r", { ...score(3, 5), offline: false });
    addPending("r", { ...score(3, 4, "pat"), offline: false });
    // Only the first was tried; the second waited behind it all the same.
    markTried("r", [readPending("r")[0].id]);
    markHeld("r");
    expect(readPending("r").every(hasWaited)).toBe(true);
  });

  it("marks a hole entered behind one that's already waiting", () => {
    addPending("r", { ...score(3, 5), offline: false });
    markTried("r", [readPending("r")[0].id]);
    const items = addPending("r", { ...score(3, 4, "greg"), offline: false });
    expect(items.find((i) => i.playerId === "greg")?.held).toBe(true);
  });

  it("but not one entered with nothing waiting", () => {
    const [item] = addPending("r", { ...score(3, 5), offline: false });
    expect(hasWaited(item)).toBe(false);
  });

  it("a correction of a held hole is held too", () => {
    addPending("r", { ...score(3, 5), offline: false });
    markTried("r", [readPending("r")[0].id]);
    addPending("r", { ...score(3, 6), offline: false });
    const [item] = readPending("r");
    expect(item.strokes).toBe(6);
    expect(item.held).toBe(true);
  });
});
