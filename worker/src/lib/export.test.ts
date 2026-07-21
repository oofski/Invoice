import { describe, it, expect } from "vitest";
import { field } from "./export";

describe("field — CSV escaping", () => {
  it("quotes values containing comma / quote / newline and doubles quotes", () => {
    expect(field("a,b")).toBe('"a,b"');
    expect(field('he said "hi"')).toBe('"he said ""hi"""');
    expect(field("line1\nline2")).toBe('"line1\nline2"');
    expect(field("plain")).toBe("plain");
  });
});

describe("field — formula-injection guard (L6)", () => {
  it("prefixes a quote on text cells that start with = + - @", () => {
    // Prefixed, then quoted because it also contains embedded quotes.
    expect(field('=HYPERLINK("http://x","pay")')).toBe(
      '"\'=HYPERLINK(""http://x"",""pay"")"',
    );
    // A cell with no comma/quote just gets the leading quote.
    expect(field("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(field("+1800")).toBe("'+1800");
    expect(field("-cmd")).toBe("'-cmd");
    expect(field("@ref")).toBe("'@ref");
  });

  it("does not alter safe text or numeric values (real negatives)", () => {
    expect(field("Acme Corp")).toBe("Acme Corp");
    expect(field(-5)).toBe("-5");
    expect(field(1234.5)).toBe("1234.5");
    expect(field(null)).toBe("");
    expect(field(undefined)).toBe("");
  });
});
