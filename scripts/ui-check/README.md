# Browser checks

Real clicks in a real browser (Playwright, Chromium) against a local copy of the app. Each result is checked through the API afterwards, not taken from the screen.

**They run only against a local server with the in-memory store and the MOCK reader.** `flows.mjs` starts by removing every invoice, so `lib.mjs` refuses to run when:

- the address is not `http://localhost:<port>`, or
- the server reports a database or a real AI reader.

The vitest suite (`npm test`) covers the rules and the services. These scripts cover what only a browser shows: dialogs, focus, layout and the screens' wording.

## What they check

| Script | What it does |
|---|---|
| `flows.mjs` | Empties every workspace, replays S1 to S14, then works through the UI. |
| `states.mjs` | Loading, error and empty states, injected in the browser only. |
| `shoot.mjs` | Screenshots of every screen at 1440, 834 and 390 px. |
| `sandboxes.mjs` | Two visitors in two browsers: a private sandbox each, switching to the shared inbox and back, and "Start again" in a sandbox. Empties every workspace first. |

Every visitor works in a private sandbox (demo workspaces). `flows.mjs`, `states.mjs` and `shoot.mjs` work in one
fixed sandbox, `sb-uicheckflows` (`UI_CHECK_WS` changes it), so their API calls and their browser see the same
invoices. Run them in the order below: `sandboxes.mjs` empties that sandbox too.

`flows.mjs` covers:

- a refused action with no name chosen
- the measured timings
- the desk's counts, due dates and due-date sort
- a correction request
- the bank override with its call record and second confirmation
- reject
- the lump-sum override
- process as invoice
- batch approval
- export
- the audit log download
- the S4 correction replacing S3
- next/previous
- the phone menu
- axe-core WCAG 2.1 A/AA on each screen and dialog

`states.mjs` covers:

- the list failing to load
- the server not answering
- an unknown link
- empty views
- a search with no match
- an in-flight reading
- the phone dialog and its focus trap
- the focus ring

`shoot.mjs` also fails on sideways scroll or a console error.

`sandboxes.mjs` checks each result through the API with that visitor's own cookie:

- two visitors get two different sandboxes; the cookies are httpOnly and SameSite=Lax
- the side menu says which workspace you are in and switches
- a replay in one sandbox is not seen in the other or in the shared inbox
- the same recorded email creates a run in each sandbox, each starting at A0001
- a link to another sandbox's invoice says so
- "Start again" in a sandbox opens a new one and deletes nothing
- the shared inbox's "Start again" warns that it empties every sandbox
- the phone menu shows the workspace line

## Run them (PowerShell)

The app must start **without** `DATABASE_URL` and `GEMINI_API_KEY`. Next.js reads `.env.local` on start, so move it aside first if it holds those values.

```powershell
Rename-Item .env.local .env.local.off       # only if it has DATABASE_URL or GEMINI_API_KEY
npm run build
# in a second terminal, from the project folder:  npx next start -p 3100
npm i --no-save playwright axe-core          # not app dependencies; package.json is unchanged
npx playwright install chromium
node scripts/ui-check/flows.mjs
node scripts/ui-check/states.mjs
node scripts/ui-check/shoot.mjs
node scripts/ui-check/sandboxes.mjs
Rename-Item .env.local.off .env.local        # put it back; stop the server when done
```

Screenshots go to `out/ui-check/` (git-ignored). Each script exits with 1 if a check fails.

- If axe-core is missing, the accessibility checks print SKIP and never count as passed.
- `B=http://localhost:4000` points the scripts at another port.
- `UI_CHECK_MODULES=<folder>\node_modules` loads Playwright from somewhere else.
