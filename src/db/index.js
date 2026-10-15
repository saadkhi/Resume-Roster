/**
 * Application data store.
 *
 * With DATABASE_URL set, everything is stored in Postgres. Without it, a local
 * JSON file is used (development only; ephemeral on serverless hosts).
 * Only account details and evaluation metadata are stored: never resume text,
 * extracted sections or file contents.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { INITIAL_JOBS_DATASET } from './jobs-data.js';
import { isConfigured, ready, query, getStatus } from './postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION);
const dbPath = process.env.RR_DB_PATH
  || (isServerless
    ? path.join(os.tmpdir(), 'resume_rater_db.json')
    : path.join(__dirname, '..', '..', '.data', 'db.json'));

const MAX_EVALUATIONS_PER_USER = 50;
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

// ── Local JSON backend ──────────────────────────────────────────────────────
let local = null;
const emptyLocal = () => ({ users: [], resumes: [], evaluations: [], contacts: [] });

function loadLocal() {
  if (local) return local;
  try {
    if (fs.existsSync(dbPath)) {
      const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      local = { ...emptyLocal(), ...parsed };
      return local;
    }
  } catch (err) {
    console.warn('Notice: could not read local database, starting empty:', err.message);
  }
  local = emptyLocal();
  return local;
}

function saveLocal() {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const tmp = `${dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(local), 'utf8');
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    console.warn('Notice: local database write skipped:', err.message);
  }
}

// ── Public API (all async) ──────────────────────────────────────────────────
async function usePostgres() {
  return isConfigured() && (await ready());
}

export const db = {
  /** True when a durable Postgres database is configured. */
  isDurable: isConfigured,

  /** True when accounts can be stored reliably on this host. */
  accountsAvailable() {
    return isConfigured() || !isServerless;
  },

  users: {
    async findByEmail(email) {
      const e = String(email).toLowerCase();
      if (await usePostgres()) {
        const { rows } = await query('SELECT id, email, name, password_hash FROM users WHERE email = $1', [e]);
        return rows[0] ? { id: rows[0].id, email: rows[0].email, name: rows[0].name, passwordHash: rows[0].password_hash } : null;
      }
      return loadLocal().users.find(u => u.email === e) || null;
    },

    /** @returns the new user, or null if the email is already registered. */
    async create({ email, name, passwordHash }) {
      const user = { id: newId('usr'), email: String(email).toLowerCase(), name, passwordHash };
      if (await usePostgres()) {
        const { rowCount } = await query(
          'INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING',
          [user.id, user.email, user.name, user.passwordHash]
        );
        return rowCount ? user : null;
      }
      const s = loadLocal();
      if (s.users.some(u => u.email === user.email)) return null;
      s.users.push({ ...user, createdAt: new Date().toISOString() });
      saveLocal();
      return user;
    }
  },

  /** Store one evaluation (and its resume metadata) for a signed-in user. */
  async saveEvaluation(userId, resume, evaluation) {
    const resumeId = newId('res');
    const evalId = newId('eval');
    if (await usePostgres()) {
      await query(
        `INSERT INTO resumes (id, user_id, filename, file_size_bytes, page_count, word_count, detected_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [resumeId, userId, String(resume.filename).slice(0, 255), resume.fileSizeBytes || 0,
          resume.pageCount || 1, resume.wordCount || 0, resume.detectedCategory || null]
      );
      await query(
        `INSERT INTO evaluations (id, user_id, resume_id, target_job_title, similarity_score, match_rating, dimensions, keyword_gaps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [evalId, userId, resumeId, evaluation.targetJobTitle, evaluation.similarityScore, evaluation.matchRating,
          JSON.stringify(evaluation.dimensions || []), JSON.stringify(evaluation.keywordGaps || [])]
      );
      await query(
        `DELETE FROM evaluations WHERE user_id = $1 AND id NOT IN
           (SELECT id FROM evaluations WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${MAX_EVALUATIONS_PER_USER})`,
        [userId]
      );
      return evalId;
    }
    const s = loadLocal();
    const now = new Date().toISOString();
    s.resumes.push({ id: resumeId, userId, ...resume, createdAt: now });
    s.evaluations.push({ id: evalId, userId, resumeId, ...evaluation, createdAt: now });
    const mine = s.evaluations.filter(e => e.userId === userId);
    if (mine.length > MAX_EVALUATIONS_PER_USER) {
      const drop = new Set(mine.slice(0, mine.length - MAX_EVALUATIONS_PER_USER).map(e => e.id));
      s.evaluations = s.evaluations.filter(e => !drop.has(e.id));
    }
    saveLocal();
    return evalId;
  },

  async history(userId, limit = 20) {
    if (await usePostgres()) {
      const { rows } = await query(
        `SELECT id, target_job_title, similarity_score, match_rating, created_at
           FROM evaluations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
      );
      return rows.map(r => ({
        id: r.id,
        target: r.target_job_title,
        score: Number(r.similarity_score),
        rating: r.match_rating,
        createdAt: new Date(r.created_at).toISOString()
      }));
    }
    return loadLocal().evaluations
      .filter(e => e.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(e => ({ id: e.id, target: e.targetJobTitle, score: e.similarityScore, rating: e.matchRating, createdAt: e.createdAt }));
  },

  /** Remove the account and everything stored about it. */
  async deleteUserData(userId) {
    if (await usePostgres()) {
      const { rows } = await query('SELECT COUNT(*)::int AS n FROM evaluations WHERE user_id = $1', [userId]);
      await query('DELETE FROM users WHERE id = $1', [userId]); // cascades
      return { evaluations: rows[0].n };
    }
    const s = loadLocal();
    const removed = { evaluations: s.evaluations.filter(e => e.userId === userId).length };
    s.evaluations = s.evaluations.filter(e => e.userId !== userId);
    s.resumes = s.resumes.filter(r => r.userId !== userId);
    s.users = s.users.filter(u => u.id !== userId);
    saveLocal();
    return removed;
  },

  contacts: {
    async create({ name, email, subject, message }) {
      const record = {
        id: newId('cnt'),
        name: String(name || '').trim().slice(0, 100),
        email: String(email || '').trim().slice(0, 254),
        subject: String(subject || 'general').slice(0, 50),
        message: String(message || '').trim().slice(0, 5000)
      };
      if (await usePostgres()) {
        await query('INSERT INTO contacts (id, name, email, subject, message) VALUES ($1, $2, $3, $4, $5)',
          [record.id, record.name, record.email, record.subject, record.message]);
      } else {
        const s = loadLocal();
        s.contacts.unshift({ ...record, createdAt: new Date().toISOString() });
        s.contacts = s.contacts.slice(0, 500);
        saveLocal();
      }
      return record;
    }
  },

  jobs: {
    list({ query: q = '', category = '', remoteOnly = false } = {}) {
      let jobs = [...INITIAL_JOBS_DATASET];
      const needle = String(q || '').toLowerCase().trim();
      if (needle) {
        jobs = jobs.filter(j =>
          j.title.toLowerCase().includes(needle) ||
          j.company.toLowerCase().includes(needle) ||
          j.description.toLowerCase().includes(needle) ||
          (j.skills || []).some(s => s.toLowerCase().includes(needle)));
      }
      const cat = String(category || '').toLowerCase().trim();
      if (cat && cat !== 'all') jobs = jobs.filter(j => (j.category || '').toLowerCase().includes(cat));
      if (remoteOnly === true || remoteOnly === 'true') jobs = jobs.filter(j => j.remote === true);
      return jobs;
    }
  },

  async health() {
    if (isConfigured()) await ready();
    return getStatus();
  },

  /** Test helper: drop in-memory local state. */
  _reset() {
    local = emptyLocal();
  }
};
