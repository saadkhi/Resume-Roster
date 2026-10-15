import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDatabaseUrl } from '../src/db/postgres.js';

describe('cleanDatabaseUrl', () => {
  const url = 'postgresql://user:pw@host.example/db?sslmode=require';
  it('accepts a plain connection string', () => {
    assert.equal(cleanDatabaseUrl(url), url);
  });
  it('strips quotes, whitespace and a pasted psql command', () => {
    assert.equal(cleanDatabaseUrl("  '" + url + "'  "), url);
    assert.equal(cleanDatabaseUrl('"' + url + '"'), url);
    assert.equal(cleanDatabaseUrl("psql '" + url + "'"), url);
  });
  it('returns an empty string for missing values', () => {
    assert.equal(cleanDatabaseUrl(undefined), '');
    assert.equal(cleanDatabaseUrl('   '), '');
  });
});

describe('configured but unreachable database', () => {
  const saved = process.env.DATABASE_URL;
  after(() => {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
  });

  it('fails loudly instead of silently writing to a local file', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none';
    // Fresh module instance with its own local-store path, isolated from other test files.
    const { db } = await import('../src/db/index.js?database-test');
    await assert.rejects(() => db.users.create({ email: 'a@b.co', name: 'A', passwordHash: 'x' }), /unavailable/i);
    await assert.rejects(() => db.users.findByEmail('a@b.co'), /unavailable/i);
    const health = await db.health();
    assert.equal(health.configured, true);
    assert.equal(health.connected, false);
    assert.ok(health.error, 'a reason is reported');
  });
});
