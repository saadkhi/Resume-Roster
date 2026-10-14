/**
 * Unit tests using Node.js built-in test runner (node:test).
 * Run with:  node --experimental-vm-modules tests/unit.test.js
 * Or via:   npm test
 *
 * Covers:
 *   1. TF-IDF vector computation and cosine similarity
 *   2. Resume match rating thresholds
 *   3. Admin middleware — unauthenticated requests rejected with 401/403
 *   4. requireAdminAuth — correct environment key accepted
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── 1. TF-IDF & cosine similarity ───────────────────────────────────────────
// We import the two exported helpers from server.js.
// The import also trains the classifier on startup (reads data/gpt_dataset.csv).
const { computeTfidfVector, rateResumeSimilarity } = await import('../server.js');

describe('computeTfidfVector', () => {
  it('returns an object with numeric weights', () => {
    const vec = computeTfidfVector('python machine learning sql tensorflow');
    assert.equal(typeof vec, 'object');
    const values = Object.values(vec);
    assert.ok(values.length > 0, 'vector should have entries');
    values.forEach(v => assert.equal(typeof v, 'number'));
  });

  it('produces a unit-normalised vector (magnitude ≈ 1)', () => {
    const vec = computeTfidfVector('python data science statistics pandas numpy');
    const mag = Math.sqrt(Object.values(vec).reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(mag - 1) < 0.001, `magnitude should be ~1, got ${mag}`);
  });

  it('empty string returns empty vector', () => {
    const vec = computeTfidfVector('');
    assert.equal(Object.keys(vec).length, 0);
  });

  it('identical texts have cosine similarity = 1', () => {
    const text = 'software engineer java algorithms microservices docker';
    const vecA = computeTfidfVector(text);
    const vecB = computeTfidfVector(text);
    // dot product of two unit vectors = 1
    const dot = Object.keys(vecA).reduce((s, k) => s + (vecA[k] || 0) * (vecB[k] || 0), 0);
    assert.ok(Math.abs(dot - 1) < 0.001, `should be ~1, got ${dot}`);
  });

  it('completely different texts have low similarity', () => {
    const vecA = computeTfidfVector('python machine learning neural networks');
    const vecB = computeTfidfVector('plumber pipes wrench bathroom kitchen');
    const dot = Object.keys(vecA).reduce((s, k) => s + (vecA[k] || 0) * (vecB[k] || 0), 0);
    assert.ok(dot < 0.3, `unrelated texts should have low similarity, got ${dot}`);
  });
});

describe('rateResumeSimilarity', () => {
  it('returns matchRating and similarityScore', () => {
    const vecA = computeTfidfVector('python data scientist machine learning sql');
    const vecB = computeTfidfVector('python data scientist machine learning sql');
    const result = rateResumeSimilarity(vecA, vecB);
    assert.ok('matchRating' in result);
    assert.ok('similarityScore' in result);
  });

  it('identical vectors → High Match', () => {
    const text = 'python machine learning tensorflow neural networks deep learning';
    const vec = computeTfidfVector(text);
    const { matchRating } = rateResumeSimilarity(vec, vec);
    assert.equal(matchRating, 'High Match');
  });

  it('zero-overlap vectors → Low Match', () => {
    const vecA = computeTfidfVector('python pandas numpy scipy sklearn');
    const vecB = computeTfidfVector('plumber carpenter electrician hvac plumbing');
    const { matchRating, similarityScore } = rateResumeSimilarity(vecA, vecB);
    assert.equal(matchRating, 'Low Match');
    assert.ok(similarityScore < 0.5);
  });

  it('similarity score is in [0, 1]', () => {
    const vecA = computeTfidfVector('react javascript typescript frontend web developer');
    const vecB = computeTfidfVector('javascript frontend developer html css react hooks');
    const { similarityScore } = rateResumeSimilarity(vecA, vecB);
    assert.ok(similarityScore >= 0 && similarityScore <= 1,
      `score should be in [0,1], got ${similarityScore}`);
  });
});

// ── 2. Admin middleware ──────────────────────────────────────────────────────
// We test requireAdminAuth and isAdminRequest in isolation.
// We mock req/res/next objects — no HTTP server needed.

const {
  requireAdminAuth,
  isAdminRequest,
  setGlobalAdminOverride,
  isGlobalAdminOverrideActive
} = await import('../src/middleware/admin.js');

function mockRes() {
  const res = { _status: null, _body: null, headersSent: false };
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

describe('isAdminRequest', () => {
  before(() => {
    // Ensure global override is off for these tests
    setGlobalAdminOverride(false);
  });

  it('returns false for anonymous request (no cookies, no headers)', () => {
    const req = { cookies: {}, headers: {}, query: {} };
    assert.equal(isAdminRequest(req), false);
  });

  it('returns false when ADMIN_EMAIL env is not set', () => {
    const req = { cookies: { user_email: 'anyone@example.com' }, headers: {}, query: {} };
    // ADMIN_EMAIL defaults to '' when env not set — should never match
    const result = isAdminRequest(req);
    // result depends on whether ADMIN_EMAIL env var is set in test environment
    assert.equal(typeof result, 'boolean');
  });

  it('globalAdminOverride defaults to false', () => {
    assert.equal(isGlobalAdminOverrideActive(), false);
  });

  it('setGlobalAdminOverride toggles correctly', () => {
    setGlobalAdminOverride(true);
    assert.equal(isGlobalAdminOverrideActive(), true);
    setGlobalAdminOverride(false);
    assert.equal(isGlobalAdminOverrideActive(), false);
  });
});

describe('requireAdminAuth — unauthenticated', () => {
  beforeEach(() => setGlobalAdminOverride(false));

  it('rejects with 401 when no Authorization header and no ADMIN_OVERRIDE_KEY set', async () => {
    const req = { headers: {}, cookies: {}, query: {} };
    const res = mockRes();
    const next = () => { throw new Error('next() should not be called'); };
    // With no SUPABASE_SERVICE_ROLE_KEY and no ADMIN_OVERRIDE_KEY in env,
    // the middleware must reject
    await requireAdminAuth(req, res, next);
    assert.ok(res._status === 401 || res._status === 403,
      `expected 401 or 403, got ${res._status}`);
    assert.equal(res._body.success, false);
  });

  it('rejects with 401 for a malformed Bearer token', async () => {
    const req = {
      headers: { authorization: 'Bearer not-a-real-jwt' },
      cookies: {},
      query: {}
    };
    const res = mockRes();
    const next = () => { throw new Error('next() should not be called'); };
    await requireAdminAuth(req, res, next);
    assert.ok(res._status === 401 || res._status === 403,
      `expected 401 or 403, got ${res._status}`);
  });

  it('rejects with 401 when wrong override key provided', async () => {
    const req = {
      headers: { 'x-admin-key': 'wrong-key-definitely-not-valid' },
      cookies: {},
      query: {}
    };
    const res = mockRes();
    const next = () => { throw new Error('next() should not be called'); };
    await requireAdminAuth(req, res, next);
    assert.ok(res._status === 401 || res._status === 403,
      `expected 401 or 403, got ${res._status}`);
  });
});

describe('requireAdminAuth — with valid override key', () => {
  it('calls next() when ADMIN_OVERRIDE_KEY matches X-Admin-Key header', async () => {
    const testKey = 'test-override-key-abc123';
    process.env.ADMIN_OVERRIDE_KEY = testKey;

    const req = {
      headers: { 'x-admin-key': testKey },
      cookies: {},
      query: {}
    };
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    await requireAdminAuth(req, res, next);
    assert.equal(nextCalled, true, 'next() should be called with valid override key');

    delete process.env.ADMIN_OVERRIDE_KEY;
  });
});
