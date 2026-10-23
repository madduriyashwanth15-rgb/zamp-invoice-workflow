// Display only: name the model once. The stored label ("Gemini gemini-3.5-flash-lite (extract-v3)") is kept as it
// is on the run and in the audit trail; screens show "gemini-3.5-flash-lite, prompt extract-v3" (review gap 8).

/** A model id for display: "gemini-3.5-flash-lite" as is, any other id prefixed "Gemini ". */
export function modelName(model: string): string {
  return /^gemini/i.test(model.trim()) ? model.trim() : `Gemini ${model.trim()}`;
}

/** A reader label for display, with the model named once; labels in any other form are returned unchanged. */
export function readerLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const m = /^Gemini\s+(\S+)\s*(?:\(([^)]+)\))?$/i.exec(label.trim());
  if (!m) return label;
  const model = modelName(m[1]);
  return m[2] ? `${model}, prompt ${m[2]}` : model;
}
