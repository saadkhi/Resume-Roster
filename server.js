import './src/polyfills.js';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
if (pdfjsWorker && (pdfjsWorker.WorkerMessageHandler || pdfjsWorker.default?.WorkerMessageHandler)) {
  globalThis.pdfjsWorker = pdfjsWorker;
}
import express from 'express';
import ejs from 'ejs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { db } from './src/db/index.js';
import { billingService, checkSubscriptionAndQuota } from './src/services/billing.js';
import { jobsService } from './src/services/jobs.js';
import { apiLimiter, uploadLimiter, billingLimiter, getSafeErrorMessage, validatePdfMagicBytes, cleanupFile } from './src/middleware/security.js';
import {
  isAdminRequest,
  getAdminUser,
  getAdminSubscription,
  isGlobalAdminOverrideActive,
  setGlobalAdminOverride,
  ADMIN_EMAIL
} from './src/middleware/admin.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const isDevMode = !isProduction;

// Trust 1 hop reverse proxy for accurate client IP resolution behind load balancers/Cloud Run/Vercel
app.set('trust proxy', 1);

// Vercel / Serverless Read-Only File System Compatibility
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION);
const bundledUploadsDir = path.join(__dirname, 'uploads');
const writableUploadsDir = isServerless ? path.join(os.tmpdir(), 'resume_rater_uploads') : bundledUploadsDir;

try {
  if (!fs.existsSync(writableUploadsDir)) {
    fs.mkdirSync(writableUploadsDir, { recursive: true });
  }
} catch (err) {
  console.warn('Notice: Writable uploads directory warning:', err.message);
}

// Helper to resolve resume file across writable /tmp, bundled repository, and current working directory
function resolveResumePath(filename) {
  const safeName = path.basename(filename);
  
  // 1. Check writable directory
  const writablePath = path.join(writableUploadsDir, safeName);
  if (fs.existsSync(writablePath)) return writablePath;

  // 2. Check bundled uploads directory
  const bundledPath = path.join(bundledUploadsDir, safeName);
  if (fs.existsSync(bundledPath)) return bundledPath;

  // 3. Check process.cwd() uploads directory (Vercel lambda bundle root)
  const cwdPath = path.join(process.cwd(), 'uploads', safeName);
  if (fs.existsSync(cwdPath)) return cwdPath;

  return writablePath;
}

// Multer setup using writable directory (/tmp on Vercel)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, writableUploadsDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1
  }
});

// Paddle Webhook Endpoint (Requires raw JSON buffer for signature verification)
const handleWebhookRequest = async (req, res) => {
  const sig = req.headers['paddle-signature'] || req.headers['stripe-signature'];
  try {
    const result = await billingService.handleWebhook(req.body, sig);
    res.json(result);
  } catch (err) {
    console.error('Paddle webhook error:', err.message);
    res.status(400).json({ error: getSafeErrorMessage(err, 'Webhook verification failed.') });
  }
};
app.post('/api/webhooks/paddle', express.raw({ type: 'application/json', limit: '2mb' }), handleWebhookRequest);
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '2mb' }), handleWebhookRequest);
app.post('/api/webhooks', express.raw({ type: 'application/json', limit: '2mb' }), handleWebhookRequest);

app.set('view engine', 'ejs');
const candidateViewsDirs = [
  path.join(process.cwd(), 'views'),
  path.join(__dirname, 'views'),
  path.join(__dirname, '..', 'views'),
  path.join('/var/task', 'views'),
  path.resolve('views')
];
const validViewsDirs = candidateViewsDirs.filter(d => {
  try { return fs.existsSync(d); } catch { return false; }
});
app.set('views', validViewsDirs.length > 0 ? validViewsDirs : path.join(process.cwd(), 'views'));

