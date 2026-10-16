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

describe('htmlToText repairs', () => {
  it('strips HTML that arrived HTML-escaped', () => {
    const escaped = '&lt;div class="x"&gt;&lt;p&gt;About &lt;strong&gt;WPP&lt;/strong&gt; production&lt;/p&gt;&lt;/div&gt;';
    assert.equal(htmlToText(escaped), 'About WPP production');
  });
  it('repairs UTF-8 mojibake', () => {
    assert.equal(htmlToText('Qu\u00c3\u00a9 es esto, tambi\u00c3\u00a9n'), 'Qu\u00e9 es esto, tambi\u00e9n');
  });
  it('leaves normal accented text alone', () => {
    assert.equal(htmlToText('Caf\u00e9 \u2013 M\u00fcnchen'), 'Caf\u00e9 \u2013 M\u00fcnchen');
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

describe('new keyless sources', () => {
  it('parses We Work Remotely RSS (CDATA, entities, company prefix)', async () => {
    const rss = '<?xml version="1.0"?><rss><channel><item>' +
      '<title><![CDATA[Acme Corp: Senior Python Engineer]]></title>' +
      '<region>Anywhere in the World</region><type>Full-Time</type><skills>Python, SQL</skills>' +
      '<category>Programming</category>' +
      '<description>&lt;p&gt;Build &lt;b&gt;things&lt;/b&gt; &amp;amp; ship&lt;/p&gt;</description>' +
      '<pubDate>Wed, 14 Oct 2026 10:00:00 +0000</pubDate>' +
      '<link>https://weworkremotely.com/remote-jobs/acme-python</link><guid>https://weworkremotely.com/remote-jobs/acme-python</guid>' +
      '</item></channel></rss>';
    behaviour = { 'weworkremotely.com': () => new Response(rss, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } }) };
    const r = await fetchLiveJobs({ sources: ['weworkremotely'] });
    assert.equal(r.total, 1);
    const j = r.jobs[0];
    assert.equal(j.title, 'Senior Python Engineer');
    assert.equal(j.company, 'Acme Corp');
    assert.equal(j.summary, 'Build things & ship');
    assert.equal(j.remote, true);
    assert.deepEqual(j.tags.slice(0, 3), ['Programming', 'Full-Time', 'Python']);
  });

  it('pulls company boards from Greenhouse, Lever and Ashby and tolerates a failing company', async () => {
    process.env.GREENHOUSE_BOARDS = 'acme, broken';
    process.env.LEVER_BOARDS = 'globex-corp';
    process.env.ASHBY_BOARDS = 'initech';
    try {
      behaviour = {
        'boards/acme/jobs': () => json({ jobs: [{ id: 1, title: 'Backend Engineer', company_name: 'Acme', location: { name: 'Remote - US' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', first_published: '2026-10-10T00:00:00Z' }] }),
        'boards/broken/jobs': () => json({}, 500),
        'postings/globex-corp': () => json([{ id: 'l1', text: 'Data Analyst', categories: { location: 'Berlin', team: 'Data' }, hostedUrl: 'https://jobs.lever.co/globex-corp/l1', createdAt: 1792000000000, descriptionPlain: 'SQL and dashboards' }]),
        'job-board/initech': () => json({ jobs: [{ id: 'a1', title: 'Designer', location: 'Paris', isRemote: false, jobUrl: 'https://jobs.ashbyhq.com/initech/a1', publishedAt: '2026-10-12T00:00:00Z', department: 'Design' }] })
      };
      const r = await fetchLiveJobs({ sources: ['greenhouse', 'lever', 'ashby'] });
      const byId = Object.fromEntries(r.sources.map(s => [s.id, s]));
      assert.equal(byId.greenhouse.status, 'ok');
      assert.equal(byId.lever.count, 1);
      assert.equal(byId.ashby.count, 1);
      const titles = r.jobs.map(j => j.title).sort();
      assert.deepEqual(titles, ['Backend Engineer', 'Data Analyst', 'Designer']);
      assert.equal(r.jobs.find(j => j.source === 'lever').company, 'Globex Corp');
      assert.equal(r.jobs.find(j => j.source === 'greenhouse').remote, true);
    } finally {
      delete process.env.GREENHOUSE_BOARDS;
      delete process.env.LEVER_BOARDS;
      delete process.env.ASHBY_BOARDS;
    }
  });

  it('rejects unsafe board slugs', async () => {
    process.env.GREENHOUSE_BOARDS = '../etc/passwd, good-co';
    try {
      behaviour = { 'boards/good-co/jobs': () => json({ jobs: [] }) };
      await fetchLiveJobs({ sources: ['greenhouse'] });
      assert.ok(calls.every(c => !c.includes('passwd')));
      assert.ok(calls.some(c => c.includes('boards/good-co/jobs')));
    } finally {
      delete process.env.GREENHOUSE_BOARDS;
    }
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
    assert.deepEqual(keyless, [
      'aidevboard', 'aijobs', 'arbeitnow', 'ashby', 'curatorsearch', 'freehire', 'greenhouse', 'himalayas',
      'hnhiring', 'jobicy', 'landingjobs', 'lever', 'remoteok', 'remotive', 'themuse', 'weworkremotely', 'workingnomads'
    ]);
    const keyed = PROVIDERS.filter(p => p.envKeys);
    assert.ok(keyed.length >= 4);
    for (const p of keyed) assert.equal(providerEnabled(p), false);
  });
});
