/**
 * Live job aggregation.
 *
 * Pulls postings from the public job APIs listed in the "Jobs" category of
 * https://github.com/saadkhi/public-apis, normalises them to one schema, and
 * isolates failures so one slow or broken source never breaks the page.
 *
 * Keyless sources are always on. Sources that need an API key are enabled by
 * setting the matching environment variables (see `envKeys`).
 */
import { scoreMatch, predictCategory } from './nlp.js';

const USER_AGENT = 'ResumeRater/1.0 (+https://github.com/saadkhi/Resume-Roster)';
const ATTEMPT_TIMEOUT_MS = 7_000;
const FAILURE_BACKOFF_MS = 20_000;
const FEED_TTL_MS = 10 * 60_000;
const QUERY_TTL_MS = 5 * 60_000;
const PER_PROVIDER_LIMIT = 30;
const MAX_TOTAL = 150;
const MAX_CACHE_ENTRIES = 200;

// ── helpers ─────────────────────────────────────────────────────────────────
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

export function htmlToText(input, max = 2000) {
  if (typeof input !== 'string') return '';
  const text = input
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text.length > max ? text.slice(0, max) : text;
}

function safeUrl(u) {
  if (typeof u !== 'string') return '';
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const toIso = (v) => {
  if (v === null || v === undefined || v === '') return null;
  // Reed sends day-first dates ("15/10/2026"); `new Date` would read them month-first.
  const dmy = typeof v === 'string' && /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (dmy) {
    const d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function salaryText(min, max, currency = '') {
  const n = (x) => (Number(x) >= 1000 ? `${Math.round(Number(x) / 1000)}k` : String(Math.round(Number(x))));
  const c = currency ? `${currency} ` : '$';
  if (min > 0 && max > 0) return `${c}${n(min)} – ${n(max)}`;
  if (max > 0 || min > 0) return `${c}${n(max || min)}`;
  return null;
}

function normalize(sourceId, sourceName, raw) {
  const url = safeUrl(raw.url);
  const title = str(raw.title, 160);
  if (!url || !title) return null;
  const description = htmlToText(raw.description || '', 2000);
  return {
    id: `${sourceId}:${str(String(raw.id ?? url), 120)}`,
    title,
    company: str(raw.company, 120) || 'Company not listed',
    location: str(raw.location, 120),
    remote: typeof raw.remote === 'boolean' ? raw.remote : null,
    summary: description.length > 320 ? description.slice(0, 317).trimEnd() + '…' : description,
    description,
    url,
    postedAt: toIso(raw.postedAt),
    salary: str(raw.salary, 80) || null,
    tags: (Array.isArray(raw.tags) ? raw.tags : []).map(t => str(String(t), 40)).filter(Boolean).slice(0, 8),
    source: sourceId,
    sourceName
  };
}

async function getJson(url, { headers = {}, method = 'GET', body, timeout = ATTEMPT_TIMEOUT_MS, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow'
      });
      if (res.status >= 500 && attempt < retries) { lastError = new Error(`HTTP ${res.status}`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.message && /^HTTP 4/.test(err.message)) break; // client errors will not improve on retry
    }
  }
  throw lastError;
}

/** Every query word must appear somewhere in the job's searchable text. */
function matchesQuery(job, q) {
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return true;
  const hay = `${job.title} ${job.company} ${job.location} ${job.tags.join(' ')} ${job.description}`.toLowerCase();
  return words.every(w => hay.includes(w));
}

const looksRemote = (job) => job.remote === true || /\bremote\b|work from home|anywhere/i.test(`${job.location} ${job.title}`);

// ── providers ───────────────────────────────────────────────────────────────
/**
 * `feed: true` providers cannot search server-side; their latest feed is
 * cached and filtered locally.
 */
export const PROVIDERS = [
  {
    id: 'remoteok', name: 'Remote OK', homepage: 'https://remoteok.com', feed: true,
    // Their terms require linking back to the posting and naming the source; the UI does both.
    async fetch() {
      const data = await getJson('https://remoteok.com/api', { timeout: 15_000, retries: 0 });
      return data.filter(j => j && j.position && j.url).map(j => normalize('remoteok', 'Remote OK', {
        id: j.id, title: j.position, company: j.company, location: j.location || 'Remote', remote: true,
        description: j.description, url: j.url, postedAt: j.date || j.epoch,
        salary: salaryText(j.salary_min, j.salary_max), tags: j.tags
      }));
    }
  },
  {
    id: 'arbeitnow', name: 'Arbeitnow', homepage: 'https://www.arbeitnow.com', feed: true,
    async fetch() {
      const data = await getJson('https://www.arbeitnow.com/api/job-board-api', { timeout: 15_000 });
      return (data.data || []).map(j => normalize('arbeitnow', 'Arbeitnow', {
        id: j.slug, title: j.title, company: j.company_name, location: j.location, remote: !!j.remote,
        description: j.description, url: j.url, postedAt: j.created_at, tags: [...(j.tags || []), ...(j.job_types || [])]
      }));
    }
  },
  {
    id: 'themuse', name: 'The Muse', homepage: 'https://www.themuse.com', feed: true,
    async fetch() {
      const pages = await Promise.all([1, 2, 3].map(p =>
        getJson(`https://www.themuse.com/api/public/jobs?page=${p}`).catch(() => ({ results: [] }))));
      return pages.flatMap(p => p.results || []).map(j => normalize('themuse', 'The Muse', {
        id: j.id, title: j.name, company: j.company?.name, location: (j.locations || []).map(l => l.name).join('; '),
        remote: (j.locations || []).some(l => /flexible|remote/i.test(l.name)) || null,
        description: j.contents, url: j.refs?.landing_page, postedAt: j.publication_date,
        tags: [...(j.categories || []).map(c => c.name), ...(j.levels || []).map(l => l.name)]
      }));
    }
  },
  {
    id: 'aidevboard', name: 'AI Dev Jobs', homepage: 'https://aidevboard.com',
    async fetch({ q, remote }) {
      const p = new URLSearchParams({ limit: String(PER_PROVIDER_LIMIT) });
      if (q) p.set('q', q);
      if (remote) p.set('remote', 'true');
      const data = await getJson(`https://aidevboard.com/api/v1/jobs?${p}`);
      return (data.jobs || []).map(j => normalize('aidevboard', 'AI Dev Jobs', {
        id: j.id, title: j.title, company: j.company_name, location: j.location,
        remote: j.workplace ? j.workplace === 'remote' : null,
        description: j.description, url: j.url || j.apply_url, postedAt: j.published_at,
        salary: salaryText(j.salary_min, j.salary_max), tags: [...(j.tags || []), j.job_type].filter(Boolean)
      }));
    }
  },
  {
    id: 'aijobs', name: 'Artificial Intelligence Jobs', homepage: 'https://artificialintelligencejobs.co',
    async fetch({ q, remote }) {
      const p = new URLSearchParams({ limit: String(PER_PROVIDER_LIMIT) });
      if (q) p.set('q', q);
      if (remote) p.set('remote', 'true');
      const data = await getJson(`https://artificialintelligencejobs.co/api/jobs?${p}`);
      return (data.jobs || []).map(j => normalize('aijobs', 'Artificial Intelligence Jobs', {
        id: j.url, title: j.title, company: j.company, location: j.location, remote: !!j.remote,
        description: '', url: j.url || j.apply_url, postedAt: j.posted, salary: j.salary,
        tags: [j.category, j.level, j.region].filter(Boolean)
      }));
    }
  },
  {
    id: 'freehire', name: 'freehire', homepage: 'https://freehire.dev',
    async fetch({ q }) {
      const base = 'https://freehire.dev/api/v1/jobs';
      const url = q
        ? `${base}/search?${new URLSearchParams({ q, limit: String(PER_PROVIDER_LIMIT) })}`
        : `${base}?limit=${PER_PROVIDER_LIMIT}`;
      const data = await getJson(url);
      return (data.data || data.jobs || data.results || []).map(j => normalize('freehire', 'freehire', {
        id: j.public_slug || j.external_id, title: j.title, company: j.company, location: j.location,
        remote: null, description: j.description, url: j.url, postedAt: j.posted_at,
        tags: [...(j.skills || []), j.enrichment?.category].filter(Boolean)
      }));
    }
  },
  {
    id: 'curatorsearch', name: 'CuratorSearch', homepage: 'https://curatorsearch.com',
    async fetch({ q }) {
      const p = new URLSearchParams({ limit: String(PER_PROVIDER_LIMIT) });
      if (q) p.set('q', q);
      const data = await getJson(`https://curatorsearch.com/api/jobs?${p}`);
      return (data.results || []).map(j => normalize('curatorsearch', 'CuratorSearch', {
        id: j.url, title: j.title, company: j.institution, location: j.location, remote: null,
        description: '', url: j.url, postedAt: j.posted, salary: j.salary, tags: [j.category, j.region].filter(Boolean)
      }));
    }
  },

  // ── API-key sources (enabled only when configured) ────────────────────────
  {
    id: 'adzuna', name: 'Adzuna', homepage: 'https://www.adzuna.com', envKeys: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    async fetch({ q }) {
      const country = (process.env.ADZUNA_COUNTRY || 'us').toLowerCase();
      const p = new URLSearchParams({
        app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY,
        results_per_page: '25', 'content-type': 'application/json'
      });
      if (q) p.set('what', q);
      const data = await getJson(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1?${p}`);
      return (data.results || []).map(j => normalize('adzuna', 'Adzuna', {
        id: j.id, title: j.title, company: j.company?.display_name, location: j.location?.display_name,
        remote: null, description: j.description, url: j.redirect_url, postedAt: j.created,
        salary: salaryText(j.salary_min, j.salary_max), tags: [j.category?.label, j.contract_time].filter(Boolean)
      }));
    }
  },
  {
    id: 'reed', name: 'Reed', homepage: 'https://www.reed.co.uk', envKeys: ['REED_API_KEY'],
    async fetch({ q }) {
      const p = new URLSearchParams({ resultsToTake: String(PER_PROVIDER_LIMIT) });
      if (q) p.set('keywords', q);
      const auth = Buffer.from(`${process.env.REED_API_KEY}:`).toString('base64');
      const data = await getJson(`https://www.reed.co.uk/api/1.0/search?${p}`, { headers: { Authorization: `Basic ${auth}` } });
      return (data.results || []).map(j => normalize('reed', 'Reed', {
        id: j.jobId, title: j.jobTitle, company: j.employerName, location: j.locationName, remote: null,
        description: j.jobDescription, url: j.jobUrl, postedAt: j.date,
        salary: salaryText(j.minimumSalary, j.maximumSalary, j.currency === 'GBP' ? '£' : '')
      }));
    }
  },
  {
    id: 'jooble', name: 'Jooble', homepage: 'https://jooble.org', envKeys: ['JOOBLE_API_KEY'],
    async fetch({ q }) {
      const data = await getJson(`https://jooble.org/api/${encodeURIComponent(process.env.JOOBLE_API_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: q || 'jobs', page: '1' })
      });
      return (data.jobs || []).slice(0, PER_PROVIDER_LIMIT).map(j => normalize('jooble', 'Jooble', {
        id: j.id, title: j.title, company: j.company, location: j.location, remote: null,
        description: j.snippet, url: j.link, postedAt: j.updated, salary: j.salary, tags: [j.type].filter(Boolean)
      }));
    }
  },
  {
    id: 'findwork', name: 'Findwork', homepage: 'https://findwork.dev', envKeys: ['FINDWORK_API_KEY'],
    async fetch({ q, remote }) {
      const p = new URLSearchParams();
      if (q) p.set('search', q);
      if (remote) p.set('remote', 'true');
      const data = await getJson(`https://findwork.dev/api/jobs/?${p}`, {
        headers: { Authorization: `Token ${process.env.FINDWORK_API_KEY}` }
      });
      return (data.results || []).slice(0, PER_PROVIDER_LIMIT).map(j => normalize('findwork', 'Findwork', {
        id: j.id, title: j.role, company: j.company_name, location: j.location, remote: !!j.remote,
        description: j.text, url: j.url, postedAt: j.date_posted, tags: [...(j.keywords || []), j.employment_type].filter(Boolean)
      }));
    }
  }
];

export const providerEnabled = (p) => !p.envKeys || p.envKeys.every(k => !!process.env[k]);

// ── cache ───────────────────────────────────────────────────────────────────
const cache = new Map(); // key -> { at, ttl, value }
const inflight = new Map(); // key -> Promise

async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = load().then((value) => {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), ttl, value });
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Upstream request budgets protect free-tier quotas. Counters are per server
 * instance (serverless cold starts reset them), so they are a safety net on top
 * of the response cache, not an exact meter. Override with e.g. ADZUNA_PER_MINUTE.
 */
