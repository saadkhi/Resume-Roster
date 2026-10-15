import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLiveJobs, htmlToText, clearLiveJobsCache, PROVIDERS, providerEnabled } from '../src/services/liveJobs.js';

const realFetch = globalThis.fetch;
const calls = [];
let behaviour = {};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeUpstream(url) {
  const u = String(url);
  calls.push(u);
  for (const [needle, handler] of Object.entries(behaviour)) {
    if (u.includes(needle)) return typeof handler === 'function' ? handler(u) : handler;
  }
  return json({}, 404);
}

const REMOTEOK = [
  { legal: 'terms' },
  { id: '1', position: 'Python Backend Engineer', company: 'Acme', description: '<p>Build <b>APIs</b> with Python &amp; SQL</p>', url: 'https://remoteok.com/remote-jobs/1', date: '2026-10-14T00:00:00Z', tags: ['python'], salary_min: 90000, salary_max: 120000 },
  { id: '2', position: 'Sales Lead', company: 'Globex', description: 'Close deals', url: 'javascript:alert(1)', date: '2026-10-13T00:00:00Z' }
];

beforeEach(() => {
  clearLiveJobsCache();
  calls.length = 0;
  behaviour = {};
  globalThis.fetch = (url) => Promise.resolve(fakeUpstream(url));
});

after(() => { globalThis.fetch = realFetch; });

describe('htmlToText', () => {
  it('strips tags, scripts and decodes entities', () => {
    assert.equal(htmlToText('<p>Hi <b>there</b> &amp; welcome</p><script>alert(1)</script>'), 'Hi there & welcome');
  });
  it('caps length', () => {
    assert.equal(htmlToText('a'.repeat(5000), 100).length, 100);
  });
});

describe('fetchLiveJobs', () => {
  it('normalises jobs, drops unsafe urls, and never leaks full descriptions', async () => {
    behaviour = { 'remoteok.com/api': json(REMOTEOK) };
    const r = await fetchLiveJobs({ sources: ['remoteok'] });
    assert.equal(r.total, 1, 'javascript: url must be dropped');
    const job = r.jobs[0];
    assert.equal(job.title, 'Python Backend Engineer');
    assert.equal(job.source, 'remoteok');
    assert.equal(job.salary, '$90k – 120k');
    assert.equal(job.summary, 'Build APIs with Python & SQL');
    assert.equal('description' in job, false);
    assert.ok(job.url.startsWith('https://'));
  });

  it('isolates a failing source and reports it', async () => {
    behaviour = {
      'remoteok.com/api': json(REMOTEOK),
      'arbeitnow.com': json({ error: 'boom' }, 500)
    };
    const r = await fetchLiveJobs({ sources: ['remoteok', 'arbeitnow'] });
    const byId = Object.fromEntries(r.sources.map(s => [s.id, s]));
    assert.equal(byId.remoteok.status, 'ok');
    assert.equal(byId.arbeitnow.status, 'error');
    assert.equal(r.total, 1);
  });

  it('backs off a recently failed source instead of re-requesting it', async () => {
    behaviour = { 'arbeitnow.com': json({}, 503) };
    await fetchLiveJobs({ sources: ['arbeitnow'] });
    const before = calls.length;
    const r = await fetchLiveJobs({ sources: ['arbeitnow'], query: 'x' });
    assert.equal(calls.length, before);
    assert.equal(r.sources[0].status, 'error');
  });

  it('filters feeds locally by query and remote flag', async () => {
    behaviour = {
      'arbeitnow.com': json({ data: [
        { slug: 'a', title: 'Rust Engineer', company_name: 'X', description: 'systems', remote: true, url: 'https://www.arbeitnow.com/a', created_at: 1792000000, location: 'Berlin' },
        { slug: 'b', title: 'Nurse', company_name: 'Y', description: 'care', remote: false, url: 'https://www.arbeitnow.com/b', created_at: 1792000001, location: 'Munich' }
      ] })
    };
    const q = await fetchLiveJobs({ sources: ['arbeitnow'], query: 'rust' });
    assert.deepEqual(q.jobs.map(j => j.title), ['Rust Engineer']);
    const rem = await fetchLiveJobs({ sources: ['arbeitnow'], remote: true });
    assert.deepEqual(rem.jobs.map(j => j.title), ['Rust Engineer']);
  });

  it('passes search terms to sources that support them', async () => {
    behaviour = { 'aidevboard.com': json({ jobs: [] }) };
    await fetchLiveJobs({ sources: ['aidevboard'], query: 'llm engineer', remote: true });
    const url = calls.find(c => c.includes('aidevboard.com'));
    assert.match(url, /q=llm\+engineer/);
    assert.match(url, /remote=true/);
  });

  it('ranks by resume match when a resume is supplied', async () => {
    behaviour = {
      'remoteok.com/api': json([
        { legal: 'x' },
        { id: '1', position: 'Plumber', company: 'Pipes', description: 'fix pipes', url: 'https://remoteok.com/1', date: '2026-10-14T00:00:00Z' },
        { id: '2', position: 'Python Engineer', company: 'Acme', description: 'python sql docker', url: 'https://remoteok.com/2', date: '2026-10-01T00:00:00Z', tags: ['python'] }
      ])
    };
    const r = await fetchLiveJobs({ sources: ['remoteok'], resumeText: 'Python developer with SQL and Docker experience' });
    assert.equal(r.hasResumeMatch, true);
    assert.equal(r.jobs[0].title, 'Python Engineer');
    assert.ok(r.jobs[0].matchPercentage > r.jobs[1].matchPercentage);
  });

  it('de-duplicates identical postings across sources', async () => {
    const same = { title: 'Data Analyst', company: 'Acme' };
    behaviour = {
      'remoteok.com/api': json([{ legal: 'x' }, { id: '1', position: same.title, company: same.company, url: 'https://remoteok.com/1', date: '2026-10-14T00:00:00Z' }]),
      'arbeitnow.com': json({ data: [{ slug: 'z', title: same.title, company_name: same.company, url: 'https://www.arbeitnow.com/z', created_at: 1792000000 }] })
    };
    const r = await fetchLiveJobs({ sources: ['remoteok', 'arbeitnow'] });
    assert.equal(r.total, 1);
  });
});

