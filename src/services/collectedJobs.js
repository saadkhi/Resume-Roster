/**
 * Jobs gathered by the Python collector (collector/), read straight from the
 * shared Postgres database.
 *
 * The collector (Indeed, ZipRecruiter, Remote OK, We Work Remotely, Hacker News,
 * ...) runs on a schedule and upserts into the `jobs` table. Reading that table
 * directly means no extra API server has to be hosted.
 *
 * Table layout is defined by collector/db.py (Job model). If the collector has
 * never run, the table does not exist yet and this returns no jobs.
 */
import { query as defaultQuery, isConfigured } from '../db/postgres.js';

const MAX_ROWS = 200;
const MAX_TERMS = 6;

const SITE_NAMES = {
  indeed: 'Indeed',
  zip_recruiter: 'ZipRecruiter',
  linkedin: 'LinkedIn',
  glassdoor: 'Glassdoor',
  bayt: 'Bayt',
  bdjobs: 'BDJobs',
  naukri: 'Naukri',
  hellowork: 'HelloWork',
  remote_ok: 'Remote OK',
  we_work_remotely: 'We Work Remotely',
  hacker_news: 'Hacker News: Who is hiring?'
};

export const siteLabel = (site) => SITE_NAMES[site] || String(site || 'Collected').replace(/_/g, ' ');

export const collectedJobsEnabled = () => isConfigured() && process.env.COLLECTED_JOBS !== 'off';

/** Escape LIKE wildcards so user text is matched literally. */
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const SALARY_PERIOD = { yearly: 'yr', monthly: 'mo', weekly: 'wk', daily: 'day', hourly: 'hr' };

function salaryOf(row) {
  const lo = Number(row.min_amount);
  const hi = Number(row.max_amount);
  if (!(lo > 0 || hi > 0)) return null;
  const sym = { USD: '$', GBP: '£', EUR: '€' }[row.currency] ?? (row.currency ? `${row.currency} ` : '$');
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
  const range = lo > 0 && hi > 0 && k(lo) !== k(hi) ? `${sym}${k(lo)} – ${k(hi)}` : `${sym}${k(hi || lo)}`;
  const per = SALARY_PERIOD[row.salary_period];
  return per ? `${range} / ${per}` : range;
}

/**
 * @param {{q?: string, remote?: boolean}} params
 * @param {(text: string, values: any[]) => Promise<{rows: any[]}>} [run] injectable for tests
 * @returns {Promise<object[]>} raw rows shaped for normalize()
 */
export async function fetchCollectedJobs({ q = '', remote = false } = {}, run = defaultQuery) {
  const where = [];
  const values = [];
  const terms = String(q).toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, MAX_TERMS);
  for (const term of terms) {
    values.push(`%${likeEscape(term)}%`);
    const p = `$${values.length}`;
    where.push(`(title ILIKE ${p} OR company ILIKE ${p} OR COALESCE(location, '') ILIKE ${p} OR COALESCE(tags, '') ILIKE ${p} OR COALESCE(description, '') ILIKE ${p})`);
  }
  if (remote) where.push("(is_remote IS TRUE OR workplace_type = 'remote')");

  const sql = `SELECT unique_hash, site, title, company, location, job_type, is_remote, workplace_type,
                      job_url, description, min_amount, max_amount, currency, salary_period,
                      date_posted, first_seen_at, tags
                 FROM jobs
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY COALESCE(date_posted, first_seen_at) DESC NULLS LAST
                LIMIT ${MAX_ROWS}`;

  let rows;
  try {
    ({ rows } = await run(sql, values));
  } catch (err) {
    if (err && err.code === '42P01') return []; // collector has not created its table yet
    throw err;
  }

  return rows.map(r => ({
    id: r.unique_hash,
    sourceName: siteLabel(r.site),
    title: r.title,
    company: r.company,
    location: r.location || '',
    remote: typeof r.is_remote === 'boolean' ? r.is_remote : (r.workplace_type === 'remote' ? true : null),
    description: r.description || '',
    url: r.job_url,
    postedAt: r.date_posted || r.first_seen_at,
    salary: salaryOf(r),
    tags: [r.workplace_type && r.workplace_type !== 'unknown' ? r.workplace_type : '', r.job_type && r.job_type !== 'unknown' ? r.job_type : '',
      ...String(r.tags || '').split(/[;,]/)].map(t => t.trim()).filter(Boolean)
  }));
}
