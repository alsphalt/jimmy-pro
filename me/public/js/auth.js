/* Sign-in gate, onboarding and PIN setup for the owner console. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const state = { me: null, needsPin: false, pin: null, step: 'login', types: [] };

  function show(step) {
    state.step = step;
    ['gateLogin', 'gateRegister', 'gateProfile', 'gateAccount', 'gateVerify', 'gatePin', 'gateCodes'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== step;
    });
    const box = $('#gateError');
    if (box) {
      box.hidden = true;
      box.textContent = '';
    }
  }

  function fail(message) {
    const box = $('#gateError');
    box.textContent = message;
    box.hidden = false;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    const label = btn.querySelector('.btn-label');
    const spinner = btn.querySelector('.spinner');
    btn.disabled = busy;
    if (label) label.style.opacity = busy ? '0.6' : '1';
    if (spinner) spinner.hidden = !busy;
  }

  function open() {
    $('#gate').hidden = false;
    document.body.classList.add('gate-open');
  }

  function close() {
    $('#gate').hidden = true;
    document.body.classList.remove('gate-open');
  }

  /** Where in onboarding does this user belong? */
  function resume() {
    const u = state.me?.user;
    if (!u) return show('login');
    if (!u.profileComplete) return show('gateProfile');
    if (!u.account?.number) return show('gateAccount');
    if (!u.pinSet) return show('gatePin');
    return close();
  }

  /* ------------------------------------------------------------- login/reg */

  async function login(event) {
    event.preventDefault();
    const btn = $('#loginBtn');
    setBusy(btn, true);
    try {
      const body = { email: $('#loginEmail').value, password: $('#loginPassword').value };
      if (state.needsPin) body.pin = $('#loginPin').value;
      state.me = await api('/api/auth/login', { method: 'POST', body });
      resume();
    } catch (err) {
      if (err.data?.needsPin) {
        state.needsPin = true;
        $('#pinRow').hidden = false;
        $('#loginPin').focus();
        fail('This is a new device — enter your security PIN to continue.');
      } else {
        fail(err.message);
      }
    } finally {
      setBusy(btn, false);
    }
  }

  async function register(event) {
    event.preventDefault();
    const btn = $('#registerBtn');
    setBusy(btn, true);
    try {
      state.me = await api('/api/auth/register', {
        method: 'POST',
        body: { email: $('#regEmail').value, password: $('#regPassword').value },
      });
      resume();
    } catch (err) {
      fail(err.message);
    } finally {
      setBusy(btn, false);
    }
  }

  /* ------------------------------------------------------------- onboarding */

  async function saveProfile(event) {
    event.preventDefault();
    const btn = $('#profileBtn');
    setBusy(btn, true);
    try {
      state.me = await api('/api/auth/profile', {
        method: 'PUT',
        body: {
          name: $('#pName').value,
          phone: $('#pPhone').value,
          business: { name: $('#pBiz').value, town: $('#pTown').value, category: $('#pCat').value },
        },
      });
      resume();
    } catch (err) {
      fail(err.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function renderAccountTypes() {
    const list = $('#typeList');
    list.innerHTML = '';
    state.types.forEach((type) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'type-card';
      card.dataset.id = type.id;
      card.innerHTML =
        `<strong>${type.label}</strong>` +
        `<span>${type.sevenDigitCode ? 'Code verification available' : 'No code verification from the provider'}</span>`;
      card.addEventListener('click', () => {
        [...list.querySelectorAll('.type-card')].forEach((c) => c.classList.toggle('is-active', c === card));
        $('#typeNote').textContent = type.note;
        $('#typeNote').hidden = false;
      });
      list.appendChild(card);
    });
  }

  async function saveAccount(event) {
    event.preventDefault();
    const chosen = $('#typeList .type-card.is-active');
    if (!chosen) return fail('Choose the type of account you receive money on.');
    const btn = $('#accountBtn');
    setBusy(btn, true);
    try {
      state.me = await api('/api/auth/account', {
        method: 'PUT',
        body: { type: chosen.dataset.id, number: $('#acctNumber').value },
      });
      startVerification();
    } catch (err) {
      fail(err.message);
    } finally {
      setBusy(btn, false);
    }
  }

  /** Ask the server what it can actually do. It is allowed to say "no". */
  async function startVerification() {
    const box = $('#verifyBody');
    box.textContent = 'Checking what the provider supports…';
    show('gateVerify');
    try {
      const res = await api('/api/auth/verification/start', { method: 'POST' });
      if (res.sevenDigitCodeSupported) {
        box.textContent = 'A verification code was sent. Enter it to continue.';
      } else {
        box.innerHTML =
          '<p class="gate-warn">No verification code was sent.</p>' +
          `<p>${esc(res.reason || 'The payment provider does not offer code verification for this account type.')}</p>` +
          '<p class="muted">What we can verify instead:</p>' +
          '<ul>' +
          (res.nextSteps || []).map((s) => `<li>${esc(s)}</li>`).join('') +
          '</ul>';
      }
    } catch (err) {
      box.textContent = err.message;
    }
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  /* -------------------------------------------------------------------- PIN */

  async function savePin(event) {
    event.preventDefault();
    const pin = $('#pin1').value;
    if (pin !== $('#pin2').value) return fail('The two PINs do not match.');
    const btn = $('#pinBtn');
    setBusy(btn, true);
    try {
      const res = await api('/api/auth/pin', { method: 'POST', body: { pin } });
      state.pin = pin;
      const list = $('#codeList');
      list.innerHTML = (res.recoveryCodes || []).map((c) => `<li><code>${esc(c)}</code></li>`).join('');
      show('gateCodes');
    } catch (err) {
      fail(err.message);
    } finally {
      setBusy(btn, false);
    }
  }

  /* ------------------------------------------------------------------- boot */

  function wire() {
    $('#gateLogin').addEventListener('submit', login);
    $('#gateRegister').addEventListener('submit', register);
    $('#toRegister').addEventListener('click', (e) => {
      e.preventDefault();
      show('gateRegister');
    });
    $('#toLogin').addEventListener('click', (e) => {
      e.preventDefault();
      show('gateLogin');
    });
    $('#gateProfile').addEventListener('submit', saveProfile);
    $('#gateAccount').addEventListener('submit', saveAccount);
    $('#verifyContinue').addEventListener('click', () => show('gatePin'));
    $('#gatePin').addEventListener('submit', savePin);
    $('#codesDone').addEventListener('click', () => location.reload());
  }

  /** true = signed in and onboarded, false = the gate took over. */
  async function ensure() {
    wire();
    let config = { hasAccounts: true, accountTypes: [] };
    try {
      config = await api('/api/auth/config');
    } catch (_) {
      /* offline: fall through to the login screen */
    }
    state.types = config.accountTypes || [];
    renderAccountTypes();

    try {
      state.me = await api('/api/auth/me');
    } catch (err) {
      open();
      if (!config.hasAccounts) {
        show('gateRegister');
        $('#gateTitle').textContent = 'Set up your business';
        $('#gateSub').textContent = 'Create the first account on this install.';
      } else {
        show('gateLogin');
      }
      return false;
    }

    const u = state.me.user;
    if (!u.profileComplete || !u.account?.number || !u.pinSet) {
      open();
      resume();
      return false;
    }
    close();
    return true;
  }

  window.JimmyAuth = { ensure, state };
})();
