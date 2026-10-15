import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { extractPost, draftApplication, cleanPostText } from '../src/services/applyEmail.js';

const POST = `*WE ARE HIRING!*
*Position: Manager – Dyeing Finishing (Knits Fabric)*

*Requirements:*
- *Education:* Bachelor’s in Chemical Engineering or a relevant field.
- *Experience:* 8–12 years of relevant experience in Knits Fabric Finishing.
- *Skills:* Strong knowledge of finishing processes, machine operations, chemicals, and team management.

*Key Responsibilities:*
- Lead finishing operations to achieve production and quality targets.
- Monitor WIP, machine performance, finishing routes, and process parameters.

📧 *Apply at:* husnain.ali@combinedfabrics.com

📅 *Last Date to Apply:* 26 October 2026
#wearehiring #ManagerDyeingFinishing #CombinedFabricsLimited #LahoreJobs


6


1`;

const realFetch = globalThis.fetch;
const savedKey = process.env.OPENROUTER_API_KEY;
let lastRequest = null;

beforeEach(() => {
  lastRequest = null;
  delete process.env.OPENROUTER_API_KEY;
  globalThis.fetch = realFetch;
});

after(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
});

describe('extractPost', () => {
  it('pulls the structured details out of a LinkedIn-style post', () => {
    const p = extractPost(POST);
    assert.equal(p.role, 'Manager – Dyeing Finishing (Knits Fabric)');
    assert.deepEqual(p.emails, ['husnain.ali@combinedfabrics.com']);
    assert.equal(p.company, 'Combined Fabrics Limited');
    assert.equal(p.deadline, '26 October 2026');
    assert.equal(p.location, 'Lahore');
    assert.match(p.experience, /^8–12 years/);
    assert.match(p.education, /Chemical Engineering/);
    assert.match(p.skills, /team management/);
    assert.equal(p.responsibilities.length, 2);
    assert.ok(p.hashtags.includes('#LahoreJobs'));
  });

  it('removes markdown, emoji and trailing reaction counters', () => {
    const t = cleanPostText(POST);
    assert.doesNotMatch(t, /[*📧📅]/u);
    assert.doesNotMatch(t, /\n6\n/);
    assert.ok(!t.endsWith('1'));
  });

  it('falls back to the email domain for the company and reports no email when absent', () => {
    const p = extractPost('Hiring: Backend Engineer\nSend your CV to jobs@acme-tech.io');
    assert.equal(p.role, 'Backend Engineer');
    assert.match(p.company, /Acme/);
    const none = extractPost('Hiring: Data Analyst\nApply via https://example.com/careers/123.');
    assert.equal(none.hasApplyEmail, false);
    assert.deepEqual(none.urls, ['https://example.com/careers/123']);
  });

  it('does not treat a personal mail domain as the company', () => {
    const p = extractPost('We are hiring a Designer. Email cv@gmail.com');
    assert.equal(p.company, '');
  });
});

describe('draftApplication', () => {
  it('returns a template draft when OpenRouter is not configured', async () => {
    const d = await draftApplication({ postText: POST, senderName: 'Ayesha Khan' });
    assert.equal(d.source, 'template');
    assert.equal(d.to, 'husnain.ali@combinedfabrics.com');
    assert.match(d.subject, /Manager – Dyeing Finishing/);
    assert.match(d.body, /Ayesha Khan/);
    assert.match(d.notice, /not configured/i);
  });

  it('uses the model output via OpenRouter and sends only post facts, never the resume text', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = (url, init) => {
      lastRequest = { url: String(url), init, body: JSON.parse(init.body) };
      return Promise.resolve(new Response(JSON.stringify({
        model: 'test/model',
        choices: [{ message: { content: JSON.stringify({
          subject: 'Application for Manager, Dyeing Finishing',
          body: 'Dear Hiring Team,\n\nI am applying for the Manager role in Dyeing Finishing at Combined Fabrics. I bring years of hands-on work in knit fabric finishing and team management and would value a conversation.\n\nMy resume is attached.\n\nBest regards,\nAyesha Khan',
          to: 'attacker@evil.example'
        }) } }]
      }), { status: 200 }));
    };
    const secret = 'SECRET-RESUME-LINE-DO-NOT-LEAK 123 Main St';
    const d = await draftApplication({
      postText: POST, senderName: 'Ayesha Khan',
      resumeText: `${secret}. Experienced in finishing processes, machine operations and chemicals.`
    });
    assert.equal(d.source, 'ai');
    assert.equal(d.model, 'test/model');
    assert.equal(d.to, 'husnain.ali@combinedfabrics.com', 'recipient comes only from the post');
    assert.equal(lastRequest.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(lastRequest.init.headers.Authorization, 'Bearer test-key');
    assert.ok(!JSON.stringify(lastRequest.body).includes('SECRET-RESUME-LINE'), 'resume text must not be sent');
    assert.match(JSON.stringify(lastRequest.body.messages[0]), /untrusted/i);
  });

  it('falls back to the template when the model fails or returns junk', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = () => Promise.resolve(new Response('upstream error', { status: 502 }));
    let d = await draftApplication({ postText: POST, senderName: 'A B' });
    assert.equal(d.source, 'template');
    assert.match(d.notice, /unavailable/i);

    globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), { status: 200 }));
    d = await draftApplication({ postText: POST, senderName: 'A B' });
    assert.equal(d.source, 'template');
  });
});
