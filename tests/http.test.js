import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.ADMIN_OVERRIDE_KEY = 'override-key-for-tests';
process.env.RR_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-')), 'db.json');
delete process.env.DATABASE_URL;

const { app } = await import('../server.js');

let server;
let base;

before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); });

const samplePdf = () => fs.readFileSync(new URL('../uploads/sample-data-scientist.pdf', import.meta.url));
const readDb = () => (fs.existsSync(process.env.RR_DB_PATH) ? fs.readFileSync(process.env.RR_DB_PATH, 'utf8') : '');

const json = (url, body, headers = {}) => fetch(`${base}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

async function register(email, password = 'correct horse battery') {
  const res = await json('/api/auth/register', { email, password, name: 'Test User' });
  return { res, cookie: cookieOf(res) };
}

describe('pages and headers', () => {
  it('serves the home page with a strict CSP and no inline scripts', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    const html = await res.text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/);
    assert.doesNotMatch(html, /\sonclick=|\sonload=/);
  });

  it('does not render any demo data before analysis', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /Saad|candidate@example\.com/i);
  });

  it('returns JSON 404 for unknown API routes and HTML 404 for pages', async () => {
    const api = await fetch(`${base}/api/nope`);
    assert.equal(api.status, 404);
    assert.equal((await api.json()).success, false);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  it('survives a malformed Cookie header', async () => {
    const res = await fetch(`${base}/`, { headers: { Cookie: 'a=%E0%A4%A' } });
    assert.equal(res.status, 200);
  });
});

describe('accounts', () => {
  it('ignores user_email / x-user-id style signals', async () => {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Cookie: 'user_email=admin@example.com; user_id=usr_admin_saad', 'x-user-id': 'usr_admin_saad' }
    });
    assert.equal((await res.json()).authenticated, false);
  });

  it('registers, sets an httpOnly session, and exposes the user', async () => {
    const { res, cookie } = await register('alice@example.com');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(res.headers.get('set-cookie'), /SameSite=Lax/i);
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.user.email, 'alice@example.com');
  });

  it('rejects duplicate emails, bad emails and weak passwords', async () => {
    assert.equal((await register('Alice@Example.com')).res.status, 409);
    assert.equal((await json('/api/auth/register', { email: 'nope', password: 'longenough1' })).status, 400);
    assert.equal((await json('/api/auth/register', { email: 'bob@example.com', password: 'short' })).status, 400);
  });

  it('logs in with the right password and gives a generic error otherwise', async () => {
    const ok = await json('/api/auth/login', { email: 'ALICE@example.com', password: 'correct horse battery' });
    assert.equal(ok.status, 200);
    const wrong = await json('/api/auth/login', { email: 'alice@example.com', password: 'wrong password' });
    const unknown = await json('/api/auth/login', { email: 'ghost@example.com', password: 'wrong password' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal((await wrong.json()).error, (await unknown.json()).error);
  });

  it('never stores the plaintext password', () => {
    const stored = readDb();
    assert.doesNotMatch(stored, /correct horse battery/);
    assert.ok(stored.includes('scrypt$16384'));
  });
});

describe('history and privacy', () => {
  it('requires sign-in', async () => {
    assert.equal((await fetch(`${base}/api/history`)).status, 401);
    assert.equal((await fetch(`${base}/api/history`, { method: 'DELETE' })).status, 401);
  });

  it('saves metadata only, and can be deleted', async () => {
    const { cookie } = await register('carol@example.com');
    const fd = new FormData();
    fd.append('resume', new Blob([samplePdf()], { type: 'application/pdf' }), 'cv.pdf');
    fd.append('job_keywords', 'Data Scientist, Python, SQL, Machine Learning');
    const up = await (await fetch(`${base}/api/parse-resume`, { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
    assert.equal(up.success, true);
    assert.equal(up.persisted, true);
    assert.ok(up.match.percentage >= 80);

    const stored = readDb();
    assert.match(stored, /carol@example\.com/);
    assert.doesNotMatch(stored, /Brightloop|Priya|rawText|sections/i, 'resume content must never be persisted');

    const hist = await (await fetch(`${base}/api/history`, { headers: { Cookie: cookie } })).json();
    assert.equal(hist.items.length, 1);
    assert.equal(hist.items[0].rating, 'High Match');

    const del = await (await fetch(`${base}/api/history`, { method: 'DELETE', headers: { Cookie: cookie } })).json();
    assert.equal(del.removed.evaluations, 1);
    assert.doesNotMatch(readDb(), /carol@example\.com/);
  });

  it('does not persist anything for anonymous users', async () => {
    const before = readDb();
    const fd = new FormData();
    fd.append('resume', new Blob([samplePdf()], { type: 'application/pdf' }), 'cv.pdf');
    fd.append('job_keywords', 'Python');
    const up = await (await fetch(`${base}/api/parse-resume`, { method: 'POST', body: fd })).json();
    assert.equal(up.persisted, false);
    assert.equal(readDb(), before);
  });
});

describe('upload validation', () => {
  const post = (blob, name = 'x.pdf') => {
    const fd = new FormData();
    fd.append('resume', blob, name);
    return fetch(`${base}/api/parse-resume`, { method: 'POST', body: fd });
  };

  it('rejects non-PDF content with a PDF extension', async () => {
    const res = await post(new Blob(['not a pdf at all'], { type: 'application/pdf' }));
    assert.equal(res.status, 400);
  });

  it('rejects files over 4 MB', async () => {
    const big = new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4.5 * 1024 * 1024)])], { type: 'application/pdf' });
    assert.equal((await post(big)).status, 413);
  });

  it('returns 422 for a PDF with no extractable text', async () => {
    const res = await post(new Blob(['%PDF-1.4\n%%EOF\n'], { type: 'application/pdf' }));
    assert.equal(res.status, 422);
  });

  it('requires a file', async () => {
    const res = await fetch(`${base}/api/parse-resume`, { method: 'POST' });
    assert.equal(res.status, 400);
  });
});

describe('csrf and admin', () => {
  it('blocks cross-origin state-changing requests', async () => {
    const res = await json('/api/evaluate-match', { resumeText: 'a', jobDescriptionText: 'b' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });

  it('admin routes reject anonymous, user-session and wrong-key callers', async () => {
    assert.equal((await fetch(`${base}/api/admin/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { Cookie: 'user_email=admin@example.com' } })).status, 401);
    const { cookie } = await register('dave@example.com');
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { 'X-Admin-Key': 'wrong' } })).status, 401);
  });

  it('admin routes accept the override key', async () => {
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { 'X-Admin-Key': 'override-key-for-tests' } })).status, 200);
  });
});