const num = (name, fallback) => Math.max(1, Number(process.env[name]) || fallback);
const BUDGETS = {
  adzuna: () => [{ windowMs: 60_000, max: Math.min(25, num('ADZUNA_PER_MINUTE', 25)) }, { windowMs: 86_400_000, max: num('ADZUNA_PER_DAY', 200) }],
  jooble: () => [{ windowMs: 86_400_000, max: num('JOOBLE_PER_DAY', 150) }],
  findwork: () => [{ windowMs: 60_000, max: Math.min(60, num('FINDWORK_PER_MINUTE', 30)) }],
  reed: () => [{ windowMs: 86_400_000, max: num('REED_PER_DAY', 500) }]
};
const usage = new Map(); // provider id -> timestamps[]

function consumeBudget(id) {
  const rules = BUDGETS[id]?.();
  if (!rules) return;
  const now = Date.now();
  const stamps = (usage.get(id) || []).filter(t => now - t < 86_400_000);
  for (const r of rules) {
    if (stamps.filter(t => now - t < r.windowMs).length >= r.max) {
      usage.set(id, stamps);
      throw new Error('request limit reached (protecting free quota)');
    }
  }
  stamps.push(now);
  usage.set(id, stamps);
}

const failures = new Map(); // provider id -> { until, error }

