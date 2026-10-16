# Collector (formerly Scrabeee)

> This directory is the job collector of the Resume Rater project (it used to be the separate `scrabeee` repository). Run all commands below from inside `collector/`. The scheduled workflow lives at `../.github/workflows/collector.yml`.

Scrabeee collects technology job listings from configured sources, normalizes
their fields, filters verifiably old postings, deduplicates repeated source
records, and stores jobs in SQLite or a configured SQLAlchemy database.

It is a command-line collector, not a web dashboard. It does not claim that
remote jobs accept candidates in Pakistan unless the source says so.

## Source support and verification

All adapters target Python 3.11 in a local/Replit CLI run or the scheduled
GitHub Actions workflow. No provider credentials are configured. Successful run
timestamps and errors are written to `source_health.json`. The existing
2026-10-12 history records successful fetches from Remote OK and We Work
Remotely, but all fetched listings were rejected by the one-hour freshness
filter. The 2026-10-14 live attempt was stopped after LinkedIn returned repeated
HTTP 429 responses and did not produce a completed run summary. The older
JobSpy history aggregates boards, so it cannot establish a last-success time
for any individual JobSpy board.

| Source | Availability | Auth and extra configuration | Restrictions and scope | Verification and last success |
| --- | --- | --- | --- | --- |
| Remote OK | Implemented; public JSON API | No API key configured for the public endpoint | Attribute Remote OK and link the original posting; source-provided URL is retained | Last completed run: 2026-10-12 09:59 UTC; 99 records fetched, all rejected by the 1-hour freshness filter, none inserted |
| We Work Remotely | Implemented; publisher RSS feed | No credentials configured | Use the publisher's feed and retain its original posting link | Last completed run: 2026-10-12 09:59 UTC; 89 records fetched, all rejected by the 1-hour freshness filter, none inserted |
| Hacker News hiring thread | Implemented; official Firebase API | No credentials configured | Checks a bounded set of current-month Ask HN stories/comments; only explicit company and role labels are accepted. Community posts are lower confidence | Last completed run: 2026-10-12; current-month thread was not found in the latest 200 stories |
| LinkedIn (`linkedin`) | JobSpy 1.3.0 adapter | Selected by `JOBSPY_SITES`; no provider credentials configured | Provider access controls/rate limits may block or restrict automated collection | Live attempt on 2026-10-14 received repeated HTTP 429 responses and was stopped; no successful run recorded |
| Indeed (`indeed`) | JobSpy 1.3.0 adapter | Requires a mapped `country_indeed`; selected by `JOBSPY_SITES` | Skipped for remote and unmapped-location searches; subject to provider access controls | Adapter parameters and skip behavior covered by tests; historical JobSpy results were aggregated, so no per-board last-success time is available |
| Glassdoor (`glassdoor`) | JobSpy 1.3.0 adapter | Requires a mapped `country_indeed`; selected by `JOBSPY_SITES` | Skipped for remote and unmapped-location searches; upstream notes day-level posting-age precision and provider limits | Adapter parameters and skip behavior covered by tests; historical JobSpy results were aggregated, so no per-board last-success time is available |
| ZipRecruiter (`zip_recruiter`) | JobSpy 1.3.0 adapter | Selected by `JOBSPY_SITES`; no provider credentials configured | Upstream documents US/Canada coverage; access controls may vary | Package identifier verified; historical JobSpy results were aggregated, so no per-board last-success time is available |
| Bayt (`bayt`) | JobSpy 1.3.0 adapter | Selected by `JOBSPY_SITES`; no provider credentials configured | Results depend on the country and listings supported by the provider | Package identifier verified; historical JobSpy results were aggregated, so no per-board last-success time is available |
| BDJobs (`bdjobs`) | JobSpy 1.3.0 adapter | Selected by `JOBSPY_SITES`; no provider credentials configured | Bangladesh-focused board; location coverage applies | Package identifier verified; historical JobSpy results were aggregated, so no per-board last-success time is available |
| Naukri (`naukri`) | JobSpy 1.3.0 adapter | Selected by `JOBSPY_SITES`; no provider credentials configured | India-focused board; location coverage applies | Package identifier verified; historical JobSpy results were aggregated, so no per-board last-success time is available |
| HelloWork (`hellowork`) | JobSpy 1.3.0 adapter | Selected by `JOBSPY_SITES`; no provider credentials configured | France-focused; French search terms may be more effective | Package identifier verified; historical JobSpy results were aggregated, so no per-board last-success time is available |
| Google Jobs (`google`) | Disabled | Not configurable | JobSpy's upstream README says Google Jobs is currently unavailable | Rejected during configuration; no run or last-success timestamp |