// Resilient template renderer for serverless environments
function renderIndexDashboard(req, res, customData = {}) {
  try {
    const admin = isAdminRequest(req);
    const cookieUserId = req.cookies?.user_id;
    const cookieUserEmail = req.cookies?.user_email;
    const cookieUserName = req.cookies?.user_name;
    const cookieUserAvatar = req.cookies?.user_avatar;

    const userId = admin ? 'usr_admin_saad' : (cookieUserId || req.headers['x-user-id'] || 'usr_demo_001');
    let user = db.users.find(userId);
    if (!user && cookieUserEmail) {
      user = db.users.create({
        id: userId,
        email: cookieUserEmail,
        name: cookieUserName || cookieUserEmail.split('@')[0],
        avatar: cookieUserAvatar || ''
      });
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    const usage = db.userUsage.getMonthlyUsage(userId, currentMonth);

    const templateData = {
      error: null,
      prediction_category: null,
      resume_match_rating: null,
      numerical_similarity_score: null,
      csv_data: null,
      isDevMode,
      isAdmin: admin,
      adminEmail: ADMIN_EMAIL,
      currentUser: user ? {
        id: user.id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        avatar: cookieUserAvatar || user.avatar || ''
      } : (cookieUserEmail ? {
        id: userId,
        email: cookieUserEmail,
        name: cookieUserName || cookieUserEmail.split('@')[0],
        avatar: cookieUserAvatar || ''
      } : null),
      supabaseUrl: process.env.SUPABASE_URL || 'https://medvnbynodmsjaqvtjzl.supabase.co',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder',
      billing: {
        isAdmin: admin,
        isPro: true,
        isFreeForever: true,
        planTier: '100% Free Forever',
        scansUsed: usage ? usage.scansUsed : 0,
        maxFreeScans: 'Unlimited',
        scansRemaining: 'unlimited',
        unrestrictedAccess: true
      },
      ...customData
    };

    // Attempt direct template read first to bypass runtime view lookup quirks
    const templateSearchPaths = [
      path.join(process.cwd(), 'views', 'index.ejs'),
      path.join(__dirname, 'views', 'index.ejs'),
      path.join(__dirname, '..', 'views', 'index.ejs'),
      path.join('/var/task', 'views', 'index.ejs'),
      path.resolve('views', 'index.ejs')
    ];

    let templateContent = null;
    for (const p of templateSearchPaths) {
      if (fs.existsSync(p)) {
        try {
          templateContent = fs.readFileSync(p, 'utf8');
          if (templateContent) break;
        } catch {
          // continue
        }
      }
    }

    if (templateContent) {
      const html = ejs.render(templateContent, templateData, {
        views: validViewsDirs
      });
      return res.send(html);
    }

    // Fallback to res.render with error interception
    return res.render('index', templateData, (err, html) => {
      if (err) {
        console.error('EJS view rendering error:', err);
        return res.status(500).send('<!DOCTYPE html><html><body><h2>Error Rendering Resume Rater Dashboard</h2><p>An unexpected error occurred while loading the dashboard.</p></body></html>');
      }
      return res.send(html);
    });
  } catch (err) {
    console.error('renderIndexDashboard error:', err);
    return res.status(500).send('<!DOCTYPE html><html><body><h2>Dashboard Load Failure</h2><p>An unexpected error occurred while loading the dashboard.</p></body></html>');
  }
}

// Resilient template renderer for legal & static pages (Terms, Privacy, Refund, Contact)
function renderEjsPage(viewName, req, res, customData = {}) {
  try {
    const templateSearchPaths = [
      path.join(process.cwd(), 'views', `${viewName}.ejs`),
      path.join(__dirname, 'views', `${viewName}.ejs`),
      path.join(__dirname, '..', 'views', `${viewName}.ejs`),
      path.join('/var/task', 'views', `${viewName}.ejs`),
      path.resolve('views', `${viewName}.ejs`)
    ];

    let templateContent = null;
    for (const p of templateSearchPaths) {
      if (fs.existsSync(p)) {
        try {
          templateContent = fs.readFileSync(p, 'utf8');
          if (templateContent) break;
        } catch {
          // continue
        }
      }
    }

    const templateData = { isDevMode, isAdmin: isAdminRequest(req), ...customData };

    if (templateContent) {
      const html = ejs.render(templateContent, templateData, { views: validViewsDirs });
      return res.send(html);
    }

    return res.render(viewName, templateData, (err, html) => {
      if (err) {
        console.error(`EJS view rendering error for ${viewName}:`, err);
        return res.status(500).send(`<!DOCTYPE html><html><body><h2>Error loading ${viewName} page</h2><p>Please try again later.</p></body></html>`);
      }
      return res.send(html);
    });
  } catch (err) {
    console.error(`renderEjsPage error for ${viewName}:`, err);
    return res.status(500).send(`<!DOCTYPE html><html><body><h2>Page Load Error</h2><p>Please try again later.</p></body></html>`);
  }
}

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Lightweight cookie parser middleware
app.use((req, res, next) => {
  req.cookies = req.cookies || {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const parts = c.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = decodeURIComponent(parts.slice(1).join('=').trim());
        req.cookies[key] = val;
      }
    });
  }
  next();
});

const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// Gracefully handle browser favicon requests
app.get(['/favicon.ico', '/favicon.png'], (req, res) => res.status(204).end());

// NLP & Model Logic
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'could', 'did',
  'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have',
  'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves'
]);

const TECH_SHORT_TOKENS = new Set([
  'c', 'r', 'go', 'ai', 'ml', 'ui', 'ux', 'db', 'qa', 'os', 'ci', 'cd', 'io', 'js', 'ts'
]);

function tokenize(text) {
  if (typeof text !== 'string') return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => (t.length > 2 || TECH_SHORT_TOKENS.has(t)) && !STOP_WORDS.has(t));
}

// Load training dataset and build category centroids & IDF
const categoryCentroids = {};
const idf = {};
let totalDocs = 0;

function trainClassifier() {
  const datasetPath = fs.existsSync(path.join(__dirname, 'data', 'gpt_dataset.csv'))
    ? path.join(__dirname, 'data', 'gpt_dataset.csv')
    : path.join(process.cwd(), 'data', 'gpt_dataset.csv');

  if (!fs.existsSync(datasetPath)) {
    console.warn('Dataset file not found at:', datasetPath);
    return;
  }

  const content = fs.readFileSync(datasetPath, 'utf8');
  const lines = content.split('\n');
  const rows = [];
  const categoryDocs = {};
  const docFreq = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const commaIdx = line.indexOf(',');
    if (commaIdx === -1) continue;
    const category = line.substring(0, commaIdx).trim().replace(/^"|"$/g, '');
    const resume = line.substring(commaIdx + 1).trim().replace(/^"|"$/g, '');
    rows.push({ category, resume });
  }

  totalDocs = rows.length;
  for (const r of rows) {
    if (!categoryDocs[r.category]) categoryDocs[r.category] = [];
    categoryDocs[r.category].push(r.resume);
    const words = new Set(tokenize(r.resume));
    for (const w of words) {
      docFreq[w] = (docFreq[w] || 0) + 1;
    }
  }

  for (const [w, df] of Object.entries(docFreq)) {
    idf[w] = Math.log((1 + totalDocs) / (1 + df)) + 1;
  }

  for (const [cat, docs] of Object.entries(categoryDocs)) {
    const combined = docs.join(' ');
    categoryCentroids[cat] = computeTfidfVector(combined);
  }

  console.log(`Classifier trained on ${totalDocs} documents across ${Object.keys(categoryCentroids).length} categories.`);
}

function computeTfidfVector(text) {
  const tokens = tokenize(text);
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  const vec = {};
  let norm = 0;
  // Bounded baseline IDF for unseen words so out-of-vocabulary terms do not distort vectors
  const defaultIdf = totalDocs > 0 ? (Math.log((1 + totalDocs) / (1 + Math.max(1, Math.round(totalDocs * 0.15)))) + 1) : 2.5;
  for (const [t, count] of Object.entries(tf)) {
    const weight = count * (idf[t] || defaultIdf);
    vec[t] = weight;
    norm += weight * weight;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const t in vec) vec[t] /= norm;
  }
  return vec;
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  for (const t in vecA) {
    if (vecB[t]) {
      dot += vecA[t] * vecB[t];
    }
  }
  return dot;
}

