import { getDocumentProxy } from "unpdf";

// Text layer for V3 and V4 (spec 2: has_text_layer = at least 50 extracted characters; images have none).
// Server-side only; the domain receives the text, never the file.
//
// Limits (audit A08): a small hostile PDF can expand to tens of megabytes of text and minutes of work, and the
// text is stored with the run. So no more than MAX_PAGES pages, MAX_TEXT_CHARS characters and PARSE_BUDGET_MS of
// work, counted from opening the file and covering every page load and read: a document over any limit is refused
// (SKIPPED UNSUPPORTED_FILE). Text is not cut and checked in part, because wording past a cut (a "proforma" mark,
// a bank account) would go unseen and could let an invoice clear; an invoice is never 200,000 characters long.

export const MIN_TEXT_LAYER_CHARS = 50;
export const MAX_PAGES = 50;
export const MAX_TEXT_CHARS = 200_000;
export const PARSE_BUDGET_MS = 15_000;

export interface TextLayer {
  text: string;
  characters: number;
  has_text_layer: boolean;
  pages: number;
  /** Set when the file claims to be a PDF but cannot be read; the caller records the run as SKIPPED UNSUPPORTED_FILE. */
  unreadable?: string;
}

/** Same whitespace rules as unpdf's mergePages, so the text (and V3) is unchanged for ordinary invoices. */
function mergePages(texts: string[]): string {
  return texts.join("\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

type TextItem = { str?: string; hasEOL?: boolean };

class TimeUp extends Error {}

/** `p`, or a TimeUp rejection once `ms` have passed (the timer is always cleared). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => undefined); // work abandoned at the time limit may still fail later (e.g. "Transport destroyed")
  if (ms <= 0) return Promise.reject(new TimeUp());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeUp()), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Never throws: a damaged, oversized or too slow PDF comes back with `unreadable` set. NUL characters are removed. */
export async function readTextLayer(bytes: Uint8Array, contentType: string, now: () => number = Date.now): Promise<TextLayer> {
  if (contentType !== "application/pdf") return { text: "", characters: 0, has_text_layer: false, pages: 1 };
  const unreadable = (pages: number, why: string): TextLayer => ({ text: "", characters: 0, has_text_layer: false, pages, unreadable: why });
  const started = now();
  const left = () => PARSE_BUDGET_MS - (now() - started);
  const tooSlow = (pages: number) => unreadable(pages, `reading the PDF's text took longer than ${PARSE_BUDGET_MS / 1000} s`);
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  let pages = 0;
  const opening = getDocumentProxy(new Uint8Array(bytes));
  try {
    pdf = await within(opening, left());
    pages = pdf.numPages;
    if (pages > MAX_PAGES) return unreadable(pages, `the PDF has ${pages} pages; at most ${MAX_PAGES} are read`);
    const texts: string[] = [];
    let total = 0;
    for (let n = 1; n <= pages; n++) {
      const page = await within(pdf.getPage(n), left());
      const reader = page.streamTextContent().getReader();
      let pageText = "";
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await within(reader.read(), left());
        } catch (e) {
          await reader.cancel(new Error("time limit")).catch(() => undefined); // pdf.js needs an Error as the reason
          throw e;
        }
        if (chunk.done) break;
        for (const item of (chunk.value as { items: TextItem[] }).items) {
          if (item.str == null) continue;
          pageText += item.str + (item.hasEOL ? "\n" : "");
        }
        if (total + pageText.length > MAX_TEXT_CHARS) {
          await reader.cancel(new Error("character limit")).catch(() => undefined);
          return unreadable(pages, `the PDF has more than ${MAX_TEXT_CHARS.toLocaleString("en-IN")} characters of text; an invoice is never this long`);
        }
      }
      total += pageText.length;
      texts.push(pageText);
    }
    const text = mergePages(texts).replace(/\u0000/g, "");
    const characters = text.replace(/\s/g, "").length;
    return { text, characters, has_text_layer: characters >= MIN_TEXT_LAYER_CHARS, pages };
  } catch (e) {
    if (e instanceof TimeUp) {
      // Opening ran out of time: destroy the document as soon as it finishes loading, so it does not linger.
      if (!pdf) opening.then((p) => p.loadingTask.destroy()).catch(() => undefined);
      return tooSlow(pages);
    }
    return unreadable(0, `the PDF could not be opened (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
}
