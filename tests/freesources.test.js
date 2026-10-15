import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLiveJobs, clearLiveJobsCache } from '../src/services/liveJobs.js';
import { db } from '../src/db/index.js';

const realFetch = globalThis.fetch;
const calls = [];
let routes = {};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const KEYS = ['JSEARCH_API_KEY', 'SERPAPI_KEY', 'USAJOBS_API_KEY', 'USAJOBS_EMAIL', 'JSEARCH_PER_MONTH', 'SERPAPI_PER_MONTH'];

beforeEach(() => {
  clearLiveJobsCache();
  db.usage._reset();
  calls.length = 0;
  routes = {};
  for (const k of KEYS) delete process.env[k];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [needle, h] of Object.entries(routes)) if (u.includes(needle)) return Promise.resolve(typeof h === 'function' ? h(u, init) : h);
    return Promise.resolve(json({}, 404));
  };
});

after(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) delete process.env[k];
});

describe('Landing.jobs and Hacker News', () => {
  it('normalises Landing.jobs postings', async () => {
    routes = {
      'landing.jobs/api/v1/jobs': () => json([{
        id: 1, title: 'Senior Java Developer', url: 'https://landing.jobs/at/acme-labs/senior-java-lisbon', remote: false,
        locations: [{ city: 'Lisbon', country_code: 'PT' }], gross_salary_low: 50000, gross_salary_high: 67000, currency_code: 'EUR',
        tags: ['Java', 'Kafka'], type: 'Full-time', published_at: '2026-10-01T00:00:00Z', role_description: '<p>Build services</p>'
      }])
    };
    const r = await fetchLiveJobs({ sources: ['landingjobs'] });
    const j = r.jobs[0];
    assert.equal(j.company, 'Acme Labs');
    assert.equal(j.location, 'Lisbon, PT');
    assert.equal(j.salary, '€50k – 67k');
    assert.deepEqual(j.tags, ['Java', 'Kafka', 'Full-time']);
  });

  it('parses "Company | Role | Location | Remote" posts from the latest Who is hiring thread', async () => {
    routes = {
      'author_whoishiring': () => json({ hits: [
        { objectID: '111', title: 'Ask HN: Who wants to be hired? (October 2026)' },
        { objectID: '222', title: 'Ask HN: Who is hiring? (October 2026)' }
      ] }),
      'tags=comment%2Cstory_222': () => json({ hits: [
        { objectID: '900', parent_id: 222, created_at: '2026-10-14T10:00:00Z', comment_text: 'NeuralFrame | Senior Backend Engineer (Python) | REMOTE (US) | Full-time<p>We build things. Email jobs@neuralframe.io' },
        { objectID: '901', parent_id: 900, created_at: '2026-10-14T11:00:00Z', comment_text: 'a reply, not a job post' }
      ] })
    };
    const r = await fetchLiveJobs({ sources: ['hnhiring'], query: 'python' });
    assert.equal(r.total, 1, 'replies are excluded');
    const j = r.jobs[0];
    assert.equal(j.company, 'NeuralFrame');
    assert.equal(j.title, 'Senior Backend Engineer (Python)');
    assert.equal(j.remote, true);
    assert.equal(j.url, 'https://news.ycombinator.com/item?id=900');
    assert.ok(calls.some(c => c.url.includes('query=python')));
  });
});

describe('free-tier keyed sources', () => {
  it('JSearch: sends RapidAPI headers, maps LinkedIn/Indeed publisher, and stops at the monthly cap', async () => {
    process.env.JSEARCH_API_KEY = 'rapid-key';
    process.env.JSEARCH_PER_MONTH = '3';
    routes = {
      'jsearch.p.rapidapi.com': () => json({ data: [{
        job_id: 'j1', job_title: 'Data Engineer', employer_name: 'Globex', job_city: 'Austin', job_state: 'TX', job_country: 'US',
        job_is_remote: false, job_description: 'Build pipelines', job_apply_link: 'https://www.linkedin.com/jobs/view/1',
        job_posted_at_datetime_utc: '2026-10-14T00:00:00Z', job_min_salary: 120000, job_max_salary: 150000, job_salary_currency: 'USD',
        job_publisher: 'LinkedIn', job_employment_type: 'FULLTIME'
      }] })
    };
    const r = await fetchLiveJobs({ sources: ['jsearch'], query: 'data engineer' });
    assert.equal(r.jobs[0].tags[0], 'via LinkedIn');
    assert.equal(r.jobs[0].salary, 'USD 120k – 150k');
    const headers = calls.find(c => c.url.includes('jsearch')).init.headers;
    assert.equal(headers['X-RapidAPI-Key'], 'rapid-key');
    assert.equal(headers['X-RapidAPI-Host'], 'jsearch.p.rapidapi.com');

    for (const q of ['a1', 'a2', 'a3', 'a4', 'a5']) await fetchLiveJobs({ sources: ['jsearch'], query: q });
    assert.equal(calls.filter(c => c.url.includes('jsearch')).length, 3, 'never exceeds the monthly cap');
    const over = await fetchLiveJobs({ sources: ['jsearch'], query: 'another' });
    assert.match(over.sources[0].error, /request limit/);
  });

  it('SerpApi Google Jobs: maps results and converts relative dates', async () => {
    process.env.SERPAPI_KEY = 'serp-key';
    routes = {
      'serpapi.com/search.json': () => json({ jobs_results: [{
        job_id: 's1', title: 'QA Engineer', company_name: 'Initech', location: 'Remote', via: 'via Indeed', description: 'Test things',
        detected_extensions: { posted_at: '3 days ago', schedule_type: 'Full-time', work_from_home: true },
        apply_options: [{ title: 'Indeed', link: 'https://www.indeed.com/viewjob?jk=1' }]
      }] })
    };
    const r = await fetchLiveJobs({ sources: ['serpapi'], query: 'qa' });
    const j = r.jobs[0];
    assert.equal(j.remote, true);
    assert.equal(j.tags[0], 'via Indeed');
    const days = (Date.now() - new Date(j.postedAt).getTime()) / 86_400_000;
    assert.ok(days > 2.9 && days < 3.1);
    assert.ok(calls[0].url.includes('api_key=serp-key') && calls[0].url.includes('engine=google_jobs'));
  });

  it('USAJOBS: needs both key and email, and sends the required headers', async () => {
    process.env.USAJOBS_API_KEY = 'usa-key';
    const without = await fetchLiveJobs({ sources: ['usajobs'] });
    assert.equal(without.sources.length, 0, 'disabled without USAJOBS_EMAIL');
    process.env.USAJOBS_EMAIL = 'me@example.com';
    routes = {
      'data.usajobs.gov': () => json({ SearchResult: { SearchResultItems: [{ MatchedObjectDescriptor: {
        PositionID: 'ABC-1', PositionTitle: 'IT Specialist', OrganizationName: 'Dept of Energy',
        PositionLocationDisplay: 'Washington, DC', PositionURI: 'https://www.usajobs.gov/job/1',
        PublicationStartDate: '2026-10-10', PositionRemuneration: [{ MinimumRange: '90000', MaximumRange: '120000' }],
        UserArea: { Details: { JobSummary: 'Support systems' } }
      } }] } })
    };
    const r = await fetchLiveJobs({ sources: ['usajobs'], query: 'it' });
    assert.equal(r.jobs[0].company, 'Dept of Energy');
    assert.equal(r.jobs[0].salary, '$90k – 120k');
    const h = calls[0].init.headers;
    assert.equal(h['Authorization-Key'], 'usa-key');
    assert.equal(h['User-Agent'], 'me@example.com');
  });
});
