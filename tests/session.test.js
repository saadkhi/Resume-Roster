import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
const { signSession, verifySession, parseCookies, sessionMiddleware, SESSION_COOKIE } =
  await import('../src/middleware/session.js');

describe('session tokens', () => {
  it('round-trips a payload', () => {
    const token = signSession({ uid: 'u1', email: 'a@b.co', name: 'A' });
    const p = verifySession(token);
    assert.equal(p.uid, 'u1');
    assert.equal(p.email, 'a@b.co');
  });

  it('rejects tampered payloads and signatures', () => {
    const token = signSession({ uid: 'u1', email: 'a@b.co', name: 'A', admin: false });
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'u1', admin: true, exp: 9999999999 })).toString('base64url');
    assert.equal(verifySession(`${forged}.${sig}`), null);
    assert.equal(verifySession(`${body}.${sig.slice(0, -2)}xx`), null);
    assert.equal(verifySession('garbage'), null);
    assert.equal(verifySession(''), null);
  });

  it('rejects expired sessions', () => {
    const token = signSession({ uid: 'u1' }, Date.now() - 8 * 24 * 3600 * 1000);
    assert.equal(verifySession(token), null);
  });
});

describe('cookies', () => {
  it('parses safely, including malformed encodings', () => {
    const c = parseCookies('a=1; b=%E0%A4%A; c=hello%20world');
    assert.equal(c.a, '1');
    assert.equal(c.b, '%E0%A4%A');
    assert.equal(c.c, 'hello world');
  });

  it('ignores identity-looking plain cookies', () => {
    const req = { headers: { cookie: 'user_email=admin@example.com; user_id=usr_admin' } };
    sessionMiddleware(req, {}, () => {});
    assert.equal(req.user, null);
  });

  it('accepts a valid signed cookie', () => {
    const token = signSession({ uid: 'u9', email: 'x@y.zz', name: 'X', admin: true });
    const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } };
    sessionMiddleware(req, {}, () => {});
    assert.equal(req.user.id, 'u9');
    assert.equal(req.user.isAdmin, true);
  });
});
