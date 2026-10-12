import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Supabase Connection Configuration provided by user
export const SUPABASE_CONFIG = {
  host: process.env.SUPABASE_DB_HOST || 'db.medvnbynodmsjaqvtjzl.supabase.co',
  port: parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_PASSWORD || '',
  supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://medvnbynodmsjaqvtjzl.supabase.co',
  anonKey: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_sZf5iUHaHsorwnonRdoC0g_gtthy4-f',
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || ''
};

function getEffectiveConnectionString() {
  const envUrl = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  if (envUrl && !envUrl.includes('[YOUR-PASSWORD]')) {
    return envUrl;
  }
  if (SUPABASE_CONFIG.password && SUPABASE_CONFIG.password !== '[YOUR-PASSWORD]') {
    const encodedPassword = encodeURIComponent(SUPABASE_CONFIG.password);
    return `postgresql://${SUPABASE_CONFIG.user}:${encodedPassword}@${SUPABASE_CONFIG.host}:${SUPABASE_CONFIG.port}/${SUPABASE_CONFIG.database}`;
  }
  return null;
}

let poolInstance = null;
let supabaseClientInstance = null;
let connectionStatus = {
  connected: false,
  error: null,
  tablesCreated: false,
  lastChecked: null,
  host: SUPABASE_CONFIG.host,
  database: SUPABASE_CONFIG.database,
  user: SUPABASE_CONFIG.user,
  port: SUPABASE_CONFIG.port
};

export function getSupabaseClient() {
  if (supabaseClientInstance) return supabaseClientInstance;
  const url = SUPABASE_CONFIG.supabaseUrl;
  const key = SUPABASE_CONFIG.serviceRoleKey || SUPABASE_CONFIG.anonKey;
  if (url && key) {
    try {
      supabaseClientInstance = createClient(url, key, {
        auth: { persistSession: false }
      });
      return supabaseClientInstance;
    } catch (err) {
      console.warn('Notice: Supabase JS client init warning:', err.message);
    }
  }
  return null;
}

