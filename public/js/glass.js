/* Liquid-glass enhancement (liquidGL: WebGPU/WebGL refraction).
   Progressive enhancement: every glass surface already has a CSS backdrop-blur
   look, and this script only upgrades it when the device can handle it. */
(function () {
  'use strict';

  var cfg = (window.RR && window.RR.config) || {};
  var root = document.documentElement;
  var KEY = 'rr_glass';

  function stored() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function store(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* storage unavailable */ }
  }

  // ?glass=off / ?glass=on lets users (and support) flip the preference from a link.
  var qp = new URLSearchParams(window.location.search).get('glass');
  if (qp === 'on' || qp === 'off') store(qp);
  var userWants = stored() !== 'off';

  // Footer toggle.
  var btn = document.getElementById('btnGlass');
  if (btn) {
    btn.textContent = 'Glass effect: ' + (userWants ? 'on' : 'off');
    btn.addEventListener('click', function () {
      store(userWants ? 'off' : 'on');
      window.location.reload();
    });
  }

  function deviceCanHandleIt() {
    var mq = function (q) { return window.matchMedia && window.matchMedia(q).matches; };
    if (mq('(prefers-reduced-motion: reduce)') || mq('(prefers-reduced-transparency: reduce)')) return false;
    var c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return false;
    if (navigator.deviceMemory && navigator.deviceMemory <= 2) return false;
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) return false;
    return true;
  }

  if (!userWants || !deviceCanHandleIt() || !cfg.glassUrl) {
    root.classList.add('no-glass');
    return;
  }

  var lenses = [];
  var factory = null;
  var phone = window.matchMedia('(max-width: 760px)');
  var dark = window.matchMedia('(prefers-color-scheme: dark)');

  function visible(selector) {
    var el = document.querySelector(selector);
    return !!(el && el.getClientRects().length);
  }

  function destroyAll() {
    lenses.forEach(function (l) { try { l.destroy(); } catch (e) { /* already gone */ } });
    lenses = [];
    root.classList.remove('glass-on');
  }

  function build() {
    if (!factory) return;
    destroyAll();
    var base = {
      snapshot: 'body',
      zIndex: 60, // all lenses must share one z-index (shared canvas)
      resolution: phone.matches ? 1 : 1.5,
      reveal: 'none',
      tilt: false,
      specular: true,
      engine: 'auto'
    };
    var headerTint = dark.matches ? 'rgba(14, 11, 22, 0.55)' : 'rgba(246, 243, 255, 0.58)';
    // The sticky header keeps the CSS frosted-glass look: a full-width lens there refracts stale text on scroll.
    var jobs = [
      ['.live-bar', { refraction: 0.012, bevelDepth: 0.09, bevelWidth: 0.16, frost: 6, shadow: true, tint: headerTint }]
    ];
    if (phone.matches) {
      jobs.push(['.tabbar', { refraction: 0.016, bevelDepth: 0.12, bevelWidth: 0.2, frost: 4, shadow: true, tint: 'rgba(10, 8, 18, 0.66)' }]);
    }
    jobs.forEach(function (job) {
      if (!visible(job[0])) return;
      try {
        var lens = factory(Object.assign({}, base, job[1], { target: job[0] }));
        if (lens) lenses.push(lens);
      } catch (e) {
        if (window.console) console.warn('Glass effect skipped for', job[0], e && e.message);
      }
    });
    if (lenses.length) {
      root.classList.add('glass-on');
      // Parts of the page that change after load must be re-sampled by the lens.
      if (typeof factory.registerDynamic === 'function') {
        try { factory.registerDynamic('#liveList, #resultsWrap, #emptyState, #sourceChips, #applyResult'); } catch (e) { /* optional */ }
      }
    }
  }

  function start() {
    import(cfg.glassUrl).then(function (mod) {
      factory = mod.default || window.liquidGL;
      if (typeof factory !== 'function') throw new Error('liquidGL did not load');
      build();
      var timer = null;
      var rebuild = function () { clearTimeout(timer); timer = setTimeout(build, 300); };
      // The page height changes when jobs/results render, so take a fresh snapshot.
      window.addEventListener('rr:content', rebuild);
      if (phone.addEventListener) {
        phone.addEventListener('change', rebuild);
        dark.addEventListener('change', rebuild);
      }
    }).catch(function (err) {
      root.classList.add('no-glass');
      if (window.console) console.warn('Glass effect unavailable:', err && err.message);
    });
  }

  // Load after the page is interactive so it never delays first paint.
  function whenIdle() {
    if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 2500 });
    else window.setTimeout(start, 600);
  }
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle);
})();