describe('matching API', () => {
  const postJson = (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  it('scores text against a job and returns a checklist', async () => {
    const res = await postJson('/api/evaluate-match', {
      resumeText: 'Python SQL Docker engineer. me@example.com',
      jobDescriptionText: 'Python, SQL, Kubernetes'
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.percentage > 0 && body.percentage < 100);
    assert.ok(Array.isArray(body.checks));
  });

  it('validates input', async () => {
    assert.equal((await postJson('/api/evaluate-match', { resumeText: '' })).status, 400);
  });

  it('serves live jobs through the aggregator without exposing raw descriptions', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => String(url).startsWith(base)
      ? realFetch(url, init)
      : Promise.resolve(new Response(JSON.stringify(
        String(url).includes('remoteok.com')
          ? [{ legal: 'x' }, { id: '9', position: 'Python Engineer', company: 'Acme', description: '<b>python</b>', url: 'https://remoteok.com/9', date: '2026-10-14T00:00:00Z' }]
          : {}
      ), { status: String(url).includes('remoteok.com') ? 200 : 404 }));
    try {
      const res = await postJson('/api/live-jobs', { query: 'python', sources: ['remoteok'], resumeText: 'Python developer SQL' });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.hasResumeMatch, true);
      assert.equal(body.jobs[0].title, 'Python Engineer');
      assert.equal('description' in body.jobs[0], false);
      assert.equal(body.sources[0].status, 'ok');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('apply by email API', () => {
  it('rejects empty or oversized posts', async () => {
    assert.equal((await json('/api/apply/draft', { postText: 'hi' })).status, 400);
    assert.equal((await json('/api/apply/draft', { postText: 'x'.repeat(13000) })).status, 413);
  });

  it('returns extracted details and a draft for a hiring post', async () => {
    const res = await json('/api/apply/draft', {
      postText: 'We are hiring!\nPosition: Data Analyst\nExperience: 2 years with SQL\nApply at: hr@acme-corp.com\nLast date to apply: 1 November 2026',
      senderName: 'Sam Lee'
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.to, 'hr@acme-corp.com');
    assert.equal(body.details.role, 'Data Analyst');
    assert.match(body.subject, /Data Analyst/);
    assert.match(body.body, /Sam Lee/);
    assert.ok(['ai', 'template'].includes(body.source));
  });
});

describe('apply page', () => {
  it('serves /apply as its own page and removes the form from the home page', async () => {
    const apply = await (await fetch(`${base}/apply`)).text();
    assert.match(apply, /id="applyForm"/);
    assert.match(apply, /<h1[^>]*>Apply by email/);
    assert.doesNotMatch(apply, /<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/);
    const home = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(home, /id="applyForm"/);
    assert.match(home, /href="\/apply"/);
  });
});
