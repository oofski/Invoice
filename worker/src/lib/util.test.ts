import { describe, it, expect } from "vitest";
import { parseAmount, toIsoDate } from "./util";

describe("parseAmount", () => {
  it("parses plain, numeric, and currency-formatted values", () => {
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount("-5.00")).toBe(-5);
    expect(parseAmount("")).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount("not money")).toBe(0);
  });

  it("treats accounting-style negatives as negative (credits/refunds)", () => {
    expect(parseAmount("(10.00)")).toBe(-10);
    expect(parseAmount("$50 CR")).toBe(-50);
    expect(parseAmount("1,234.56-")).toBe(-1234.56);
  });
});

describe("toIsoDate", () => {
  it("normalizes MM/DD/YYYY (incl. 2-digit year) and null", () => {
    expect(toIsoDate("07/21/2026")).toBe("2026-07-21");
    expect(toIsoDate("7/1/26")).toBe("2026-07-01");
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });
});
