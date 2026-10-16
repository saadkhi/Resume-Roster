import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.RR_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-acct-')), 'db.json');
delete process.env.DATABASE_URL;

const { app } = await import('../server.js');
let server;
let base;
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('account page and navigation', () => {
  it('redirects anonymous visitors from /account to sign-in', async () => {
    const res = await fetch(`${base}/account`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/auth');
  });

  it('shows the profile page and signed-in navigation after registering', async () => {
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nav@example.com', password: 'long-enough-pass', name: 'Nora Vale' })
    });
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const page = await (await fetch(`${base}/account`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /Hi, <em>Nora<\/em>/);
    assert.match(page, /nav@example\.com/);
    const home = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();
    assert.match(home, /href="\/account"/);
    assert.match(home, /Hi, Nora/);
  });

  it('marks the active tab in the bottom bar', async () => {
    const apply = await (await fetch(`${base}/apply`)).text();
    assert.match(apply, /<a href="\/apply" aria-current="page">/);
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /<a href="\/" aria-current="page">/);
    assert.match(home, /class="tabbar"/);
  });
});
