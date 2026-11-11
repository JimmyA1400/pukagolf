import { describe, expect, it } from "vitest";

import {
  TEE_PREFERENCES,
  isTeePreference,
  resolveTee,
  teePreferenceLabel,
} from "./tee-preference";

const card = (...tees: [string, number][]) =>
  tees.map(([tee, totalYards]) => ({ tee, totalYards }));

/** A plain five-set card, nothing in the names to go on. */
const fiveSets = card(
  ["black", 6800],
  ["blue", 6400],
  ["white", 6000],
  ["gold", 5600],
  ["red", 5100],
);

describe("TEE_PREFERENCES", () => {
  it("offers exactly the five sets the league asked for", () => {
    expect(TEE_PREFERENCES.map((p) => p.label)).toEqual([
      "Tips",
      "Mens",
      "Seniors",
      "Ladies",
      "Front Tees",
    ]);
  });

  it("recognises its own ids and nothing else", () => {
    expect(isTeePreference("tips")).toBe(true);
    expect(isTeePreference("front")).toBe(true);
    // The old free-text values, which is what a saved profile may still hold.
    expect(isTeePreference("blue")).toBe(false);
    expect(isTeePreference(null)).toBe(false);
    expect(isTeePreference(4)).toBe(false);
  });

  it("labels an id, and refuses one it does not know", () => {
    expect(teePreferenceLabel("front")).toBe("Front Tees");
    expect(teePreferenceLabel("iv-v-male")).toBeNull();
  });
});

describe("resolveTee", () => {
  it("spreads the five ranks across a five-set card", () => {
    const picked = TEE_PREFERENCES.map(
      (p) => resolveTee(p.id, fiveSets)?.tee,
    );

    expect(picked).toEqual(["black", "blue", "white", "gold", "red"]);
  });

  it("puts tips on the longest and front on the shortest, always", () => {
    for (const sets of [1, 2, 3, 4, 5, 7]) {
      const course = card(
        ...Array.from(
          { length: sets },
          (_, i) => [`tee${i}`, 7000 - i * 300] as [string, number],
        ),
      );

      expect(resolveTee("tips", course)?.tee).toBe("tee0");
      expect(resolveTee("front", course)?.tee).toBe(`tee${sets - 1}`);
    }
  });

  it("collapses gracefully on a card with only two sets", () => {
    const two = card(["championship", 6900], ["resort", 5900]);

    // Nothing invented: the two longer preferences get the long set, the two
    // shorter ones the short set.
    expect(resolveTee("tips", two)?.tee).toBe("championship");
    expect(resolveTee("mens", two)?.tee).toBe("championship");
    expect(resolveTee("ladies", two)?.tee).toBe("resort");
    expect(resolveTee("front", two)?.tee).toBe("resort");
  });

  it("takes the card's own word over the ranking", () => {
    // "Silver-female" is longer than the gold set, so ranking alone would put
    // Ladies on the wrong one.
    const course = card(
      ["I-male", 6900],
      ["II-male", 6300],
      ["Silver-female", 5800],
      ["gold", 5400],
      ["V-female", 4900],
    );

    expect(resolveTee("ladies", course)?.tee).toBe("Silver-female");
  });

  it("picks the longest set when a card names several of a kind", () => {
    const course = card(
      ["black", 7000],
      ["IV-female", 5400],
      ["V-female", 4800],
    );

    expect(resolveTee("ladies", course)?.tee).toBe("IV-female");
  });

  it("reads senior and championship off the card too", () => {
    const course = card(
      ["Championship", 7100],
      ["Regular", 6400],
      ["Senior", 5700],
      ["Forward", 5000],
    );

    expect(resolveTee("tips", course)?.tee).toBe("Championship");
    expect(resolveTee("elderly", course)?.tee).toBe("Senior");
    expect(resolveTee("front", course)?.tee).toBe("Forward");
  });

  it("does not sort by name inside a hyphenated tee", () => {
    // "Iv-v-female" has to read as words before the keyword can match.
    const course = card(["I-male", 6800], ["Iv-v-female", 5200]);

    expect(resolveTee("ladies", course)?.tee).toBe("Iv-v-female");
  });

  it("ignores the order it is handed", () => {
    const shuffled = card(
      ["red", 5100],
      ["black", 6800],
      ["white", 6000],
      ["gold", 5600],
      ["blue", 6400],
    );

    expect(resolveTee("tips", shuffled)?.tee).toBe("black");
    expect(resolveTee("mens", shuffled)?.tee).toBe("blue");
  });

  it("returns null rather than guessing", () => {
    expect(resolveTee(null, fiveSets)).toBeNull();
    expect(resolveTee("", fiveSets)).toBeNull();
    // A preference saved before the five categories existed.
    expect(resolveTee("blue", fiveSets)).toBeNull();
    expect(resolveTee("tips", [])).toBeNull();
  });
});
