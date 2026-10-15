/**
 * Postgres connection (Neon or any Postgres). Configured only through
 * DATABASE_URL. The schema is applied idempotently on first connect.
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RETRY_AFTER_MS = 30_000;

let pool = null;
let readyPromise = null;
let failedAt = 0;
const state = { connected: false, error: null, lastChecked: null };

export function isConfigured() {
  return !!process.env.DATABASE_URL;
}

function createPool() {
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return new Pool({
    connectionString: url,
    ssl: local ? false : (process.env.DATABASE_SSL_CA
      ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true }
      : { rejectUnauthorized: true }),
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000
  });
}

async function init() {
  state.lastChecked = new Date().toISOString();
  try {
    pool = pool || createPool();
    pool.on('error', (err) => console.warn('Notice: Postgres idle client error:', err.message));
    const schemaPath = path.join(__dirname, '..', '..', 'scripts', 'schema.sql');
    await pool.query(fs.readFileSync(schemaPath, 'utf8'));
    state.connected = true;
    state.error = null;
    return true;
  } catch (err) {
    state.connected = false;
    state.error = err.message;
    failedAt = Date.now();
    console.warn('Notice: Postgres unavailable:', err.message);
    return false;
  }
}

/** Resolves true when the database is configured and reachable. */
export function ready() {
  if (!isConfigured()) return Promise.resolve(false);
  if (readyPromise && state.connected === false && failedAt && Date.now() - failedAt > RETRY_AFTER_MS) {
    readyPromise = null; // allow a retry after a failed attempt
  }
  readyPromise ||= init();
  return readyPromise;
}

export async function query(text, params = []) {
  if (!(await ready())) throw new Error('Database is unavailable.');
  return pool.query(text, params);
}

export function getStatus() {
  return { configured: isConfigured(), ...state };
}
