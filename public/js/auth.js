/* Sign-in / create-account form. Credentials go to our own API over HTTPS;
   the server replies by setting an httpOnly session cookie. */
(function () {
  'use strict';

  var cfg = (window.RR && window.RR.config) || {};
  var $ = function (id) { return document.getElementById(id); };
  var alertBox = $('authAlert');
  var form = $('emailForm');
  var submit = $('btnSubmit');
  var signUp = false;

  function show(text, ok) {
    alertBox.hidden = false;
    alertBox.className = 'alert ' + (ok ? 'alert-success' : 'alert-error');
    alertBox.textContent = text;
  }

  if (!cfg.authEnabled) {
    alertBox.hidden = false;
    alertBox.className = 'alert alert-info';
    alertBox.textContent = 'Accounts are not available on this server yet. You can still use the resume checker without one.';
    Array.prototype.forEach.call(document.querySelectorAll('[data-auth-control]'), function (el) { el.disabled = true; });
    return;
  }

  function setMode(isUp) {
    signUp = isUp;
    $('modeSignIn').setAttribute('aria-pressed', String(!isUp));
    $('modeSignUp').setAttribute('aria-pressed', String(isUp));
    $('nameField').hidden = !isUp;
    $('passwordHint').hidden = !isUp;
    submit.textContent = isUp ? 'Create account' : 'Sign in';
    $('password').setAttribute('autocomplete', isUp ? 'new-password' : 'current-password');
    alertBox.hidden = true;
  }
  $('modeSignIn').addEventListener('click', function () { setMode(false); });
  $('modeSignUp').addEventListener('click', function () { setMode(true); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('email').value.trim();
    var password = $('password').value;
    if (!email || !password) return show('Enter your email and password.');
    if (signUp && password.length < 8) return show('Use a password of at least 8 characters.');

    submit.disabled = true;
    var label = submit.textContent;
    submit.textContent = signUp ? 'Creating account…' : 'Signing in…';

    fetch(signUp ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password, name: $('fullName').value.trim() })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || !body.success) throw new Error(body.error || 'Something went wrong. Please try again.');
        show('Signed in. Redirecting…', true);
        window.location.replace('/');
      });
    }).catch(function (err) {
      show(err.message);
      submit.disabled = false;
      submit.textContent = label;
    });
  });
})();
