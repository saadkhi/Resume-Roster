import './src/polyfills.js';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { db } from './src/db/index.js';
import { jobsService } from './src/services/jobs.js';
import { scoreMatch, atsChecks } from './src/services/nlp.js';
import { analyzeResume, UnreadablePdfError } from './src/services/resumeParser.js';
import { authConfigured, verifyAccessToken, bearerToken } from './src/services/auth.js';
import {
  sessionMiddleware, sessionsEnabled, setSessionCookie, clearSessionCookie
} from './src/middleware/session.js';
import {
  apiLimiter, uploadLimiter, authLimiter, getSafeErrorMessage, isPdfBuffer,
  securityHeaders, sameOriginGuard
} from './src/middleware/security.js';
import { requireAdminAuth, isAdminEmail } from './src/middleware/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');
// One reverse-proxy hop (Vercel / load balancer) for accurate client IPs.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024; // Vercel's request body ceiling is 4.5 MB
const MAX_JOB_TEXT_CHARS = 20_000;
const MAX_MATCH_TEXT_CHARS = 200_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT_BYTES, files: 1 }
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(sessionMiddleware);
app.use(sameOriginGuard);

const publicDir = path.join(__dirname, 'public');

// Content-hashed asset URLs let static files be cached for a long time while
// still updating immediately after a deploy.
const assetVersions = new Map();
app.locals.asset = (urlPath) => {
  const file = path.join(publicDir, urlPath);
  let v = 'dev';
  try {
    const { mtimeMs } = fs.statSync(file);
    const cached = assetVersions.get(urlPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      v = cached.v;
    } else {
      v = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
      assetVersions.set(urlPath, { mtimeMs, v });
    }
  } catch { /* missing file: unversioned */ }
  return `${urlPath}?v=${v}`;
};

app.use((req, res, next) => {
  // Versioned (?v=hash) asset URLs are immutable; unversioned ones revalidate soon.
  if (req.method === 'GET' && /^\/(app\.css|js\/|vendor\/|match-visualizer)/.test(req.path)) {
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  }
  next();
});
app.use(express.static(publicDir, { index: false, cacheControl: false }));
app.get(['/favicon.ico', '/favicon.png'], (req, res) => res.status(204).end());

// ── Helpers ─────────────────────────────────────────────────────────────────
const ok = (res, body = {}) => res.json({ success: true, ...body });
const fail = (res, status, error) => res.status(status).json({ success: false, error });

function pageData(req, extra = {}) {
  return {
    currentUser: req.user ? { name: req.user.name, email: req.user.email, avatar: req.user.avatar } : null,
    authEnabled: authConfigured() && sessionsEnabled(),
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    persistenceMode: db.isDurable() ? 'durable' : 'ephemeral',
    contactEmail: process.env.CONTACT_EMAIL || '',
    ...extra
  };
}

function render(view, req, res, extra = {}) {
  res.render(view, pageData(req, extra), (err, html) => {
    if (err) {
      console.error(`Template error (${view}):`, err);
      return res.status(500).type('html').send('<!DOCTYPE html><title>Error</title><p>Something went wrong. Please try again.</p>');
    }
    res.type('html').send(html);
  });
}

function jobTextFrom(body = {}) {
  const text = typeof body.job_description_text === 'string' ? body.job_description_text.trim() : '';
  const keywords = typeof body.job_keywords === 'string' ? body.job_keywords.trim() : '';
  return (text || keywords).slice(0, MAX_JOB_TEXT_CHARS);
}

function persistEvaluation(req, analysis, size) {
  if (!req.user || !analysis.match) return false;
  db.users.upsert(req.user); // idempotent; also recreates state on a cold serverless instance
  const resume = db.resumes.create({
    userId: req.user.id,
    filename: analysis.filename,
    fileSizeBytes: size,
    pageCount: analysis.pages,
    wordCount: analysis.stats.wordCount,
    detectedCategory: analysis.category
  });
  db.evaluations.create({
    userId: req.user.id,
    resumeId: resume.id,
    targetJobTitle: analysis.match.targetJob,
    similarityScore: analysis.match.similarityScore,
    matchRating: analysis.match.matchRating,
    dimensions: analysis.match.dimensions,
    keywordGaps: analysis.match.missingKeywords
  });
  return true;
}

function sendAnalysisError(res, err, fallback) {
  if (err instanceof UnreadablePdfError) return fail(res, 422, err.message);
  console.error('Analysis error:', err);
  return fail(res, 500, getSafeErrorMessage(err, fallback));
}

