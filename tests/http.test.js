import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_OVERRIDE_KEY = 'override-key-for-tests';
process.env.RR_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-')), 'db.json');
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { app } = await import('../server.js');
const { setTokenVerifier } = await import('../src/services/auth.js');

let server;
let base;
const users = {
  'token-alice': { id: 'uid-alice', email: 'alice@example.com', name: 'Alice', avatar: '', emailConfirmed: true },
  'token-admin': { id: 'uid-admin', email: 'admin@example.com', name: 'Admin', avatar: '', emailConfirmed: true }
};

before(async () => {
  setTokenVerifier(async (t) => users[t] || null);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); setTokenVerifier(null); });

const samplePdf = () => fs.readFileSync(new URL('../uploads/sample-data-scientist.pdf', import.meta.url));
const readDb = () => (fs.existsSync(process.env.RR_DB_PATH) ? fs.readFileSync(process.env.RR_DB_PATH, 'utf8') : '');

async function signIn(token) {
  const res = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, cookie };
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

describe('identity cannot be spoofed', () => {
  it('ignores user_email / x-user-id style signals', async () => {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Cookie: 'user_email=admin@example.com; user_id=usr_admin_saad', 'x-user-id': 'usr_admin_saad' }
    });
    assert.equal((await res.json()).authenticated, false);
  });

  it('rejects an unverified token and does not set a cookie', async () => {
    const { res, cookie } = await signIn('forged');
    assert.equal(res.status, 401);
    assert.equal(cookie, '');
  });

  it('ignores identity fields in the request body', async () => {
    const res = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', id: 'uid-admin' })
    });
    assert.equal(res.status, 401);
  });

  it('issues an httpOnly session for a verified token', async () => {
    const { res, cookie } = await signIn('token-alice');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(res.headers.get('set-cookie'), /SameSite=Lax/i);
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.user.email, 'alice@example.com');
  });
});

describe('history and privacy', () => {
  it('requires sign-in', async () => {
    assert.equal((await fetch(`${base}/api/history`)).status, 401);
    assert.equal((await fetch(`${base}/api/history`, { method: 'DELETE' })).status, 401);
  });

  it('saves metadata only, and can be deleted', async () => {
    const { cookie } = await signIn('token-alice');
    const fd = new FormData();
    fd.append('resume', new Blob([samplePdf()], { type: 'application/pdf' }), 'cv.pdf');
    fd.append('job_keywords', 'Data Scientist, Python, SQL, Machine Learning');
    const up = await (await fetch(`${base}/api/parse-resume`, { method: 'POST', body: fd, headers: { Cookie: cookie } })).json();
    assert.equal(up.success, true);
    assert.equal(up.persisted, true);
    assert.ok(up.match.percentage >= 80);

    const stored = readDb();
    assert.match(stored, /alice@example\.com/);
    assert.doesNotMatch(stored, /Brightloop|Priya|rawText|sections/i, 'resume content must never be persisted');

    const hist = await (await fetch(`${base}/api/history`, { headers: { Cookie: cookie } })).json();
    assert.equal(hist.items.length, 1);
    assert.equal(hist.items[0].rating, 'High Match');

    const del = await (await fetch(`${base}/api/history`, { method: 'DELETE', headers: { Cookie: cookie } })).json();
    assert.equal(del.removed.evaluations, 1);
    assert.doesNotMatch(readDb(), /alice@example\.com/);
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
    const res = await fetch(`${base}/api/evaluate-match`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText: 'a', jobDescriptionText: 'b' })
    });
    assert.equal(res.status, 403);
  });

  it('admin routes reject anonymous, non-admin and cookie-only callers', async () => {
    assert.equal((await fetch(`${base}/api/admin/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { Authorization: 'Bearer token-alice' } })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { Cookie: 'user_email=admin@example.com' } })).status, 401);
    const { cookie } = await signIn('token-admin');
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { Cookie: cookie } })).status, 401);
  });

  it('admin routes accept a verified admin token or the override key', async () => {
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { Authorization: 'Bearer token-admin' } })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { 'X-Admin-Key': 'override-key-for-tests' } })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { 'X-Admin-Key': 'wrong' } })).status, 401);
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

  it('ranks sample roles against a resume and exposes no apply links', async () => {
    const res = await postJson('/api/jobs', {
      resumeText: 'Python PyTorch TensorFlow machine learning computer vision Docker REST APIs'
    });
    const body = await res.json();
    assert.equal(body.hasResumeMatch, true);
    assert.ok(body.jobs[0].matchPercentage >= body.jobs[body.jobs.length - 1].matchPercentage);
    assert.equal(body.jobs[0].applyUrl, undefined);
  });
});