JobSpy's current README says it supports Python 3.10 or newer and documents the
`scrape_jobs(site_name=..., search_term=..., location=...)` interface. It also
notes that Indeed and Glassdoor require `country_indeed`; the adapter skips
those two for remote searches and for locations without a verified country
mapping rather than sending misleading country settings. JobSpy's own scraping
may be rate-limited or blocked. No CAPTCHA handling, browser stealth, or access
control bypass is implemented.

## Architecture

1. `config.py` loads and validates environment configuration.
2. Source adapters in `scrapers/` fetch independently. The JobSpy adapter runs
   per configured query/location; public feeds are fetched once per run.
3. `utils/normalization.py` maps source data into one schema and rejects records
   without a title, company, and valid URL. Unknown dates remain unknown.
4. `utils/fingerprints.py` produces stable SHA-256 identities from source,
   company, title, and canonicalized URL.
5. `db.py` persists jobs and per-source run metadata using SQLAlchemy. Workers
   do not write to SQLite; a single persistence stage runs after collection.
6. `utils/exports.py` writes normalized CSV/JSON data and source health. Logs
   are emitted as JSON to the console and `output/scraper.log`.

## Requirements and local setup

Python 3.11+ is recommended. The pinned dependencies are in `requirements.txt`;
the PostgreSQL driver is included for projects that set a PostgreSQL URL.

```bash
python -m pip install -r requirements.txt
cp .env.example .env
python main.py --init-db
```

Edit `.env` to set the queries, locations, enabled sources, and storage. `.env`
is ignored by Git. No API keys are required for the configured public feeds.

To run one collection:

```bash
python main.py
```

To run tests and lint:

```bash
pytest
ruff check .
ruff format --check .
```

Tests mock all source HTTP and JobSpy calls; they do not scrape websites.

## Configuration

`SEARCH_QUERIES` and `SEARCH_LOCATIONS` are comma-separated. Defaults include
technology roles and remote, Pakistan, UK, US, Canada, Germany, Netherlands,
Italy, UAE, and Saudi Arabia. Set only the searches you want to run. JobSpy's
result limit applies per configured site and search; actual result counts vary.

Operational variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `JOBSPY_SITES` | `indeed,zip_recruiter` | Verified JobSpy identifiers; Google is rejected as unavailable. |
| `ENABLED_SOURCES` | Remote OK, WWR, HN | Comma-separated names: `remote_ok,we_work_remotely,hacker_news`. |
| `MAX_RESULTS_PER_QUERY` | `30` | Requested result cap for each configured JobSpy site/search. |
| `JOB_MAX_AGE_HOURS` | `72` | Reject dated listings older than this threshold. Undated listings are retained and explicitly not freshness-verified. |
| `REQUEST_TIMEOUT_SECONDS` | `20` | Timeout for custom-feed HTTP requests. |
| `MAX_RETRIES` | `3` | Bounded retries for transport, 429, and selected 5xx errors; 403 is not retried. |
| `BACKOFF_BASE_SECONDS` / `BACKOFF_MAX_SECONDS` | `1` / `30` | Exponential retry delay limits. `Retry-After` is honored up to the configured maximum. |
| `MAX_CONCURRENT_REQUESTS` | `4` | Bounded outer fetch workers. JobSpy can create its own internal workers. |
| `MAX_EXECUTION_SECONDS` | `1800` | Collection deadline; network/library calls still have their own timeout behavior. |
| `HN_MAX_COMMENTS` | `300` | Maximum hiring-thread comments checked per run. |
| `HN_STORY_SCAN_LIMIT` | `200` | Maximum recent Ask HN stories checked for the current hiring thread. |
| `DATABASE_URL` | `sqlite:///jobs.db` | SQLAlchemy URL; use a persistent PostgreSQL service for scheduled runs. |
| `OUTPUT_DIR` | `output` | Directory for exports and logs. |
| `EXPORT_FORMATS` | `csv,json` | Select `csv`, `json`, or both. |
| `ENABLE_CSV_EXPORT` / `ENABLE_JSON_EXPORT` | `true` | Disable one output without changing the format list. |
| `LOG_LEVEL` | `INFO` | Standard Python logging level. |
| `PROXIES_LIST` | unset | Optional one authorized HTTP(S) proxy. Multiple proxies are rejected; rotation is deliberately not supported. |

`DATABASE_URL` may contain credentials in your local `.env` or a GitHub Actions
secret. Do not commit credentials or print their values. Query examples and
locations in `.env.example` are plain text and can be changed without modifying
the scraper.

### Database, backup, and retention

SQLite is appropriate for local runs and small single-writer deployments:

```text
DATABASE_URL=sqlite:///jobs.db
```