// ── Pages ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => render('index', req, res));
app.get('/auth', (req, res) => render('auth', req, res));
app.get('/auth/callback', (req, res) => render('auth-callback', req, res));
app.get('/terms', (req, res) => render('terms', req, res));
app.get('/privacy', (req, res) => render('privacy', req, res));
app.get('/contact', (req, res) => render('contact', req, res, { form: { name: '', email: '', subject: 'general', message: '' }, status: null }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/contact', apiLimiter, (req, res) => {
  const body = req.body || {};
  const form = {
    name: String(body.name || '').trim().slice(0, 100),
    email: String(body.email || '').trim().slice(0, 254),
    subject: String(body.subject || 'general').slice(0, 50),
    message: String(body.message || '').trim().slice(0, 5000)
  };
  // Hidden "website" field: humans leave it empty, bots fill it in.
  if (body.website) return render('contact', req, res, { form, status: { ok: true, text: 'Thanks. Your message was sent.' } });
  if (!EMAIL_RE.test(form.email) || form.message.length < 10) {
    return res.status(400).render('contact', pageData(req, {
      form,
      status: { ok: false, text: 'Please enter a valid email address and a message of at least 10 characters.' }
    }));
  }
  db.contacts.create(form);
  return render('contact', req, res, {
    form: { name: '', email: '', subject: 'general', message: '' },
    status: { ok: true, text: 'Thanks. Your message was sent and we will reply by email.' }
  });
});

// ── Resume analysis API ─────────────────────────────────────────────────────
app.post('/api/parse-resume', uploadLimiter, (req, res, next) => {
  upload.single('resume')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 413, 'File exceeds the 4 MB limit. Please upload a smaller PDF.');
    }
    return fail(res, 400, 'File upload failed. Please try again.');
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) return fail(res, 400, 'No PDF uploaded. Please choose a PDF resume.');
  if (!isPdfBuffer(file.buffer)) return fail(res, 400, 'That file is not a valid PDF document.');

  try {
    const analysis = await analyzeResume(file.buffer, {
      filename: path.basename(file.originalname || 'resume.pdf').slice(0, 255),
      jobText: jobTextFrom(req.body)
    });
    const persisted = persistEvaluation(req, analysis, file.size);
    return ok(res, { ...analysis, persisted });
  } catch (err) {
    return sendAnalysisError(res, err, 'Failed to analyse the resume.');
  }
});

// Bundled, fictional sample resumes for trying the tool without uploading.
const SAMPLE_DIR = path.join(__dirname, 'uploads');
const SAMPLES = [
  { file: 'sample-data-scientist.pdf', name: 'Data scientist (sample)' },
  { file: 'sample-software-engineer.pdf', name: 'Software engineer (sample)' },
  { file: 'sample-web-developer.pdf', name: 'Web developer (sample)' },
  { file: 'sample-junior-developer.pdf', name: 'Junior developer (sample)' }
];

app.get('/api/sample-resumes', apiLimiter, (req, res) => {
  const samples = SAMPLES.filter(s => fs.existsSync(path.join(SAMPLE_DIR, s.file)))
    .map(s => ({ id: s.file, name: s.name }));
  return ok(res, { samples });
});

app.post('/api/parse-sample', apiLimiter, async (req, res) => {
  const sample = SAMPLES.find(s => s.file === req.body?.sampleName);
  if (!sample) return fail(res, 400, 'Unknown sample resume.');
  try {
    const buffer = fs.readFileSync(path.join(SAMPLE_DIR, sample.file));
    const analysis = await analyzeResume(buffer, { filename: sample.name, jobText: jobTextFrom(req.body) });
    return ok(res, { ...analysis, persisted: false, isSample: true });
  } catch (err) {
    return sendAnalysisError(res, err, 'Failed to load the sample resume.');
  }
});

app.post('/api/evaluate-match', apiLimiter, (req, res) => {
  const { resumeText, jobDescriptionText, resumeSections } = req.body || {};
  if (typeof resumeText !== 'string' || typeof jobDescriptionText !== 'string' ||
      !resumeText.trim() || !jobDescriptionText.trim()) {
    return fail(res, 400, 'Both resumeText and jobDescriptionText are required.');
  }
  if (resumeText.length > MAX_MATCH_TEXT_CHARS || jobDescriptionText.length > MAX_MATCH_TEXT_CHARS) {
    return fail(res, 413, 'Text input exceeds the 200 KB per-field limit.');
  }
  const sections = resumeSections && typeof resumeSections === 'object' ? resumeSections : {};
  const match = scoreMatch(resumeText, jobDescriptionText, sections);
  const { checks, suggestions } = atsChecks({ rawText: resumeText, sections, pages: Number(req.body.pages) || 1, match });
  return ok(res, { ...match, checks, suggestions });
});

