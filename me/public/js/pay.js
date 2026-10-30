/* Public payment page: the person being prompted opens this link. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const ref = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const state = { payment: null, timer: null, attempts: 0, msisdn: null };

  const kes = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

  /* Same rules as the server: 254 + 9 digits, 07xx or 01xx series. */
  function normalizePhone(input) {
    let digits = String(input).replace(/\D/g, '');
    if (digits.startsWith('254')) {
      /* already international */
    } else if (digits.startsWith('0') && digits.length === 10) {
      digits = '254' + digits.slice(1);
    } else if (digits.length === 9) {
      digits = '254' + digits;
    }
    return /^254[17]\d{8}$/.test(digits) ? digits : null;
  }

  function prettyPhone(msisdn) {
    const local = '0' + msisdn.slice(3);
    return local.slice(0, 4) + ' ' + local.slice(4, 7) + ' ' + local.slice(7);
  }

  function show(id) {
    ['payRequest', 'payConfirm', 'payWaiting', 'payDone', 'payClosed'].forEach((key) => {
      const el = document.getElementById(key);
      if (el) el.hidden = key !== id;
    });
  }

  function setBusy(btn, busy) {
    const label = btn.querySelector('.btn-label');
    const spinner = btn.querySelector('.spinner');
    btn.disabled = busy;
    if (label) label.style.opacity = busy ? '0.6' : '1';
    if (spinner) spinner.hidden = !busy;
  }

  function error(message) {
    const box = $('#payError');
    box.textContent = message;
    box.hidden = !message;
  }

  async function load() {
    const res = await fetch(`/api/public/pay/${encodeURIComponent(ref)}`, { cache: 'no-store' });
    if (!res.ok) {
      $('#payLoading').hidden = true;
      $('#payBody').hidden = false;
      $('#payRequest').hidden = true;
      $('#payClosed').hidden = false;
      $('#closedTitle').textContent = 'Link not found';
      $('#closedText').textContent = 'This payment link is not valid or has been removed.';
      return;
    }
    const data = await res.json();
    state.payment = data;

    $('#payLoading').hidden = true;
    $('#payBody').hidden = false;

    $('#pBusiness').textContent = data.businessName || 'Jimmy Pro';
    $('#pAmount').textContent = kes(data.amount);
    $('#waitAmount').textContent = kes(data.amount);
    $('#pDesc').textContent = data.description || 'Payment request';
    $('#pRef').textContent = data.ref;

    if (data.status === 'success') {
      renderSuccess(data);
    } else if (data.status === 'pending' && !data.expired) {
      show('payRequest');
      startPolling();
    } else {
      show('payClosed');
      $('#closedTitle').textContent = data.expired ? 'Request expired' : `Request ${data.status}`;
      $('#closedText').textContent = data.expired
        ? 'This payment link is older than 30 minutes. Ask for a new one.'
        : 'This payment request is no longer active.';
    }
  }

  function renderSuccess(data) {
    $('#rReceipt').textContent = data.mpesaReceipt || '—';
    $('#rAmount').textContent = kes(data.amount);
    $('#rRef').textContent = data.ref;
    show('payDone');
    $('#payDone').querySelector('.pulse-ring').className = 'pulse-ring success';
  }

  function startPolling() {
    if (state.timer) return;
    state.timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/pay/${encodeURIComponent(ref)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'success') {
          clearInterval(state.timer);
          state.timer = null;
          renderSuccess(data);
        } else if (data.status !== 'pending') {
          clearInterval(state.timer);
          state.timer = null;
          show('payClosed');
          $('#closedTitle').textContent = data.status === 'cancelled' ? 'Payment cancelled' : 'Payment did not go through';
          $('#closedText').textContent =
            data.status === 'timeout'
              ? 'The prompt timed out. You can ask for a new link.'
              : 'You can try again with a new request.';
        }
      } catch (_) {
        /* keep polling */
      }
    }, 3000);
  }

  /* Step 1: validate locally and show what is about to happen. No request is
     made here, so a mistyped number costs nothing and nobody gets prompted by
     accident. */
  function review(event) {
    if (event) event.preventDefault();
    error('');

    const msisdn = normalizePhone($('#pPhone').value);
    if (!msisdn) {
      return error('Enter a valid Safaricom number, e.g. 0712 345 678.');
    }

    state.msisdn = msisdn;
    $('#cAmount').textContent = kes(state.payment?.amount);
    $('#cBusiness').textContent = state.payment?.businessName || 'Jimmy Pro';
    $('#cRef').textContent = state.payment?.ref || ref;
    $('#cPhone').textContent = prettyPhone(msisdn);
    show('payConfirm');
  }

  /* Step 2: the payer has confirmed the details, so the prompt can go out. */
  async function pay() {
    error('');
    const phone = state.msisdn;
    if (!phone) return review();

    const btn = $('#confirmBtn');
    setBusy(btn, true);
    try {
      const res = await fetch(`/api/public/pay/${encodeURIComponent(ref)}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the prompt.');

      state.attempts += 1;
      show('payWaiting');
      $('#waitTitle').textContent = 'Check your phone';
      $('#waitText').textContent =
        data.message || 'Enter your M-Pesa PIN on the prompt to approve.';
      startPolling();
    } catch (err) {
      error(err.message);
      show('payConfirm');
    } finally {
      setBusy(btn, false);
    }
  }

  function retry() {
    show('payRequest');
    error('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#payForm').addEventListener('submit', review);
    $('#confirmBtn').addEventListener('click', pay);
    $('#changeBtn').addEventListener('click', () => {
      show('payRequest');
      error('');
      $('#pPhone').focus();
    });
    $('#payRetryBtn').addEventListener('click', retry);
    $('#payRetryBtn').hidden = false;
    load().catch(() => {
      $('#payLoading').hidden = true;
      $('#payBody').hidden = false;
      show('payClosed');
      $('#closedTitle').textContent = 'Could not load';
      $('#closedText').textContent = 'Check your connection and reload the page.';
    });
  });
})();