function predictCategory(resumeText) {
  const resumeVec = computeTfidfVector(resumeText);
  let bestCategory = 'Unknown';
  let bestScore = -1;

  for (const [cat, catVec] of Object.entries(categoryCentroids)) {
    const sim = cosineSimilarity(resumeVec, catVec);
    if (sim > bestScore) {
      bestScore = sim;
      bestCategory = cat;
    }
  }
  return bestCategory;
}

function rateResumeSimilarity(resumeVec, jobDescVec) {
  const similarityScore = cosineSimilarity(resumeVec, jobDescVec);
  let matchRating = 'Low Match';
  if (similarityScore >= 0.75) {
    matchRating = 'High Match';
  } else if (similarityScore >= 0.50) {
    matchRating = 'Medium Match';
  }
  return { matchRating, similarityScore };
}

function getPdfjsAssetPath(subDir) {
  try {
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    const dir = path.join(path.dirname(pkgPath), subDir);
    if (fs.existsSync(dir)) {
      return dir.endsWith(path.sep) ? dir : dir + path.sep;
    }
  } catch {}
  const fallback = path.join(__dirname, 'node_modules/pdfjs-dist', subDir);
  return fallback.endsWith(path.sep) ? fallback : fallback + path.sep;
}

let CachedPDFParse = null;
async function getPDFParseClass() {
  if (!globalThis.pdfjsWorker) {
    try {
      const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      globalThis.pdfjsWorker = workerMod;
    } catch {}
  }
  if (!CachedPDFParse) {
    const mod = await import('pdf-parse');
    CachedPDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;
  }
  return CachedPDFParse;
}

async function parsePdfDetails(filePath) {
  try {
    const fileBuffer = typeof filePath === 'string' ? fs.readFileSync(filePath) : filePath;
    const PDFParser = await getPDFParseClass();
    const standardFontDataUrl = getPdfjsAssetPath('standard_fonts');
    const cMapUrl = getPdfjsAssetPath('cmaps');
    const parser = new PDFParser({
      data: new Uint8Array(fileBuffer),
      standardFontDataUrl,
      cMapUrl,
      cMapPacked: true
    });
    const result = await parser.getText();
    const text = result?.text || '';
    const pages = result?.total || (result?.pages ? result.pages.length : 1);
    return { text, pages };
  } catch (err) {
    console.error('Error parsing PDF details:', err);
    throw err;
  }
}

async function pdfToText(filePath) {
  try {
    const { text } = await parsePdfDetails(filePath);
    return text;
  } catch (err) {
    console.error('Error parsing PDF:', err);
    return '';
  }
}

