import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLiveJobs, clearLiveJobsCache, adzunaCountries } from '../src/services/liveJobs.js';

const realFetch = globalThis.fetch;
const urls = [];

beforeEach(() => {
  clearLiveJobsCache();
  urls.length = 0;
  process.env.ADZUNA_APP_ID = 'id';
  process.env.ADZUNA_APP_KEY = 'key';
  globalThis.fetch = (url) => {
    const u = String(url);
    urls.push(u);
    const country = /jobs\/([a-z]{2})\//.exec(u)?.[1];
    if (country === 'ca') return Promise.resolve(new Response('unavailable', { status: 503 }));
    return Promise.resolve(new Response(JSON.stringify({
      results: [{ id: country + '1', title: 'Dev ' + country, company: { display_name: 'Co' }, location: { display_name: country }, redirect_url: `https://www.adzuna.com/land/${country}`, created: '2026-10-14T00:00:00Z', description: 'x' }]
    }), { status: 200 }));
  };
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.ADZUNA_APP_ID;
  delete process.env.ADZUNA_APP_KEY;
  delete process.env.ADZUNA_COUNTRY;
});

describe('Adzuna multi-country', () => {
  it('parses and validates ADZUNA_COUNTRY', () => {
    process.env.ADZUNA_COUNTRY = 'US, gb ,xx,in,us';
    assert.deepEqual(adzunaCountries(), ['us', 'gb', 'in']);
    process.env.ADZUNA_COUNTRY = 'zz';
    assert.deepEqual(adzunaCountries(), ['us']);
  });

  it('queries every country, keeps total results at 25 or fewer, and survives one failing country', async () => {
    process.env.ADZUNA_COUNTRY = 'us,gb,ca,au,in';
    const r = await fetchLiveJobs({ sources: ['adzuna'], query: 'dev' });
    assert.equal(urls.length, 5);
    assert.ok(urls.every(u => /results_per_page=5(&|$)/.test(u)), 'per-country page size');
    assert.equal(r.sources[0].status, 'ok');
    assert.deepEqual(r.jobs.map(j => j.tags[0]).sort(), ['AU', 'GB', 'IN', 'US']);
  });
});
