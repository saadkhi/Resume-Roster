/* Shared page chrome: config, mobile menu, sign-out. */
(function () {
  'use strict';

  var cfg = {};
  try {
    cfg = JSON.parse(document.getElementById('rr-config').textContent) || {};
  } catch (e) { /* config is optional */ }
  window.RR = { config: cfg };

  var btnMenu = document.getElementById('btnMenu');
  var nav = document.getElementById('siteNav');
  if (btnMenu && nav) {
    btnMenu.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      btnMenu.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) {
        nav.classList.remove('open');
        btnMenu.setAttribute('aria-expanded', 'false');
        btnMenu.focus();
      }
    });
  }

  var btnSignOut = document.getElementById('btnSignOut');
  if (btnSignOut) {
    btnSignOut.addEventListener('click', function () {
      btnSignOut.disabled = true;
      fetch('/api/auth/signout', { method: 'POST' })
        .catch(function () { /* cookie may already be gone */ })
        .then(function () {
          try {
            Object.keys(localStorage).forEach(function (k) {
              if (k.indexOf('sb-') === 0) localStorage.removeItem(k);
            });
          } catch (e) { /* storage unavailable */ }
          window.location.href = '/';
        });
    });
  }
})();