function cleanResume(txt) {
  if (typeof txt !== 'string') return '';
  let cleanText = txt.replace(/http\S+\s*/g, ' ');
  cleanText = cleanText.replace(/\b(RT|cc)\b/g, ' ');
  cleanText = cleanText.replace(/#\S+\s*/g, ' ');
  cleanText = cleanText.replace(/@\S+/g, ' ');
  // Normalize programming languages & technical acronyms with symbols before removing punctuation
  cleanText = cleanText.replace(/c\+\+/gi, ' cpp ');
  cleanText = cleanText.replace(/c#/gi, ' csharp ');
  cleanText = cleanText.replace(/\.net\b/gi, ' dotnet ');
  cleanText = cleanText.replace(/node\.js\b/gi, ' nodejs ');
  cleanText = cleanText.replace(/react\.js\b/gi, ' reactjs ');
  cleanText = cleanText.replace(/vue\.js\b/gi, ' vuejs ');
  cleanText = cleanText.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, ' ');
  cleanText = cleanText.replace(/[^\x00-\x7f]/g, ' ');
  cleanText = cleanText.replace(/\s+/g, ' ').trim();
  return cleanText;
}

const ALL_SECTION_NAMES = ['Education', 'Experience', 'Skills', 'Projects', 'Certifications', 'Languages', 'Summary', 'Profile'];
const getSectionTerminators = (currentSection) => ALL_SECTION_NAMES.filter(s => s.toLowerCase() !== currentSection.toLowerCase());

function extractSectionRegex(cvText, sectionName, endKeywords) {
  if (typeof cvText !== 'string') return `${sectionName} section not found.`;
  const lines = cvText.split(/\r?\n/);
  let capturing = false;
  const capturedLines = [];
  const startRegex = new RegExp('^\\s*(?:[#*\\d.-]+\\s*)?' + sectionName + '[:\\s]*$', 'i');
  const endKeywordsList = (Array.isArray(endKeywords) && endKeywords.length > 0) ? endKeywords : getSectionTerminators(sectionName);
  const endRegex = new RegExp('^\\s*(?:[#*\\d.-]+\\s*)?(' + endKeywordsList.join('|') + ')[:\\s]*$', 'i');

  for (const line of lines) {
    if (!capturing) {
      if (startRegex.test(line.trim())) {
        capturing = true;
        capturedLines.push(line);
      }
    } else {
      if (endRegex.test(line.trim())) {
        break;
      }
      capturedLines.push(line);
    }
  }

  if (capturedLines.length > 0) {
    return capturedLines.join('\n').trim();
  }

  // Fallback: search substring boundary
  const subIdx = cvText.search(new RegExp('(?:^|\\n)\\s*(?:[#*\\d.-]+\\s*)?' + sectionName, 'i'));
  if (subIdx !== -1) {
    const fromSection = cvText.slice(subIdx);
    const firstNewline = fromSection.indexOf('\n');
    if (firstNewline !== -1) {
      const contentAfterHeader = fromSection.slice(firstNewline + 1);
      const endMatch = contentAfterHeader.search(new RegExp('(?:^|\\n)\\s*(?:[#*\\d.-]+\\s*)?(' + endKeywordsList.join('|') + ')[:\\s]', 'im'));
      if (endMatch !== -1) {
        return contentAfterHeader.slice(0, endMatch).trim();
      }
      return contentAfterHeader.trim();
    }
    return fromSection.trim();
  }

  return `${sectionName} section not found.`;
}

function saveToCsv(data) {
  const csvFile = isServerless ? path.join(os.tmpdir(), 'cv_sections.csv') : path.join(__dirname, 'cv_sections.csv');
  try {
    const fileExists = fs.existsSync(csvFile);

    const escapeCsv = (val) => {
      if (val === undefined || val === null) return '""';
      let str = String(val);
      // Neutralize formula / CSV injection
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const line = [
      escapeCsv(data.Name),
      escapeCsv(data.Category),
      escapeCsv(data.Education),
      escapeCsv(data.Experience),
      escapeCsv(data.Skills),
      escapeCsv(data.Projects),
      data['Probability Score']
    ].join(',') + '\n';

    if (!fileExists) {
      const header = 'Name,Category,Education,Experience,Skills,Projects,Probability Score\n';
      fs.writeFileSync(csvFile, header + line, 'utf8');
    } else {
      fs.appendFileSync(csvFile, line, 'utf8');
    }
  } catch (err) {
    console.warn('Notice: Could not write to cv_sections.csv on serverless filesystem:', err.message);
  }
}

function computeDetailedMatchMetrics(resumeText, jobDescriptionText, resumeSections = null) {
  const cleanedResume = cleanResume(resumeText);
  const cleanedJd = cleanResume(jobDescriptionText);

  const resumeVec = computeTfidfVector(cleanedResume);
  const jdVec = computeTfidfVector(cleanedJd);

  const { matchRating, similarityScore } = rateResumeSimilarity(resumeVec, jdVec);
  const roundedScore = Number(similarityScore.toFixed(2));
  const percentage = Math.min(100, Math.max(0, Math.round(roundedScore * 100)));

  // Extract top keywords from JD
  const jdTokens = Object.keys(jdVec).sort((a, b) => jdVec[b] - jdVec[a]);
  const topJdTokens = jdTokens.slice(0, 8);

  const keywordAlignment = topJdTokens.map(token => {
    const jdVal = Math.min(100, Math.round((jdVec[token] || 0) * 160));
    const resumeVal = Math.min(100, Math.round((resumeVec[token] || 0) * 160));
    return {
      keyword: token.charAt(0).toUpperCase() + token.slice(1),
      resumeScore: resumeVal,
      jobScore: Math.max(jdVal, 35),
      matched: resumeVal > 0
    };
  });

  const matchedTokensCount = topJdTokens.filter(t => (resumeVec[t] || 0) > 0).length;
  const keywordCoverage = topJdTokens.length > 0 ? Math.round((matchedTokensCount / topJdTokens.length) * 100) : percentage;

  // Skills alignment score
  let skillsScore = percentage;
  if (resumeSections?.Skills && !resumeSections.Skills.toLowerCase().includes('not found')) {
    const skillsVec = computeTfidfVector(cleanResume(resumeSections.Skills));
    const skillSim = cosineSimilarity(skillsVec, jdVec);
    skillsScore = Math.min(100, Math.round(skillSim * 120) + 10);
  } else {
    skillsScore = Math.max(15, Math.round(percentage * 0.9));
  }

  // Projects / Experience score
  let projectsScore = percentage;
  if (resumeSections?.Projects && !resumeSections.Projects.toLowerCase().includes('not found')) {
    const projVec = computeTfidfVector(cleanResume(resumeSections.Projects));
    const projSim = cosineSimilarity(projVec, jdVec);
    projectsScore = Math.min(100, Math.round(projSim * 120) + 10);
  } else {
    projectsScore = Math.max(10, Math.round(percentage * 0.85));
  }

  const domainScore = Math.min(100, Math.max(percentage, Math.round((percentage + keywordCoverage) / 2)));

  const dimensions = [
    { dimension: 'Cosine Fit', score: Math.max(percentage, 5), target: 100, fullMark: 100 },
    { dimension: 'Key Skills', score: Math.max(skillsScore, 5), target: 100, fullMark: 100 },
    { dimension: 'Keywords', score: Math.max(keywordCoverage, 5), target: 100, fullMark: 100 },
    { dimension: 'Projects', score: Math.max(projectsScore, 5), target: 100, fullMark: 100 },
    { dimension: 'Domain Scope', score: Math.max(domainScore, 5), target: 100, fullMark: 100 }
  ];

  return {
    similarityScore: roundedScore,
    matchRating,
    percentage,
    dimensions,
    keywordAlignment,
    matchedCount: matchedTokensCount,
    totalKeywordsChecked: topJdTokens.length
  };
}

// Helper to extract full resume analysis
async function analyzeResumePdf(filePath, originalName, jobDescriptionText = '', jobKeywords = '') {
  const { text: rawText, pages } = await parsePdfDetails(filePath);
  const cleanedResume = cleanResume(rawText);

  const sections = {
    Education: extractSectionRegex(rawText, 'Education', getSectionTerminators('Education')),
    Experience: extractSectionRegex(rawText, 'Experience', getSectionTerminators('Experience')),
    Skills: extractSectionRegex(rawText, 'Skills', getSectionTerminators('Skills')),
    Projects: extractSectionRegex(rawText, 'Projects', getSectionTerminators('Projects'))
  };

  const wordCount = rawText.trim() ? rawText.trim().split(/\s+/).length : 0;
  const characterCount = rawText.length;
  const category = predictCategory(cleanedResume);

  // Match against job description if provided
  let match = null;
  const targetJd = jobDescriptionText.trim() || jobKeywords.trim() || '';
  if (targetJd) {
    const detailedMatch = computeDetailedMatchMetrics(cleanedResume, targetJd, sections);
    match = {
      ...detailedMatch,
      targetJob: targetJd.length > 80 ? targetJd.substring(0, 80) + '...' : targetJd
    };

    saveToCsv({
      Name: originalName || 'Unknown',
      Category: category,
      Education: sections.Education,
      Experience: sections.Experience,
      Skills: sections.Skills,
      Projects: sections.Projects,
      'Probability Score': detailedMatch.similarityScore
    });
  }

  return {
    filename: originalName,
    pages,
    stats: {
      wordCount,
      characterCount,
      pageCount: pages
    },
    category,
    sections,
    rawText,
    cleanedText: cleanedResume,
    match
  };
}

// REST API Endpoints

// 1. API: Parse uploaded PDF resume (Protected by subscription & quota check)
app.post('/api/parse-resume', uploadLimiter, checkSubscriptionAndQuota, (req, res, next) => {
  upload.single('resume')(req, res, err => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ success: false, error: 'File size exceeds 15MB limit. Please upload a smaller PDF.' });
        }
        return res.status(400).json({ success: false, error: getSafeErrorMessage(err, 'File upload error.') });
      }
      return res.status(400).json({ success: false, error: getSafeErrorMessage(err, 'File upload failed.') });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No PDF file uploaded. Please select or drag a PDF resume.'
      });
    }

    const isPdf = req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      cleanupFile(req.file.path);
      return res.status(400).json({
        success: false,
        error: 'Unsupported file type. Please upload a valid PDF document.'
      });
    }

    if (!validatePdfMagicBytes(req.file.path)) {
      cleanupFile(req.file.path);
      return res.status(400).json({
        success: false,
        error: 'The uploaded file is not a valid PDF document.'
      });
    }

    const jobDescriptionText = req.body.job_description_text || '';
    const jobKeywords = req.body.job_keywords || '';

    let analysis;
    try {
      analysis = await analyzeResumePdf(req.file.path, req.file.originalname, jobDescriptionText, jobKeywords);
    } finally {
      cleanupFile(req.file.path);
    }

    // Consume scan quota for free users upon successful parse
    if (req.consumeScanQuota) req.consumeScanQuota();

    // Persist to relational database
    const currentMonth = new Date().toISOString().slice(0, 7);
    const updatedUsage = db.userUsage.getMonthlyUsage(req.user.id, currentMonth);

    const savedResume = db.resumes.create({
      userId: req.user.id,
      title: req.file.originalname.replace(/\.pdf$/i, ''),
      filename: req.file.originalname,
      fileSizeBytes: req.file.size,
      pageCount: analysis.pages || 1,
      rawText: analysis.rawText,
      cleanedText: analysis.cleanedText,
      parsedSections: analysis.sections,
      detectedCategory: analysis.category
    });

    if (analysis.match) {
      db.evaluations.create({
        userId: req.user.id,
        resumeId: savedResume.id,
        targetJobTitle: analysis.match.targetJob || jobKeywords || 'Custom Job Requirement',
        similarityScore: analysis.match.similarityScore,
        matchRating: analysis.match.matchRating,
        dimensions: analysis.match.dimensions || [],
        keywordGaps: analysis.match.keywordAlignment || []
      });
    }

    return res.json({
      success: true,
      ...analysis,
      resumeId: savedResume.id,
      billing: {
        isPro: req.isPro,
        planTier: req.subscription?.planTier || 'free',
        scansUsed: updatedUsage.scansUsed,
        maxFreeScans: updatedUsage.maxFreeScans,
        scansRemaining: req.isPro ? 'unlimited' : Math.max(0, updatedUsage.maxFreeScans - updatedUsage.scansUsed)
      }
    });
  } catch (err) {
    console.error('API /api/parse-resume error:', err);
    if (req.file) cleanupFile(req.file.path);
    return res.status(500).json({
      success: false,
      error: getSafeErrorMessage(err, 'Failed to parse resume document.')
    });
  }
});

