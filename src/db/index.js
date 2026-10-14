import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { INITIAL_JOBS_DATASET } from './jobs-data.js';
import {
  initializeSupabase,
  getSupabaseStatus,
  syncUserToSupabase,
  syncSubscriptionToSupabase,
  syncUsageToSupabase,
  syncResumeToSupabase,
  syncEvaluationToSupabase
} from './supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect serverless environment (Vercel, AWS Lambda, etc.)
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION);
const bundledDbPath = path.join(__dirname, '..', '..', 'data', 'db.json');
const writableDbPath = isServerless ? path.join(os.tmpdir(), 'resume_rater_db.json') : bundledDbPath;

// In-memory state cache for instant access and resilience against read-only filesystems
let inMemoryDbState = null;

// Initial state template
const initialDbState = {
  users: [
    {
      id: 'usr_admin_saad',
      email: process.env.ADMIN_EMAIL || 'admin@example.com',
      name: 'Platform Admin',
      role: 'admin',
      isAdmin: true,
      createdAt: new Date().toISOString()
    },
    {
      id: 'usr_demo_001',
      email: 'candidate@example.com',
      name: 'Demo Candidate',
      role: 'user',
      createdAt: new Date().toISOString()
    }
  ],
  subscriptions: [
    {
      id: 'sub_admin_saad',
      userId: 'usr_admin_saad',
      paddleCustomerId: 'ctm_admin_saad',
      paddleSubscriptionId: 'sub_admin_override',
      paddlePriceId: 'pri_admin_unlimited',
      paddleTransactionId: 'txn_admin_unrestricted',
      planTier: 'admin_unlimited',
      status: 'active',
      currentPeriodEnd: '2099-12-31T23:59:59.999Z',
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString()
    },
    {
      id: 'sub_demo_001',
      userId: 'usr_demo_001',
      paddleCustomerId: 'ctm_demo_001',
      paddleSubscriptionId: null,
      paddlePriceId: null,
      paddleTransactionId: null,
      planTier: 'free',
      status: 'inactive',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString()
    }
  ],
  user_usage: [
    {
      id: 'usg_demo_001',
      userId: 'usr_demo_001',
      monthYear: new Date().toISOString().slice(0, 7),
      scansUsed: 0,
      maxFreeScans: 3,
      updatedAt: new Date().toISOString()
    }
  ],
  resumes: [],
  evaluations: [],
  webhook_events: [],
  jobs: [...INITIAL_JOBS_DATASET]
};

function ensureDbFile() {
  try {
    const dir = path.dirname(writableDbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(writableDbPath)) {
      if (fs.existsSync(bundledDbPath)) {
        const raw = fs.readFileSync(bundledDbPath, 'utf8');
        fs.writeFileSync(writableDbPath, raw, 'utf8');
      } else {
        fs.writeFileSync(writableDbPath, JSON.stringify(initialDbState, null, 2), 'utf8');
      }
    }
  } catch (err) {
    console.warn('Notice: Disk initialization warning (in-memory state active):', err.message);
  }
}

function loadDb() {
  if (inMemoryDbState) {
    return inMemoryDbState;
  }

  ensureDbFile();

  // Try loading from writable path
  if (fs.existsSync(writableDbPath)) {
    try {
      const raw = fs.readFileSync(writableDbPath, 'utf8');
      inMemoryDbState = JSON.parse(raw);
      ensureJobsSeeded(inMemoryDbState);
      return inMemoryDbState;
    } catch (err) {
      console.warn('Notice: Could not parse writable DB, falling back:', err.message);
    }
  }

  // Try loading from bundled repo path
  if (fs.existsSync(bundledDbPath)) {
    try {
      const raw = fs.readFileSync(bundledDbPath, 'utf8');
      inMemoryDbState = JSON.parse(raw);
      ensureJobsSeeded(inMemoryDbState);
      saveDb(inMemoryDbState);
      return inMemoryDbState;
    } catch (err) {
      console.warn('Notice: Could not parse bundled DB:', err.message);
    }
  }

  // Fallback to initialDbState
  inMemoryDbState = JSON.parse(JSON.stringify(initialDbState));
  ensureJobsSeeded(inMemoryDbState);
  saveDb(inMemoryDbState);
  return inMemoryDbState;
}

