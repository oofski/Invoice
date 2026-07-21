import { describe, it, expect } from "vitest";
import { sniffBytes, containsPdfHeader } from "./pdfNormalize";

const b = (arr: number[]) => new Uint8Array(arr);

describe("sniffBytes", () => {
  it("identifies documents by magic bytes", () => {
    expect(sniffBytes(b([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe("pdf"); // %PDF-1
    expect(sniffBytes(b([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffBytes(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffBytes(b([0x47, 0x49, 0x46, 0x38]))).toBe("gif");
    expect(sniffBytes(b([0x00, 0x01, 0x02, 0x03]))).toBe("unknown");
  });

  it("detects an HTML/email body even after a UTF-8 BOM or whitespace", () => {
    expect(sniffBytes(b([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBe("html"); // <html
    expect(sniffBytes(b([0xef, 0xbb, 0xbf, 0x20, 0x3c, 0x64]))).toBe("html"); // BOM ␣ <d
  });
});

describe("containsPdfHeader — leading-bytes PDF (L13)", () => {
  it("finds %PDF- past offset 0", () => {
    expect(containsPdfHeader(b([0x0a, 0x0a, 0x20, 0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe(
      true,
    );
  });
  it("is false when the header is absent", () => {
    expect(containsPdfHeader(b([0x00, 0x01, 0x02, 0x03, 0x04]))).toBe(false);
    expect(containsPdfHeader(b([0x25, 0x50, 0x44]))).toBe(false); // too short / partial
  });
});
