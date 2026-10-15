/* Resume checker page. No inline handlers; all user-derived text is inserted
   with textContent / createElement, never innerHTML. */
(function () {
  'use strict';

  var cfg = (window.RR && window.RR.config) || {};
  var MAX_BYTES = 4 * 1024 * 1024;
  var JOBS_PAGE = 10;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    form: $('analyzeForm'), dropzone: $('dropzone'), fileInput: $('fileInput'), btnBrowse: $('btnBrowse'),
    fileChip: $('fileChip'), fileName: $('fileName'), fileSize: $('fileSize'), btnClear: $('btnClearFile'),
    sampleList: $('sampleList'), jdText: $('jdText'), rolePreset: $('rolePreset'),
    btnAnalyze: $('btnAnalyze'), hint: $('analyzeHint'), progress: $('progress'), progressText: $('progressText'),
    alertBox: $('alertBox'), announcer: $('srAnnouncer'),
    empty: $('emptyState'), results: $('resultsWrap'),
    ringValue: $('ringValue'), ringNum: $('ringNum'), ringSub: $('ringSub'), scoreRing: $('scoreRing'),
    ratingText: $('ratingText'), ratingBadge: $('ratingBadge'), targetText: $('targetText'),
    factFile: $('factFile'), factCategory: $('factCategory'), factLength: $('factLength'),
    kwWrap: $('kwWrap'), overviewKeywords: $('overviewKeywords'), overviewSuggestions: $('overviewSuggestions'),
    suggestionList: $('suggestionList'), checkList: $('checkList'),
    dimBody: $('dimBody'), radarIntro: $('radarIntro'), sectionsGrid: $('sectionsGrid'),
    matchPreset: $('matchPreset'), matchJd: $('matchJd'), btnMatch: $('btnMatch'),
    liveForm: $('liveForm'), liveQuery: $('liveQuery'), liveRemote: $('liveRemote'),
    liveStatus: $('liveStatus'), liveList: $('liveList'), btnMoreLive: $('btnMoreLive'),
    btnRefreshLive: $('btnRefreshLive'), sourceChips: $('sourceChips'), liveLead: $('liveJobsLead'),
    rawText: $('rawText'), btnCopyText: $('btnCopyText'),
    historyCard: $('historyCard'), historyList: $('historyList'), historyNote: $('historyNote'),
    btnDeleteHistory: $('btnDeleteHistory')
  };

  var state = { file: null, sample: null, result: null, jobs: [], jobsShown: JOBS_PAGE, busy: false, liveToken: 0 };

  /* ── helpers ──────────────────────────────────────────────────────── */
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function announce(text) { if (el.announcer) el.announcer.textContent = text; }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function tone(rating) {
    return /^High/.test(rating) ? 'high' : /^Medium/.test(rating) ? 'medium' : 'low';
  }
  function showError(text) {
    el.alertBox.textContent = text;
    el.alertBox.hidden = false;
    announce(text);
  }
  function hideError() { el.alertBox.hidden = true; el.alertBox.textContent = ''; }

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || body.success === false) {
          var err = new Error(body.error || 'Something went wrong. Please try again.');
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function jobText() {
    return (el.jdText.value.trim() || el.rolePreset.value || '').trim();
  }

  /* ── input state ──────────────────────────────────────────────────── */
  function refreshControls() {
    var hasResume = !!(state.file || state.sample);
    el.btnAnalyze.disabled = !hasResume || state.busy;
    el.hint.textContent = !hasResume
      ? 'Add a resume to get started.'
      : (jobText() ? 'Ready. Run the analysis.' : 'No job selected: you will get the ATS checklist but no match score.');
  }

  function setFile(file) {
    hideError();
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      return showError('Only PDF files are supported. Export your resume as a PDF and try again.');
    }
    if (file.size > MAX_BYTES) {
      return showError('That file is ' + formatBytes(file.size) + '. The limit is 4 MB.');
    }
    state.file = file;
    state.sample = null;
    markSample(null);
    el.fileName.textContent = file.name;
    el.fileSize.textContent = formatBytes(file.size);
    el.fileChip.hidden = false;
    el.dropzone.hidden = true;
    refreshControls();
  }

  function clearFile() {
    state.file = null;
    el.fileInput.value = '';
    el.fileChip.hidden = true;
    el.dropzone.hidden = false;
    refreshControls();
  }

  function markSample(id) {
    Array.prototype.forEach.call(el.sampleList.querySelectorAll('[data-sample]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-sample') === id));
    });
  }

  el.btnBrowse.addEventListener('click', function (e) { e.stopPropagation(); el.fileInput.click(); });
  el.dropzone.addEventListener('click', function () { el.fileInput.click(); });
  el.fileInput.addEventListener('change', function () { if (el.fileInput.files[0]) setFile(el.fileInput.files[0]); });
  el.btnClear.addEventListener('click', clearFile);
  ['dragenter', 'dragover'].forEach(function (ev) {
    el.dropzone.addEventListener(ev, function (e) { e.preventDefault(); el.dropzone.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    el.dropzone.addEventListener(ev, function (e) { e.preventDefault(); el.dropzone.classList.remove('drag-over'); });
  });
  el.dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  el.sampleList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-sample]');
    if (!btn) return;
    state.sample = btn.getAttribute('data-sample');
    if (state.file) clearFile();
    markSample(state.sample);
    if (!el.jdText.value.trim()) el.rolePreset.value = btn.getAttribute('data-role') || '';
    refreshControls();
    analyze();
  });

  el.jdText.addEventListener('input', refreshControls);
  el.rolePreset.addEventListener('change', refreshControls);

  /* ── analysis ─────────────────────────────────────────────────────── */
  function setBusy(busy, text) {
    state.busy = busy;
    el.progress.hidden = !busy;
    if (text) { el.progressText.textContent = text; announce(text); }
    refreshControls();
  }

  function analyze() {
    if (state.busy || !(state.file || state.sample)) return;
    hideError();
    setBusy(true, 'Reading your resume and scoring it…');

    var request;
    if (state.file) {
      var fd = new FormData();
      fd.append('resume', state.file);
      var jd = el.jdText.value.trim();
      var preset = el.rolePreset.value;
      if (jd) fd.append('job_description_text', jd);
      if (preset) fd.append('job_keywords', preset);
      request = api('/api/parse-resume', { method: 'POST', body: fd });
    } else {
      request = api('/api/parse-sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleName: state.sample,
          job_description_text: el.jdText.value.trim(),
          job_keywords: el.rolePreset.value
        })
      });
    }

    request.then(function (data) {
      state.result = data;
      renderResults();
      announce('Analysis complete.');
      if (cfg.currentUser && data.persisted) loadHistory();
      if (window.matchMedia('(max-width: 980px)').matches) el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      showError(err.message);
    }).then(function () { setBusy(false); });
  }

  el.form.addEventListener('submit', function (e) { e.preventDefault(); analyze(); });

  /* ── rendering ────────────────────────────────────────────────────── */
  function renderResults() {
    var r = state.result;
    el.empty.hidden = true;
    el.results.hidden = false;
    renderSummary();
    renderOverview();
    renderRadar();
    renderSections(r.sections || {});
    el.rawText.textContent = r.rawText || '';
    el.factFile.textContent = r.filename || '–';
    el.factCategory.textContent = r.category === 'Uncertain' ? 'Not enough signal' : r.category;
    el.factLength.textContent = r.stats.wordCount.toLocaleString() + ' words · ' + r.pages + (r.pages === 1 ? ' page' : ' pages');
    activateTab('tab-overview', false);
    loadLiveJobs();
  }

  function renderSummary() {
    var r = state.result, m = r.match;
    var circumference = 2 * Math.PI * 56;
    if (m) {
      var t = tone(m.matchRating);
      el.ringNum.textContent = m.percentage + '%';
      el.ringSub.textContent = 'match';
      el.ringValue.setAttribute('data-tone', t);
      el.ringValue.style.strokeDashoffset = String(circumference * (1 - m.percentage / 100));
      el.scoreRing.setAttribute('aria-label', 'Match score ' + m.percentage + ' percent');
      el.ratingText.textContent = m.matchRating;
      el.ratingBadge.hidden = true;
      el.targetText.textContent = 'Target: ' + m.targetJob;
    } else {
      el.ringNum.textContent = '–';
      el.ringSub.textContent = 'no job';
      el.ringValue.removeAttribute('data-tone');
      el.ringValue.style.strokeDashoffset = String(circumference);
      el.scoreRing.setAttribute('aria-label', 'No match score');
      el.ratingText.textContent = 'Resume analysed';
      el.targetText.textContent = 'Add a job description to see how well this resume matches it.';
    }
  }

  function renderOverview() {
    var r = state.result, m = r.match;

    clear(el.kwWrap);
    el.overviewKeywords.hidden = !m;
    if (m) {
      m.keywordAlignment.forEach(function (k) {
        el.kwWrap.appendChild(h('span', { class: 'kw ' + (k.matched ? 'kw-hit' : 'kw-miss') }, [
          h('span', { 'aria-hidden': 'true', text: k.matched ? '✓' : '✕' }),
          h('span', { text: k.keyword }),
          h('span', { class: 'sr-only', text: k.matched ? '(found)' : '(missing)' })
        ]));
      });
    }

    clear(el.suggestionList);
    (r.suggestions || []).forEach(function (s) { el.suggestionList.appendChild(h('li', { text: s })); });
    el.overviewSuggestions.hidden = !(r.suggestions && r.suggestions.length);

    clear(el.checkList);
    (r.checks || []).forEach(function (c) {
      var icon = c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✕';
      el.checkList.appendChild(h('li', { class: 'check', 'data-status': c.status }, [
        h('span', { class: 'check-icon', 'aria-hidden': 'true', text: icon }),
        h('div', {}, [
          h('b', { text: c.label }),
          h('span', { text: c.detail }),
          h('span', { class: 'sr-only', text: ' Status: ' + c.status })
        ])
      ]));
    });
  }

  function renderRadar() {
    var m = state.result.match;
    clear(el.dimBody);
    if (!m) {
      el.radarIntro.textContent = 'Add a job description to see how your resume scores on each dimension.';
      clear($('radarMount'));
      return;
    }
    el.radarIntro.textContent = 'Each axis shows how much of the job’s key vocabulary appears in that part of your resume. “Similarity” compares overall wording.';
    m.dimensions.forEach(function (d) {
      var bar = h('div', { class: 'meter' }, [h('i', { style: 'width:' + (d.available === false ? 0 : d.score) + '%' })]);
      el.dimBody.appendChild(h('tr', {}, [
        h('th', { scope: 'row', text: d.dimension }),
        h('td', {}, [h('span', { text: d.available === false ? 'Not detected' : d.score + '%' })]),
        h('td', {}, [bar])
      ]));
    });
    // The chart measures its container, so draw it only while its tab is visible.
    if (!$('tab-radar').hidden && window.renderMatchRadar) window.renderMatchRadar('radarMount', m.dimensions);
  }

  var SECTION_LABELS = [['Experience', 'Experience'], ['Education', 'Education'], ['Skills', 'Skills'], ['Projects', 'Projects']];
  function renderSections(sections) {
    clear(el.sectionsGrid);
    SECTION_LABELS.forEach(function (pair) {
      var text = sections[pair[0]];
      var missing = !text || /section not found\.?$/i.test(text);
      el.sectionsGrid.appendChild(h('div', { class: 'section-box' }, [
        h('header', {}, [h('span', { text: pair[1] })]),
        h('pre', { class: missing ? 'empty-text' : '', text: missing ? 'Not detected. Add a clear “' + pair[1] + '” heading.' : text })
      ]));
    });
  }

  /* ── tabs ─────────────────────────────────────────────────────────── */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function activateTab(id, focus) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      var panel = $(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
      if (on && focus) t.focus();
    });
    if (id === 'tab-radar' && window.renderMatchRadar && state.result && state.result.match) {
      window.renderMatchRadar('radarMount', state.result.match.dimensions);
    }
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { activateTab(t.getAttribute('data-tab'), false); });
    t.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (e.key === 'Home') next = tabs[0];
      if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); activateTab(next.getAttribute('data-tab'), true); }
    });
  });

  /* ── re-score against another job ─────────────────────────────────── */
  el.matchPreset.addEventListener('change', function () {
    if (el.matchPreset.value) el.matchJd.value = el.matchPreset.value;
  });

  function matchAgainst(text) {
    var r = state.result;
    if (!r) return;
    el.btnMatch.disabled = true;
    el.btnMatch.textContent = 'Scoring…';
    api('/api/evaluate-match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText: r.rawText, jobDescriptionText: text, resumeSections: r.sections, pages: r.pages })
    }).then(function (data) {
      r.match = Object.assign({}, data, { targetJob: text.length > 80 ? text.slice(0, 80) + '…' : text });
      r.checks = data.checks;
      r.suggestions = data.suggestions;
      renderSummary();
      renderOverview();
      renderRadar();
      activateTab('tab-overview', false);
      el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
      announce('Match score updated to ' + data.percentage + ' percent.');
    }).catch(function (err) {
      showError(err.message);
    }).then(function () {
      el.btnMatch.disabled = false;
      el.btnMatch.textContent = 'Score against this job';
    });
  }

  el.btnMatch.addEventListener('click', function () {
    var text = el.matchJd.value.trim();
    if (!text) { showError('Paste a job description or choose a role preset first.'); return; }
    hideError();
    matchAgainst(text);
  });

  /* ── live jobs ────────────────────────────────────────────────────── */
  function relativeTime(iso) {
    if (!iso) return '';
    var days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 0 || isNaN(days)) return '';
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return days + ' days ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderSources(sources) {
    clear(el.sourceChips);
    sources.forEach(function (s) {
      var label = s.status === 'ok' ? s.name + ' · ' + s.count : s.name + ' · unavailable';
      var chip = h('a', {
        class: 'source-chip ' + (s.status === 'ok' ? 'ok' : 'error'),
        href: s.homepage, target: '_blank', rel: 'noopener noreferrer',
        title: s.status === 'ok' ? 'Loaded in ' + s.ms + ' ms' : 'Could not load: ' + (s.error || 'error')
      });
      chip.textContent = label;
      el.sourceChips.appendChild(chip);
    });
  }

  function loadLiveJobs() {
    var token = ++state.liveToken;
    el.liveStatus.textContent = 'Loading jobs from the job boards…';
    clear(el.liveList);
    for (var i = 0; i < 4; i++) {
      el.liveList.appendChild(h('div', { class: 'skeleton-card', 'aria-hidden': 'true' }, [
        h('div', { class: 'skeleton', style: 'width:70%' }),
        h('div', { class: 'skeleton', style: 'width:40%' }),
        h('div', { class: 'skeleton', style: 'width:90%' })
      ]));
    }
    el.btnMoreLive.hidden = true;
    el.btnRefreshLive.disabled = true;

    api('/api/live-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: el.liveQuery.value.trim(),
        remote: el.liveRemote.checked,
        resumeText: state.result ? state.result.rawText : ''
      })
    }).then(function (data) {
      if (token !== state.liveToken) return; // a newer request superseded this one
      state.jobs = data.jobs || [];
      state.jobsShown = JOBS_PAGE;
      renderSources(data.sources || []);
      renderLiveJobs(data);
    }).catch(function (err) {
      if (token !== state.liveToken) return;
      clear(el.liveList);
      el.liveStatus.textContent = err.message;
    }).then(function () {
      if (token === state.liveToken) el.btnRefreshLive.disabled = false;
    });
  }

  function renderLiveJobs(data) {
    clear(el.liveList);
    var total = state.jobs.length;
    var failed = (data.sources || []).filter(function (s) { return s.status !== 'ok'; }).length;
    if (total) {
      el.liveStatus.textContent = total + (total === 1 ? ' job' : ' jobs') +
        (data.hasResumeMatch ? ', best matches for your resume first.' : ', newest first.') +
        (failed ? ' ' + failed + (failed === 1 ? ' source was' : ' sources were') + ' unavailable.' : '');
    } else {
      el.liveStatus.textContent = 'No jobs matched. Try a broader search or turn off “Remote only”.';
    }
    el.liveLead.textContent = data.hasResumeMatch
      ? 'Ranked by how well each posting matches the resume you analyzed.'
      : 'Fresh postings pulled from several public job boards. Analyze a resume above to rank them by how well you match.';

    state.jobs.slice(0, state.jobsShown).forEach(function (job) {
      var badge = null;
      if (job.matchPercentage !== undefined) {
        badge = h('span', { class: 'badge badge-' + tone(job.matchRating), text: job.matchPercentage + '% match' });
      }
      var meta = [job.company, job.location].filter(Boolean).join(' · ');
      var tags = [];
      if (job.remote === true) tags.push('Remote');
      if (job.salary) tags.push(job.salary);
      var posted = relativeTime(job.postedAt);
      if (posted) tags.push(posted);
      (job.tags || []).slice(0, 5).forEach(function (t) { tags.push(t); });

      var kids = [
        h('div', { class: 'job-head' }, [
          h('div', {}, [h('h3', { text: job.title }), h('div', { class: 'meta', text: meta })]),
          badge
        ])
      ];
      if (job.summary) kids.push(h('p', { text: job.summary }));
      kids.push(h('div', { class: 'job-tags' }, tags.map(function (t) { return h('span', { class: 'tag', text: t }); })));
      if (job.missingKeywords && job.missingKeywords.length) {
        kids.push(h('p', { class: 'small', text: 'Missing from your resume: ' + job.missingKeywords.join(', ') }));
      }

      var view = h('a', {
        class: 'btn btn-primary btn-sm', href: job.url, target: '_blank',
        rel: 'noopener noreferrer nofollow', text: 'View & apply'
      });
      var scoreBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Score my resume' });
      scoreBtn.addEventListener('click', function () {
        if (!state.result) {
          showError('Analyze a resume first, then you can score it against any job.');
          document.getElementById('main-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        var text = job.title + '\n' + (job.tags || []).join(', ') + '\n' + (job.summary || '');
        el.matchJd.value = text;
        el.matchPreset.value = '';
        matchAgainst(text);
      });
      kids.push(h('div', { class: 'job-actions' }, [view, scoreBtn]));

      var src = h('div', { class: 'job-source' });
      src.appendChild(document.createTextNode('via '));
      var srcLink = h('a', { href: job.url, target: '_blank', rel: 'noopener noreferrer nofollow' });
      srcLink.textContent = job.sourceName;
      src.appendChild(srcLink);
      kids.push(src);

      el.liveList.appendChild(h('article', { class: 'job' }, kids));
    });

    el.btnMoreLive.hidden = total <= state.jobsShown;
  }

  el.btnMoreLive.addEventListener('click', function () {
    state.jobsShown += JOBS_PAGE;
    renderLiveJobs({ sources: [], hasResumeMatch: !!state.result });
  });
  el.liveForm.addEventListener('submit', function (e) { e.preventDefault(); loadLiveJobs(); });
  el.liveRemote.addEventListener('change', loadLiveJobs);
  el.btnRefreshLive.addEventListener('click', loadLiveJobs);

  /* ── extracted text copy ──────────────────────────────────────────── */
  el.btnCopyText.addEventListener('click', function () {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(el.rawText.textContent).then(function () {
      el.btnCopyText.textContent = 'Copied';
      setTimeout(function () { el.btnCopyText.textContent = 'Copy'; }, 1500);
    });
  });

  /* ── history (signed-in users) ────────────────────────────────────── */
  function loadHistory() {
    api('/api/history').then(function (data) {
      el.historyCard.hidden = false;
      el.historyNote.textContent = data.durable
        ? 'Only scores and keyword gaps are saved, never your resume text.'
        : 'Only scores and keyword gaps are saved, never your resume text. Storage on this server is temporary and may reset.';
      clear(el.historyList);
      if (!data.items.length) {
        el.historyList.appendChild(h('li', { class: 'small muted', text: 'No evaluations yet.' }));
      }
      data.items.slice(0, 6).forEach(function (item) {
        el.historyList.appendChild(h('li', { class: 'history-item' }, [
          h('span', { text: item.target }),
          h('strong', { text: Math.round(item.score * 100) + '%' })
        ]));
      });
    }).catch(function () { el.historyCard.hidden = true; });
  }

  el.btnDeleteHistory.addEventListener('click', function () {
    if (!window.confirm('Delete all saved evaluations and your profile from this app? You will be signed out.')) return;
    api('/api/history', { method: 'DELETE' }).then(function () {
      window.location.href = '/';
    }).catch(function (err) { showError(err.message); });
  });

  // Let the apply-by-email tool use the analyzed resume (never persisted or sent as a file).
  window.RR = window.RR || {};
  window.RR.getResumeText = function () { return state.result ? state.result.rawText : ''; };

  /* ── init ─────────────────────────────────────────────────────────── */
  refreshControls();
  loadLiveJobs();
  if (cfg.currentUser) loadHistory();
})();
