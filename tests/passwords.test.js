import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/services/passwords.js';

describe('passwords', () => {
  it('verifies the right password and rejects others', async () => {
    const h = await hashPassword('s3cret-passphrase');
    assert.match(h, /^scrypt\$/);
    assert.equal(await verifyPassword('s3cret-passphrase', h), true);
    assert.equal(await verifyPassword('S3cret-passphrase', h), false);
  });

  it('salts every hash', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  it('rejects malformed stored values', async () => {
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('x', undefined), false);
  });
});
