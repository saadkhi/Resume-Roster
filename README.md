# Resume Rater

A free ATS-style resume checker. Upload a PDF resume and a job description and get:

- a **match score**: the share of the job's important vocabulary (IDF-weighted) that appears in your resume
- **keyword gaps**: the high-value terms you have not mentioned
- an **ATS-readiness checklist**: contact details, standard sections, length, measurable results
- a **skill radar** by resume section, and a re-scoring tool for trying other jobs

Aimed at job seekers, students and career-changers. Scores are keyword-based estimates, not a simulation of any specific employer's ATS, and should not be used for hiring decisions.

## How scoring works

| Output | Definition |
|---|---|
| Match score | Weighted coverage of the job's top 30 terms. Each term's weight is `(1 + ln tf) × idf`, with IDF learned from `data/gpt_dataset.csv`. |
| Rating | High ≥ 60%, Medium ≥ 35%, otherwise Low (calibrated against the bundled sample resumes). |
| Skills / Experience / Projects | The same coverage computed only on that resume section. A section that is not detected scores 0 and is flagged as "Not detected". |
| Similarity | Raw TF-IDF cosine similarity between resume and job text, shown unscaled. |
| Likely field | Nearest category centroid from the training CSV; reported as "Uncertain" when evidence is weak. |

Nothing is padded or floored to look better: a resume with no matching vocabulary scores 0.

## Privacy model

- Uploaded PDFs are processed **in memory** and never written to disk.
- Resume text is returned to the browser and is **never stored** by the server.
- Anonymous users persist nothing.
- Signed-in users get history of **metadata only** (file name, field, score, rating, missing keywords). They can delete it from the UI (`DELETE /api/history`).

## Security model

- Identity comes only from a **signed, httpOnly session cookie** issued after the server verifies a Supabase access token (`POST /api/auth/session`). Request bodies, headers and plain cookies are never trusted as identity.
- `/api/admin/*` requires a verified admin token (email matches `ADMIN_EMAIL`) or the `ADMIN_OVERRIDE_KEY` header (timing-safe compare).
- Strict CSP (`script-src 'self'`), no inline scripts, same-origin guard on state-changing requests, rate limits on all API routes, PDF magic-byte validation and a 4 MB cap.

## Setup

```bash
git clone <repo-url>
cd Resume-Roster
npm install
cp .env.example .env.local   # fill in values (all optional for local use)
npm run build                # bundles the radar, vendors the Supabase client, generates samples
npm start                    # http://localhost:3000
```

With no environment variables the app runs fully: analysis works and sign-in is disabled.

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs the session cookie. **Required** (≥16 chars) in production for sign-in to be enabled. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Enables Google / GitHub / Microsoft / email sign-in. |
| `DATABASE_URL` | Mirrors evaluation metadata to Postgres. Without it, history is kept in an ephemeral local store. |
| `DATABASE_SSL_CA` | Optional CA certificate (PEM) to verify the database server. |
| `ADMIN_EMAIL`, `ADMIN_OVERRIDE_KEY` | Operator access to `/api/admin/*`. |
| `CONTACT_EMAIL` | Shown on the legal pages (optional). |

Apply `scripts/init-supabase-schema.sql` to your database (the app also runs it on connect). If an older deployment stored resume text, purge it once with the `UPDATE` statement in that file.

## Scripts

```bash
npm run dev      # start the server
npm run build    # build assets and sample resumes
npm test         # node:test suites (44 tests: NLP, sessions, HTTP/security)
npm run lint     # ESLint
```

## Deployment (Vercel)

Set the environment variables above in the project settings and push. Vercel runs `npm run build` and routes everything through `api/index.js`. Uploads are limited to 4 MB to stay under Vercel's 4.5 MB request body ceiling.

On serverless hosting the local store is ephemeral. Configure `DATABASE_URL` for durable history.

## Project layout

```
server.js                        Express app and routes
src/services/nlp.js              Tokenising, TF-IDF, classifier, scoring, ATS checks (pure functions)
src/services/resumeParser.js     PDF extraction, section parsing, analysis pipeline
src/services/auth.js             Supabase token verification
src/services/jobs.js             Sample role matching
src/middleware/session.js        Signed session cookies
src/middleware/admin.js          Operator auth
src/middleware/security.js       Headers, CSRF guard, rate limits
src/db/                          Local store + Postgres mirror, sample role fixture
src/MatchVisualizer.jsx          Radar chart (bundled by esbuild)
views/, public/                  EJS pages, CSS, browser scripts
tests/                           node:test suites
```

## Notes

- The "Sample roles" tab uses a bundled fixture of fictional roles for demonstration. It is not a live job feed.
- Sample resumes in `uploads/` are fictional and generated by `scripts/create-sample-resumes.js`.
- PDF only. Scanned (image-only) PDFs are rejected with a clear message because they contain no extractable text.