// 2. API: List available sample resumes for quick testing (bundled samples only)
const BUNDLED_SAMPLE_FILES = [
  'Saads_CV_Resume.pdf',
  'resume1.pdf',
  'resume2.pdf',
  'Saad_Ali_ResumeCV_Old.pdf'
];

app.get('/api/sample-resumes', (req, res) => {
  try {
    const samples = BUNDLED_SAMPLE_FILES.map(filename => {
      const filePath = resolveResumePath(filename);
      try {
        const stat = fs.statSync(filePath);
        return {
          filename,
          displayName: filename.replace(/^\d+_/, '').replace(/\.pdf$/i, '').replace(/_/g, ' '),
          sizeBytes: stat.size,
          sizeFormatted: `${(stat.size / 1024).toFixed(1)} KB`
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    return res.json({ success: true, samples });
  } catch (err) {
    return res.status(500).json({ success: false, error: getSafeErrorMessage(err) });
  }
});

// 3. API: Parse an existing sample resume (Protected by subscription & quota check)
app.post('/api/parse-sample', apiLimiter, checkSubscriptionAndQuota, async (req, res) => {
  try {
    const { sampleName, job_description_text, job_keywords, isSamplePreview } = req.body || {};
    if (!sampleName || typeof sampleName !== 'string') {
      return res.status(400).json({ success: false, error: 'sampleName is required and must be a string.' });
    }

    const safeSampleName = path.basename(sampleName);
    if (!BUNDLED_SAMPLE_FILES.includes(safeSampleName)) {
      return res.status(400).json({ success: false, error: 'Invalid sample file requested: ' + safeSampleName });
    }
    const targetPath = resolveResumePath(safeSampleName);
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ success: false, error: 'Sample file not found: ' + safeSampleName });
    }

    const analysis = await analyzeResumePdf(targetPath, safeSampleName, job_description_text || '', job_keywords || '');

    // Consume scan quota for free users unless previewing a bundled sample
    if (req.consumeScanQuota && !isSamplePreview) req.consumeScanQuota();

    const currentMonth = new Date().toISOString().slice(0, 7);
    const updatedUsage = db.userUsage.getMonthlyUsage(req.user.id, currentMonth);

    return res.json({
      success: true,
      ...analysis,
      billing: {
        isPro: req.isPro,
        planTier: req.subscription?.planTier || 'free',
        scansUsed: updatedUsage.scansUsed,
        maxFreeScans: updatedUsage.maxFreeScans,
        scansRemaining: req.isPro ? 'unlimited' : Math.max(0, updatedUsage.maxFreeScans - updatedUsage.scansUsed)
      }
    });
  } catch (err) {
    console.error('API /api/parse-sample error:', err);
    return res.status(500).json({
      success: false,
      error: getSafeErrorMessage(err, 'Failed to parse sample resume.')
    });
  }
});

// 4. API: Interactive Match Evaluator against Job Description
app.post('/api/evaluate-match', apiLimiter, (req, res) => {
  try {
    const { resumeText, jobDescriptionText, resumeSections } = req.body || {};
    if (typeof resumeText !== 'string' || typeof jobDescriptionText !== 'string' || !resumeText.trim() || !jobDescriptionText.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Both resumeText and jobDescriptionText are required string values.'
      });
    }

    const detailedMetrics = computeDetailedMatchMetrics(resumeText, jobDescriptionText, resumeSections || null);

    return res.json({
      success: true,
      ...detailedMetrics
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: getSafeErrorMessage(err, 'Evaluation failed.')
    });
  }
});