describe('keyed sources', () => {
  it('Adzuna never asks for more than 25 results and never exceeds 25 requests a minute', async () => {
    process.env.ADZUNA_APP_ID = 'id';
    process.env.ADZUNA_APP_KEY = 'key';
    try {
      behaviour = { 'api.adzuna.com': () => json({ results: [] }) };
      for (let i = 0; i < 40; i++) await fetchLiveJobs({ sources: ['adzuna'], query: 'q' + i });
      const upstream = calls.filter(c => c.includes('api.adzuna.com'));
      assert.equal(upstream.length, 25, 'made ' + upstream.length + ' upstream calls');
      assert.ok(upstream.every(u => /results_per_page=25(&|$)/.test(u)));
      const r = await fetchLiveJobs({ sources: ['adzuna'], query: 'one more' });
      assert.match(r.sources[0].error, /request limit/);
    } finally {
      delete process.env.ADZUNA_APP_ID;
      delete process.env.ADZUNA_APP_KEY;
    }
  });

  it('parses Reed day-first dates correctly', async () => {
    process.env.REED_API_KEY = 'k';
    try {
      behaviour = { 'reed.co.uk': json({ results: [{ jobId: 1, jobTitle: 'Dev', employerName: 'A', locationName: 'London', jobUrl: 'https://www.reed.co.uk/jobs/1', date: '12/09/2026' }] }) };
      const r = await fetchLiveJobs({ sources: ['reed'] });
      assert.equal(r.jobs[0].postedAt.slice(0, 10), '2026-09-12');
    } finally {
      delete process.env.REED_API_KEY;
    }
  });
});

describe('providers', () => {
  it('covers the keyless public-apis job sources and gates keyed ones', () => {
    const keyless = PROVIDERS.filter(p => !p.envKeys).map(p => p.id).sort();
    assert.deepEqual(keyless, ['aidevboard', 'aijobs', 'arbeitnow', 'curatorsearch', 'freehire', 'remoteok', 'themuse']);
    const keyed = PROVIDERS.filter(p => p.envKeys);
    assert.ok(keyed.length >= 4);
    for (const p of keyed) assert.equal(providerEnabled(p), false);
  });
});
