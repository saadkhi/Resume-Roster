/* Sign-in page and OAuth callback. Identity is always verified server-side:
   we hand the Supabase access token to /api/auth/session, which verifies it
   and sets an httpOnly session cookie. */
(function () {
  'use strict';

  var cfg = (window.RR && window.RR.config) || {};
  var page = document.body.getAttribute('data-page');
  var client = null;

  if (cfg.authEnabled && cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
    try {
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { detectSessionInUrl: true, flowType: 'pkce' }
      });
    } catch (e) {
      client = null;
    }
  }

  function exchange(session) {
    return fetch('/api/auth/session', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.access_token }
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body.success) throw new Error(body.error || 'Sign-in failed.');
        return body;
      });
    }).then(function (body) {
      // The server session is all we need; do not leave tokens in localStorage.
      return client.auth.signOut({ scope: 'local' }).catch(function () {}).then(function () { return body; });
    });
  }

  /* ── OAuth callback ───────────────────────────────────────────────── */
  if (page === 'auth-callback') {
    var msg = document.getElementById('callbackMessage');
    var fail = function (text) {
      document.getElementById('callbackSpinner').hidden = true;
      msg.textContent = text;
      var back = document.getElementById('callbackBack');
      if (back) back.hidden = false;
    };
    if (!client) return fail('Sign-in is not available right now.');
    client.auth.getSession().then(function (r) {
      if (!r.data.session) throw new Error('No sign-in session was found. Please try again.');
      return exchange(r.data.session);
    }).then(function () {
      window.location.replace('/');
    }).catch(function (err) {
      fail(err.message || 'Sign-in failed.');
    });
    return;
  }

  /* ── Sign-in page ─────────────────────────────────────────────────── */
  var alertBox = document.getElementById('authAlert');
  var form = document.getElementById('emailForm');
  var submit = document.getElementById('btnSubmit');
  var nameField = document.getElementById('nameField');
  var tabIn = document.getElementById('modeSignIn');
  var tabUp = document.getElementById('modeSignUp');
  var signUp = false;

  function show(text, ok) {
    alertBox.hidden = false;
    alertBox.className = 'alert ' + (ok ? 'alert-success' : 'alert-error');
    alertBox.textContent = text;
  }

  if (!client) {
    show('Sign-in is not configured on this server. You can still use the resume checker without an account.', false);
    alertBox.className = 'alert alert-info';
    Array.prototype.forEach.call(document.querySelectorAll('[data-auth-control]'), function (el) { el.disabled = true; });
    return;
  }

  function setMode(isUp) {
    signUp = isUp;
    tabIn.setAttribute('aria-pressed', String(!isUp));
    tabUp.setAttribute('aria-pressed', String(isUp));
    nameField.hidden = !isUp;
    submit.textContent = isUp ? 'Create account' : 'Sign in';
    document.getElementById('password').setAttribute('autocomplete', isUp ? 'new-password' : 'current-password');
    alertBox.hidden = true;
  }
  tabIn.addEventListener('click', function () { setMode(false); });
  tabUp.addEventListener('click', function () { setMode(true); });

  Array.prototype.forEach.call(document.querySelectorAll('[data-provider]'), function (btn) {
    btn.addEventListener('click', function () {
      client.auth.signInWithOAuth({
        provider: btn.getAttribute('data-provider'),
        options: { redirectTo: window.location.origin + '/auth/callback' }
      }).then(function (r) {
        if (r.error) show(r.error.message || 'Could not start sign-in.');
      });
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;
    var name = document.getElementById('fullName').value.trim();
    if (!email || !password) return show('Enter your email and password.');
    if (signUp && password.length < 8) return show('Use a password of at least 8 characters.');

    submit.disabled = true;
    var original = submit.textContent;
    submit.textContent = signUp ? 'Creating account…' : 'Signing in…';

    var request = signUp
      ? client.auth.signUp({ email: email, password: password, options: { data: { full_name: name || email.split('@')[0] } } })
      : client.auth.signInWithPassword({ email: email, password: password });

    request.then(function (r) {
      if (r.error) throw r.error;
      if (!r.data.session) {
        show('Check your email to confirm your account, then sign in.', true);
        return null;
      }
      return exchange(r.data.session).then(function () {
        show('Signed in. Redirecting…', true);
        window.location.replace('/');
      });
    }).catch(function (err) {
      show(err.message || 'Authentication failed.');
    }).then(function () {
      submit.disabled = false;
      submit.textContent = original;
    });
  });
})();
