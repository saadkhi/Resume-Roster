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
import { db } from '../db/index.js';

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

/** Repairs UTF-8 text that an upstream decoded as Latin-1 ("QuÃ©" -> "Qué"). */
function fixMojibake(text) {
  if (!/[ÃÂâ][\u0080-\u00BF\u2018-\u203A]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    return repaired.includes('\uFFFD') ? text : repaired;
  } catch {
    return text;
  }
}

function stripTags(input) {
  return input
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
}

export function htmlToText(input, max = 2000) {
  if (typeof input !== 'string') return '';
  let text = stripTags(input);
  // Some feeds HTML-escape their HTML; decoding entities reveals tags, so strip once more.
  if (/<\/?[a-z][^>]*>/i.test(text)) text = stripTags(text);
  text = fixMojibake(text)
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

const CURRENCY_BY_COUNTRY = { us: '$', gb: '£', au: 'A$', ca: 'C$', nz: 'NZ$', in: '₹', sg: 'S$', za: 'R', pl: 'zł ', br: 'R$', mx: 'MX$' };

function salaryText(min, max, currency = '$') {
  const n = (x) => (Number(x) >= 1000 ? `${Math.round(Number(x) / 1000)}k` : String(Math.round(Number(x))));
  const c = currency;
  if (min > 0 && max > 0 && n(min) !== n(max)) return `${c}${n(min)} – ${n(max)}`;
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

/** Text of the first <tag> in an XML fragment, with CDATA and entities resolved. */
function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (e) => ENTITIES[e] || e).trim();
}

async function getText(url, { timeout = ATTEMPT_TIMEOUT_MS * 2 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Run `fn` over `items` with at most `limit` in flight; failures are skipped. */
async function mapLimit(items, limit, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { out.push(...(await fn(item))); } catch { /* one company failing must not hide the rest */ }
    }
  }));
  return out;
}

/** "3 days ago" style strings (SerpApi) to an approximate ISO date. */
function relativeToIso(text) {
  const m = /(\d+)\s*(hour|day|week|month)/i.exec(String(text || ''));
  if (!m) return null;
  const unit = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 }[m[2].toLowerCase()];
  return new Date(Date.now() - Number(m[1]) * unit).toISOString();
}

