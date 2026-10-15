/**
 * Application data store.
 *
 * State lives in a JSON file (a per-instance cache) and is mirrored to Supabase
 * Postgres when DATABASE_URL is configured. Only signed-in users' evaluation
 * metadata is stored: never resume text, extracted sections or file contents.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { INITIAL_JOBS_DATASET } from './jobs-data.js';
import {
  initializeSupabase,
  getSupabaseStatus,
  syncUserToSupabase,
  syncResumeToSupabase,
  syncEvaluationToSupabase,
  deleteUserDataFromSupabase
} from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION);
const dbPath = process.env.RR_DB_PATH
  || (isServerless
    ? path.join(os.tmpdir(), 'resume_rater_db.json')
    : path.join(__dirname, '..', '..', '.data', 'db.json'));

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

let state = null;

function freshState() {
  return { users: [], resumes: [], evaluations: [], contacts: [], jobs: [...INITIAL_JOBS_DATASET] };
}

function normalise(s) {
  const base = freshState();
  for (const key of Object.keys(base)) if (!Array.isArray(s[key])) s[key] = base[key];
  // The jobs fixture is authoritative; always serve the current version.
  s.jobs = [...INITIAL_JOBS_DATASET];
  return s;
}

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(dbPath)) {
      state = normalise(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
      return state;
    }
  } catch (err) {
    console.warn('Notice: could not read database file, starting empty:', err.message);
  }
  state = freshState();
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const tmp = `${dbPath}.${process.pid}.tmp`;
    // Jobs are a fixture; do not persist them.
    const { jobs: _jobs, ...persistable } = state;
    fs.writeFileSync(tmp, JSON.stringify(persistable), 'utf8');
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    console.warn('Notice: database write skipped (in-memory state kept):', err.message);
  }
}

const MAX_RECORDS_PER_USER = 50;

export const db = {
  users: {
    find(id) {
      return load().users.find(u => u.id === id) || null;
    },
    /** Insert or refresh a user keyed by their verified Supabase id. */
    upsert({ id, email, name, avatar }) {
      const s = load();
      let user = s.users.find(u => u.id === id);
      if (user) {
        Object.assign(user, { email, name, avatar: avatar || '' });
      } else {
        user = { id, email, name, avatar: avatar || '', createdAt: new Date().toISOString() };
        s.users.push(user);
      }
      save();
      syncUserToSupabase(user).catch(() => {});
      return user;
    }
  },

  resumes: {
    create({ userId, filename, fileSizeBytes, pageCount, detectedCategory, wordCount }) {
      const s = load();
      const record = {
        id: newId('res'),
        userId,
        filename: String(filename || 'resume.pdf').slice(0, 255),
        fileSizeBytes: fileSizeBytes || 0,
        pageCount: pageCount || 1,
        wordCount: wordCount || 0,
        detectedCategory: detectedCategory || null,
        createdAt: new Date().toISOString()
      };
      s.resumes.push(record);
      save();
      syncResumeToSupabase(record).catch(() => {});
      return record;
    }
  },

  evaluations: {
    create(data) {
      const s = load();
      const record = { id: newId('eval'), ...data, createdAt: new Date().toISOString() };
      s.evaluations.push(record);
      // Cap per-user history so the store cannot grow without bound.
      const mine = s.evaluations.filter(e => e.userId === data.userId);
      if (mine.length > MAX_RECORDS_PER_USER) {
        const drop = new Set(mine.slice(0, mine.length - MAX_RECORDS_PER_USER).map(e => e.id));
        s.evaluations = s.evaluations.filter(e => !drop.has(e.id));
      }
      save();
      syncEvaluationToSupabase(record).catch(() => {});
      return record;
    },
    listByUser(userId, limit = 20) {
      return load().evaluations
        .filter(e => e.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    }
  },

  /** Remove everything stored about a user (history and profile). */
  deleteUserData(userId) {
    const s = load();
    const removed = {
      evaluations: s.evaluations.filter(e => e.userId === userId).length,
      resumes: s.resumes.filter(r => r.userId === userId).length
    };
    s.evaluations = s.evaluations.filter(e => e.userId !== userId);
    s.resumes = s.resumes.filter(r => r.userId !== userId);
    s.users = s.users.filter(u => u.id !== userId);
    save();
    deleteUserDataFromSupabase(userId).catch(() => {});
    return removed;
  },

  jobs: {
    list({ query = '', category = '', remoteOnly = false } = {}) {
      let jobs = [...load().jobs];
      const q = String(query || '').toLowerCase().trim();
      if (q) {
        jobs = jobs.filter(j =>
          j.title.toLowerCase().includes(q) ||
          j.company.toLowerCase().includes(q) ||
          j.description.toLowerCase().includes(q) ||
          (j.skills || []).some(s => s.toLowerCase().includes(q)));
      }
      const cat = String(category || '').toLowerCase().trim();
      if (cat && cat !== 'all') jobs = jobs.filter(j => (j.category || '').toLowerCase().includes(cat));
      if (remoteOnly === true || remoteOnly === 'true') jobs = jobs.filter(j => j.remote === true);
      return jobs;
    }
  },

  contacts: {
    create({ name, email, subject, message }) {
      const s = load();
      const record = {
        id: newId('cnt'),
        name: String(name || '').trim().slice(0, 100),
        email: String(email || '').trim().slice(0, 254),
        subject: String(subject || 'general').slice(0, 50),
        message: String(message || '').trim().slice(0, 5000),
        createdAt: new Date().toISOString()
      };
      s.contacts.unshift(record);
      s.contacts = s.contacts.slice(0, 500);
      save();
      return record;
    }
  },

  supabase: {
    getStatus: getSupabaseStatus,
    initialize: initializeSupabase
  },

  /** True when evaluations are mirrored to a durable database. */
  isDurable() {
    return !!getSupabaseStatus().hasConnectionString;
  },

  /** Test helper: drop in-memory state. */
  _reset() {
    state = freshState();
  }
};

// Connect to Supabase Postgres in the background (no-op when unconfigured).
initializeSupabase().catch(err => {
  console.warn('Notice: background Supabase init:', err.message);
});
