import { describe, it, expect } from "vitest";
import { validateSplits, roundCents } from "./ccRules";
import { CC_ENTITIES } from "./ccConstants";

const [E1, E2, E3] = CC_ENTITIES;

describe("roundCents", () => {
  it("rounds to 2dp", () => {
    expect(roundCents(0.334)).toBe(0.33);
    expect(roundCents(0.335)).toBe(0.34);
    expect(roundCents(1)).toBe(1);
  });
});

describe("validateSplits (M9 — round-per-row)", () => {
  it("accepts an exact split", () => {
    const r = validateSplits(100, [
      { entity_name: E1, amount: 60 },
      { entity_name: E2, amount: 40 },
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejects a split that sums right RAW but wrong after per-row rounding", () => {
    // 0.334 + 0.333 + 0.333 = 1.000 raw, but stores as 0.33*3 = 0.99
    const r = validateSplits(1, [
      { entity_name: E1, amount: 0.334 },
      { entity_name: E2, amount: 0.333 },
      { entity_name: E3, amount: 0.333 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown entities, negatives, and empty rows", () => {
    expect(validateSplits(10, [{ entity_name: "NotARealEntity", amount: 10 }]).ok).toBe(false);
    expect(validateSplits(10, [{ entity_name: E1, amount: -10 }]).ok).toBe(false);
    expect(validateSplits(10, []).ok).toBe(false);
  });
});