// 5b. API: Fetch Job Listings (JobDataLake API Integration & Match Scoring)
const handleJobsRequest = async (req, res) => {
  try {
    const query = req.body?.query || req.query?.query || '';
    const category = req.body?.category || req.query?.category || '';
    const remote = req.body?.remote !== undefined ? req.body.remote : (req.query?.remote === 'true' || req.query?.remote === true);
    const resumeText = req.body?.resumeText || req.query?.resumeText || '';

    const result = await jobsService.getJobs({
      query,
      category,
      remoteOnly: remote === 'true' || remote === true,
      resumeText,
      computeTfidfVector,
      rateResumeSimilarity
    });
    return res.json(result);
  } catch (err) {
    console.error('API /api/jobs error:', err);
    return res.status(500).json({ success: false, error: getSafeErrorMessage(err, 'Failed to fetch job listings.') });
  }
};
app.get('/api/jobs', apiLimiter, handleJobsRequest);
app.post('/api/jobs', apiLimiter, handleJobsRequest);

// 6. API: 100% Free Platform - Checkout bypassed
app.all('/api/create-checkout-session', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    success: true,
    isFree: true,
    isPro: true,
    unrestrictedAccess: true,
    plan: 'free_unlimited',
    message: 'Resume Rater is completely 100% free with unlimited scans. No subscription or checkout is required!',
    checkoutUrl: '/#features'
  });
});

// 7. API: Customer Portal (100% Free Account)
app.all('/api/create-portal-session', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  return res.json({
    success: true,
    isFree: true,
    message: 'Your account has full, permanent unrestricted access to all features at no cost.',
    url: '/'
  });
});

// 8. API: Subscription & Monthly Quota Status (100% Free Forever)
app.get('/api/subscription-status', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const admin = isAdminRequest(req);
    const userId = admin ? 'usr_admin_saad' : (req.cookies?.user_id || req.headers['x-user-id'] || 'usr_demo_001');

    return res.json({
      success: true,
      userId,
      email: admin ? ADMIN_EMAIL : (req.cookies?.user_email || 'candidate@example.com'),
      isAdmin: admin,
      isPro: true,
      isFreeForever: true,
      planTier: '100% Free Forever',
      status: 'active',
      currentPeriodEnd: '2099-12-31T23:59:59.999Z',
      scansUsed: 0,
      maxFreeScans: 'Unlimited',
      scansRemaining: 'unlimited',
      unrestrictedAccess: true,
      message: 'All ATS resume evaluation tools and visualizations are 100% free with unlimited scans.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: getSafeErrorMessage(err) });
  }
});

// === Supabase Auth Endpoints (Google, GitHub, Microsoft, Email) ===
app.get('/auth', (req, res) => {
  renderEjsPage('auth', req, res, {
    supabaseUrl: process.env.SUPABASE_URL || 'https://medvnbynodmsjaqvtjzl.supabase.co',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder'
  });
});

app.get('/auth/callback', (req, res) => {
  renderEjsPage('auth-callback', req, res, {
    supabaseUrl: process.env.SUPABASE_URL || 'https://medvnbynodmsjaqvtjzl.supabase.co',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder'
  });
});

app.post('/api/auth/sync', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { id, email, name, avatar } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' });
    }

    const userId = id || `usr_${Date.now()}`;
    let user = db.users.findByEmail(email);
    if (!user) {
      user = db.users.create({
        id: userId,
        email,
        name: name || email.split('@')[0],
        avatar: avatar || '',
        role: email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'user'
      });
    }

    // Set cookie headers for persistent authentication
    res.cookie('user_id', user.id, { httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
    res.cookie('user_email', user.email, { httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
    if (user.name) res.cookie('user_name', user.name, { httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
    if (avatar) res.cookie('user_avatar', avatar, { httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });

    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, error: getSafeErrorMessage(err) });
  }
});

app.get('/api/auth/me', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const userId = req.cookies?.user_id || req.headers['x-user-id'];
  const user = userId ? db.users.find(userId) : null;
  return res.json({
    success: true,
    authenticated: !!user || !!req.cookies?.user_email,
    user: user || (req.cookies?.user_email ? {
      id: req.cookies.user_id || 'usr_session',
      email: req.cookies.user_email,
      name: req.cookies.user_name || req.cookies.user_email.split('@')[0],
      avatar: req.cookies.user_avatar || ''
    } : null)
  });
});

app.post('/api/auth/signout', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.clearCookie('user_id', { path: '/' });
  res.clearCookie('user_email', { path: '/' });
  res.clearCookie('user_name', { path: '/' });
  res.clearCookie('user_avatar', { path: '/' });
  return res.json({ success: true, message: 'Signed out successfully.' });
});

// 8b. API: Admin Status & Override Toggle Endpoints
app.get('/api/admin/status', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const admin = isAdminRequest(req);
  return res.json({
    success: true,
    isAdmin: admin,
    globalOverride: isGlobalAdminOverrideActive(),
    adminEmail: ADMIN_EMAIL,
    unrestrictedAccess: admin,
    message: admin ? 'Admin override active. Full platform access enabled.' : 'Admin override inactive.'
  });
});