const handleJobs = (req, res) => {
  const src = req.method === 'GET' ? req.query : (req.body || {});
  const resumeText = typeof src.resumeText === 'string' ? src.resumeText.slice(0, MAX_MATCH_TEXT_CHARS) : '';
  const result = jobsService.getJobs({
    query: String(src.query || '').slice(0, 100),
    category: String(src.category || '').slice(0, 60),
    remoteOnly: src.remote === true || src.remote === 'true',
    resumeText
  });
  return res.json(result);
};
app.get('/api/jobs', apiLimiter, handleJobs);
app.post('/api/jobs', apiLimiter, handleJobs);

// ── Auth API ────────────────────────────────────────────────────────────────
// The client sends its Supabase access token; the server verifies it with
// Supabase and issues its own signed, httpOnly session cookie. No identity is
// ever taken from the request body.
app.post('/api/auth/session', authLimiter, async (req, res) => {
  if (!authConfigured()) return fail(res, 503, 'Sign-in is not configured on this server.');
  if (!sessionsEnabled()) return fail(res, 503, 'Sign-in is temporarily unavailable (server configuration).');

  const verified = await verifyAccessToken(bearerToken(req));
  if (!verified) return fail(res, 401, 'Your sign-in could not be verified. Please try again.');

  const user = { id: verified.id, email: verified.email, name: verified.name, avatar: verified.avatar };
  db.users.upsert(user);
  setSessionCookie(req, res, { ...user, isAdmin: isAdminEmail(user.email, verified.emailConfirmed) });
  return ok(res, { user: { name: user.name, email: user.email, avatar: user.avatar } });
});

app.get('/api/auth/me', apiLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return ok(res, {
    authenticated: !!req.user,
    user: req.user ? { name: req.user.name, email: req.user.email, avatar: req.user.avatar } : null
  });
});

app.post('/api/auth/signout', (req, res) => {
  clearSessionCookie(req, res);
  return ok(res);
});

// ── Signed-in user data ─────────────────────────────────────────────────────
function requireUser(req, res, next) {
  if (!req.user) return fail(res, 401, 'Please sign in to view your history.');
  return next();
}

app.get('/api/history', apiLimiter, requireUser, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const items = db.evaluations.listByUser(req.user.id, 20).map(e => ({
    id: e.id,
    target: e.targetJobTitle,
    score: e.similarityScore,
    rating: e.matchRating,
    createdAt: e.createdAt
  }));
  return ok(res, { items, durable: db.isDurable() });
});

app.delete('/api/history', apiLimiter, requireUser, (req, res) => {
  const removed = db.deleteUserData(req.user.id);
  clearSessionCookie(req, res);
  return ok(res, { removed });
});

// ── Operations ──────────────────────────────────────────────────────────────
app.get('/api/health', apiLimiter, (req, res) => ok(res, {
  status: 'ok',
  auth: authConfigured() && sessionsEnabled(),
  persistence: db.isDurable() ? 'durable' : 'ephemeral'
}));

app.get('/api/admin/status', requireAdminAuth, (req, res) => ok(res, {
  isAdmin: true,
  database: db.supabase.getStatus()
}));

app.post('/api/admin/db-test', requireAdminAuth, apiLimiter, async (req, res) => {
  try {
    return ok(res, { database: await db.supabase.initialize() });
  } catch (err) {
    return fail(res, 500, getSafeErrorMessage(err));
  }
});

// ── Errors ──────────────────────────────────────────────────────────────────
app.use('/api', (req, res) => fail(res, 404, `API route not found: ${req.method} ${req.path}`));

app.use((req, res) => {
  res.status(404).type('html').send('<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;padding:3rem"><h1>Page not found</h1><p><a href="/">Back to Resume Rater</a></p></body></html>');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('Unhandled error:', err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return fail(res, status, status >= 500 ? getSafeErrorMessage(err, 'An unexpected server error occurred.') : (err.expose ? err.message : 'Bad request.'));
  }
  return res.status(status).type('html').send('<!DOCTYPE html><title>Error</title><p>Something went wrong. Please try again.</p>');
});

// Listen only when run directly (not when imported by Vercel or tests).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`Resume Rater listening on http://localhost:${PORT} (${isProduction ? 'production' : 'development'})`);
  });
}

export { app };
export default app;