function ensureJobsSeeded(state) {
  if (!state) return;
  if (!Array.isArray(state.jobs) || state.jobs.length < INITIAL_JOBS_DATASET.length) {
    const existingJobIds = new Set((state.jobs || []).map(j => j.id));
    const merged = Array.isArray(state.jobs) ? [...state.jobs] : [];
    for (const job of INITIAL_JOBS_DATASET) {
      if (!existingJobIds.has(job.id)) {
        merged.push(job);
      }
    }
    state.jobs = merged;
  }
}

function saveDb(data) {
  inMemoryDbState = data;
  try {
    const dir = path.dirname(writableDbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempFile = `${writableDbPath}.${Date.now()}.${Math.random().toString(36).substring(2, 7)}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    try {
      fs.renameSync(tempFile, writableDbPath);
    } catch {
      // Fallback if atomic rename across mounts or permissions fails
      fs.writeFileSync(writableDbPath, JSON.stringify(data, null, 2), 'utf8');
      try { fs.unlinkSync(tempFile); } catch {}
    }
  } catch (err) {
    console.warn('Notice: DB write skipped due to filesystem constraint (in-memory preserved):', err.message);
  }
}

// Database helper API
export const db = {
  // Users
  users: {
    find(id) {
      const state = loadDb();
      return state.users.find(u => u.id === id) || null;
    },
    findByEmail(email) {
      const state = loadDb();
      return state.users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
    },
    create(userData) {
      const state = loadDb();
      const newUser = {
        id: userData.id || `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        email: userData.email,
        name: userData.name || 'Candidate',
        role: userData.role || 'user',
        createdAt: new Date().toISOString()
      };
      state.users.push(newUser);
      saveDb(state);
      syncUserToSupabase(newUser).catch(() => {});
      return newUser;
    }
  },

  // Subscriptions
  subscriptions: {
    findByUserId(userId) {
      const state = loadDb();
      return state.subscriptions.find(s => s.userId === userId) || null;
    },
    findActiveByUserId(userId) {
      const state = loadDb();
      const sub = state.subscriptions.find(s => s.userId === userId);
      if (!sub) return null;
      if (sub.status === 'active') {
        // If currentPeriodEnd is provided, ensure it's still in the future
        if (sub.currentPeriodEnd) {
          const expires = new Date(sub.currentPeriodEnd);
          if (expires > new Date()) return sub;
        } else {
          return sub;
        }
      }
      return null;
    },
    findByPaddleCustomerId(customerId) {
      const state = loadDb();
      return state.subscriptions.find(s => s.paddleCustomerId === customerId || s.stripeCustomerId === customerId) || null;
    },
    findByPaddleSubId(subId) {
      const state = loadDb();
      return state.subscriptions.find(s => s.paddleSubscriptionId === subId || s.stripeSubscriptionId === subId) || null;
    },
    upsert(subData) {
      const state = loadDb();
      const existingIdx = state.subscriptions.findIndex(
        s => s.userId === subData.userId || 
             (subData.paddleCustomerId && s.paddleCustomerId === subData.paddleCustomerId) ||
             (subData.stripeCustomerId && s.stripeCustomerId === subData.stripeCustomerId) ||
             (subData.paddleSubscriptionId && s.paddleSubscriptionId === subData.paddleSubscriptionId)
      );

      const record = {
        id: existingIdx >= 0 ? state.subscriptions[existingIdx].id : `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        userId: subData.userId,
        paddleCustomerId: subData.paddleCustomerId || subData.stripeCustomerId || (existingIdx >= 0 ? state.subscriptions[existingIdx].paddleCustomerId : null),
        paddleSubscriptionId: subData.paddleSubscriptionId || subData.stripeSubscriptionId || (existingIdx >= 0 ? state.subscriptions[existingIdx].paddleSubscriptionId : null),
        paddlePriceId: subData.paddlePriceId || subData.stripePriceId || (existingIdx >= 0 ? state.subscriptions[existingIdx].paddlePriceId : null),
        paddleTransactionId: subData.paddleTransactionId || (existingIdx >= 0 ? state.subscriptions[existingIdx].paddleTransactionId : null),
        // Backward-compat aliases
        stripeCustomerId: subData.paddleCustomerId || subData.stripeCustomerId || (existingIdx >= 0 ? state.subscriptions[existingIdx].paddleCustomerId : null),
        stripeSubscriptionId: subData.paddleSubscriptionId || subData.stripeSubscriptionId || (existingIdx >= 0 ? state.subscriptions[existingIdx].paddleSubscriptionId : null),
        planTier: subData.planTier || (existingIdx >= 0 ? state.subscriptions[existingIdx].planTier : 'pro'),
        status: subData.status || (existingIdx >= 0 ? state.subscriptions[existingIdx].status : 'inactive'),
        currentPeriodEnd: subData.currentPeriodEnd !== undefined ? subData.currentPeriodEnd : (existingIdx >= 0 ? state.subscriptions[existingIdx].currentPeriodEnd : null),
        cancelAtPeriodEnd: subData.cancelAtPeriodEnd !== undefined ? subData.cancelAtPeriodEnd : (existingIdx >= 0 ? state.subscriptions[existingIdx].cancelAtPeriodEnd : false),
        updatedAt: new Date().toISOString(),
        createdAt: existingIdx >= 0 ? state.subscriptions[existingIdx].createdAt : new Date().toISOString()
      };

      if (existingIdx >= 0) {
        state.subscriptions[existingIdx] = record;
      } else {
        state.subscriptions.push(record);
      }
      saveDb(state);
      syncSubscriptionToSupabase(record).catch(() => {});
      return record;
    }
  },

  // Usage Quotas
  userUsage: {
    getMonthlyUsage(userId, monthYear = new Date().toISOString().slice(0, 7)) {
      const state = loadDb();
      let usage = state.user_usage.find(u => u.userId === userId && u.monthYear === monthYear);
      if (!usage) {
        usage = {
          id: `usg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          userId,
          monthYear,
          scansUsed: 0,
          maxFreeScans: 3,
          updatedAt: new Date().toISOString()
        };
        state.user_usage.push(usage);
        saveDb(state);
      }
      return usage;
    },
    incrementScan(userId, monthYear = new Date().toISOString().slice(0, 7)) {
      const state = loadDb();
      let usage = state.user_usage.find(u => u.userId === userId && u.monthYear === monthYear);
      if (!usage) {
        usage = {
          id: `usg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          userId,
          monthYear,
          scansUsed: 1,
          maxFreeScans: 3,
          updatedAt: new Date().toISOString()
        };
        state.user_usage.push(usage);
      } else {
        usage.scansUsed = (usage.scansUsed || 0) + 1;
        usage.updatedAt = new Date().toISOString();
      }
      saveDb(state);
      syncUsageToSupabase(usage).catch(() => {});
      return usage;
    },
    setScansUsed(userId, count, monthYear = new Date().toISOString().slice(0, 7)) {
      const state = loadDb();
      let usage = state.user_usage.find(u => u.userId === userId && u.monthYear === monthYear);
      if (!usage) {
        usage = {
          id: `usg_${Date.now()}`,
          userId,
          monthYear,
          scansUsed: count,
          maxFreeScans: 3,
          updatedAt: new Date().toISOString()
        };
        state.user_usage.push(usage);
      } else {
        usage.scansUsed = count;
        usage.updatedAt = new Date().toISOString();
      }
      saveDb(state);
      syncUsageToSupabase(usage).catch(() => {});
      return usage;
    }
  },

  // Resumes
  resumes: {
    create(resumeData) {
      const state = loadDb();
      const record = {
        id: `res_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        ...resumeData,
        createdAt: new Date().toISOString()
      };
      state.resumes.push(record);
      saveDb(state);
      syncResumeToSupabase(record).catch(() => {});
      return record;
    },
    findByUserId(userId) {
      const state = loadDb();
      return state.resumes.filter(r => r.userId === userId);
    }
  },

  // Evaluations
  evaluations: {
    create(evalData) {
      const state = loadDb();
      const record = {
        id: `eval_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        ...evalData,
        createdAt: new Date().toISOString()
      };
      state.evaluations.push(record);
      saveDb(state);
      syncEvaluationToSupabase(record).catch(() => {});
      return record;
    },
    findByUserId(userId) {
      const state = loadDb();
      return state.evaluations.filter(e => e.userId === userId);
    }
  },

  // Webhook Events
  webhookEvents: {
    record(eventData) {
      const state = loadDb();
      if (!state.webhook_events) state.webhook_events = [];
      const record = {
        id: eventData.id || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        eventType: eventData.type || eventData.eventType || 'unknown',
        payload: eventData.data || eventData.payload || {},
        status: 'processed',
        receivedAt: new Date().toISOString()
      };
      state.webhook_events.push(record);
      saveDb(state);
      return record;
    },
    list() {
      const state = loadDb();
      return state.webhook_events || [];
    }
  },

  // Jobs Repository (Database Integration)
  jobs: {
    list({ query = '', category = '', remoteOnly = false } = {}) {
      const state = loadDb();
      let jobs = Array.isArray(state.jobs) ? [...state.jobs] : [];
      if (!jobs.length) {
        jobs = [...INITIAL_JOBS_DATASET];
        state.jobs = jobs;
        saveDb(state);
      }

      // Filter by query (title, company, description, skills)
      if (query && query.trim()) {
        const q = query.toLowerCase().trim();
        jobs = jobs.filter(job =>
          (job.title && job.title.toLowerCase().includes(q)) ||
          (job.company && job.company.toLowerCase().includes(q)) ||
          (job.description && job.description.toLowerCase().includes(q)) ||
          (Array.isArray(job.skills) && job.skills.some(s => s.toLowerCase().includes(q)))
        );
      }

      // Filter by category
      if (category && category !== 'All' && category !== '') {
        const cat = category.toLowerCase().trim();
        jobs = jobs.filter(job => job.category && job.category.toLowerCase().includes(cat));
      }

      // Filter by remote status
      if (remoteOnly === true || remoteOnly === 'true') {
        jobs = jobs.filter(job => job.remote === true);
      }

      return jobs;
    },
    findById(id) {
      const state = loadDb();
      return (state.jobs || []).find(j => j.id === id) || null;
    },
    count() {
      const state = loadDb();
      return (state.jobs || []).length;
    },
    create(jobData) {
      const state = loadDb();
      if (!state.jobs) state.jobs = [];
      const newJob = {
        id: jobData.id || `job_jdl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        companyInitial: jobData.companyInitial || (jobData.company ? jobData.company.charAt(0).toUpperCase() : 'J'),
        remote: !!jobData.remote,
        remoteText: jobData.remoteText || (jobData.remote ? 'Remote Allowed' : 'On-Site'),
        employmentType: jobData.employmentType || 'Full-time',
        postedAt: jobData.postedAt || 'Just now',
        source: jobData.source || 'Sample dataset',
        skills: Array.isArray(jobData.skills) ? jobData.skills : [],
        ...jobData,
        createdAt: new Date().toISOString()
      };
      state.jobs.unshift(newJob);
      saveDb(state);
      return newJob;
    }
  },
  contacts: {
    getAll() {
      const state = loadDb();
      return state.contacts || [];
    },
    create(data) {
      const state = loadDb();
      if (!state.contacts) state.contacts = [];
      const newContact = {
        id: `cnt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name: data.name?.trim() || '',
        email: data.email?.trim() || '',
        subject: data.subject || 'general',
        message: data.message?.trim() || '',
        status: 'received',
        createdAt: new Date().toISOString()
      };
      state.contacts.unshift(newContact);
      saveDb(state);
      return newContact;
    }
  },
  supabase: {
    getStatus: getSupabaseStatus,
    initialize: initializeSupabase
  }
};

// Initialize Supabase PostgreSQL in background on server boot
initializeSupabase().catch(err => {
  console.warn('Notice: Background Supabase init notice:', err.message);
});