export function getSupabasePool() {
  if (poolInstance) return poolInstance;
  const connString = getEffectiveConnectionString();
  if (!connString) {
    return null;
  }

  try {
    poolInstance = new Pool({
      connectionString: connString,
      ssl: {
        rejectUnauthorized: false // Supabase cloud postgres requires SSL
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 7000
    });

    poolInstance.on('error', (err) => {
      console.warn('Notice: Supabase PG Pool idle client warning:', err.message);
    });

    return poolInstance;
  } catch (err) {
    console.warn('Notice: Could not construct Supabase PG pool:', err.message);
    return null;
  }
}

/**
 * Execute query safely against Supabase PostgreSQL
 */
export async function querySupabase(text, params = []) {
  const pool = getSupabasePool();
  if (!pool) {
    throw new Error('Supabase PostgreSQL pool not initialized. Provide SUPABASE_DB_PASSWORD or DATABASE_URL in environment.');
  }
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

/**
 * Initialize and verify Supabase PostgreSQL connection and tables
 */
export async function initializeSupabase() {
  const connString = getEffectiveConnectionString();
  connectionStatus.lastChecked = new Date().toISOString();

  if (!connString) {
    connectionStatus.connected = false;
    connectionStatus.error = 'Database password or connection string not configured. Set SUPABASE_DB_PASSWORD or DATABASE_URL in environment variables.';
    return connectionStatus;
  }

  const pool = getSupabasePool();
  if (!pool) {
    connectionStatus.connected = false;
    connectionStatus.error = 'Failed to create Postgres connection pool for Supabase.';
    return connectionStatus;
  }

  try {
    // 1. Test basic connectivity
    const client = await pool.connect();
    try {
      const res = await client.query('SELECT current_database(), current_user, version()');
      connectionStatus.connected = true;
      connectionStatus.error = null;
      connectionStatus.database = res.rows[0]?.current_database || SUPABASE_CONFIG.database;
      connectionStatus.user = res.rows[0]?.current_user || SUPABASE_CONFIG.user;
      console.log(`Successfully connected to Supabase PostgreSQL [${connectionStatus.database}] as [${connectionStatus.user}]!`);

      // 2. Initialize schema tables
      await runSchemaMigrations(client);
      connectionStatus.tablesCreated = true;
    } finally {
      client.release();
    }
  } catch (err) {
    connectionStatus.connected = false;
    connectionStatus.error = err.message;
    console.warn('Notice: Supabase PostgreSQL connection check:', err.message);
  }

  return connectionStatus;
}

async function runSchemaMigrations(client) {
  try {
    const schemaSqlPath = path.join(__dirname, '..', '..', 'scripts', 'init-supabase-schema.sql');
    if (fs.existsSync(schemaSqlPath)) {
      const sql = fs.readFileSync(schemaSqlPath, 'utf8');
      await client.query(sql);
      console.log('Supabase tables and indexes verified/created successfully.');
    }
  } catch (err) {
    console.warn('Notice: Error executing Supabase schema migration:', err.message);
  }
}

export function getSupabaseStatus() {
  return {
    ...connectionStatus,
    host: SUPABASE_CONFIG.host,
    port: SUPABASE_CONFIG.port,
    database: SUPABASE_CONFIG.database,
    user: SUPABASE_CONFIG.user,
    hasPasswordConfigured: !!(process.env.SUPABASE_DB_PASSWORD || process.env.DATABASE_URL || process.env.DATABASE_PASSWORD),
    hasConnectionString: !!getEffectiveConnectionString(),
    lastChecked: connectionStatus.lastChecked || new Date().toISOString()
  };
}

/**
 * Async Sync Helpers: Fire-and-forget sync to Supabase when records are modified
 */
export async function syncUserToSupabase(user) {
  if (!connectionStatus.connected) return;
  try {
    await querySupabase(
      `INSERT INTO users (id, email, name, role, is_admin, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         is_admin = EXCLUDED.is_admin,
         updated_at = NOW()`,
      [user.id, user.email, user.name || 'Candidate', user.role || 'user', !!(user.isAdmin || user.role === 'admin')]
    );
  } catch (err) {
    console.warn('Notice: Supabase user sync warning:', err.message);
  }
}

export async function syncSubscriptionToSupabase(sub) {
  if (!connectionStatus.connected) return;
  try {
    await querySupabase(
      `INSERT INTO subscriptions (
         id, user_id, paddle_customer_id, paddle_subscription_id, paddle_price_id, 
         paddle_transaction_id, stripe_customer_id, stripe_subscription_id, plan_tier, 
         status, current_period_end, cancel_at_period_end, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (id) DO UPDATE SET
         paddle_customer_id = EXCLUDED.paddle_customer_id,
         paddle_subscription_id = EXCLUDED.paddle_subscription_id,
         paddle_price_id = EXCLUDED.paddle_price_id,
         paddle_transaction_id = EXCLUDED.paddle_transaction_id,
         plan_tier = EXCLUDED.plan_tier,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         updated_at = NOW()`,
      [
        sub.id,
        sub.userId,
        sub.paddleCustomerId || null,
        sub.paddleSubscriptionId || null,
        sub.paddlePriceId || null,
        sub.paddleTransactionId || null,
        sub.stripeCustomerId || null,
        sub.stripeSubscriptionId || null,
        sub.planTier || 'free',
        sub.status || 'inactive',
        sub.currentPeriodEnd || null,
        !!sub.cancelAtPeriodEnd
      ]
    );
  } catch (err) {
    console.warn('Notice: Supabase subscription sync warning:', err.message);
  }
}

export async function syncUsageToSupabase(usage) {
  if (!connectionStatus.connected) return;
  try {
    await querySupabase(
      `INSERT INTO user_usage (id, user_id, month_year, scans_used, max_free_scans, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, month_year) DO UPDATE SET
         scans_used = EXCLUDED.scans_used,
         max_free_scans = EXCLUDED.max_free_scans,
         updated_at = NOW()`,
      [usage.id || `usg_${usage.userId}_${usage.monthYear}`, usage.userId, usage.monthYear, usage.scansUsed, usage.maxFreeScans || 3]
    );
  } catch (err) {
    console.warn('Notice: Supabase usage sync warning:', err.message);
  }
}

export async function syncResumeToSupabase(resume) {
  if (!connectionStatus.connected) return;
  try {
    await querySupabase(
      `INSERT INTO resumes (id, user_id, title, filename, file_size_bytes, page_count, raw_text, cleaned_text, parsed_sections, detected_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        resume.id,
        resume.userId,
        resume.title,
        resume.filename,
        resume.fileSizeBytes || 0,
        resume.pageCount || 1,
        resume.rawText || '',
        resume.cleanedText || '',
        JSON.stringify(resume.parsedSections || {}),
        resume.detectedCategory || null
      ]
    );
  } catch (err) {
    console.warn('Notice: Supabase resume sync warning:', err.message);
  }
}

export async function syncEvaluationToSupabase(evaluation) {
  if (!connectionStatus.connected) return;
  try {
    await querySupabase(
      `INSERT INTO evaluations (id, user_id, resume_id, target_job_title, similarity_score, match_rating, dimensions, keyword_gaps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        evaluation.id,
        evaluation.userId,
        evaluation.resumeId,
        evaluation.targetJobTitle,
        evaluation.similarityScore || 0,
        evaluation.matchRating || '',
        JSON.stringify(evaluation.dimensions || []),
        JSON.stringify(evaluation.keywordGaps || [])
      ]
    );
  } catch (err) {
    console.warn('Notice: Supabase evaluation sync warning:', err.message);
  }
}
