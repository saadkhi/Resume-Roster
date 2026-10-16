# Resume Rater

A free ATS-style resume checker. Upload a PDF resume and a job description and get:

- a **match score**: the share of the job's important vocabulary (IDF-weighted) that appears in your resume
- **keyword gaps**: the high-value terms you have not mentioned
- an **ATS-readiness checklist**: contact details, standard sections, length, measurable results
- a **skill radar** by resume section, and a re-scoring tool for trying other jobs
- a **Live job openings** section that aggregates postings from several public job APIs and ranks them against your resume

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

## Glass effect

The floating mobile tab bar and the sticky job search bar use [liquidGL](https://github.com/naughtyduk/liquidGL) (MIT, WebGPU with WebGL and CSS fallbacks) for Apple-style liquid-glass refraction. The library is vendored to `public/vendor/liquidGL.js` by `npm run build` and loaded lazily after page load. It is progressive enhancement: every glass surface already has a CSS frosted look, and the effect is skipped for reduced-motion / reduced-transparency users, data-saver, and low-memory devices. Users can switch it off with the footer toggle or `?glass=off`. The CSP allows `worker-src blob:` for the library's rasteriser worker only.

## Apply by email

Paste a recruiter's LinkedIn hiring post into **Apply by email from a LinkedIn post**. The server extracts the role, company, deadline, location, requirements and the apply-to email address (regex, always works), then writes a short, natural application email through [OpenRouter](https://openrouter.ai) (`OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL`, default `openai/gpt-4o-mini`). Without a key you get a clean template draft instead.

The draft is editable. Use **Open in my email app** (mailto), **Open in Gmail**, or **Copy email**, then attach your resume PDF and send it from your own account: the app never sends email itself. The recipient is only ever taken from the pasted post, the model sees only the post facts, your name, an optional note and a few matching skill keywords (never your resume file or full text), and the post is treated as untrusted data in the prompt.

## Live jobs

`GET|POST /api/live-jobs` fans out to the job APIs listed under **Jobs** in [saadkhi/public-apis](https://github.com/saadkhi/public-apis), normalises results to one schema, de-duplicates them, and (when a resume is supplied) ranks by match score. Each source is isolated: a slow or failing source is reported in the response and never breaks the page. Results are cached for a few minutes.

**17 keyless sources** are always on: Remote OK, Arbeitnow, The Muse, AI Dev Jobs, Artificial Intelligence Jobs, freehire, CuratorSearch, Remotive, Jobicy, Himalayas, Working Nomads, We Work Remotely, Landing.jobs, Hacker News "Who is hiring?", and company boards on Greenhouse, Lever and Ashby (company lists configurable with `GREENHOUSE_BOARDS`, `LEVER_BOARDS`, `ASHBY_BOARDS`).

**7 keyed sources** switch on when configured (JSearch, SerpApi and USAJOBS add LinkedIn/Indeed/Glassdoor-via-Google and US federal jobs, with persistent monthly caps): `JSEARCH_API_KEY`, `SERPAPI_KEY`, `USAJOBS_API_KEY` + `USAJOBS_EMAIL`, and Adzuna (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `ADZUNA_COUNTRY` as a list), Reed (`REED_API_KEY`), Jooble (`JOOBLE_API_KEY`), Findwork (`FINDWORK_API_KEY`). The app caps its own usage to stay inside the free tiers.

The complete list, with cache times, required details and everything that was considered but not integrated, is in [docs/JOB_SOURCES.md](docs/JOB_SOURCES.md). Adding a source is one entry in `src/services/liveJobs.js`.

## Privacy model

- Uploaded PDFs are processed **in memory** and never written to disk.
- Resume text is returned to the browser and is **never stored** by the server.
- Anonymous users persist nothing.
- Signed-in users get history of **metadata only** (file name, field, score, rating, missing keywords). They can delete it from the UI (`DELETE /api/history`).

## Security model

- Accounts are email + password. Passwords are stored as salted **scrypt** hashes; login failures are generic and timing-equalized.
- Identity comes only from a **signed, httpOnly session cookie** issued after a successful login. Request bodies, headers and plain cookies are never trusted as identity.
- `/api/admin/*` requires the `ADMIN_OVERRIDE_KEY` secret in `X-Admin-Key` (timing-safe compare). No user session can grant operator access.
- Strict CSP (`script-src 'self'`), no inline scripts, same-origin guard on state-changing requests, rate limits on all API routes, PDF magic-byte validation and a 4 MB cap.

## Setup

```bash
git clone <repo-url>
cd Resume-Roster
npm install
cp .env.example .env.local   # fill in values (all optional for local use)
npm run build                # bundles the radar chart, generates sample resumes
npm start                    # http://localhost:3000
```

With no environment variables the analyzer works fully. Accounts need `SESSION_SECRET`, and on serverless hosts also `DATABASE_URL`.

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs the session cookie. **Required** (≥16 chars) in production for accounts to be enabled. |
| `DATABASE_URL` | Postgres connection string (Neon recommended; use the pooled string). Enables accounts and durable history on serverless hosts. |
| `DATABASE_SSL_CA` | Optional CA certificate (PEM) to pin the database server certificate. |
| `ADMIN_OVERRIDE_KEY` | Optional operator secret (≥16 chars) for `/api/admin/*`. |
| `CONTACT_EMAIL` | Shown on the legal pages (optional). |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Optional: AI-written application emails (template fallback without a key). |
| `ADZUNA_*`, `REED_API_KEY`, `JOOBLE_API_KEY`, `FINDWORK_API_KEY` | Optional: enable extra job sources. |

The schema in `src/db/schema.js` is applied automatically (idempotently) on first connect.

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
src/services/passwords.js        scrypt password hashing
src/services/liveJobs.js         Job-board aggregation, normalisation, ranking
src/middleware/session.js        Signed session cookies
src/middleware/admin.js          Operator auth
src/middleware/security.js       Headers, CSRF guard, rate limits
src/db/                          Postgres (Neon) store with local JSON fallback
src/MatchVisualizer.jsx          Radar chart (bundled by esbuild)
views/, public/                  EJS pages, CSS, browser scripts
tests/                           node:test suites
```

## Notes

- Sample resumes in `uploads/` are fictional and generated by `scripts/create-sample-resumes.js`.
- PDF only. Scanned (image-only) PDFs are rejected with a clear message because they contain no extractable text.
