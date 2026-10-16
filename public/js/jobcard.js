/* Shared job-card renderer used by the Jobs page and the resume-matches block.
   All text goes through textContent; nothing from job feeds is inserted as HTML. */
(function () {
  'use strict';

  window.RR = window.RR || {};

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

  function tone(rating) {
    return /^High/.test(rating) ? 'high' : /^Medium/.test(rating) ? 'medium' : 'low';
  }

  function relativeTime(iso) {
    if (!iso) return '';
    var days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 0 || isNaN(days)) return '';
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return days + ' days ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /**
   * @param {object} job normalised job from /api/live-jobs
   * @param {{onScore?: function(object, HTMLElement, HTMLElement)}} opts
   */
  function card(job, opts) {
    opts = opts || {};
    var badge = null;
    if (job.matchPercentage !== undefined) {
      badge = h('span', { class: 'badge badge-' + tone(job.matchRating), text: job.matchPercentage + '% match' });
    }
    var meta = [job.company, job.location].filter(Boolean).join(' · ');
    var tags = [];
    if (job.remote === true) tags.push('Remote');
    if (job.salary) tags.push(job.salary);
    if (job.limitedDetails) tags.push('Limited details');
    var posted = relativeTime(job.postedAt);
    if (posted) tags.push(posted);
    (job.tags || []).slice(0, 5).forEach(function (t) { tags.push(t); });

    var hue = 0;
    for (var i = 0; i < job.company.length; i++) hue = (hue * 31 + job.company.charCodeAt(i)) % 360;
    var avatar = h('div', { class: 'avatar-co', 'aria-hidden': 'true', text: (job.company || '?').charAt(0).toUpperCase() });
    avatar.setAttribute('style', 'background:hsl(' + hue + ' 80% 93%);color:hsl(' + hue + ' 55% 32%)');

    var kids = [
      h('div', { class: 'job-head' }, [
        h('div', { class: 'job-lead' }, [avatar, h('div', {}, [h('h3', { text: job.title }), h('div', { class: 'meta', text: meta })])]),
        badge
      ])
    ];
    if (job.summary) kids.push(h('p', { text: job.summary }));
    kids.push(h('div', { class: 'job-tags' }, tags.map(function (t) {
      return h('span', { class: 'tag' + (job.salary && t === job.salary ? ' tag-salary' : ''), text: t });
    })));
    if (job.missingKeywords && job.missingKeywords.length) {
      kids.push(h('p', { class: 'small', text: 'Missing from your resume: ' + job.missingKeywords.join(', ') }));
    }

    var view = h('a', { class: 'btn btn-ink btn-sm', href: job.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: 'View & apply' });
    var actions = [view];
    var article = h('article', { class: 'job' }, kids);
    if (opts.onScore) {
      var scoreBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Score my resume' });
      scoreBtn.addEventListener('click', function () { opts.onScore(job, article, scoreBtn); });
      actions.push(scoreBtn);
    }
    kids.push(h('div', { class: 'job-actions' }, actions));

    var src = h('div', { class: 'job-source' });
    src.appendChild(document.createTextNode('via '));
    var link = h('a', { href: job.url, target: '_blank', rel: 'noopener noreferrer nofollow' });
    link.textContent = job.sourceName;
    src.appendChild(link);
    article.appendChild(src);
    return article;
  }

  function skeletons(count) {
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(h('div', { class: 'skeleton-card', 'aria-hidden': 'true' }, [
        h('div', { class: 'skeleton', style: 'width:70%' }),
        h('div', { class: 'skeleton', style: 'width:40%' }),
        h('div', { class: 'skeleton', style: 'width:90%' })
      ]));
    }
    return out;
  }

  window.RR.jobs = { card: card, skeletons: skeletons, relativeTime: relativeTime, tone: tone, h: h };
})();
