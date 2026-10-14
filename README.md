# Resume Rater

ATS Resume Evaluation Engine — parses PDF resumes, extracts CV sections, predicts candidate category, and computes multi-dimensional match similarity against a target job description using TF-IDF vector space cosine similarity.

## What it actually does

| Feature | Status |
|---|---|
| PDF upload + server-side text extraction | ✓ Working |
| TF-IDF cosine similarity scoring | ✓ Working |
| 20-role industry benchmark presets | ✓ Working |
| 5-dimension Recharts competency radar | ✓ Working |
| CV section parser (Education, Experience, Skills, Projects) | ✓ Working |
| Keyword gap analysis | ✓ Working |
| Job listings tab | ✓ Bundled sample dataset (not a live external feed) |
| Supabase Auth (Google, GitHub, Microsoft, email) | ✓ Working when configured |
| Evaluation history persistence | ✓ Requires `DATABASE_URL` in env (falls back to ephemeral `/tmp` without it) |
| DOCX support | ✗ Not implemented — PDF only |

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd Resume-Roster
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your values. The minimum required to run locally:

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-supabase-anon-key>
```

To enable durable evaluation history, also set:

```
DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
SUPABASE_DB_PASSWORD=<your-db-password>
```

For the admin panel (`/api/admin/*`):

```
ADMIN_EMAIL=<your-email>
ADMIN_OVERRIDE_KEY=<generate with: openssl rand -hex 32>
```

See `.env.example` for all available variables.

### 3. Build the client bundle

```bash
npm run build
```

### 4. Run locally

```bash
npm start
```

App listens on `http://localhost:3000`.

## Development

```bash
npm run dev    # same as npm start
npm run build  # rebuild public/match-visualizer.bundle.js
npm test       # Node built-in test runner (TF-IDF, section parser, admin auth)
npm run lint   # ESLint on server.js + src/
```

## Deployment (Vercel)

1. Set environment variables in Vercel Dashboard → Settings → Environment Variables (use `.env.example` as the reference).
2. Push to `main` — Vercel builds via `npm run build` and routes all requests through `api/index.js`.

**Upload size limit:** Vercel free tier enforces a **4.5 MB** request body limit. The app enforces a **4 MB** client-side and multer limit to stay safely under the ceiling.

## Persistence

On Vercel free tier without a configured database:

- Evaluations are stored in `/tmp` (ephemeral — lost on cold start / between serverless invocations).
- The app shows a visible warning banner when running in this mode.

With `DATABASE_URL` set, evaluations sync to Supabase PostgreSQL via fire-and-forget async writes.

## Project structure

```
server.js          — Express 5 app (all routes, TF-IDF logic, section parser)
src/
  middleware/
    admin.js       — Admin auth (Supabase JWT + override key)
    security.js    — Rate limiters, magic-byte validation, error helpers
  db/
    index.js       — JSON file DB + Supabase sync
    supabase.js    — PostgreSQL pool + sync helpers
    jobs-data.js   — Bundled sample job dataset (28 positions)
  services/
    billing.js     — Subscription middleware (free platform; no paywall)
    jobs.js        — Job listing service
views/
  index.ejs        — Main dashboard
  partials/        — Shared head, header, footer, role-options
  auth.ejs         — Sign in / sign up
  contact.ejs      — Contact form
  terms.ejs        — Terms of service
  privacy.ejs      — Privacy policy
  refund.ejs       — Refund policy
public/
  app.css          — All styles (extracted from index.ejs)
  match-visualizer.bundle.js  — Recharts radar (esbuild bundle)
api/
  index.js         — Vercel serverless function entry point
tests/
  unit.test.js     — Node built-in test runner (17 tests)
```

## Notes

- No paid features, no subscription required, no credit card.
- Resumes are processed **server-side** (not locally in the browser).
- No end-to-end encryption. Data is transmitted over HTTPS and stored in Supabase PostgreSQL when configured.
- The job listings tab reads a **static bundled dataset** — there is no live external job API.