/** Monthly quota guard (persistent when a database is configured). */
async function consumeMonthly(provider, envName, fallback) {
  const limit = Math.max(1, Number(process.env[envName]) || fallback);
  const period = new Date().toISOString().slice(0, 7);
  if (!(await db.usage.consume(provider, period, limit))) {
    throw new Error('request limit reached (protecting free quota)');
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;
const titleCase = (slug) => slug.replace(/[-_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function boardSlugs(envName, defaults) {
  const raw = process.env[envName];
  const list = raw ? raw.split(/[\s,]+/).filter(x => SLUG_RE.test(x)) : defaults;
  return [...new Set(list)].slice(0, 25);
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

  {
    id: 'remotive', name: 'Remotive', homepage: 'https://remotive.com', feed: true, ttl: 6 * 60 * 60_000,
    // Remotive asks API users to fetch sparingly; one cached pull every 6 hours.
    async fetch() {
      const data = await getJson('https://remotive.com/api/remote-jobs', { timeout: 15_000 });
      return (data.jobs || []).map(j => normalize('remotive', 'Remotive', {
        id: j.id, title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote',
        remote: true, description: j.description, url: j.url, postedAt: j.publication_date,
        salary: j.salary, tags: [j.category, j.job_type, ...(j.tags || [])].filter(Boolean)
      }));
    }
  },
  {
    id: 'jobicy', name: 'Jobicy', homepage: 'https://jobicy.com', feed: true, ttl: 60 * 60_000,
    async fetch() {
      const data = await getJson('https://jobicy.com/api/v2/remote-jobs?count=50');
      return (data.jobs || []).map(j => normalize('jobicy', 'Jobicy', {
        id: j.id, title: j.jobTitle, company: j.companyName, location: j.jobGeo || 'Remote', remote: true,
        description: j.jobDescription || j.jobExcerpt, url: j.url, postedAt: j.pubDate,
        salary: salaryText(j.salaryMin, j.salaryMax, j.salaryCurrency ? `${j.salaryCurrency} ` : '$'),
        tags: [...(j.jobIndustry || []), ...(j.jobType || []), j.jobLevel].filter(Boolean)
      }));
    }
  },
  {
    id: 'himalayas', name: 'Himalayas', homepage: 'https://himalayas.app',
    async fetch({ q }) {
      const url = q
        ? `https://himalayas.app/jobs/api/search?${new URLSearchParams({ q, limit: '20' })}`
        : 'https://himalayas.app/jobs/api?limit=20';
      const data = await getJson(url);
      return (data.jobs || []).map(j => normalize('himalayas', 'Himalayas', {
        id: j.guid || j.applicationLink || j.title + j.companyName,
        title: j.title, company: j.companyName,
        location: (j.locationRestrictions || []).join(', ') || 'Remote', remote: true,
        description: j.description || j.excerpt, url: j.applicationLink || j.url || j.guid,
        postedAt: j.pubDate || j.publishedAt, salary: salaryText(j.minSalary, j.maxSalary, j.currency ? `${j.currency} ` : '$'),
        tags: [j.employmentType, ...(j.seniority || []), ...(j.categories || []).slice(0, 3)].filter(Boolean)
      }));
    }
  },
  {
    id: 'workingnomads', name: 'Working Nomads', homepage: 'https://www.workingnomads.com', feed: true,
    async fetch() {
      const data = await getJson('https://www.workingnomads.com/api/exposed_jobs/');
      return data.map(j => normalize('workingnomads', 'Working Nomads', {
        id: j.url, title: j.title, company: j.company_name, location: j.location || 'Remote', remote: true,
        description: j.description, url: j.url, postedAt: j.pub_date,
        tags: [j.category_name, ...String(j.tags || '').split(',')].filter(Boolean)
      }));
    }
  },
  {
    id: 'weworkremotely', name: 'We Work Remotely', homepage: 'https://weworkremotely.com', feed: true,
    async fetch() {
      const xml = await getText('https://weworkremotely.com/remote-jobs.rss', { timeout: 15_000 });
      const items = xml.split('<item>').slice(1, 201);
      return items.map(item => {
        const full = xmlText(item, 'title'); // "Company: Job title"
        const idx = full.indexOf(': ');
        const link = xmlText(item, 'link') || xmlText(item, 'guid');
        return normalize('weworkremotely', 'We Work Remotely', {
          id: xmlText(item, 'guid') || link,
          title: idx > 0 ? full.slice(idx + 2) : full,
          company: idx > 0 ? full.slice(0, idx) : '',
          location: [xmlText(item, 'region'), xmlText(item, 'country')].filter(Boolean).join(', ') || 'Remote',
          remote: true, description: xmlText(item, 'description'), url: link, postedAt: xmlText(item, 'pubDate'),
          tags: [xmlText(item, 'category'), xmlText(item, 'type'), ...xmlText(item, 'skills').split(',')]
            .map(t => t.trim()).filter(Boolean)
        });
      });
    }
  },

  {
    id: 'landingjobs', name: 'Landing.jobs', homepage: 'https://landing.jobs', feed: true, ttl: 30 * 60_000,
    async fetch() {
      const data = await getJson('https://landing.jobs/api/v1/jobs?limit=50');
      const sym = { EUR: '€', USD: '$', GBP: '£' };
      return (Array.isArray(data) ? data : []).map(j => {
        const loc = (j.locations || []).map(l => [l.city, l.country_code].filter(Boolean).join(', ')).filter(Boolean).join(' · ');
        const company = /\/at\/([^/]+)\//.exec(j.url || '')?.[1];
        return normalize('landingjobs', 'Landing.jobs', {
          id: j.id, title: j.title, company: company ? titleCase(company) : '', location: loc || (j.remote ? 'Remote' : ''),
          remote: typeof j.remote === 'boolean' ? j.remote : null,
          description: [j.role_description, j.main_requirements].filter(Boolean).join(' '),
          url: j.url, postedAt: j.published_at || j.created_at,
          salary: salaryText(j.gross_salary_low, j.gross_salary_high, sym[j.currency_code] ?? `${j.currency_code || ''} `),
          tags: [...(j.tags || []), j.type].filter(Boolean)
        });
      });
    }
  },
  {
    id: 'hnhiring', name: 'Hacker News: Who is hiring?', homepage: 'https://news.ycombinator.com/submitted?id=whoishiring',
    async fetch({ q }) {
      const story = await cached('hn:story', 6 * 60 * 60_000, async () => {
        const d = await getJson('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6');
        const hit = (d.hits || []).find(h => /who is hiring/i.test(h.title || ''));
        if (!hit) throw new Error('no current thread');
        return hit.objectID;
      });
      const p = new URLSearchParams({ tags: `comment,story_${story}`, hitsPerPage: '100' });
      if (q) p.set('query', q);
      const data = await getJson(`https://hn.algolia.com/api/v1/${q ? 'search' : 'search_by_date'}?${p}`);
      return (data.hits || [])
        .filter(h => String(h.parent_id) === String(story) && h.comment_text) // top-level posts only
        .map(h => {
          const text = htmlToText(h.comment_text, 2000);
          const head = text.split('\n')[0].split('|').map(x => x.trim()).filter(Boolean);
          const hasRoleSegment = head.length >= 2;
          return normalize('hnhiring', 'Hacker News: Who is hiring?', {
            id: h.objectID,
            title: hasRoleSegment ? head[1] : (head[0] || text.slice(0, 90)),
            company: hasRoleSegment ? head[0] : 'See post',
            location: head.slice(2).find(x => !/^(full|part)[- ]?time$|^intern/i.test(x)) || '',
            remote: /\bremote\b/i.test(head.join(' ')) ? true : null,
            description: text,
            url: `https://news.ycombinator.com/item?id=${h.objectID}`,
            postedAt: h.created_at,
            tags: ['Hacker News']
          });
        });
    }
  },

  // Company career boards (public ATS APIs). Override the company lists with
  // GREENHOUSE_BOARDS / LEVER_BOARDS / ASHBY_BOARDS (comma-separated slugs).
  {
    id: 'greenhouse', name: 'Greenhouse boards', homepage: 'https://www.greenhouse.io', feed: true, ttl: 15 * 60_000,
    async fetch() {
      const slugs = boardSlugs('GREENHOUSE_BOARDS', ['stripe', 'airbnb', 'discord', 'figma', 'cloudflare', 'gitlab', 'coinbase', 'robinhood', 'instacart', 'dropbox', 'datadog']);
      return mapLimit(slugs, 4, async (slug) => {
        const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { timeout: 15_000 });
        return (data.jobs || []).map(j => normalize('greenhouse', 'Greenhouse boards', {
          id: `${slug}-${j.id}`, title: j.title, company: j.company_name || slug, location: j.location?.name,
          remote: /remote/i.test(j.location?.name || '') || null, description: '', url: j.absolute_url,
          postedAt: j.first_published || j.updated_at, tags: []
        }));
      });
    }
  },
  {
    id: 'lever', name: 'Lever boards', homepage: 'https://www.lever.co', feed: true, ttl: 15 * 60_000,
    async fetch() {
      const slugs = boardSlugs('LEVER_BOARDS', ['spotify', 'ro', 'weride']);
      return mapLimit(slugs, 3, async (slug) => {
        const data = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`, { timeout: 15_000 });
        return data.map(j => normalize('lever', 'Lever boards', {
          id: j.id, title: j.text, company: titleCase(slug), location: j.categories?.location,
          remote: j.workplaceType ? j.workplaceType === 'remote' : null,
          description: j.descriptionPlain || '', url: j.hostedUrl, postedAt: j.createdAt,
          tags: [j.categories?.team, j.categories?.commitment].filter(Boolean)
        }));
      });
    }
  },
  {
    id: 'ashby', name: 'Ashby boards', homepage: 'https://www.ashbyhq.com', feed: true, ttl: 15 * 60_000,
    async fetch() {
      const slugs = boardSlugs('ASHBY_BOARDS', ['linear', 'cursor', 'sentry', 'notion', 'ramp']);
      return mapLimit(slugs, 3, async (slug) => {
        const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { timeout: 20_000 });
        return (data.jobs || []).filter(j => j.isListed !== false).map(j => normalize('ashby', 'Ashby boards', {
          id: j.id, title: j.title, company: titleCase(slug), location: j.location,
          remote: typeof j.isRemote === 'boolean' ? j.isRemote : null,
          description: j.descriptionPlain || j.descriptionHtml || '', url: j.jobUrl || j.applyUrl, postedAt: j.publishedAt,
          tags: [j.department, j.employmentType].filter(Boolean)
        }));
      });
    }
  },

  // ── API-key sources (enabled only when configured) ────────────────────────
  {
    id: 'adzuna', name: 'Adzuna', homepage: 'https://www.adzuna.com', envKeys: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    // ADZUNA_COUNTRY accepts one code or a comma-separated list, e.g. "us,gb,in,ca,au".
    async fetch({ q }) {
      const countries = adzunaCountries();
      // Each country is one upstream request; keep the total at 25 results at most.
      const perCountry = Math.max(3, Math.floor(25 / countries.length));
      // Sequential on purpose: Adzuna rate-limits bursts, and a 429 should stop
      // the remaining calls instead of hammering the API.
      const out = [];
      let firstError;
      for (let i = 0; i < countries.length; i++) {
        const country = countries[i];
        try {
          if (i > 0) {
            consumeBudget('adzuna'); // the first request is counted by the caller
            await new Promise(r => setTimeout(r, 1100)); // stay under Adzuna's burst limit
          }
          const p = new URLSearchParams({
            app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY,
            results_per_page: String(perCountry), 'content-type': 'application/json'
          });
          if (q) p.set('what', q);
          const data = await getJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${p}`, { retries: 0 });
          for (const j of data.results || []) {
            out.push(normalize('adzuna', 'Adzuna', {
              id: j.id, title: j.title, company: j.company?.display_name, location: j.location?.display_name,
              remote: null, description: j.description, url: j.redirect_url, postedAt: j.created,
              salary: salaryText(j.salary_min, j.salary_max, CURRENCY_BY_COUNTRY[country] ?? ''),
              tags: [country.toUpperCase(), j.category?.label, j.contract_time].filter(Boolean)
            }));
          }
        } catch (err) {
          firstError ||= err;
          // Only a rate limit (or our own budget) should stop the run; one country
          // having a bad moment must not hide the others.
          if (/HTTP 429|request limit/.test(err.message)) break;
        }
      }
      if (!out.length && firstError) throw firstError;
      return out;
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
        salary: salaryText(j.minimumSalary, j.maximumSalary, !j.currency || j.currency === 'GBP' ? '£' : `${j.currency} `)
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
  },
  {
    id: 'jsearch', name: 'JSearch (LinkedIn, Indeed, Glassdoor via Google Jobs)', homepage: 'https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch',
    envKeys: ['JSEARCH_API_KEY'],
    async fetch({ q }) {
      await consumeMonthly('jsearch', 'JSEARCH_PER_MONTH', 150);
      const p = new URLSearchParams({ query: q || 'software developer', page: '1', num_pages: '1' });
      if (process.env.JSEARCH_COUNTRY) p.set('country', process.env.JSEARCH_COUNTRY.toLowerCase().slice(0, 2));
      const data = await getJson(`https://jsearch.p.rapidapi.com/search?${p}`, {
        headers: { 'X-RapidAPI-Key': process.env.JSEARCH_API_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }
      });
      return (data.data || []).slice(0, PER_PROVIDER_LIMIT).map(j => normalize('jsearch', 'JSearch', {
        id: j.job_id, title: j.job_title, company: j.employer_name,
        location: [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', '),
        remote: typeof j.job_is_remote === 'boolean' ? j.job_is_remote : null,
        description: j.job_description, url: j.job_apply_link, postedAt: j.job_posted_at_datetime_utc,
        salary: salaryText(j.job_min_salary, j.job_max_salary, j.job_salary_currency ? `${j.job_salary_currency} ` : '$'),
        tags: [j.job_publisher ? `via ${j.job_publisher}` : '', j.job_employment_type].filter(Boolean)
      }));
    }
  },
  {
    id: 'serpapi', name: 'Google Jobs (SerpApi)', homepage: 'https://serpapi.com/google-jobs-api', envKeys: ['SERPAPI_KEY'],
    async fetch({ q }) {
      await consumeMonthly('serpapi', 'SERPAPI_PER_MONTH', 80);
      const p = new URLSearchParams({ engine: 'google_jobs', q: q || 'software developer', hl: 'en', api_key: process.env.SERPAPI_KEY });
      const data = await getJson(`https://serpapi.com/search.json?${p}`);
      return (data.jobs_results || []).slice(0, PER_PROVIDER_LIMIT).map(j => normalize('serpapi', 'Google Jobs', {
        id: j.job_id, title: j.title, company: j.company_name, location: j.location,
        remote: j.detected_extensions?.work_from_home === true ? true : null,
        description: j.description, url: j.apply_options?.[0]?.link || j.share_link,
        postedAt: relativeToIso(j.detected_extensions?.posted_at), salary: j.detected_extensions?.salary,
        tags: [j.via ? `via ${String(j.via).replace(/^via\s+/i, '')}` : '', j.detected_extensions?.schedule_type].filter(Boolean)
      }));
    }
  },
  {
    id: 'usajobs', name: 'USAJOBS', homepage: 'https://www.usajobs.gov', envKeys: ['USAJOBS_API_KEY', 'USAJOBS_EMAIL'],
    async fetch({ q }) {
      const p = new URLSearchParams({ ResultsPerPage: '25' });
      if (q) p.set('Keyword', q);
      const data = await getJson(`https://data.usajobs.gov/api/search?${p}`, {
        headers: { Host: 'data.usajobs.gov', 'User-Agent': process.env.USAJOBS_EMAIL, 'Authorization-Key': process.env.USAJOBS_API_KEY }
      });
      const items = data.SearchResult?.SearchResultItems || [];
      return items.map(({ MatchedObjectDescriptor: d }) => {
        const pay = d.PositionRemuneration?.[0];
        return normalize('usajobs', 'USAJOBS', {
          id: d.PositionID, title: d.PositionTitle, company: d.OrganizationName || d.DepartmentName,
          location: d.PositionLocationDisplay, remote: /remote|telework/i.test(d.PositionLocationDisplay || '') || null,
          description: d.UserArea?.Details?.JobSummary || d.QualificationSummary,
          url: d.PositionURI || d.ApplyURI?.[0], postedAt: d.PublicationStartDate,
          salary: salaryText(Number(pay?.MinimumRange), Number(pay?.MaximumRange), '$'),
          tags: [d.PositionSchedule?.[0]?.Name, pay?.Description].filter(Boolean)
        });
      });
    }
  }
];

const ADZUNA_COUNTRIES = new Set(['at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es', 'fr', 'gb', 'in', 'it', 'mx', 'nl', 'nz', 'pl', 'sg', 'us', 'za']);

/** Valid Adzuna country codes from ADZUNA_COUNTRY (default "us"), max 6. */
export function adzunaCountries() {
  const list = String(process.env.ADZUNA_COUNTRY || 'us').toLowerCase().split(/[\s,]+/)
    .filter(c => ADZUNA_COUNTRIES.has(c));
  return [...new Set(list.length ? list : ['us'])].slice(0, 6);
}

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
      const all = await cached(`feed:${p.id}`, p.ttl || FEED_TTL_MS, () => p.fetch({}).then(list => list.filter(Boolean)));
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
