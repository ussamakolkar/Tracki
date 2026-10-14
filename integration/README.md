# Connecting Parsable CV to Tracki

The goal: **you save a CV in Parsable CV → a dialogue box asks whether to add that
job to the tracker → saying yes writes it to the tracker sheet.**

Pick whichever of these matches how Parsable CV is built. They can be combined;
Tracki will not ask twice about the same CV.

| Parsable CV is... | Use | Code changes |
|---|---|---|
| anything at all | [A. Folder watching](#a-folder-watching) | none |
| a web page / React / Vue / Flask or Django template | [B. The browser bridge](#b-the-browser-bridge) | one `<script>` line |
| a web page you would rather not edit much | [C. autoHook](#c-autohook) | one `<script>` line |
| Electron or Node | [D. The Node hook](#d-the-node-hook) | one `require` |
| Python (Flask, Streamlit, Tk, a script) | [E. The Python hook](#e-the-python-hook) | one import |
| none of the above | [F. The HTTP API](#f-the-http-api-directly) | one HTTP POST |

**Before you start:** have Tracki running (`npm start`, or `start-tracki.bat`), and
try the dialogue at <http://127.0.0.1:4321/integration/demo-parsable-cv.html> so you
know what you are aiming for.

---

## A. Folder watching

No code changes at all.

1. Open **Settings** in Tracki.
2. Paste the folder Parsable CV saves CVs into, e.g.
   `D:\claude code repo\Parsable CV\output`.
3. Tick *Ask me about a job whenever a CV is saved there* and save.

When a CV file lands in that folder, the Tracki window raises the dialogue. Tracki
fills in what it can work out, in this order:

1. **Structured data** — a `.json` CV, or a `.json` sidecar next to the PDF/DOCX.
   It recognises the obvious key names (`jobTitle`, `role`, `position`, `company`,
   `companyName`, `employer`, `jobUrl`, `postingUrl`, `location`, …) at any nesting depth.
2. **Text** — `.txt`, `.md`, `.html`: lines like `Role: …`, `Company: …`, `Apply: …`,
   and the first URL it finds.
3. **The filename** — `Acme-Corp_Senior-Engineer_v2.pdf` becomes company
   *Acme Corp*, role *Senior Engineer*.

Anything it cannot work out is simply left blank for you to type in the dialogue.
It waits for the file to stop growing before reading it, so a CV still being
written is never half-parsed.

The easiest way to make this accurate is to have Parsable CV write a small JSON
file beside each CV:

```json
{ "jobTitle": "Senior Backend Engineer", "companyName": "Acme Corp",
  "jobUrl": "https://acme.com/jobs/42", "location": "Manchester" }
```

---

## B. The browser bridge

For a Parsable CV with a web UI. Add one line to its page:

```html
<script src="http://127.0.0.1:4321/integration/tracki-bridge.js"></script>
```

Served straight from Tracki, so there is no file to copy and it stays in step with
the app. (Prefer a local copy? Copy `tracki-bridge.js` next to your page and point
the `src` at it.)

Then call `Tracki.onCvSaved(...)` when your save finishes:

```js
async function saveCv() {
  const file = await myExistingSaveRoutine();     // whatever you do today

  Tracki.onCvSaved({
    role:       document.querySelector('#role').value,
    company:    document.querySelector('#company').value,
    jobUrl:     document.querySelector('#jobUrl').value,
    location:   document.querySelector('#location').value,
    cvVersion:  'CV_backend_v3',
    cvFilePath: file.path,
    notes:      'Tailored for the Kubernetes bullet points',
  });
}
```

Every field is optional — pass what you have. The dialogue appears in the Parsable
CV window with those values pre-filled and editable, warns you if the job is
already tracked, and on **Add to Tracki** writes it straight to the tracker.

`onCvSaved` returns a promise: the new job, or `null` if you declined.

```js
const job = await Tracki.onCvSaved({ role, company });
if (job) console.log('tracked as', job.id);
```

### The rest of the API

```js
Tracki.ping()                  // -> {app, version, jobs} or null if Tracki is not running
Tracki.addJob({role, company}) // add with no dialogue at all
Tracki.ask({role, company})    // just show the dialogue
Tracki.open()                  // open the Tracki window
Tracki.configure({ origin: 'http://127.0.0.1:4321', mode: 'dialog', defaultStatus: 'Applied' })
```

`mode: 'queue'` asks in the Tracki window instead of in your page — useful if a
modal would get in the way of your own save flow.

If Tracki is not running the dialogue still appears and says so, so you can start
Tracki and press the button again. The bridge never throws into your save path.

---

## C. autoHook

Same `<script>` line, but no changes to your save code. Mark your save button:

```html
<button id="save" data-tracki-save>Save CV</button>
<script src="http://127.0.0.1:4321/integration/tracki-bridge.js" data-auto-hook="true"></script>
```

Tracki waits for your own click handler to finish, then asks. It reads the job
details from `data-tracki-*` attributes on the button:

```html
<button data-tracki-save data-tracki-role="Senior Dev" data-tracki-company="Acme">Save CV</button>
```

or, failing that, from inputs on the page named `role`, `jobTitle`, `company`,
`companyName`, `jobUrl` or `location`.

Can't edit the button either? Use `data-auto-hook="heuristics"`, which also
triggers on buttons whose text looks like "Save CV", "Download resume",
"Export PDF". Marking the button is more reliable.

---

## D. The Node hook

For Electron or Node builds of Parsable CV:

```js
const tracki = require('./integration/parsable-cv-hook');

async function afterCvSaved(filePath, details) {
  await tracki.askToTrack({
    role: details.role,
    company: details.company,
    jobUrl: details.jobUrl,
    cvFilePath: filePath,
  });
}
```

In Electron this is a **native dialog box**; elsewhere it queues the prompt and the
Tracki window asks. Also available: `tracki.addJob(details)` (no prompt) and
`tracki.queuePrompt(details)`.

From a batch file or a post-save script:

```bat
node "D:\claude code repo\Tracki\integration\parsable-cv-hook.js" ^
  --role "Senior Dev" --company "Acme" --job-url https://acme.com/jobs/42 ^
  --cv-file "D:\CVs\CV_Acme_v3.pdf"
```

---

## E. The Python hook

Standard library only — no pip install.

```python
import sys
sys.path.append(r"D:\claude code repo\Tracki\integration")
from tracki_hook import ask_to_track

def after_cv_saved(path, role, company, job_url):
    ask_to_track(role=role, company=company, job_url=job_url, cv_file_path=path)
```

With Tk available this is a native yes/no dialog box; without it the prompt is
queued for the Tracki window. It never raises — a tracker that is not running must
not break a CV save — it returns `{"error": ...}` instead.

Also available: `add_job(...)` (no prompt) and `queue_prompt(...)`. It works as a
command too:

```bash
python tracki_hook.py --role "Senior Dev" --company "Acme" --cv-file "D:\CVs\cv.pdf"
```

---

## F. The HTTP API directly

One POST to `http://127.0.0.1:4321/api/intake`:

```jsonc
// Ask in the Tracki window:
{ "role": "Senior Dev", "company": "Acme", "jobUrl": "https://acme.com/jobs/42",
  "cvFilePath": "D:\\CVs\\CV_Acme_v3.pdf" }
// -> 202 {"queued": true, "pendingId": "...", "suggestion": {...}, "duplicate": null}

// Already asked yourself, the answer was yes:
{ "confirm": true, "role": "Senior Dev", "company": "Acme" }
// -> 201 {"added": true, "job": {...}}

// Just tell me what you know, queue nothing (this is what the dialogue uses):
{ "ask": true, "role": "Senior Dev", "company": "Acme" }
// -> 200 {"asking": true, "suggestion": {...}, "duplicate": {...}|null}
```

Fields: `role`, `company`, `jobUrl`, `location`, `cvVersion`, `cvFilePath`,
`notes`, `salaryMin`, `salaryMax`, `source`. All optional; `role` and `company` are
required only at the point a job is actually created. Add `"job": {"status": "Applied"}`
with `confirm` to set any other tracker field.

A duplicate returns **409** — resend with `"allowDuplicate": true` to add it anyway.

Only localhost pages may call the API. If Parsable CV is served from some other
origin, add it to `allowedOrigins` in `tracki.config.json`.

---

## Troubleshooting

**The dialogue never appears.** Is Tracki running? Open
<http://127.0.0.1:4321/api/ping> — you should see `{"app":"tracki",...}`.
In a browser console, `await Tracki.ping()` should return the same.

**"This origin is not allowed to talk to Tracki" (403).** Parsable CV is served
from a non-localhost origin. Add it to `allowedOrigins` in `tracki.config.json`
and restart Tracki.

**The folder watcher does nothing.** Check the path in Settings — Tracki shows an
error there if the folder does not exist. Files already in the folder when Tracki
starts are treated as history, not new saves; save a fresh CV to test. On a network
drive, folder watching can be unreliable — use the bridge instead.

**It asks twice.** It should not: a job added for a CV file clears any prompt still
queued for that same file. If it happens, the two paths are passing different
`cvFilePath` values — pass the same full path from both.

**Role and company come through empty.** That is the filename fallback doing its
best. Either pass the fields explicitly (B–F) or write a JSON sidecar (A). You can
always type them into the dialogue.

**Port 4321 is taken.** Set `"port"` in `tracki.config.json`, then update the
`<script src>` in Parsable CV to match.