Back up `jobs.db` while the collector is not writing to it. Restore by placing
the backup at the configured database path. The collector creates tables on
startup; schema changes are not currently versioned with migrations.

GitHub-hosted Actions runners are temporary. The default SQLite database does
**not** persist to the next scheduled run; artifact uploads are downloadable
backups, not a database restore mechanism. For deduplication across scheduled
runs, configure a persistent PostgreSQL `DATABASE_URL` as a repository or
organization Actions secret. SQLite and PostgreSQL are supported by the ORM,
but PostgreSQL deployment connectivity has not been verified here.

## Twice-daily GitHub Actions

`../.github/workflows/collector.yml` runs at 12:00 AM and 12:00 PM Asia/Karachi
(19:00 and 07:00 UTC) and supports manual dispatch. The Replit `Job collector`
workflow remains a manual, one-cycle run. To preserve jobs across scheduled
runs, configure the Actions secret `DATABASE_URL` with a persistent PostgreSQL
connection string. Optional repository variables can override `SEARCH_QUERIES`,
`SEARCH_LOCATIONS`, `JOBSPY_SITES`, and `ENABLED_SOURCES`. Never set credentials
as repository variables.

Actions schedule start times are approximate and may be delayed by GitHub.
Runs are serialized, time-limited, and upload logs/exports even on failure.
Actions run lint and unit tests before collection. The workflow does not commit
database changes to the repository.

## Exports and source health

- `jobs.db`: local SQLite database when using the default URL.
- `output/jobs.csv`: UTF-8 BOM CSV with spreadsheet formula cells escaped.
- `output/jobs.json`: normalized job records, dates in ISO-8601 UTC.
- `output/source_health.json`: recent per-source run counts and errors.
- `output/scraper.log`: structured JSON logs for the current process.

`jobs` includes source ID, source, title, company, location, job type, nullable
remote/workplace flags, original URL, description, optional salary/currency/
period, posting date, first/last seen and created/updated timestamps, and tags.
Missing source dates and eligibility are not guessed.

## Troubleshooting and limitations

- A source can return an empty result, be unavailable, or reject automated
  requests. Check `source_health.json` and `scraper.log`; a failure from one
  source does not stop results from another.
- JobSpy's per-site behavior and search coverage can change upstream. Google
  Jobs is currently unavailable. Indeed/Glassdoor need explicit country context;
  unsupported location mappings are skipped.
- Hacker News is a community source. To avoid inventing fields, its adapter
  only accepts posts with explicit `Company:` and `Role:` (or `Position:`)
  labels or a `Company | Role | Location` header line, and links to the exact HN comment. It is not a conventional job board.
- The public RSS/feed integrations do not establish whether a role accepts
  applicants in Pakistan. Verify location and work authorization on the original
  listing.
- Live tests are intentionally opt-in and are not part of normal CI. The unit
  suite uses mocked responses; only Remote OK's public endpoint was reachable
  during implementation research, not a full collection run.
- No license was present in the import. Choose and add a license before
  distributing this repository as open source. Contributions should include
  source-attribution and policy considerations, tests with mocked responses,
  and documentation of any newly verified integrations.

## Adding a source

Implement the `SourceAdapter` shape in `scrapers/base.py`: a stable `name` and
`fetch(query, location)` returning normalized source dictionaries plus error
metadata in `SourceResult`. Add it to `_default_adapters()` in `main.py`, add
mocked HTTP tests under `tests/`, and document its official interface and
verification status here. Do not bypass access controls or overstate support.

## Jobs API (for Resume-Roster and other clients)

A read-only FastAPI service exposes the collected jobs from the same
`DATABASE_URL` the collector writes to. Point it at the shared PostgreSQL
database so it sees every scheduled run.

```bash
uvicorn api:create_app --factory --host 0.0.0.0 --port 8000
```

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Same database as the collector. |
| `API_KEY` | If set, `/jobs*` and `/sources` require an `X-API-Key` header. Set it in production. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API. Not needed for server-to-server calls (Resume-Roster's Express backend). |

Endpoints (interactive docs at `/docs`):

- `GET /health` — liveness and job count (no key needed).
- `GET /jobs` — newest first. Query params: `q` (title/company/description/tags),
  `location`, `source`, `job_type`, `workplace_type`, `remote`,
  `posted_within_hours`, `limit` (1-200, default 50), `offset`,
  `include_description`. Returns `{total, limit, offset, items[]}`.
- `GET /jobs/{id}` — one job including its description.
- `GET /sources` — job counts per source.

Example from Resume-Roster's Node backend:

```js
const res = await fetch(`${process.env.SCRABEEE_API_URL}/jobs?q=python&limit=50`, {
  headers: { "X-API-Key": process.env.SCRABEEE_API_KEY },
});
const { total, items } = await res.json();
```