app.post('/api/admin/toggle-override', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const currentState = isGlobalAdminOverrideActive();
  const newState = req.body?.enable !== undefined ? !!req.body.enable : !currentState;
  setGlobalAdminOverride(newState);
  return res.json({
    success: true,
    isAdmin: newState,
    globalOverride: newState,
    message: newState
      ? 'Admin authentication override activated. Unrestricted access granted to all features.'
      : 'Admin authentication override deactivated.'
  });
});

// 8c. API: Supabase PostgreSQL Database Status & Health Check
app.get('/api/supabase/status', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const status = db.supabase.getStatus();
    return res.json({
      success: true,
      supabase: status,
      connectionDetails: {
        host: 'db.medvnbynodmsjaqvtjzl.supabase.co',
        port: 5432,
        database: 'postgres',
        user: 'postgres',
        ssl: true
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: getSafeErrorMessage(err) });
  }
});

app.post('/api/supabase/test', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const result = await db.supabase.initialize();
    return res.json({
      success: true,
      supabase: result
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: getSafeErrorMessage(err) });
  }
});

// === Development-only test endpoints (100% Free Platform) ===
if (isDevMode) {
  app.all(['/api/test/toggle-pro', '/api/test/reset-quota', '/api/test/simulate-limit-reached'], (req, res) => {
    return res.json({
      success: true,
      isPro: true,
      isFree: true,
      scansRemaining: 'unlimited',
      planTier: '100% Free Forever',
      message: 'Resume Rater is 100% free with unlimited scans. No subscription or paywall active.'
    });
  });
} // end if (isDevMode)

// Routes
app.get('/', (req, res) => renderIndexDashboard(req, res));

// Legal & Compliance Pages
app.get('/terms', (req, res) => renderEjsPage('terms', req, res));
app.get('/terms-of-service', (req, res) => res.redirect(301, '/terms'));

app.get('/privacy', (req, res) => renderEjsPage('privacy', req, res));
app.get('/privacy-policy', (req, res) => res.redirect(301, '/privacy'));

app.get('/refund', (req, res) => renderEjsPage('refund', req, res));
app.get('/refund-policy', (req, res) => res.redirect(301, '/refund'));

// Contact Page & Support Form Handler
app.get('/contact', (req, res) => {
  renderEjsPage('contact', req, res, {
    submitted: false,
    success: false,
    error: null,
    name: '',
    email: '',
    subject: 'general',
    message: ''
  });
});

app.post('/contact', apiLimiter, (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};

    if (!email || !message) {
      if (req.accepts('json') && !req.accepts('html')) {
        return res.status(400).json({ success: false, error: 'Email and message are required.' });
      }
      return renderEjsPage('contact', req, res, {
        submitted: false,
        success: false,
        error: 'Please provide both your email address and message.',
        name: name || '',
        email: email || '',
        subject: subject || 'general',
        message: message || ''
      });
    }

    // Save contact entry in DB
    const savedContact = db.contacts.create({
      name: name || 'Anonymous',
      email,
      subject: subject || 'general',
      message
    });

    console.log(`[Contact Support] New message received from ${email} (${subject}):`, savedContact.id);

    if (req.accepts('json') && !req.accepts('html')) {
      return res.json({
        success: true,
        message: 'Your support inquiry has been received. We will respond promptly.',
        contactId: savedContact.id
      });
    }

    return renderEjsPage('contact', req, res, {
      submitted: true,
      success: true,
      error: null,
      senderEmail: email,
      name: '',
      email: '',
      subject: 'general',
      message: ''
    });
  } catch (err) {
    console.error('Contact submission error:', err);
    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(500).json({ success: false, error: 'Failed to process support request.' });
    }
    return renderEjsPage('contact', req, res, {
      submitted: false,
      success: false,
      error: 'An unexpected error occurred while sending your message. Please email saadalioffic@gmail.com directly.',
      name: req.body?.name || '',
      email: req.body?.email || '',
      subject: req.body?.subject || 'general',
      message: req.body?.message || ''
    });
  }
});