export function clearLiveJobsCache() {
  cache.clear();
  inflight.clear();
  failures.clear();
  usage.clear();
}

// ── aggregation ─────────────────────────────────────────────────────────────
async function runProvider(p, params) {
  const started = Date.now();
  const recent = failures.get(p.id);
  if (recent && recent.until > started) {
    // Recently failed: skip instead of making every visitor wait for the timeout again.
    return { id: p.id, name: p.name, homepage: p.homepage, status: 'error', count: 0, ms: 0, error: recent.error, jobs: [] };
  }
  try {
    let jobs;
    if (p.feed) {
      const all = await cached(`feed:${p.id}`, FEED_TTL_MS, () => p.fetch({}).then(list => list.filter(Boolean)));
      jobs = all;
    } else {
      const term = params.q || params.seed || '';
      jobs = await cached(`q:${p.id}:${term}:${params.remote}`, QUERY_TTL_MS,
        () => {
          consumeBudget(p.id);
          return p.fetch({ q: term, remote: params.remote }).then(list => list.filter(Boolean));
        });
    }
    if (params.q) jobs = jobs.filter(j => matchesQuery(j, params.q));
    if (params.remote) jobs = jobs.filter(looksRemote);
    return { id: p.id, name: p.name, homepage: p.homepage, status: 'ok', count: jobs.length, ms: Date.now() - started, jobs };
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'timed out' : String(err.message || 'failed').slice(0, 80);
    if (!/request limit reached/.test(message)) failures.set(p.id, { until: Date.now() + FAILURE_BACKOFF_MS, error: message });
    return { id: p.id, name: p.name, homepage: p.homepage, status: 'error', count: 0, ms: Date.now() - started, error: message, jobs: [] };
  }
}

