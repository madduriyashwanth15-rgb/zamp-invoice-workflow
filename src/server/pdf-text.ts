import { extractText, getDocumentProxy } from "unpdf";

// Text layer for V3 and V4 (spec 2: has_text_layer = at least 50 extracted characters; images have none).
// Server-side only; the domain receives the text, never the file.

export const MIN_TEXT_LAYER_CHARS = 50;

export interface TextLayer {
  text: string;
  characters: number;
  has_text_layer: boolean;
  pages: number;
  /** Set when the file claims to be a PDF but cannot be opened; the caller records the run as SKIPPED UNSUPPORTED_FILE. */
  unreadable?: string;
}

/** Never throws: a damaged PDF comes back with `unreadable` set. NUL characters are removed (Postgres text cannot hold them). */
export async function readTextLayer(bytes: Uint8Array, contentType: string): Promise<TextLayer> {
  if (contentType !== "application/pdf") return { text: "", characters: 0, has_text_layer: false, pages: 1 };
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text: raw } = await extractText(pdf, { mergePages: true });
    const text = raw.replace(/\u0000/g, "");
    const characters = text.replace(/\s/g, "").length;
    return { text, characters, has_text_layer: characters >= MIN_TEXT_LAYER_CHARS, pages: totalPages };
  } catch (e) {
    return { text: "", characters: 0, has_text_layer: false, pages: 0, unreadable: `the PDF could not be opened (${e instanceof Error ? e.message : String(e)})` };
  }
}
