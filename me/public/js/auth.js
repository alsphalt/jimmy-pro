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

  function fail(message, { focus } = {}) {
    const box = $('#gateError');
    box.textContent = message;
    box.hidden = false;
    /* On a phone the card is taller than the screen, so an error rendered at the
       top was simply never seen - it looked like the button did nothing. */
    /* Not every webview implements this; failing here would swallow the error we
       are trying to show. */
    if (typeof box.scrollIntoView === 'function') {
      try {
        box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (_) {
        /* ignore */
      }
    }
    if (focus) {
      const el = document.getElementById(focus);
      if (el) el.focus({ preventScroll: false });
    }
  }

  function clearFieldErrors(form) {
    [...form.querySelectorAll('.field-error')].forEach((el) => el.remove());
    [...form.querySelectorAll('.is-invalid')].forEach((el) => el.classList.remove('is-invalid'));
  }

  /** Marks the field and returns the message, so the caller can also banner it. */
  function fieldError(input, message) {
    if (!input) return message;
    input.classList.add('is-invalid');
    const hint = document.createElement('small');
    hint.className = 'field-error';
    hint.textContent = message;
    input.parentElement.appendChild(hint);
    return message;
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
      err.needsLogin = res.status === 401 && data.loginRequired === true;
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
    if (!u.profileComplete) {
      show('gateProfile');
      restoreProfile();
      return;
    }
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

  function validateProfile() {
    const name = $('#pName');
    const phone = $('#pPhone');
    const biz = $('#pBiz');
    if (!name.value.trim()) return { message: fieldError(name, 'Enter your name.'), focus: 'pName' };
    const digits = phone.value.replace(/\D/g, '');
    const normalised = digits.startsWith('254')
      ? digits
      : digits.startsWith('0')
        ? `254${digits.slice(1)}`
        : digits.length === 9
          ? `254${digits}`
          : digits;
    if (!/^254[17]\d{8}$/.test(normalised)) {
      return { message: fieldError(phone, 'Enter a Safaricom number, e.g. 0712 345 678.'), focus: 'pPhone' };
    }
    if (!biz.value.trim()) return { message: fieldError(biz, 'Enter your business name.'), focus: 'pBiz' };
    return null;
  }

  async function saveProfile(event) {
    event.preventDefault();
    const form = $('#gateProfile');
    const btn = $('#profileBtn');
    if (btn.disabled) return; /* double tap on a slow phone */
    clearFieldErrors(form);
    const invalid = validateProfile();
    if (invalid) return fail(invalid.message, { focus: invalid.focus });
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
      /* A session that cannot be found (expired, or a different server instance
         without the shared store) must not leave the user stuck on a form that
         answers 401 forever. Keep their input and send them to sign in. */
      if (err.needsLogin) {
        state.pendingProfile = {
          name: $('#pName').value,
          phone: $('#pPhone').value,
          business: {
            name: $('#pBiz').value,
            town: $('#pTown').value,
            category: $('#pCat').value,
          },
        };
        state.me = null;
        show('gateLogin');
        fail('Your session ended. Sign in again — your details are still here.');
        return;
      }
      fail(err.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function restoreProfile() {
    const p = state.pendingProfile;
    if (!p) return;
    $('#pName').value = p.name || '';
    $('#pPhone').value = p.phone || '';
    $('#pBiz').value = p.business?.name || '';
    $('#pTown').value = p.business?.town || '';
    $('#pCat').value = p.business?.category || '';
    delete state.pendingProfile;
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
      const kycForm = $('#kycForm');
      if (kycForm) kycForm.hidden = !res.kyc;
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

  /** The one real ownership check Daraja offers for personal accounts. */
  async function runKyc(event) {
    event.preventDefault();
    const btn = $('#kycBtn');
    if (btn.disabled) return;
    setBusy(btn, true);
    try {
      const res = await api('/api/auth/verification/kyc', {
        method: 'POST',
        body: { idType: $('#kycType').value.trim(), idNumber: $('#kycNumber').value.trim() },
      });
      const box = $('#verifyBody');
      box.innerHTML =
        '<p class="gate-ok">Verified with Safaricom.</p>' +
        `<p class="muted">Checked ${esc(new Date(res.verification.checkedAt).toLocaleString())}.</p>`;
      $('#kycForm').hidden = true;
      fail('');
      $('#gateError').hidden = true;
    } catch (err) {
      /* Show exactly what the provider said; do not soften a failure. */
      fail(err.message);
    } finally {
      setBusy(btn, false);
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
    $('#kycForm').addEventListener('submit', runKyc);
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