app.post('/upload', uploadLimiter, (req, res, next) => {
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'job_description', maxCount: 1 }
  ])(req, res, err => {
    if (err) {
      const msg = (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
        ? 'File size exceeds 15MB limit. Please upload a smaller PDF.'
        : (isDevMode ? (err.message || 'File upload failed.') : 'File upload failed.');
      return renderIndexDashboard(req, res, { error: msg });
    }
    next();
  });
}, async (req, res) => {
  const uploadedFiles = [];
  try {
    const files = req.files || {};
    const resumeFile = files.resume ? files.resume[0] : null;
    const jobDescriptionFile = files.job_description ? files.job_description[0] : null;
    if (resumeFile) uploadedFiles.push(resumeFile.path);
    if (jobDescriptionFile) uploadedFiles.push(jobDescriptionFile.path);

    const admin = isAdminRequest(req);
    const userId = admin ? 'usr_admin_saad' : (req.headers['x-user-id'] || 'usr_demo_001');
    let user = admin ? getAdminUser() : db.users.find(userId);
    if (!user) {
      user = db.users.create({ id: userId, email: admin ? ADMIN_EMAIL : 'candidate@example.com', name: admin ? 'Saad Ali (Admin)' : 'Demo Candidate' });
    }
    const sub = admin ? getAdminSubscription() : db.subscriptions.findActiveByUserId(userId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const usage = admin
      ? { scansUsed: 0, maxFreeScans: 999999, scansRemaining: 'unlimited' }
      : db.userUsage.getMonthlyUsage(userId, currentMonth);

    // All users have 100% Free, Unlimited ATS scans - quota check bypassed

    const jobDescriptionText = req.body.job_description_text ? req.body.job_description_text.trim() : '';
    const jobKeywords = req.body.job_keywords ? req.body.job_keywords.trim() : '';

    if (!resumeFile || (!jobDescriptionFile && !jobDescriptionText && !jobKeywords)) {
      return renderIndexDashboard(req, res, {
        error: 'No file part',
        prediction_category: null,
        resume_match_rating: null,
        numerical_similarity_score: null,
        csv_data: null,
        billing: {
          isPro: !!sub,
          planTier: sub?.planTier || 'free',
          scansUsed: usage.scansUsed,
          maxFreeScans: usage.maxFreeScans,
          scansRemaining: sub ? 'unlimited' : Math.max(0, usage.maxFreeScans - usage.scansUsed)
        }
      });
    }

    // Extract text from resume PDF
    const resumeText = await pdfToText(resumeFile.path);
    const cleanedResume = cleanResume(resumeText);

    // Extract sections
    const resumeSections = {
      Education: extractSectionRegex(resumeText, 'Education', getSectionTerminators('Education')),
      Experience: extractSectionRegex(resumeText, 'Experience', getSectionTerminators('Experience')),
      Skills: extractSectionRegex(resumeText, 'Skills', getSectionTerminators('Skills')),
      Projects: extractSectionRegex(resumeText, 'Projects', getSectionTerminators('Projects'))
    };

    // Determine Job Description text
    let jdRawText = '';
    if (jobDescriptionFile) {
      jdRawText = await pdfToText(jobDescriptionFile.path);
    } else if (jobDescriptionText) {
      jdRawText = jobDescriptionText;
    } else if (jobKeywords) {
      jdRawText = jobKeywords;
    } else {
      jdRawText = resumeSections.Education || '';
    }

    const cleanedJobDescription = cleanResume(jdRawText);

    // Vectors and Similarity
    const resumeVec = computeTfidfVector(cleanedResume);
    const jdVec = computeTfidfVector(cleanedJobDescription);

    const predictionId = predictCategory(cleanedResume);
    const { matchRating, similarityScore } = rateResumeSimilarity(resumeVec, jdVec);
    const roundedSimilarityScore = Number(similarityScore.toFixed(2));

    const name = resumeFile.originalname || 'Unknown';
    const csvData = {
      Name: name,
      Category: predictionId,
      Education: resumeSections.Education,
      Experience: resumeSections.Experience,
      Skills: resumeSections.Skills,
      Projects: resumeSections.Projects,
      'Probability Score': roundedSimilarityScore
    };
    saveToCsv(csvData);

    // Increment scan analytics count
    db.userUsage.incrementScan(userId, currentMonth);
    const updatedUsage = db.userUsage.getMonthlyUsage(userId, currentMonth);

    // Persist to database
    const savedResume = db.resumes.create({
      userId,
      title: name.replace(/\.pdf$/i, ''),
      filename: name,
      fileSizeBytes: resumeFile.size,
      pageCount: 1,
      rawText: resumeText,
      cleanedText: cleanedResume,
      parsedSections: resumeSections,
      detectedCategory: predictionId
    });

    db.evaluations.create({
      userId,
      resumeId: savedResume.id,
      targetJobTitle: jobKeywords || 'Evaluated Job',
      similarityScore: roundedSimilarityScore,
      matchRating,
      dimensions: [],
      keywordGaps: []
    });

    const csvDataForTemplate = [
      { Section: 'Education', Content: resumeSections.Education },
      { Section: 'Experience', Content: resumeSections.Experience },
      { Section: 'Skills', Content: resumeSections.Skills },
      { Section: 'Projects', Content: resumeSections.Projects }
    ];

    return renderIndexDashboard(req, res, {
      error: null,
      prediction_category: predictionId,
      resume_match_rating: matchRating,
      numerical_similarity_score: roundedSimilarityScore,
      csv_data: csvDataForTemplate,
      isAdmin: admin,
      billing: {
        isAdmin: admin,
        isPro: true,
        isFreeForever: true,
        planTier: '100% Free Forever',
        scansUsed: updatedUsage.scansUsed,
        maxFreeScans: 'Unlimited',
        scansRemaining: 'unlimited',
        unrestrictedAccess: true
      }
    });
  } catch (err) {
    console.error('Error handling upload:', err);
    return renderIndexDashboard(req, res, {
      error: 'An error occurred while evaluating the resume.' + (isDevMode ? ' ' + err.message : ''),
      prediction_category: null,
      resume_match_rating: null,
      numerical_similarity_score: null,
      csv_data: null
    });
  } finally {
    uploadedFiles.forEach(fp => cleanupFile(fp));
  }
});

// Train classifier on startup
trainClassifier();

// Dedicated API 404 handler: Ensures any unhandled /api/* request receives JSON, NEVER HTML
app.use('/api', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  return res.status(404).json({
    success: false,
    error: `API route not found: ${req.method} ${req.originalUrl || req.url}`
  });
});

// Global Express error handler to prevent serverless function crashes
app.use((err, req, res, next) => {
  console.error('Global Server Error:', err);
  if (res.headersSent) {
    return next(err);
  }

  // All API routes, AJAX/fetch requests, or Accept: application/json MUST receive JSON, NEVER HTML
  const isApiRoute = req.path.startsWith('/api/') || req.xhr || req.headers.accept?.includes('application/json');
  if (isApiRoute) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(err.status || 500).json({
      success: false,
      error: getSafeErrorMessage(err, 'An unexpected server error occurred.')
    });
  }

  if (req.accepts('html')) {
    return res.status(500).send('<!DOCTYPE html><html><body><h2>Resume Rater Server Error</h2><p>An unexpected error occurred. Please try again.</p></body></html>');
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(500).json({ success: false, error: getSafeErrorMessage(err) });
});

// Listen on port only when run directly (not under Vercel serverless functions)
const isServerlessRuntime = !!(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NOW_REGION ||
  process.env.VERCEL_ENV
);

if (!isServerlessRuntime) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Resume Rater app listening on http://0.0.0.0:${PORT}`);
  });
}

export { app, computeTfidfVector, rateResumeSimilarity };
export default app;