const dedupeKey = (j) => `${j.title}|${j.company}`.toLowerCase().replace(/[^a-z0-9|]/g, '');

/**
 * @param {{query?: string, remote?: boolean, sources?: string[], resumeText?: string}} opts
 */
export async function fetchLiveJobs({ query = '', remote = false, sources = [], resumeText = '' } = {}) {
  const q = String(query).trim().slice(0, 100);
  const wanted = new Set((sources || []).map(String));
  const active = PROVIDERS.filter(p => providerEnabled(p) && (!wanted.size || wanted.has(p.id)));

  const hasResume = typeof resumeText === 'string' && resumeText.trim().length > 0;
  // With a resume and no explicit search, seed search-capable sources with the
  // resume's predicted field so results are relevant rather than just "latest".
  let seed = '';
  if (hasResume && !q) {
    const { category } = predictCategory(resumeText);
    if (category && category !== 'Uncertain') seed = category;
  }

  const results = await Promise.all(active.map(p => runProvider(p, { q, seed, remote: !!remote })));

  // Rank within each source (by resume match, else by date) and keep the best N,
  // so large feeds cannot crowd out small sources.
  const byDate = (a, b) => (b.postedAt || '').localeCompare(a.postedAt || '');
  for (const r of results) {
    if (hasResume) {
      r.jobs = r.jobs.map(j => {
        const m = scoreMatch(resumeText, `${j.title}. ${j.tags.join(' ')} ${j.description}`);
        return { ...j, matchPercentage: m.percentage, matchRating: m.matchRating, missingKeywords: m.missingKeywords.slice(0, 5) };
      }).sort((a, b) => b.matchPercentage - a.matchPercentage || byDate(a, b));
    } else {
      r.jobs.sort(byDate);
    }
    r.jobs = r.jobs.slice(0, PER_PROVIDER_LIMIT);
    r.count = r.jobs.length;
  }

  // Interleave sources so the list stays diverse.
  const seen = new Set();
  const merged = [];
  const lists = results.map(r => r.jobs);
  for (let i = 0; merged.length < MAX_TOTAL && lists.some(l => i < l.length); i++) {
    for (const l of lists) {
      const job = l[i];
      if (!job) continue;
      const key = dedupeKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(job);
    }
  }
  merged.length = Math.min(merged.length, MAX_TOTAL);

  const jobs = hasResume
    ? merged.sort((a, b) => b.matchPercentage - a.matchPercentage || byDate(a, b))
    : merged;

  // The full description is only needed server-side for scoring.
  const publicJobs = jobs.map(({ description: _d, ...rest }) => rest);

  return {
    success: true,
    fetchedAt: new Date().toISOString(),
    total: publicJobs.length,
    hasResumeMatch: hasResume,
    sources: results.map(({ jobs: _j, ...s }) => s),
    availableSources: PROVIDERS.map(p => ({ id: p.id, name: p.name, homepage: p.homepage, enabled: providerEnabled(p), needsKey: !!p.envKeys })),
    jobs: publicJobs
  };
}
