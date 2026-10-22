import { getDocumentProxy } from "unpdf";

// Text layer for V3 and V4 (spec 2: has_text_layer = at least 50 extracted characters; images have none).
// Server-side only; the domain receives the text, never the file.
//
// Limits (audit A08): a small hostile PDF can expand to tens of megabytes of text and minutes of work, and the
// text is stored with the run. So no more than MAX_PAGES pages, MAX_TEXT_CHARS characters and PARSE_BUDGET_MS of
// work: a document over the page or time limit is refused (SKIPPED UNSUPPORTED_FILE); text over the character
// limit is cut there, and any value printed after the cut fails V3 (held), so the cut can only hold, never clear.

export const MIN_TEXT_LAYER_CHARS = 50;
export const MAX_PAGES = 50;
export const MAX_TEXT_CHARS = 200_000;
export const PARSE_BUDGET_MS = 15_000;

export interface TextLayer {
  text: string;
  characters: number;
  has_text_layer: boolean;
  pages: number;
  /** True when the text was cut at MAX_TEXT_CHARS. */
  truncated?: boolean;
  /** Set when the file claims to be a PDF but cannot be read; the caller records the run as SKIPPED UNSUPPORTED_FILE. */
  unreadable?: string;
}

/** Same whitespace rules as unpdf's mergePages, so the text (and V3) is unchanged for ordinary invoices. */
function mergePages(texts: string[]): string {
  return texts.join("\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

type TextItem = { str?: string; hasEOL?: boolean };

/** Never throws: a damaged, oversized or too slow PDF comes back with `unreadable` set. NUL characters are removed. */
export async function readTextLayer(bytes: Uint8Array, contentType: string, now: () => number = Date.now): Promise<TextLayer> {
  if (contentType !== "application/pdf") return { text: "", characters: 0, has_text_layer: false, pages: 1 };
  const unreadable = (pages: number, why: string): TextLayer => ({ text: "", characters: 0, has_text_layer: false, pages, unreadable: why });
  const started = now();
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
    const pages = pdf.numPages;
    if (pages > MAX_PAGES) return unreadable(pages, `the PDF has ${pages} pages; at most ${MAX_PAGES} are read`);
    const texts: string[] = [];
    let total = 0;
    let truncated = false;
    for (let n = 1; n <= pages && !truncated; n++) {
      const page = await pdf.getPage(n);
      const reader = page.streamTextContent().getReader();
      let pageText = "";
      for (;;) {
        if (now() - started > PARSE_BUDGET_MS) {
          await reader.cancel(new Error("time limit")); // pdf.js needs an Error as the reason
          return unreadable(pages, `reading the PDF's text took longer than ${PARSE_BUDGET_MS / 1000} s`);
        }
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of (value as { items: TextItem[] }).items) {
          if (item.str == null) continue;
          pageText += item.str + (item.hasEOL ? "\n" : "");
        }
        if (total + pageText.length > MAX_TEXT_CHARS) {
          pageText = pageText.slice(0, MAX_TEXT_CHARS - total);
          truncated = true;
          await reader.cancel(new Error("character limit"));
          break;
        }
      }
      total += pageText.length;
      texts.push(pageText);
    }
    const text = mergePages(texts).replace(/\u0000/g, "").slice(0, MAX_TEXT_CHARS);
    const characters = text.replace(/\s/g, "").length;
    return { text, characters, has_text_layer: characters >= MIN_TEXT_LAYER_CHARS, pages, ...(truncated ? { truncated } : {}) };
  } catch (e) {
    return unreadable(0, `the PDF could not be opened (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
}
