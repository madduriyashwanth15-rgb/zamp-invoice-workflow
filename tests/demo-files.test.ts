import { describe, expect, it } from "vitest";
import { sampleFile } from "@/server/demo";

// Sample invoice downloads on the Demo emails page: only the attachments of known test emails are served.
describe("sample invoice downloads", () => {
  it("serves the attachment of a known test email", () => {
    const f = sampleFile("S7")!;
    expect(f.filename).toBe("S07_Sharma_SKE-119_SCANNED.pdf");
    expect(f.content_type).toBe("application/pdf");
    expect(new TextDecoder().decode(f.bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("refuses anything that is not a test id, including path tricks", () => {
    for (const id of ["S99", "../vendors", "..%2Fvendors", "S1/../../package", ""]) expect(sampleFile(id)).toBeNull();
  });
});
