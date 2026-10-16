/* Jobs page: every live posting from all sources, with search, filters and
   optional ranking by the resume analysed earlier in this browser tab. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var form = $('liveForm');
  if (!form || !window.RR || !window.RR.jobs) return;
  var J = window.RR.jobs;
  var PAGE = 12;

  var el = {
    query: $('liveQuery'), remote: $('liveRemote'), status: $('liveStatus'), list: $('liveList'),
    more: $('btnMoreLive'), refresh: $('btnRefreshLive'), sources: $('sourceChips'), lead: $('liveJobsLead'),
    chips: $('quickChips'), rankWrap: $('rankWrap'), rank: $('rankByResume')
  };
  var state = { jobs: [], shown: PAGE, token: 0 };

  function resumeText() {
    try { return window.sessionStorage.getItem('rr_resume_text') || ''; } catch (e) { return ''; }
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function renderSources(sources) {
    clear(el.sources);
    sources.forEach(function (s) {
      var chip = J.h('a', {
        class: 'source-chip ' + (s.status === 'ok' ? 'ok' : 'error'), href: s.homepage, target: '_blank', rel: 'noopener noreferrer',
        title: s.status === 'ok' ? 'Loaded in ' + s.ms + ' ms' : 'Could not load: ' + (s.error || 'error')
      });
      chip.textContent = s.status === 'ok' ? s.name + ' · ' + s.count : s.name + ' · unavailable';
      el.sources.appendChild(chip);
    });
  }

  // Inline scoring of the stored resume against one job (no navigation needed).
  function scoreOne(job, article, button) {
    var text = resumeText();
    var old = article.querySelector('.score-inline');
    if (old) old.remove();
    var note = J.h('div', { class: 'alert alert-info score-inline', role: 'status' });
    article.insertBefore(note, article.querySelector('.job-actions'));
    if (!text) {
      note.textContent = 'Analyze your resume on the home page first, then score it against any job here.';
      return;
    }
    button.disabled = true;
    note.textContent = 'Scoring…';
    fetch('/api/evaluate-match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText: text, jobDescriptionText: job.title + '\n' + (job.tags || []).join(', ') + '\n' + (job.summary || '') })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok || !b.success) throw new Error(b.error || 'Could not score this job.');
        return b;
      });
    }).then(function (b) {
      var missing = (b.missingKeywords || []).slice(0, 6).join(', ');
      note.textContent = 'Your match: ' + b.percentage + '% (' + b.matchRating + ').' + (missing ? ' Missing: ' + missing + '.' : ' You cover the key terms.');
    }).catch(function (err) { note.textContent = err.message; })
      .then(function () { button.disabled = false; });
  }

  function useResume() {
    return !!resumeText() && (!el.rank || el.rank.checked);
  }

  function render(data) {
    clear(el.list);
    var total = state.jobs.length;
    var failed = (data.sources || []).filter(function (s) { return s.status !== 'ok'; }).length;
    el.status.textContent = total
      ? total + (total === 1 ? ' job' : ' jobs') + (data.hasResumeMatch ? ', best matches for your resume first.' : ', newest first.') +
        (failed ? ' ' + failed + (failed === 1 ? ' source was' : ' sources were') + ' unavailable.' : '')
      : 'No jobs matched. Try a broader search or turn off “Remote only”.';
    el.lead.textContent = data.hasResumeMatch
      ? 'Ranked by how well each posting matches the resume you analyzed.'
      : 'Fresh postings from 20+ public job boards. Analyze a resume on the home page to rank them by how well you match.';
    state.jobs.slice(0, state.shown).forEach(function (job) { el.list.appendChild(J.card(job, { onScore: scoreOne })); });
    el.more.hidden = total <= state.shown;
    window.dispatchEvent(new Event('rr:content'));
  }

  function load() {
    var token = ++state.token;
    el.status.textContent = 'Loading jobs from the job boards…';
    clear(el.list);
    J.skeletons(4).forEach(function (n) { el.list.appendChild(n); });
    el.more.hidden = true;
    el.refresh.disabled = true;

    fetch('/api/live-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: el.query.value.trim(), remote: el.remote.checked, resumeText: useResume() ? resumeText() : '' })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok || b.success === false) throw new Error(b.error || 'Could not load jobs. Please try again.');
        return b;
      });
    }).then(function (data) {
      if (token !== state.token) return;
      state.jobs = data.jobs || [];
      state.shown = PAGE;
      renderSources(data.sources || []);
      render(data);
    }).catch(function (err) {
      if (token !== state.token) return;
      clear(el.list);
      el.status.textContent = err.message;
    }).then(function () {
      if (token === state.token) el.refresh.disabled = false;
    });
  }

  if (el.rankWrap) el.rankWrap.hidden = !resumeText();
  if (el.rank) el.rank.addEventListener('change', load);
  el.more.addEventListener('click', function () {
    state.shown += PAGE;
    render({ sources: [], hasResumeMatch: useResume() });
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); load(); });
  el.remote.addEventListener('change', load);
  el.refresh.addEventListener('click', load);
  el.chips.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-q]');
    if (!btn) return;
    Array.prototype.forEach.call(el.chips.querySelectorAll('[data-q]'), function (b) { b.classList.toggle('active', b === btn); });
    el.query.value = btn.getAttribute('data-q');
    load();
  });

  // Support links like /jobs?q=python&remote=1
  var qs = new URLSearchParams(window.location.search);
  if (qs.get('q')) el.query.value = qs.get('q').slice(0, 100);
  if (qs.get('remote') === '1') el.remote.checked = true;
  load();
})();
