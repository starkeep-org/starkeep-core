import { describe, expect, it } from "vitest";
import { contentDisposition } from "../src/content-disposition";

describe("contentDisposition", () => {
  it("names the file for inline display", () => {
    expect(contentDisposition("report.docx", { inline: true })).toBe(
      `inline; filename="report.docx"; filename*=UTF-8''report.docx`,
    );
  });

  it("names the file for download", () => {
    expect(contentDisposition("archive.zip", { inline: false })).toBe(
      `attachment; filename="archive.zip"; filename*=UTF-8''archive.zip`,
    );
  });

  it("keeps a non-ASCII name in filename* and gives an ASCII fallback", () => {
    expect(contentDisposition("Café menu.pdf", { inline: false })).toBe(
      `attachment; filename="Caf_ menu.pdf"; filename*=UTF-8''Caf%C3%A9%20menu.pdf`,
    );
  });

  it("cannot break out of the quoted filename or name a path", () => {
    const header = contentDisposition('a"b\\c/d\r\ne.txt', { inline: true });
    expect(header).toBe(`inline; filename="a_b_c_d__e.txt"; filename*=UTF-8''a_b_c_d__e.txt`);
  });

  it("percent-encodes the characters RFC 8187 leaves out", () => {
    expect(contentDisposition("it's (1)*.txt", { inline: true })).toContain(
      "filename*=UTF-8''it%27s%20%281%29%2A.txt",
    );
  });

  it("falls back to download for an empty name", () => {
    expect(contentDisposition("   ", { inline: false })).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });
});
