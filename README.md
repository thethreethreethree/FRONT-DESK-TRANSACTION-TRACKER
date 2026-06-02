# Frendz Hostel El Nido — Front Desk Transaction Tracker

A clean, tamper-evident replacement for the front-desk deposit spreadsheet.
Staff record guest **deposits** (towel / padlock / hair dryer) and **refunds**;
the app keeps a running, locked **Cash On Hand (COH)** that cannot be edited or
fudged — only built up from the transactions themselves.

No build step, no framework, no server required. It's a single static web app
(vanilla JS + custom CSS) that runs from `localStorage` and hosts on **GitHub Pages**.

---

## Why COH can't be manipulated

This is the whole point of the tool. Three layers:

1. **COH is derived, never typed.** `COH = Σ deposits − Σ refunds`. There is no
   editable Cash-On-Hand field anywhere — so it can't be over-typed by accident
   or on purpose.
2. **The ledger is append-only.** There is no edit and no delete. A mistake is
   corrected by appending a **reversal** (a "void"), which requires the **Manager
   PIN** and a written reason. The original entry and its reversal both stay in
   the record forever.
3. **Every entry is hash-chained.** Each transaction stores
   `hash = sha256(entry + previousHash)`. If anyone edits the stored data out of
   band, the chain breaks and the app shows **"⚠ integrity broken @ #N"**,
   pointing straight at the altered row. (Verified against FIPS-180 test vectors.)

Plus a reconciliation view that always ties back to COH and **flags refunds that
don't match a recorded deposit** (name/room typos, or refunds of pre-system
deposits) — the kind of slip a paper sheet hides.

> Honest scope: a serverless app is **tamper-evident**, not tamper-proof. It
> fully prevents *unintentional* manipulation and casual fudging, and makes
> deeper tampering visible. Committing the JSON backup to this Git repo adds a
> second, independent tamper-evident history (Git's own hash chain).

---

## Run it locally

```bash
node serve.mjs          # → http://localhost:3000
```

(Or any static server. The app also works opened directly, but a server is
recommended so ES modules and the logo load cleanly.)

First launch walks you through a one-time **setup**: set a Manager PIN, an
optional Staff PIN, and choose to start with sample data (mirrors the Feb 3–9
sheet) or empty.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**,
   branch `main`, folder `/ (root)`.
3. Open the published URL (e.g. `https://<you>.github.io/<repo>/`).

That's it — it's all static files. Front-desk staff just bookmark the URL.

---

## Roles

| Role | Can do |
|------|--------|
| **Staff** | Record deposits & refunds, view dashboard / ledger / outstanding, close shifts |
| **Manager** | Everything staff can, **plus** void/correct entries, configure items & amounts, export/import & reset data |

PINs are stored only as salted SHA-256 hashes, never in plain text.

## Data & backup

- **Live data** lives in the browser's `localStorage` on the front-desk device.
- **GitHub backup (built in).** In *Settings → GitHub backup*, set the owner,
  repo, branch and path, paste a token, and either click **Back up now** or tick
  **Auto-backup when a shift is closed**. Each backup is a commit, so **Git
  history becomes a durable, dated, off-device audit trail** — independent of the
  app's own hash chain.
- **Local file backup.** *Settings → Export backup* downloads a versioned JSON
  snapshot; **Import backup** restores it (and re-verifies integrity).

### Setting up GitHub backup (one time)

1. Create a repo for backups (a **private** repo is recommended).
2. GitHub → *Settings → Developer settings → Fine-grained personal access
   tokens* → **Generate new token**, scoped to **only that repo**, with
   **Repository permissions → Contents: Read and write**.
3. In the app: *Settings → GitHub backup* → fill owner/repo, paste the token,
   **Test connection**, then **Back up now**. The token is stored only in this
   device's `localStorage` and is never included in any export.

---

## Project layout

```
index.html            App shell (loads styles + the ES-module app)
styles.css            Frendz brand styling (gold #F5B324 / charcoal)
serve.mjs             Tiny static dev server
brand_assets/         Frendz logos
app/
  util.js             Helpers + verified SHA-256
  store.js            THE ENGINE: append-only hash-chained ledger, derived COH,
                      integrity verify, shifts, items, reconciliation
  seed.js             Optional demo data (Feb 3–9)
  components.js       Modal / confirm / manager-PIN gate
  main.js             Bootstrap, setup/login, nav, shifts & settings
  views/              dashboard · deposit · refund · ledger · outstanding
```

## The deposit model (from the real sheet)

Guests pay a cash deposit to borrow an item and get it back on return / checkout:

| Item | Default deposit |
|------|-----------------|
| Towel | ₱200 |
| Padlock | ₱100 |
| Hair Dryer | ₱500 |

Items and amounts are **manager-configurable** in Settings.
