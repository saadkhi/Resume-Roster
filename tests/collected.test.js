import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCollectedJobs, siteLabel } from '../src/services/collectedJobs.js';
import { fetchLiveJobs, clearLiveJobsCache, providerEnabled, PROVIDERS } from '../src/services/liveJobs.js';

const ROW = {
  unique_hash: 'abc123', site: 'indeed', title: 'Python Developer', company: 'Acme', location: 'Lahore, PK',
  job_type: 'fulltime', is_remote: false, workplace_type: 'onsite', job_url: 'https://pk.indeed.com/viewjob?jk=1',
  description: 'Build APIs with Python and SQL', min_amount: 90000, max_amount: 120000, currency: 'USD', salary_period: 'yearly',
  date_posted: new Date('2026-10-14T00:00:00Z'), first_seen_at: new Date('2026-10-15T00:00:00Z'), tags: 'python;sql'
};

describe('fetchCollectedJobs', () => {
  it('maps collector rows and labels the real job board', async () => {
    const jobs = await fetchCollectedJobs({ q: '' }, async () => ({ rows: [ROW] }));
    assert.equal(jobs.length, 1);
    const j = jobs[0];
    assert.equal(j.sourceName, 'Indeed');
    assert.equal(j.salary, '$90k – 120k / yr');
    assert.equal(j.remote, false);
    assert.deepEqual(j.tags, ['onsite', 'fulltime', 'python', 'sql']);
    assert.equal(j.url, ROW.job_url);
  });

  it('parameterises search terms and escapes LIKE wildcards (no SQL injection)', async () => {
    let seen;
    await fetchCollectedJobs({ q: "python'; DROP TABLE jobs;-- 100%_x" , remote: true }, async (sql, values) => {
      seen = { sql, values };
      return { rows: [] };
    });
    assert.ok(!seen.sql.includes('DROP'), 'user text must never be spliced into SQL');
    assert.ok(seen.values.length > 0 && seen.values.length <= 6);
    assert.ok(seen.values.some(v => v.includes('100\\%\\_x')), 'wildcards escaped');
    assert.match(seen.sql, /is_remote IS TRUE/);
    assert.match(seen.sql, /LIMIT 200/);
  });

  it('returns no jobs when the collector table does not exist yet', async () => {
    const err = Object.assign(new Error('relation "jobs" does not exist'), { code: '42P01' });
    const jobs = await fetchCollectedJobs({}, async () => { throw err; });
    assert.deepEqual(jobs, []);
  });

  it('propagates other database errors', async () => {
    await assert.rejects(() => fetchCollectedJobs({}, async () => { throw new Error('connection refused'); }), /connection refused/);
  });

  it('knows common job board names', () => {
    assert.equal(siteLabel('zip_recruiter'), 'ZipRecruiter');
    assert.equal(siteLabel('some_new_board'), 'some new board');
  });
});

describe('collected provider wiring', () => {
  const saved = process.env.DATABASE_URL;
  beforeEach(() => clearLiveJobsCache());
  after(() => {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    delete process.env.COLLECTED_JOBS;
  });

  it('is enabled only when a database is configured and not switched off', () => {
    const p = PROVIDERS.find(x => x.id === 'collected');
    delete process.env.DATABASE_URL;
    assert.equal(providerEnabled(p), false);
    process.env.DATABASE_URL = 'postgresql://u:p@localhost/db';
    assert.equal(providerEnabled(p), true);
    process.env.COLLECTED_JOBS = 'off';
    assert.equal(providerEnabled(p), false);
  });

  it('is not queried when disabled', async () => {
    delete process.env.DATABASE_URL;
    const r = await fetchLiveJobs({ sources: ['collected'] });
    assert.equal(r.sources.length, 0);
  });
});
