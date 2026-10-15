/**
 * PDF text extraction, CV section parsing, and the end-to-end analysis pipeline.
 */
import './../polyfills.js';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { cleanResume, predictCategory, scoreMatch, atsChecks } from './nlp.js';

// pdf.js needs its worker on globalThis in serverless bundles.
if (pdfjsWorker && (pdfjsWorker.WorkerMessageHandler || pdfjsWorker.default?.WorkerMessageHandler)) {
  globalThis.pdfjsWorker = pdfjsWorker;
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIN_EXTRACTABLE_CHARS = 80;

// pdf.js requires a forward-slash path with a trailing "/", even on Windows.
function pdfjsAssetPath(subDir) {
  const withSlash = (p) => p.replace(/\\/g, '/').replace(/\/?$/, '/');
  try {
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    const dir = path.join(path.dirname(pkgPath), subDir);
    if (fs.existsSync(dir)) return withSlash(dir);
  } catch { /* fall through */ }
  return withSlash(path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', subDir));
}

let PDFParseClass = null;
async function getPdfParse() {
  if (!PDFParseClass) {
    const mod = await import('pdf-parse');
    PDFParseClass = mod.PDFParse || mod.default?.PDFParse || mod.default;
  }
  return PDFParseClass;
}

/** @param {Buffer|Uint8Array} buffer */
export async function extractPdf(buffer) {
  const PDFParse = await getPdfParse();
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
    standardFontDataUrl: pdfjsAssetPath('standard_fonts'),
    cMapUrl: pdfjsAssetPath('cmaps'),
    cMapPacked: true
  });
  try {
    const result = await parser.getText();
    // pdf-parse inserts "-- 1 of 2 --" page markers; they are not resume content.
    const text = (result?.text || '')
      .replace(/^[ \t]*-- \d+ of \d+ --[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      text,
      pages: result?.total || (Array.isArray(result?.pages) ? result.pages.length : 1)
    };
  } finally {
    try { await parser.destroy?.(); } catch { /* best effort */ }
  }
}

// ── Section parsing ─────────────────────────────────────────────────────────

const SECTION_ALIASES = {
  Education: ['education', 'academic background', 'academic qualifications', 'qualifications'],
  Experience: ['experience', 'work experience', 'professional experience', 'employment history', 'work history', 'internships'],
  Skills: ['skills', 'technical skills', 'key skills', 'core competencies', 'technologies', 'technical proficiencies'],
  Projects: ['projects', 'personal projects', 'selected projects', 'academic projects', 'key projects']
};
const OTHER_HEADINGS = [
  'summary', 'professional summary', 'profile', 'objective', 'career objective', 'certifications', 'certificates',
  'languages', 'awards', 'achievements', 'publications', 'references', 'interests', 'volunteering', 'extracurricular activities'
];
const ALL_HEADINGS = [...Object.values(SECTION_ALIASES).flat(), ...OTHER_HEADINGS];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEADING_PREFIX = '^\\s*(?:[#*•\\d.)\\-–]+\\s*)?';
const headingRe = (names) => new RegExp(`${HEADING_PREFIX}(?:${names.map(escapeRe).join('|')})\\s*(?::|-|–)?\\s*$`, 'i');
const inlineHeadingRe = (names) => new RegExp(`${HEADING_PREFIX}(?:${names.map(escapeRe).join('|')})\\s*[:\\-–]\\s*(\\S.*)$`, 'i');

export function extractSection(cvText, sectionName) {
  const notFound = `${sectionName} section not found.`;
  if (typeof cvText !== 'string' || !cvText) return notFound;
  const aliases = SECTION_ALIASES[sectionName] || [sectionName.toLowerCase()];
  const startRe = headingRe(aliases);
  const inlineRe = inlineHeadingRe(aliases);
  const others = ALL_HEADINGS.filter(h => !aliases.includes(h));
  const stopBare = headingRe(others);
  const stopInline = inlineHeadingRe(others);
  const stopRe = { test: (line) => stopBare.test(line) || stopInline.test(line) };

  const captured = [];
  let capturing = false;
  for (const line of cvText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!capturing) {
      if (startRe.test(trimmed)) { capturing = true; continue; }
      const inline = inlineRe.exec(trimmed);
      if (inline) { capturing = true; captured.push(inline[1]); }
    } else if (stopRe.test(trimmed)) {
      break;
    } else {
      captured.push(line);
    }
  }
  const body = captured.join('\n').trim();
  return body || notFound;
}

export function extractSections(rawText) {
  return {
    Education: extractSection(rawText, 'Education'),
    Experience: extractSection(rawText, 'Experience'),
    Skills: extractSection(rawText, 'Skills'),
    Projects: extractSection(rawText, 'Projects')
  };
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export class UnreadablePdfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnreadablePdfError';
  }
}

/**
 * @param {Buffer} buffer PDF bytes
 * @param {{filename?: string, jobText?: string}} opts
 */
export async function analyzeResume(buffer, { filename = 'resume.pdf', jobText = '' } = {}) {
  let extracted;
  try {
    extracted = await extractPdf(buffer);
  } catch (err) {
    console.warn('PDF extraction failed:', err.message);
    throw new UnreadablePdfError('This PDF could not be read. It may be corrupted or password-protected.');
  }
  const { text: rawText, pages } = extracted;
  if (rawText.replace(/\s+/g, '').length < MIN_EXTRACTABLE_CHARS) {
    throw new UnreadablePdfError(
      'We could not extract text from this PDF. It may be a scanned image. Export it from a text editor (Word, Google Docs) and try again.'
    );
  }

  const sections = extractSections(rawText);
  const cleanedText = cleanResume(rawText);
  const { category, confidence } = predictCategory(rawText);
  const wordCount = rawText.trim().split(/\s+/).length;

  const target = jobText.trim();
  const match = target
    ? { ...scoreMatch(rawText, target, sections), targetJob: target.length > 80 ? target.slice(0, 80) + '…' : target }
    : null;

  const { checks, suggestions } = atsChecks({ rawText, sections, pages, match });

  return {
    filename,
    pages,
    stats: { wordCount, characterCount: rawText.length, pageCount: pages },
    category,
    categoryConfidence: confidence,
    sections,
    rawText,
    cleanedText,
    match,
    checks,
    suggestions
  };
}
