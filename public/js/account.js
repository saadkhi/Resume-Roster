/* Account page: history and account deletion. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var list = $('histList');
  if (!list) return;

  function showError(text) { var e = $('histError'); e.textContent = text; e.hidden = false; }

  function load() {
    fetch('/api/history').then(function (res) {
      return res.json().then(function (b) {
        if (!res.ok || !b.success) throw new Error(b.error || 'Could not load your history.');
        return b;
      });
    }).then(function (data) {
      if (!data.items.length) {
        var p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'No evaluations yet. Check a resume and your scores will appear here.';
        list.appendChild(p);
        return;
      }
      data.items.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'stage-card';
        var left = document.createElement('div');
        var title = document.createElement('div');
        title.className = 'stage-title';
        title.textContent = item.target.length > 70 ? item.target.slice(0, 70) + '…' : item.target;
        var sub = document.createElement('div');
        sub.className = 'stage-sub';
        sub.textContent = item.rating + ' · ' + new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        left.appendChild(title);
        left.appendChild(sub);
        var score = document.createElement('div');
        score.className = 'stage-score';
        score.textContent = Math.round(item.score * 100) + '%';
        row.appendChild(left);
        row.appendChild(score);
        list.appendChild(row);
      });
    }).catch(function (err) { showError(err.message); });
  }

  $('btnSignOut2').addEventListener('click', function () {
    fetch('/api/auth/signout', { method: 'POST' }).catch(function () {}).then(function () { window.location.href = '/'; });
  });
  $('btnDeleteAccount').addEventListener('click', function () {
    if (!window.confirm('Delete your account and all saved evaluations? This cannot be undone.')) return;
    fetch('/api/history', { method: 'DELETE' }).then(function (res) {
      if (!res.ok) throw new Error('Could not delete your data. Please try again.');
      window.location.href = '/';
    }).catch(function (err) { showError(err.message); });
  });

  load();
})();
