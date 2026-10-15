import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanResume, tokenize, parseCsv, tfidfVector, cosineSimilarity, scoreMatch,
  predictCategory, atsChecks, ratingFor, MATCH_THRESHOLDS
} from '../src/services/nlp.js';
import { extractSection, extractSections } from '../src/services/resumeParser.js';

describe('cleanResume / tokenize', () => {
  it('keeps technology names intact', () => {
    const t = tokenize(cleanResume('Built services in C++, C#, Node.js and ASP.NET'));
    for (const want of ['cpp', 'csharp', 'nodejs', 'asp', 'dotnet']) assert.ok(t.includes(want), want);
  });

  it('drops urls and emails', () => {
    const t = tokenize(cleanResume('mail me@example.com https://example.com/x python'));
    assert.deepEqual(t, ['mail', 'python']);
  });

  it('stems simple plurals consistently', () => {
    assert.deepEqual(tokenize('databases database'), ['database', 'database']);
  });
});

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes and newlines', () => {
    const rows = parseCsv('Category,Resume\nDev,"Python, SQL ""fast""\nsecond line"\nOps,plain\n');
    assert.equal(rows.length, 3);
    assert.equal(rows[1][1], 'Python, SQL "fast"\nsecond line');
    assert.deepEqual(rows[2], ['Ops', 'plain']);
  });
});

describe('vectors', () => {
  it('are unit length and identical texts have cosine 1', () => {
    const v = tfidfVector('python machine learning sql tensorflow');
    const norm = Math.sqrt(Object.values(v).reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
  });

  it('empty text gives an empty vector', () => {
    assert.equal(Object.keys(tfidfVector('')).length, 0);
  });
});

describe('scoreMatch', () => {
  const resume = 'Python developer. Built machine learning models with scikit-learn and SQL. Docker, AWS, REST APIs.';

  it('covers a matching job highly and an unrelated job poorly', () => {
    const good = scoreMatch(resume, 'Python, SQL, machine learning, Docker, AWS');
    const bad = scoreMatch(resume, 'Plumber, pipes, wrench, boiler installation, soldering');
    assert.ok(good.percentage >= 90, `good=${good.percentage}`);
    assert.equal(bad.percentage, 0);
    assert.equal(good.matchRating, 'High Match');
    assert.equal(bad.matchRating, 'Low Match');
  });

  it('reports missing keywords and keeps scores within bounds', () => {
    const m = scoreMatch(resume, 'Python, Kubernetes, Terraform, Docker');
    assert.ok(m.missingKeywords.map(k => k.toLowerCase()).includes('kubernetes'));
    for (const d of m.dimensions) assert.ok(d.score >= 0 && d.score <= 100);
    assert.ok(m.similarityScore >= 0 && m.similarityScore <= 1);
  });

  it('marks undetected sections as unavailable instead of inventing a score', () => {
    const m = scoreMatch(resume, 'Python, SQL', { Skills: 'Python, SQL', Projects: 'Projects section not found.' });
    const dim = Object.fromEntries(m.dimensions.map(d => [d.dimension, d]));
    assert.equal(dim.Skills.available, true);
    assert.equal(dim.Projects.available, false);
    assert.equal(dim.Projects.score, 0);
  });

  it('is deterministic', () => {
    assert.deepEqual(scoreMatch(resume, 'Python, SQL'), scoreMatch(resume, 'Python, SQL'));
  });

  it('ratings follow the documented thresholds', () => {
    assert.equal(ratingFor(MATCH_THRESHOLDS.high), 'High Match');
    assert.equal(ratingFor(MATCH_THRESHOLDS.medium), 'Medium Match');
    assert.equal(ratingFor(MATCH_THRESHOLDS.medium - 0.01), 'Low Match');
  });
});

describe('predictCategory', () => {
  it('returns Uncertain for very short text', () => {
    assert.equal(predictCategory('hello world').category, 'Uncertain');
  });
});

describe('extractSection(s)', () => {
  const cv = [
    'Jane Doe', 'jane@example.com', '',
    'EDUCATION', 'B.S. Computer Science, Example University', '',
    'Technical Skills', 'Python, SQL, Docker', '',
    'Work Experience', 'Engineer at Acme', '- Built things', '',
    'Projects: Resume Rater, a scoring tool', 'More project detail', '',
    'References', 'Available on request'
  ].join('\n');

  it('finds headings regardless of case and common aliases', () => {
    const s = extractSections(cv);
    assert.match(s.Education, /Example University/);
    assert.equal(s.Skills, 'Python, SQL, Docker');
    assert.match(s.Experience, /Built things/);
    assert.doesNotMatch(s.Experience, /Resume Rater/);
  });

  it('supports inline headings and stops at the next heading', () => {
    const p = extractSection(cv, 'Projects');
    assert.match(p, /^Resume Rater, a scoring tool\nMore project detail$/);
  });

  it('reports a missing section', () => {
    assert.equal(extractSection('just some text', 'Skills'), 'Skills section not found.');
  });
});

describe('atsChecks', () => {
  it('flags a resume with no contact info and no sections', () => {
    const { checks, suggestions } = atsChecks({ rawText: 'short text only', sections: {}, pages: 1 });
    const byId = Object.fromEntries(checks.map(c => [c.id, c.status]));
    assert.equal(byId.email, 'fail');
    assert.equal(byId.length, 'fail');
    assert.ok(suggestions.length > 0);
  });

  it('passes a reasonable resume', () => {
    const body = 'Delivered projects improving throughput by 40% and cutting cost by 15%. Led 3 engineers. '.repeat(20);
    const { checks } = atsChecks({
      rawText: `me@example.com (555) 123-4567 ${body}`,
      sections: { Experience: 'x', Education: 'y', Skills: 'z' },
      pages: 1
    });
    assert.ok(checks.every(c => c.status === 'pass'), JSON.stringify(checks.filter(c => c.status !== 'pass')));
  });
});
