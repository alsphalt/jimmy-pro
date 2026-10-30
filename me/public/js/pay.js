/* Public payment page: the person being prompted opens this link. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const ref = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const state = { payment: null, timer: null, attempts: 0 };

  const kes = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

  function show(id) {
    ['payRequest', 'payWaiting', 'payDone', 'payClosed'].forEach((key) => {
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
    $('#demoBanner').hidden = data.mode !== 'demo';

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

  async function pay(event) {
    event.preventDefault();
    error('');
    const phone = $('#pPhone').value.trim();
    if (!phone) return error('Enter your M-Pesa number.');

    const btn = $('#payBtn');
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
      $('#waitText').textContent = data.demo
        ? 'Demo mode: this resolves automatically in a few seconds.'
        : data.message || 'Enter your M-Pesa PIN on the prompt to approve.';
      startPolling();
    } catch (err) {
      error(err.message);
      show('payRequest');
    } finally {
      setBusy(btn, false);
    }
  }

  function retry() {
    show('payRequest');
    error('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#payForm').addEventListener('submit', pay);
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
