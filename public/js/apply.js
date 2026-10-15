/* "Apply by email": paste a hiring post, review extracted details and a draft,
   then open it in the user's own mail client. The server never sends email. */
(function () {
  'use strict';

  var cfg = (window.RR && window.RR.config) || {};

  // Pre-fill from the bookmarklet (see below) when the page is opened with #job=...
  function prefillFromHash() {
    var m = /^#job=(.+)$/.exec(window.location.hash || '');
    if (!m) return;
    try {
      var text = decodeURIComponent(m[1]);
      var area = document.getElementById('postText');
      if (area && text) area.value = text.slice(0, 12000);
      window.history.replaceState(null, '', window.location.pathname);
    } catch (e) { /* ignore malformed fragment */ }
  }
  var $ = function (id) { return document.getElementById(id); };
  var form = $('applyForm');
  if (!form) return;

  var el = {
    post: $('postText'), name: $('senderName'), about: $('aboutYou'), useResume: $('useResume'),
    useResumeWrap: $('useResumeWrap'), btn: $('btnDraft'), error: $('applyError'),
    result: $('applyResult'), grid: $('detailGrid'), noEmail: $('noEmailNote'), links: $('linkRow'),
    source: $('draftSource'), notice: $('draftNotice'),
    to: $('draftTo'), subject: $('draftSubject'), body: $('draftBody'),
    mailto: $('btnMailto'), gmail: $('btnGmail'), copy: $('btnCopyDraft'), redraft: $('btnRedraft'),
    score: $('btnScore'), scoreResult: $('scoreResult'), bookmarklet: $('bookmarklet')
  };

  // Bookmarklet: opens this site with the text of the page being viewed (browser-side only).
  if (el.bookmarklet) {
    var code = "(function(){var s=window.getSelection?String(window.getSelection()).trim():'';" +
      "var t=s||document.body.innerText||'';t=t.replace(/\\s+/g,' ').slice(0,6000);" +
      "window.open('" + window.location.origin + "/apply#job='+encodeURIComponent(document.title+'\\n'+location.href+'\\n'+t),'_blank');})();";
    el.bookmarklet.setAttribute('href', 'javascript:' + code);
  }

  prefillFromHash();
  if (cfg.currentUser && cfg.currentUser.name) el.name.value = cfg.currentUser.name;
  try {
    var savedName = window.localStorage.getItem('rr_sender_name');
    if (savedName && !el.name.value) el.name.value = savedName;
  } catch (e) { /* storage unavailable */ }

  function resumeText() {
    try {
      return window.sessionStorage.getItem('rr_resume_text') || '';
    } catch (e) {
      return '';
    }
  }

  // Reveal the resume option once a resume has been analyzed.
  function syncResumeOption() { el.useResumeWrap.hidden = !resumeText(); }
  ['focus', 'input'].forEach(function (ev) { el.post.addEventListener(ev, syncResumeOption); });
  syncResumeOption();

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function showError(text) { el.error.textContent = text; el.error.hidden = false; }

  function row(label, value) {
    if (!value) return null;
    var wrap = document.createElement('div');
    wrap.className = 'detail';
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    return wrap;
  }

  function renderDetails(d) {
    clear(el.grid);
    [
      ['Role', d.role], ['Company', d.company], ['Apply to', (d.emails || []).join(', ')],
      ['Deadline', d.deadline], ['Location', d.location], ['Experience', d.experience],
      ['Education', d.education], ['Skills', d.skills]
    ].forEach(function (pair) {
      var r = row(pair[0], pair[1]);
      if (r) el.grid.appendChild(r);
    });
    el.noEmail.hidden = !!(d.emails && d.emails.length);

    clear(el.links);
    el.links.hidden = !(d.urls && d.urls.length);
    (d.urls || []).forEach(function (u) {
      var a = document.createElement('a');
      a.href = u;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      a.textContent = u;
      var div = document.createElement('div');
      div.appendChild(document.createTextNode('Link in post: '));
      div.appendChild(a);
      el.links.appendChild(div);
    });
  }

  function refreshLinks() {
    var to = el.to.value.trim();
    var subject = el.subject.value;
    var body = el.body.value;
    el.mailto.href = 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    el.gmail.href = 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(to) +
      '&su=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }
  [el.to, el.subject, el.body].forEach(function (n) { n.addEventListener('input', refreshLinks); });

  function draft() {
    el.error.hidden = true;
    var postText = el.post.value.trim();
    if (postText.length < 30) return showError('Paste the full hiring post first.');

    el.btn.disabled = true;
    var label = el.btn.textContent;
    el.btn.textContent = 'Writing your draft…';
    try { window.localStorage.setItem('rr_sender_name', el.name.value.trim()); } catch (e) { /* ignore */ }

    fetch('/api/apply/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postText: postText,
        senderName: el.name.value.trim(),
        aboutYou: el.about.value.trim(),
        resumeText: el.useResume.checked ? resumeText() : ''
      })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || !body.success) throw new Error(body.error || 'Could not prepare the draft.');
        return body;
      });
    }).then(function (data) {
      renderDetails(data.details || {});
      el.to.value = data.to || '';
      el.subject.value = data.subject || '';
      el.body.value = data.body || '';
      el.source.textContent = data.source === 'ai' ? 'Written by AI' : 'Template draft';
      el.source.className = 'badge ' + (data.source === 'ai' ? 'badge-high' : '');
      el.notice.hidden = !data.notice;
      el.notice.textContent = data.notice || '';
      refreshLinks();
      el.result.hidden = false;
      el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      showError(err.message);
    }).then(function () {
      el.btn.disabled = false;
      el.btn.textContent = label;
    });
  }

  // Score the analyzed resume against the pasted post (local scoring, no AI).
  el.score.addEventListener('click', function () {
    var text = resumeText();
    el.scoreResult.hidden = false;
    if (!text) {
      el.scoreResult.textContent = 'Analyze your resume on the home page first, then come back and score it against this post.';
      return;
    }
    el.scoreResult.textContent = 'Scoring…';
    fetch('/api/evaluate-match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText: text, jobDescriptionText: el.post.value.trim() })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok || !b.success) throw new Error(b.error || 'Could not score.');
        return b;
      });
    }).then(function (b) {
      var missing = (b.missingKeywords || []).slice(0, 6).join(', ');
      el.scoreResult.textContent = 'Match: ' + b.percentage + '% (' + b.matchRating + ').' +
        (missing ? ' Missing from your resume: ' + missing + '.' : ' Your resume covers the key terms.');
    }).catch(function (err) { el.scoreResult.textContent = err.message; });
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); draft(); });
  el.redraft.addEventListener('click', draft);

  el.copy.addEventListener('click', function () {
    var text = 'To: ' + el.to.value + '\nSubject: ' + el.subject.value + '\n\n' + el.body.value;
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      el.copy.textContent = 'Copied';
      setTimeout(function () { el.copy.textContent = 'Copy email'; }, 1500);
    });
  });
})();
