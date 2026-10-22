# Five-minute demo: first draft (mentor, 22 Oct)

A starting point to rehearse against, not a final script. Timings assume the deployed app with the Neon demo
database and the real Gemini extractor, started from `npm run demo:reset`. Say it in your own words.

| Time | Show | Say (the point, not a script) |
|---|---|---|
| 0:00-0:30 | Dashboard, empty | SpiceRoute's AP desk gets supplier invoices by email. The expensive mistakes are paying a price nobody agreed, paying twice, and paying into a changed bank account. |
| 0:30-1:40 | Demo emails: send S1, open it | The run appears without a click. Step 1 (dashed) is the only AI step: it reads. Steps 2-9 are code: every value is found in the PDF text, the vendor and bank match the master, prices match the PO within 2%. Cleared by checks is a recommendation; approve it, export the payment list (CSV). |
| 1:40-2:30 | Send S2 | A known vendor, but the bank account printed differs from the master. Held, with both last-4s and the instruction to call the number in the vendor master, never the one on the invoice. |
| 2:30-3:50 | Send S3, request correction, send S4 | Tomatoes billed 5% above the PO price: held. The correction email is written by code from the findings and carries a reference. The vendor's reply with that reference passes every check, so S3 is replaced automatically and S4 is cleared. Without the reference (X2) a person must confirm the link. |
| 3:50-4:30 | Send S7 (or S14) | A scan: values come from the image only, so it is always held for a human check, and the PO was inferred because none was printed. (S14: the AI proposed a line match; code checked the pack size against the catalog before accepting it.) |
| 4:30-5:00 | Rules page, then a test summary | Rules and reference data are visible. Trust: 18 golden scenarios pass and agree with an independent oracle; the same suite runs on Postgres; concurrent invoices on one PO cannot both clear (T16). Limits: demo identity is not authentication; scans are never auto-cleared. |

Edge cases to keep ready for questions: S5 (duplicate with a reformatted number, rejected), S6b (second delivery
over the PO quantity), S8 (unknown vendor, unregistered sender), S9 (quotation skipped), S12 (lump sum).

Before recording: send each demo email once on the deployed app, then reset. Readings are cached in Postgres by
file, prompt and model, so the recorded demo never waits on a slow model call. Check the header shows Gemini and
Postgres, not MOCK or in memory.
