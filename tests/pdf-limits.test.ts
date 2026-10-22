import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { TEST_DATA_DIR } from "@/fixtures/load";
import { MAX_PAGES, MAX_TEXT_CHARS, PARSE_BUDGET_MS, readTextLayer } from "@/server/pdf-text";

// Audit A08: a small hostile PDF expanded to 23 M characters (31.9 s, 850 MB) and 13,000 pages reached 2 GB.
// The reader now stops at page, character and time limits. Ordinary invoices must read exactly as before.

/** A minimal valid PDF: `pages` pages, each drawing `ops` text operations (a long content stream). */
function makePdf(pages: number, ops: number): Uint8Array {
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + 2 * i} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const body = `BT /F1 10 Tf ${"1 0 0 1 20 400 Tm (Invoice line text ABCDEFGHIJ) Tj ".repeat(ops)} ET`; // every run drawn inside the page
  for (let i = 0; i < pages; i++) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("PDF reading limits (audit A08)", () => {
  it("every test invoice reads exactly as unpdf's own text extraction did before the limits", async () => {
    const dir = path.join(TEST_DATA_DIR, "invoices");
    const pdfs = readdirSync(dir).filter((f) => f.endsWith(".pdf"));
    expect(pdfs.length).toBeGreaterThanOrEqual(17);
    for (const f of pdfs) {
      const bytes = new Uint8Array(readFileSync(path.join(dir, f)));
      const before = (await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true })).text.replace(/\u0000/g, "");
      const now = await readTextLayer(bytes, "application/pdf");
      expect(now.text, f).toBe(before);
      expect(now.unreadable, f).toBeUndefined();
    }
  });

  it(`more than ${MAX_PAGES} pages is refused at once, without reading them`, async () => {
    const t0 = Date.now();
    const r = await readTextLayer(makePdf(MAX_PAGES + 10, 1), "application/pdf");
    expect(r.unreadable).toMatch(new RegExp(`${MAX_PAGES + 10} pages; at most ${MAX_PAGES}`));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it(`text beyond ${MAX_TEXT_CHARS.toLocaleString("en")} characters is refused, not cut (wording past a cut would go unseen)`, async () => {
    const r = await readTextLayer(makePdf(3, 4_000), "application/pdf"); // about 360,000 characters
    expect(r.unreadable).toMatch(/more than 2,00,000 characters of text/);
    expect(r.text).toBe("");
  });

  it("the time budget covers opening the file and loading each page, not only reading text", async () => {
    let clock = 0;
    const r = await readTextLayer(makePdf(1, 10), "application/pdf", () => (clock += PARSE_BUDGET_MS / 2));
    expect(r.unreadable).toMatch(/took longer than/);
  });

  it(`work beyond ${PARSE_BUDGET_MS / 1000} s is stopped and the file refused`, async () => {
    let clock = 0;
    const r = await readTextLayer(makePdf(2, 50), "application/pdf", () => (clock += PARSE_BUDGET_MS)); // each check sees time pass
    expect(r.unreadable).toMatch(/took longer than/);
  });

  it("a file that is not a PDF at all is refused, not thrown", async () => {
    const r = await readTextLayer(new TextEncoder().encode("<html>not a pdf</html>"), "application/pdf");
    expect(r.unreadable).toMatch(/could not be opened/);
  });
});
