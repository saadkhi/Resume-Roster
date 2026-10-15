import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Connection settings come from the environment only.
const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST || '',
  port: parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_PASSWORD || ''
};

function getConnectionString() {
  const envUrl = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  if (envUrl && !envUrl.includes('[YOUR-PASSWORD]')) return envUrl;
  if (DB_CONFIG.host && DB_CONFIG.password && DB_CONFIG.password !== '[YOUR-PASSWORD]') {
    const pw = encodeURIComponent(DB_CONFIG.password);
    return `postgresql://${DB_CONFIG.user}:${pw}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`;
  }
  return null;
}

let pool = null;
const connectionStatus = {
  connected: false,
  error: null,
  tablesCreated: false,
  lastChecked: null
};

function getPool() {
  if (pool) return pool;
  const connectionString = getConnectionString();
  if (!connectionString) return null;
  try {
    pool = new Pool({
      connectionString,
      // Set DATABASE_SSL_CA to the provider's CA certificate to verify the server.
      ssl: process.env.DATABASE_SSL_CA
        ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true }
        : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 7000
    });
    pool.on('error', (err) => console.warn('Notice: Postgres idle client warning:', err.message));
    return pool;
  } catch (err) {
    console.warn('Notice: could not create Postgres pool:', err.message);
    return null;
  }
}

async function query(text, params = []) {
  const p = getPool();
  if (!p) throw new Error('Database is not configured.');
  const client = await p.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function initializeSupabase() {
  connectionStatus.lastChecked = new Date().toISOString();
  const p = getPool();
  if (!p) {
    connectionStatus.connected = false;
    connectionStatus.error = 'DATABASE_URL is not configured.';
    return { ...connectionStatus };
  }
  try {
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      connectionStatus.connected = true;
      connectionStatus.error = null;
      const schemaPath = path.join(__dirname, '..', '..', 'scripts', 'init-supabase-schema.sql');
      if (fs.existsSync(schemaPath)) {
        await client.query(fs.readFileSync(schemaPath, 'utf8'));
        connectionStatus.tablesCreated = true;
      }
    } finally {
      client.release();
    }
  } catch (err) {
    connectionStatus.connected = false;
    connectionStatus.error = err.message;
    console.warn('Notice: Postgres connection check:', err.message);
  }
  return { ...connectionStatus };
}

export function getSupabaseStatus() {
  return {
    ...connectionStatus,
    hasConnectionString: !!getConnectionString()
  };
}

/**
 * Best-effort mirroring of app records to Postgres. Failures are logged and
 * never surface to the user; the local store stays authoritative for the
 * current request.
 */
async function mirror(label, text, params) {
  if (!connectionStatus.connected) return;
  try {
    await query(text, params);
  } catch (err) {
    console.warn(`Notice: Postgres ${label} sync warning:`, err.message);
  }
}

export function syncUserToSupabase(user) {
  return mirror('user',
    `INSERT INTO users (id, email, name, avatar, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email, name = EXCLUDED.name, avatar = EXCLUDED.avatar, updated_at = NOW()`,
    [user.id, user.email, user.name || '', user.avatar || '']);
}

export function syncResumeToSupabase(resume) {
  return mirror('resume',
    `INSERT INTO resumes (id, user_id, title, filename, file_size_bytes, page_count, word_count, detected_category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [resume.id, resume.userId, resume.filename, resume.filename, resume.fileSizeBytes || 0,
      resume.pageCount || 1, resume.wordCount || 0, resume.detectedCategory || null]);
}

export function syncEvaluationToSupabase(evaluation) {
  return mirror('evaluation',
    `INSERT INTO evaluations (id, user_id, resume_id, target_job_title, similarity_score, match_rating, dimensions, keyword_gaps)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [evaluation.id, evaluation.userId, evaluation.resumeId, evaluation.targetJobTitle,
      evaluation.similarityScore || 0, evaluation.matchRating || '',
      JSON.stringify(evaluation.dimensions || []), JSON.stringify(evaluation.keywordGaps || [])]);
}

/** Deleting the user cascades to their resumes and evaluations. */
export function deleteUserDataFromSupabase(userId) {
  return mirror('delete', 'DELETE FROM users WHERE id = $1', [userId]);
}
