/**
 * NLP + scoring engine.
 *
 * Pure functions (no HTTP, no persistence) so everything here is unit-testable.
 *
 * Scoring model
 * -------------
 * The headline "match score" is IDF-weighted keyword coverage: of the most
 * important terms in the job description, what share (weighted by how
 * distinctive each term is) appears in the resume? This mirrors how keyword
 * based ATS filters work and is easy to explain to a user.
 *
 * Cosine similarity of TF-IDF vectors is reported separately as "content
 * similarity". It is a real measurement and is NOT rescaled or padded.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have',
  'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
  // resume / job-post boilerplate that carries no signal
  'etc', 'including', 'include', 'includes', 'ability', 'able', 'strong', 'good', 'excellent', 'looking',
  'candidate', 'candidates', 'role', 'position', 'responsibilities', 'requirements', 'required', 'preferred',
  'years', 'year', 'work', 'working', 'team', 'teams', 'company', 'seeking', 'must', 'plus', 'well'
]);

// Short tokens that are meaningful in technical resumes.
const TECH_SHORT_TOKENS = new Set([
  'c', 'r', 'go', 'ai', 'ml', 'ui', 'ux', 'db', 'qa', 'os', 'ci', 'cd', 'io', 'js', 'ts', 'bi', 'vr', 'ar', 'hr', 'it'
]);

/** Normalise punctuation-heavy technology names before stripping symbols. */
export function cleanResume(txt) {
  if (typeof txt !== 'string') return '';
  let t = txt;
  t = t.replace(/\bc\+\+/gi, ' cpp ');
  t = t.replace(/\bc#/gi, ' csharp ');
  t = t.replace(/\bf#/gi, ' fsharp ');
  t = t.replace(/\.net\b/gi, ' dotnet ');
  t = t.replace(/\b([a-z0-9]+)\.js\b/gi, ' $1js ');
  t = t.replace(/https?:\/\/\S+/gi, ' ');
  t = t.replace(/\bwww\.\S+/gi, ' ');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ');
  t = t.replace(/\P{ASCII}/gu, ' ');
  t = t.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** Very light plural stemmer. Applied identically to resume and job text. */
function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 3 && token.endsWith('s') && !/(ss|us|is|js)$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Tokenise into stems. Returns { stems: string[], surface: Map<stem, original> }.
 * `surface` lets the UI show "Kubernetes" rather than "kubernete".
 */
export function analyzeTokens(text) {
  const surface = new Map();
  const stems = [];
  if (typeof text !== 'string' || !text) return { stems, surface };
  for (const orig of text.match(/[A-Za-z0-9]+/g) || []) {
    const tok = orig.toLowerCase();
    if (!(tok.length > 2 || TECH_SHORT_TOKENS.has(tok))) continue;
    if (STOP_WORDS.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue; // bare numbers are not keywords
    const s = stem(tok);
    stems.push(s);
    if (!surface.has(s)) surface.set(s, orig);
  }
  return { stems, surface };
}

export function tokenize(text) {
  return analyzeTokens(text).stems;
}

// ── Training corpus (IDF + category centroids) ──────────────────────────────

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const idf = Object.create(null);
const categoryCentroids = Object.create(null);
let totalDocs = 0;
let unseenIdf = 3;

function resolveDatasetPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'data', 'gpt_dataset.csv'),
    path.join(process.cwd(), 'data', 'gpt_dataset.csv')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

export function trainClassifier() {
  const datasetPath = resolveDatasetPath();
  if (!datasetPath) {
    console.warn('Notice: training dataset not found; category prediction disabled.');
    return { documents: 0, categories: 0 };
  }
  const rows = parseCsv(fs.readFileSync(datasetPath, 'utf8')).slice(1)
    .filter(r => r.length >= 2 && r[0].trim() && r[1].trim())
    .map(r => ({ category: r[0].trim(), resume: r[1] }));

  totalDocs = rows.length;
  const docFreq = Object.create(null);
  const byCategory = Object.create(null);
  for (const r of rows) {
    (byCategory[r.category] ||= []).push(r.resume);
    for (const w of new Set(tokenize(cleanResume(r.resume)))) docFreq[w] = (docFreq[w] || 0) + 1;
  }
  for (const [w, df] of Object.entries(docFreq)) idf[w] = Math.log((1 + totalDocs) / (1 + df)) + 1;
  // Terms never seen in the corpus are treated as rare (appearing in ~2 docs).
  unseenIdf = Math.log((1 + totalDocs) / 3) + 1;

  for (const [cat, docs] of Object.entries(byCategory)) {
    categoryCentroids[cat] = tfidfVector(cleanResume(docs.join(' ')));
  }
  return { documents: totalDocs, categories: Object.keys(categoryCentroids).length };
}

export function idfFor(stemmed) {
  return idf[stemmed] ?? unseenIdf;
}

// ── Vector math ─────────────────────────────────────────────────────────────

/** L2-normalised sublinear TF-IDF vector. */
export function tfidfVector(text) {
  const { stems } = analyzeTokens(text);
  const tf = Object.create(null);
  for (const t of stems) tf[t] = (tf[t] || 0) + 1;
  const vec = Object.create(null);
  let norm = 0;
  for (const [t, count] of Object.entries(tf)) {
    const w = (1 + Math.log(count)) * idfFor(t);
    vec[t] = w;
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const t in vec) vec[t] /= norm;
  return vec;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (const t in a) if (b[t]) dot += a[t] * b[t];
  return dot;
}

// ── Category prediction ─────────────────────────────────────────────────────

const MIN_TOKENS_FOR_CATEGORY = 25;
const MIN_CATEGORY_SIMILARITY = 0.08;

/** @returns {{category: string, confidence: number}} category is 'Uncertain' when evidence is weak. */
export function predictCategory(resumeText) {
  const cleaned = cleanResume(resumeText);
  const tokens = tokenize(cleaned);
  const cats = Object.entries(categoryCentroids);
  if (!cats.length || tokens.length < MIN_TOKENS_FOR_CATEGORY) {
    return { category: 'Uncertain', confidence: 0 };
  }
  const vec = tfidfVector(cleaned);
  const ranked = cats
    .map(([category, c]) => ({ category, sim: cosineSimilarity(vec, c) }))
    .sort((a, b) => b.sim - a.sim);
  const best = ranked[0];
  const second = ranked[1]?.sim ?? 0;
  if (best.sim < MIN_CATEGORY_SIMILARITY) return { category: 'Uncertain', confidence: 0 };
  // Confidence = how clearly the winner beats the runner-up (0..1).
  const confidence = best.sim > 0 ? Math.max(0, Math.min(1, (best.sim - second) / best.sim)) : 0;
  return { category: best.category, confidence: Number(confidence.toFixed(2)) };
}

// ── Match scoring ───────────────────────────────────────────────────────────

export const MATCH_THRESHOLDS = { high: 0.6, medium: 0.35 };
const MAX_KEYWORDS = 30;
const DISPLAY_KEYWORDS = 15;

export function ratingFor(score) {
  if (score >= MATCH_THRESHOLDS.high) return 'High Match';
  if (score >= MATCH_THRESHOLDS.medium) return 'Medium Match';
  return 'Low Match';
}

function termSet(text) {
  return new Set(analyzeTokens(cleanResume(text)).stems);
}

/** Top weighted terms from a job description: [{ term, label, weight }]. */
export function extractKeywords(jobText, limit = MAX_KEYWORDS) {
  const { stems, surface } = analyzeTokens(cleanResume(jobText));
  const tf = Object.create(null);
  for (const t of stems) tf[t] = (tf[t] || 0) + 1;
  return Object.entries(tf)
    .map(([term, count]) => ({
      term,
      label: surface.get(term) || term,
      weight: (1 + Math.log(count)) * idfFor(term)
    }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, limit);
}

function coverage(keywords, present) {
  const total = keywords.reduce((s, k) => s + k.weight, 0);
  if (total === 0) return 0;
  const hit = keywords.reduce((s, k) => s + (present.has(k.term) ? k.weight : 0), 0);
  return hit / total;
}

const pct = (x) => Math.round(Math.max(0, Math.min(1, x)) * 100);
const isMissingSection = (s) => !s || /section not found\.?$/i.test(String(s).trim());

/**
 * Score a resume against a job description.
 * @param {string} resumeText raw or cleaned resume text
 * @param {string} jobText    job description or role keywords
 * @param {{Skills?:string,Experience?:string,Projects?:string}} sections parsed sections
 */
export function scoreMatch(resumeText, jobText, sections = {}) {
  const keywords = extractKeywords(jobText);
  const resumeTerms = termSet(resumeText);

  const overall = coverage(keywords, resumeTerms);
  const similarity = cosineSimilarity(tfidfVector(cleanResume(resumeText)), tfidfVector(cleanResume(jobText)));

  const sectionDim = (name, label) => {
    const text = sections?.[name];
    if (isMissingSection(text)) {
      return { dimension: label, score: 0, target: 100, fullMark: 100, available: false };
    }
    return { dimension: label, score: pct(coverage(keywords, termSet(text))), target: 100, fullMark: 100, available: true };
  };

  const dimensions = [
    { dimension: 'Keywords', score: pct(overall), target: 100, fullMark: 100, available: true },
    sectionDim('Skills', 'Skills'),
    sectionDim('Experience', 'Experience'),
    sectionDim('Projects', 'Projects'),
    { dimension: 'Similarity', score: pct(similarity), target: 100, fullMark: 100, available: true }
  ];

  const maxWeight = keywords[0]?.weight || 1;
  const keywordAlignment = keywords.map(k => ({
    keyword: k.label === k.label.toLowerCase() ? k.label.charAt(0).toUpperCase() + k.label.slice(1) : k.label,
    matched: resumeTerms.has(k.term),
    importance: Math.max(10, Math.round((k.weight / maxWeight) * 100))
  }));

  const matched = keywordAlignment.filter(k => k.matched);
  const missing = keywordAlignment.filter(k => !k.matched);

  const roundedScore = Number(overall.toFixed(2));
  return {
    similarityScore: roundedScore,
    percentage: pct(overall),
    matchRating: ratingFor(overall),
    contentSimilarity: Number(similarity.toFixed(2)),
    dimensions,
    keywordAlignment: keywordAlignment.slice(0, DISPLAY_KEYWORDS),
    missingKeywords: missing.slice(0, 10).map(k => k.keyword),
    matchedCount: matched.length,
    totalKeywordsChecked: keywordAlignment.length
  };
}

// ── ATS readiness checks ────────────────────────────────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;

/**
 * Structural checks a recruiter-side parser cares about.
 * @returns {{checks: Array<{id,label,status,detail}>, suggestions: string[]}}
 */
export function atsChecks({ rawText = '', sections = {}, pages = 1, match = null }) {
  const words = rawText.trim() ? rawText.trim().split(/\s+/).length : 0;
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  add('email', 'Email address', EMAIL_RE.test(rawText) ? 'pass' : 'fail',
    EMAIL_RE.test(rawText) ? 'Found a contact email.' : 'No email address detected. Recruiters need a way to reach you.');
  add('phone', 'Phone number', PHONE_RE.test(rawText) ? 'pass' : 'warn',
    PHONE_RE.test(rawText) ? 'Found a phone number.' : 'No phone number detected.');

  for (const [key, label] of [['Experience', 'Experience section'], ['Education', 'Education section'], ['Skills', 'Skills section']]) {
    const ok = !isMissingSection(sections[key]);
    add(key.toLowerCase(), label, ok ? 'pass' : 'warn',
      ok ? `${key} section detected.` : `No "${key}" heading detected. Use a plain heading such as "${key}" so parsers can find it.`);
  }

  if (words < 150) add('length', 'Length', 'fail', `Only ${words} words extracted. The PDF may be mostly images or very sparse.`);
  else if (words < 250) add('length', 'Length', 'warn', `${words} words is short. Aim for 300–800 words.`);
  else if (words > 1100) add('length', 'Length', 'warn', `${words} words is long. Consider trimming to the most relevant content.`);
  else add('length', 'Length', 'pass', `${words} words, a good length.`);

  add('pages', 'Page count', pages <= 2 ? 'pass' : 'warn',
    pages <= 2 ? `${pages} page${pages === 1 ? '' : 's'}.` : `${pages} pages. Most recruiters prefer 1–2.`);

  const numbers = (rawText.match(/\b\d+(?:[.,]\d+)?\s?(?:%|\+|k\b|m\b|x\b)|[$€£]\s?\d/gi) || []).length;
  add('metrics', 'Measurable results', numbers >= 3 ? 'pass' : 'warn',
    numbers >= 3 ? 'Includes quantified achievements.' : 'Few numbers or percentages found. Quantify impact where you can (e.g. "reduced load time by 40%").');

  const suggestions = [];
  for (const c of checks) {
    if (c.status === 'fail') suggestions.push(c.detail);
  }
  if (match) {
    if (match.missingKeywords?.length) {
      suggestions.push(`Missing high-value terms from the job description: ${match.missingKeywords.slice(0, 6).join(', ')}. Add them where they truthfully apply.`);
    }
    if (match.dimensions) {
      const weakest = match.dimensions.filter(d => d.available && d.dimension !== 'Similarity').sort((a, b) => a.score - b.score)[0];
      if (weakest && weakest.score < 40) {
        suggestions.push(`Your ${weakest.dimension} content covers only ${weakest.score}% of the job's key terms. This is the biggest gap to close.`);
      }
    }
  }
  for (const c of checks) {
    if (c.status === 'warn') suggestions.push(c.detail);
  }
  return { checks, suggestions: suggestions.slice(0, 8) };
}

trainClassifier();
