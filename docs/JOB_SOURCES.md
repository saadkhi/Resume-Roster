# Job sources

Everything below is pulled live by the server (`src/services/liveJobs.js`) and
shown in the **Live job openings** section. Each source is isolated: one failing
never breaks the others.

## 1. Implemented: free, no key, no registration (15)

| Source | What it covers | How it is fetched | Cache | Notes |
|---|---|---|---|---|
| Remote OK | Remote jobs, worldwide | `remoteok.com/api` (full feed, filtered locally) | 10 min | Terms require a link back + naming the source (done on every card). |
| Arbeitnow | Europe / remote | `arbeitnow.com/api/job-board-api` (feed) | 10 min | |
| The Muse | General, US-heavy | `themuse.com/api/public/jobs` pages 1-3 | 10 min | |
| AI Dev Jobs | AI / ML engineering | `aidevboard.com/api/v1/jobs?q=` | 5 min | Server-side search. |
| Artificial Intelligence Jobs | AI / ML | `artificialintelligencejobs.co/api/jobs?q=` | 5 min | Server-side search. |
| freehire | Aggregates company ATS boards | `freehire.dev/api/v1/jobs`, `/jobs/search?q=` | 5 min | |
| CuratorSearch | Museum and gallery jobs | `curatorsearch.com/api/jobs?q=` | 5 min | Niche; rarely relevant to tech resumes. |
| Remotive | Remote tech / general | `remotive.com/api/remote-jobs` | 6 h | They ask for sparing use, hence the long cache. |
| Jobicy | Remote jobs, with salary | `jobicy.com/api/v2/remote-jobs` | 1 h | |
| Himalayas | Remote jobs, with salary | `himalayas.app/jobs/api[/search]` | 5 min | Server-side search. |
| Working Nomads | Remote jobs | `workingnomads.com/api/exposed_jobs/` | 10 min | |
| We Work Remotely | Remote jobs | RSS: `weworkremotely.com/remote-jobs.rss` | 10 min | |
| Greenhouse boards | Openings at specific companies | `boards-api.greenhouse.io/v1/boards/<slug>/jobs` | 15 min | List: `GREENHOUSE_BOARDS` (default: stripe, airbnb, discord, figma, cloudflare, gitlab, coinbase, robinhood, instacart, dropbox, datadog). The list endpoint has no description, so ranking uses title only. |
| Lever boards | Openings at specific companies | `api.lever.co/v0/postings/<slug>` | 15 min | List: `LEVER_BOARDS` (default: spotify, ro, weride). |
| Ashby boards | Openings at specific companies | `api.ashbyhq.com/posting-api/job-board/<slug>` | 15 min | List: `ASHBY_BOARDS` (default: linear, cursor, sentry, notion, ramp). |

To target other companies, find the slug in the company's careers URL
(`boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`, `jobs.ashbyhq.com/<slug>`)
and set the matching variable to a comma-separated list (max 25 each).

## 2. Implemented: need your details (key or registration)

These are built and switch on automatically when the variables are set.

| Source | Details you must provide | Where to get them | Free? | Env variables |
|---|---|---|---|---|
| Adzuna | App ID + App Key | https://developer.adzuna.com (register, then Dashboard) | Free tier, rate-limited | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, optional `ADZUNA_COUNTRY` (list, e.g. `us,gb,in`) |
| Reed (UK only) | API key | https://www.reed.co.uk/developers | Free | `REED_API_KEY` |
| Jooble | API key (emailed after a request form, ~500 requests default) | https://jooble.org/api/about | Free, approval-based | `JOOBLE_API_KEY` |
| Findwork | API token | https://findwork.dev/developers (free account) | Free, 60 req/min | `FINDWORK_API_KEY` |

The app also protects these quotas itself (Adzuna: 25 results per call and 25
calls per minute; Jooble 150/day; Findwork 30/min; Reed 500/day). Override with
`ADZUNA_PER_MINUTE`, `ADZUNA_PER_DAY`, `JOOBLE_PER_DAY`, `FINDWORK_PER_MINUTE`,
`REED_PER_DAY`.

## 3. Not implemented: would need details, or are not usable

| Source | Why not | What would be required |
|---|---|---|
| USAJOBS (US federal) | Needs a key | Free API key from https://developer.usajobs.gov plus your email address sent in a header. |
| Careerjet | Needs a partner key; API is HTTP-only and wants the visitor's IP | Affiliate ID from https://www.careerjet.com/partners/api/. |
| Jobs2Careers / Talroo, Juju | Publisher accounts | Publisher ID + key, approval by the provider. |
| JobsPipe, Techmap, JobDataLake, Jobven, RankFabrik | Paid or key-gated aggregators | Paid plan / API key. |
| Upwork | OAuth app | Registered OAuth application and per-user consent. |
| Arbeitsagentur (Germany) | Public API but I could not verify access from here | A public client key header (`X-API-Key`); needs testing. |
| NoFluffJobs | Public but the unfiltered response is ~120 MB | Would need server-side filters/paging before it is safe to call. |
| DevITjobs UK, GraphQL Jobs | Endpoints no longer serve a public API | n/a |
| LinkedIn, Indeed, Glassdoor | No public job API; scraping breaks their terms | n/a |
