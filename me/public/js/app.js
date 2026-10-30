/* Jimmy Pro — front-end controller */
(function () {
  'use strict';

  /* Selector-safe lookups: a "#/"-style hash is not a valid CSS selector, and
     any host script that reflects the URL into querySelector() would throw a
     SyntaxError on it. Plain "#id" selectors go through getElementById and
     everything else is guarded, so a bad selector can never crash the app. */
  const $ = (sel, root) => {
    if (typeof sel !== 'string' || !sel) return null;
    if (/^#[A-Za-z][\w-]*$/.test(sel)) return document.getElementById(sel.slice(1));
    try {
      return (root || document).querySelector(sel);
    } catch (_) {
      return null;
    }
  };
  const $$ = (sel, root) => {
    if (typeof sel !== 'string' || !sel) return [];
    try {
      return Array.from((root || document).querySelectorAll(sel));
    } catch (_) {
      return [];
    }
  };

  const state = {
    settings: null,
    stats: null,
    payments: [],
    filter: 'all',
    query: '',
    activePayment: null,
    pollTimer: null,
    pollStartedAt: 0,
    refreshTimer: null,
    installPrompt: null,
    b2b: [],
    kyc: [],
    endpoints: null,
    b2bPollTimer: null,
    showB2bResult: false,
    showKycResult: false,
  };

  const STATUS_LABEL = {
    success: 'Paid',
    pending: 'Pending',
    failed: 'Failed',
    cancelled: 'Cancelled',
    timeout: 'Timed out',
  };

  /* ------------------------------------------------------------- utilities */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const kes = (n) =>
    'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi',
    });
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi',
    });
  }

  function fullTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi',
    });
  }

  function adminPin() {
    return localStorage.getItem('jp_admin_pin') || '';
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const pin = adminPin();
    if (pin) headers['x-admin-pin'] = pin;

    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });

    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------------------------------------------------------------- toasts */

  function toast(message, kind) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind || 'success'}`;
    el.innerHTML = `<span class="bar"></span><span>${esc(message)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 220);
    }, 3600);
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(`${label || 'Copied'} to clipboard`, 'success');
    } catch (_) {
      toast('Could not copy. Long-press the text instead.', 'error');
    }
  }

  async function shareLink(url, title, text) {
    if (navigator.share) {
      try {
        await navigator.share({ title: title || 'Jimmy Pro payment', text: text || '', url });
        return;
      } catch (_) {
        /* user cancelled - fall through to copy */
      }
    }
    copyText(url, 'Payment link');
  }

  /* ----------------------------------------------------------------- router */

  const VIEWS = ['home', 'new', 'history', 'business', 'settings'];

  /* Routes are plain "#home" style fragments, never "#/home": "#/x" is not a
     valid CSS selector and host runtimes that mirror the hash into
     querySelector() throw "…'#/home' is not a valid selector". */
  function setView(name) {
    if (!VIEWS.includes(name)) name = 'home';
    VIEWS.forEach((v) => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.hidden = v !== name;
    });
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.goto === name));
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    if (name === 'history') loadPayments();
    if (name === 'business') {
      loadBusiness();
      loadEndpoints();
    }
    if (name === 'settings') {
      renderSettings();
      loadEndpoints();
    }
  }

  function currentView() {
    /* Accepts "#new", "#/new" (old links) and "" without ever building a
       selector out of the raw hash. */
    const raw = String(location.hash || '').replace(/^#\/?/, '').toLowerCase();
    return VIEWS.includes(raw) ? raw : 'home';
  }

  /* -------------------------------------------------------------- data load */

  async function loadSettings() {
    const s = await api('/api/settings');
    state.settings = s;
    renderMode();
    return s;
  }

  async function loadStats() {
    const s = await api('/api/stats');
    state.stats = s;
    renderStats();
  }

  async function loadPayments() {
    const params = new URLSearchParams();
    if (state.filter && state.filter !== 'all') params.set('status', state.filter);
    if (state.query) params.set('q', state.query);
    params.set('limit', '200');
    const data = await api(`/api/payments?${params.toString()}`);
    state.payments = data.payments;
    renderHistory();
    renderRecent();
  }

  async function refreshAll() {
    try {
      await Promise.all([loadStats(), loadPayments()]);
    } catch (_) {
      /* offline - keep what we have */
    }
  }

  function scheduleRefresh() {
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      refreshAll();
    }, 350);
  }

  /* --------------------------------------------------------------- render UI */

  function renderMode() {
    const s = state.settings;
    if (!s) return;
    const pill = $('#modePill');
    pill.textContent = s.live ? 'LIVE' : 'SETUP';
    pill.className = `mode-pill ${s.live ? 'live' : 'setup'}`;
    pill.title = s.live
      ? 'Connected to Safaricom - real prompts are sent'
      : 'Not configured - add your Daraja credentials';

    $('#brandSub').textContent =
      s.businessName && s.businessName !== 'Jimmy Pro' ? s.businessName : 'M-Pesa payments';

    const missing = Array.isArray(s.missing) && s.missing.length ? s.missing.join(', ') : 'credentials';
    $('#modeTitle').textContent = s.live ? 'Live mode' : 'Not configured';
    $('#modeText').textContent = s.live
      ? `Connected to Safaricom ${s.environment}. Prompts are sent to real phones and money moves.`
      : `Nothing can be charged until M-Pesa is configured. Missing: ${missing}.`;
    $('#modeDot').className = `dot-live ${s.live ? 'live' : ''}`;

    $('#promptFineprint').textContent = s.live
      ? `The payer receives an M-Pesa prompt from shortcode ${s.shortcode}. Money is settled instantly.`
      : 'M-Pesa is not configured. Add your Daraja credentials in Settings to send prompts.';

    $('#greeting').textContent = greetingText();
  }

  function greetingText() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function renderStats() {
    const s = state.stats;
    if (!s) return;
    $('#statCollected').textContent = kes(s.collected);
    $('#statSuccessRate').textContent = `${s.successRate}% success rate`;
    $('#statAverage').textContent = `avg ${kes(s.average)}`;
    $('#statToday').textContent = kes(s.todayCollected);
    $('#statTodayCount').textContent = `${s.todayCount} request${s.todayCount === 1 ? '' : 's'}`;
    $('#statPending').textContent = String(s.pendingCount);
    $('#statFailed').textContent = String(s.failedCount);
    drawSparkline(s.series || []);
  }

  function drawSparkline(series) {
    const svg = $('#sparkline');
    const w = 300;
    const h = 70;
    const pad = 6;
    const values = series.map((p) => Number(p.amount) || 0);
    const max = Math.max.apply(null, values.concat([1]));
    const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;

    if (!values.some((v) => v > 0)) {
      svg.innerHTML =
        '<line x1="6" y1="58" x2="294" y2="58" stroke="rgba(167,255,203,0.22)" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 7"/>';
      return;
    }

    const points = values.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - (v / max) * (h - pad * 2);
      return [x, y];
    });

    let line = '';
    points.forEach((p, i) => {
      if (i === 0) {
        line += `M ${p[0]} ${p[1]}`;
      } else {
        const prev = points[i - 1];
        const cx = (prev[0] + p[0]) / 2;
        line += ` C ${cx} ${prev[1]}, ${cx} ${p[1]}, ${p[0]} ${p[1]}`;
      }
    });

    const area = `${line} L ${pad + (values.length - 1) * step} ${h} L ${pad} ${h} Z`;

    svg.innerHTML = `
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#7df5b0" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#7df5b0" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#sparkFill)"/>
      <path d="${line}" fill="none" stroke="#a7ffcb" stroke-width="2.2" stroke-linecap="round"/>
    `;
  }

  function rowHtml(p) {
    const label = STATUS_LABEL[p.status] || p.status;
    const iconSvg = p.status === 'success'
      ? '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : p.status === 'pending'
        ? '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.9" stroke-dasharray="3 3"/><path d="M12 8v4l2.5 1.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    const sub = [p.phonePretty || p.phone, p.ref, p.mpesaReceipt]
      .filter(Boolean)
      .map(esc)
      .join(' · ');

    return `
      <button class="row" data-id="${esc(p.id)}">
        <span class="row-icon ${esc(p.status)}">${iconSvg}</span>
        <span class="row-main">
          <span class="row-title"><span class="row-name">${esc(p.accountReference || p.ref)}</span>
            <span class="status-pill ${esc(p.status)}">${esc(label)}</span>
          </span>
          <span class="row-sub">${sub}</span>
        </span>
        <span class="row-right">
          <span class="row-amount">${kes(p.amount)}</span>
          <span class="row-time">${esc(timeAgo(p.createdAt))}</span>
        </span>
      </button>`;
  }

  function renderRecent() {
    const list = $('#recentList');
    const rows = state.payments.slice(0, 5);
    if (!rows.length) {
      list.innerHTML = `
        <div class="empty">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16v10H4z" stroke="currentColor" stroke-width="1.6"/><path d="M4 10h16" stroke="currentColor" stroke-width="1.6"/></svg>
          <strong>No payments yet</strong>
          <p>Send your first prompt and it will show up here.</p>
        </div>`;
      return;
    }
    list.innerHTML = rows.map(rowHtml).join('');
  }

  function renderHistory() {
    const list = $('#historyList');
    if (!state.payments.length) {
      list.innerHTML = `
        <div class="empty">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v4l2.5 1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          <strong>Nothing here</strong>
          <p>${state.query || state.filter !== 'all' ? 'No requests match this filter.' : 'Requests you send will be listed here.'}</p>
        </div>`;
      return;
    }

    let html = '';
    let currentDay = '';
    for (const p of state.payments) {
      const day = dayLabel(p.createdAt);
      if (day !== currentDay) {
        currentDay = day;
        html += `<div class="date-head">${esc(day)}</div>`;
      }
      html += rowHtml(p);
    }
    list.innerHTML = html;
  }

  /* --------------------------------------------------------- detail sheet */

  function openSheet(payment) {
    state.activePayment = payment;
    const p = payment;
    $('#sheetRef').textContent = p.ref;
    $('#sheetTitle').textContent = p.accountReference || 'Payment request';
    $('#sheetAmount').textContent = kes(p.amount);
    const pill = $('#sheetStatus');
    pill.className = `status-pill ${p.status}`;
    pill.textContent = STATUS_LABEL[p.status] || p.status;

    const rows = [
      ['Phone', p.phonePretty || p.phone],
      ['Payer', p.payerPhonePretty || '—'],
      ['Description', p.description || '—'],
      ['Created', fullTime(p.createdAt)],
      ['Completed', p.completedAt ? fullTime(p.completedAt) : '—'],
      ['Receipt', p.mpesaReceipt || '—'],
      ['M-Pesa code', p.resultCode || '—'],
      ['Message', p.resultDesc || '—'],
    ];

    $('#sheetDetails').innerHTML = rows
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
      .join('');

    $('#sheetReceiptBtn').hidden = !p.mpesaReceipt;
    $('#sheetQueryBtn').hidden = p.status !== 'pending';

    $('#sheetBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    $('#sheetBackdrop').hidden = true;
    state.activePayment = null;
    document.body.style.overflow = '';
  }

  async function openById(id) {
    try {
      const { payment } = await api(`/api/payments/${id}`);
      openSheet(payment);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* -------------------------------------------------------- payment result */

  function showResult(payment) {
    state.activePayment = payment;
    const card = $('#resultCard');
    card.hidden = false;
    $('#linkResult').hidden = true;
    updateResultCard(payment);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    startPolling(payment);
  }

  function updateResultCard(p) {
    const ring = $('#resultRing');
    ring.className = `pulse-ring ${p.status}`;

    const titles = {
      success: 'Payment received',
      pending: 'Waiting for the customer',
      failed: 'Payment failed',
      cancelled: 'Payment cancelled',
      timeout: 'Request timed out',
    };

    $('#resultTitle').textContent = titles[p.status] || 'Payment';
    $('#resultSub').textContent =
      p.status === 'pending'
        ? 'Prompt sent. Ask them to enter their M-Pesa PIN.'
        : p.resultDesc || STATUS_LABEL[p.status];
    $('#resultAmount').textContent = kes(p.amount);
    $('#resultRef').textContent = p.ref;
    $('#resultPhone').textContent = p.payerPhonePretty || p.phonePretty || '—';
    $('#resultReceipt').textContent = p.mpesaReceipt || '—';
    $('#checkStatusBtn').disabled = p.status !== 'pending';
  }

  function startPolling(payment) {
    stopPolling();
    if (payment.status !== 'pending') return;
    state.pollStartedAt = Date.now();
    state.pollTimer = setInterval(async () => {
      if (!state.activePayment || state.activePayment.status !== 'pending') {
        stopPolling();
        return;
      }
      if (Date.now() - state.pollStartedAt > 5 * 60 * 1000) {
        stopPolling();
        return;
      }
      try {
        const { payment: fresh } = await api(`/api/payments/${state.activePayment.id}`);
        if (fresh.status !== 'pending') {
          state.activePayment = fresh;
          updateResultCard(fresh);
          stopPolling();
          scheduleRefresh();
          if (fresh.status === 'success') {
            toast(`Paid ${kes(fresh.amount)} · ${fresh.mpesaReceipt || ''}`, 'success');
          }
        }
      } catch (_) {
        /* transient - keep polling */
      }
    }, 3000);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /* -------------------------------------------------------------- settings */

  function renderSettings() {
    const s = state.settings;
    if (!s) return;

    $('#setShortcode').value = s.shortcode || '';
    $('#setTransactionType').value = s.transactionType || 'CustomerPayBillOnline';
    $('#setBusinessName').value = s.businessName || '';
    $('#setCallback').value = s.callbackUrl || s.callbackSuggestion || '';
    $('#setConsumerKey').value = s.hasConsumerKey ? '' : '';
    $('#setConsumerKey').placeholder = s.hasConsumerKey
      ? 'Saved — paste a new key to replace'
      : 'Paste consumer key';
    $('#setConsumerSecret').placeholder = s.hasConsumerSecret
      ? 'Saved — leave blank to keep'
      : 'Paste consumer secret';
    $('#setPasskey').placeholder = s.hasPasskey ? 'Saved — leave blank to keep' : 'Paste passkey';

    /* B2B + KYC settings */
    $('#setInitiator').value = s.initiatorName || '';
    $('#setSenderShortcode').value = s.senderShortcode || '';
    $('#setResultUrl').value = s.resultUrl || (s.callbackSuggestion || '').replace('/mpesa/callback', '/b2b/callback');
    $('#setTimeoutUrl').value = s.timeoutUrl || (s.callbackSuggestion || '').replace('/mpesa/callback', '/b2b/timeout');
    $('#setKycShortcode').value = s.kycShortcode || '';
    const cert = s.certificate || {};
    $('#certStatus').textContent = s.hasSecurityCredential
      ? cert.present
        ? `Security credential ready — certificate valid until ${cert.validTo}.`
        : 'Security credential supplied through the environment.'
      : 'Security credential not set. Add MPESA_INITIATOR_PASSWORD plus certs/safaricom.cer (or MPESA_SECURITY_CREDENTIAL) before using live B2B.';
    $$('#envToggle .seg').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.env === s.environment)
    );

    $('#adminPinField').hidden = !s.adminPinRequired;
    if (s.adminPinRequired && !adminPin()) $('#adminPinField').hidden = false;

    $('#callbackDisplay').value = s.callbackSuggestion || '';
    $('#sandboxKey').textContent = `${String(s.sandboxPasskeyHint).slice(0, 8)}…${String(s.sandboxPasskeyHint).slice(-5)}`;
    $('#versionLine').textContent = 'Jimmy Pro v1.1.0 · ' + (s.live ? 'live' : 'not configured');
  }

  function settingsPayload() {
    const payload = {
      environment: ($('#envToggle .seg.is-active') || {}).dataset
        ? $('#envToggle .seg.is-active').dataset.env
        : 'sandbox',
      shortcode: $('#setShortcode').value.trim(),
      transactionType: $('#setTransactionType').value,
      consumerKey: $('#setConsumerKey').value.trim(),
      consumerSecret: $('#setConsumerSecret').value.trim(),
      passkey: $('#setPasskey').value.trim(),
      callbackUrl: $('#setCallback').value.trim(),
      businessName: $('#setBusinessName').value.trim(),
      initiatorName: $('#setInitiator').value.trim(),
      senderShortcode: $('#setSenderShortcode').value.trim(),
      resultUrl: $('#setResultUrl').value.trim(),
      timeoutUrl: $('#setTimeoutUrl').value.trim(),
      kycShortcode: $('#setKycShortcode').value.trim(),
    };
    const pin = $('#setAdminPin').value.trim();
    if (pin) {
      localStorage.setItem('jp_admin_pin', pin);
      payload.adminPin = pin;
    }
    return payload;
  }

  /* ------------------------------------------------------------ form submit */

  async function submitPrompt(event) {
    event.preventDefault();
    const btn = $('#sendPromptBtn');
    const phone = $('#phone').value.trim();
    const amount = $('#amount').value.trim();

    if (!phone) return toast('Enter the phone number to prompt.', 'error');
    if (!amount || Number(amount) < 1) return toast('Enter an amount of at least KES 1.', 'error');

    setBusy(btn, true);
    try {
      const body = {
        phone,
        amount: Number(amount),
        accountReference: $('#reference').value.trim() || $('#description').value.trim() || 'Jimmy Pro',
        description: $('#description').value.trim() || 'Payment request',
      };
      const { payment } = await api('/api/payments', { method: 'POST', body });
      toast(`Prompt sent to ${payment.phonePretty || payment.phone}`, 'success');
      showResult(payment);
      scheduleRefresh();
      $('#promptForm').reset();
      $('#amount').value = '';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  }

  async function submitLink(event) {
    event.preventDefault();
    const btn = $('#createLinkBtn');
    const amount = $('#linkAmount').value.trim();
    if (!amount || Number(amount) < 1) return toast('Enter an amount of at least KES 1.', 'error');

    setBusy(btn, true);
    try {
      const { payment } = await api('/api/payments', {
        method: 'POST',
        body: {
          mode: 'link',
          amount: Number(amount),
          accountReference: $('#linkReference').value.trim() || 'Jimmy Pro',
          description: $('#linkDescription').value.trim() || 'Payment request',
        },
      });
      $('#linkResultUrl').value = payment.payUrl;
      $('#linkResultAmount').textContent = kes(payment.amount);
      $('#linkResult').dataset.id = payment.id;
      $('#linkResult').dataset.url = payment.payUrl;
      $('#linkResult').hidden = false;
      $('#resultCard').hidden = true;
      toast('Payment link created', 'success');
      $('#linkForm').reset();
      scheduleRefresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    const label = $('.btn-label', btn);
    const spinner = $('.spinner', btn);
    btn.disabled = busy;
    if (label) label.style.opacity = busy ? '0.6' : '1';
    if (spinner) spinner.hidden = !busy;
  }

  /* --------------------------------------------------------------- actions */

  async function queryPayment(id, silent) {
    try {
      const { payment, message } = await api(`/api/payments/${id}/query`, { method: 'POST' });
      if (!silent) {
        toast(
          payment.status === 'pending'
            ? message || 'Still waiting for the customer'
            : `${STATUS_LABEL[payment.status]} · ${payment.resultDesc || ''}`,
          payment.status === 'pending' ? 'info' : payment.status === 'success' ? 'success' : 'error'
        );
      }
      if (state.activePayment && state.activePayment.id === payment.id) {
        state.activePayment = payment;
        if (!$('#resultCard').hidden) updateResultCard(payment);
        if (!$('#sheetBackdrop').hidden) openSheet(payment);
      }
      scheduleRefresh();
      return payment;
    } catch (err) {
      if (!silent) toast(err.message, 'error');
      return null;
    }
  }

  async function retryPayment(id) {
    try {
      const { payment } = await api(`/api/payments/${id}/retry`, { method: 'POST' });
      toast(`New prompt sent · ${payment.ref}`, 'success');
      closeSheet();
      setView('home');
      await refreshAll();
      openSheet(payment);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deletePayment(id) {
    if (!confirm('Delete this payment record? This cannot be undone.')) return;
    try {
      await api(`/api/payments/${id}`, { method: 'DELETE' });
      toast('Payment deleted', 'success');
      closeSheet();
      refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }


  /* ------------------------------------------------------------ business API */

const B2B_STATUS = { success: 'Paid', pending: 'Pending', failed: 'Failed' };
const KYC_STATUS = { valid: 'Valid', invalid: 'Invalid', error: 'Error', pending: 'Pending' };

async function loadEndpoints() {
  try {
    state.endpoints = await api('/api/endpoints');
    renderEndpoints();
    applyEndpointDefaults();
  } catch (_) {
    /* the business screens still work without the catalogue */
  }
}

function renderEndpoints() {
  const list = $('#endpointList');
  if (!list) return;
  const data = state.endpoints;
  if (!data) {
    list.innerHTML = '<p class="muted small">Loading…</p>';
    return;
  }
  list.innerHTML = data.endpoints
    .map(
      (ep) => `
      <div class="endpoint-row">
        <span class="method">${esc(ep.method)}</span>
        <span class="ep-main">
          <span class="ep-label">${esc(ep.label)}</span>
          <span class="ep-url">${esc(ep.url)}</span>
        </span>
        <button class="btn btn-mini" data-copy="${esc(ep.url)}" type="button">Copy</button>
      </div>`
    )
    .join('');
}

function applyEndpointDefaults() {
  const d = state.endpoints && state.endpoints.defaults;
  if (!d) return;
  if (!$('#b2bPartyA').value && d.partyA) $('#b2bPartyA').placeholder = d.partyA;
  if (d.commandId) $('#b2bCommand').value = d.commandId;
  $('#b2bFineprint').textContent =
    'Money moves from your shortcode to the receiver. Safaricom posts the final result to your B2B result URL.';
  $('#kycFineprint').textContent =
    'The ID and MSISDN are checked against Safaricom records. Each check is billed.';
}

async function loadBusiness() {
  try {
    const [b2bData, kycData] = await Promise.all([
      api('/api/b2b/payments?limit=50'),
      api('/api/kyc/checks?limit=50'),
    ]);
    state.b2b = b2bData.payments || [];
    state.kyc = kycData.checks || [];
    renderB2bList();
    renderKycList();
  } catch (_) {
    /* keep whatever is already rendered */
  }
}

function renderB2bList() {
  const list = $('#b2bList');
  if (!list) return;
  if (!state.b2b.length) {
    list.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 8.5h16V19a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19V8.5z" stroke="currentColor" stroke-width="1.6"/><path d="M9 8.5V6a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 6v2.5" stroke="currentColor" stroke-width="1.6"/></svg>
        <strong>No B2B payments yet</strong>
        <p>Send one above and it will be listed here.</p>
      </div>`;
    return;
  }
  list.innerHTML = state.b2b
    .map(
      (p) => `
    <button class="row" data-b2b="${esc(p.id)}">
      <span class="row-icon ${esc(p.status)}">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 8.5h16V19a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19V8.5z" stroke="currentColor" stroke-width="1.7"/><path d="M4 13h16" stroke="currentColor" stroke-width="1.7"/></svg>
      </span>
      <span class="row-main">
        <span class="row-title"><span class="row-name">${esc(p.accountReference || p.ref)}</span>
          <span class="status-pill ${esc(p.status)}">${esc(B2B_STATUS[p.status] || p.status)}</span>
        </span>
        <span class="row-sub">To ${esc(p.partyB)} · ${esc(p.commandId)}</span>
      </span>
      <span class="row-right">
        <span class="row-amount">${kes(p.amount)}</span>
        <span class="row-time">${esc(timeAgo(p.createdAt))}</span>
      </span>
    </button>`
    )
    .join('');
}

function renderKycList() {
  const list = $('#kycList');
  if (!list) return;
  if (!state.kyc.length) {
    list.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" stroke="currentColor" stroke-width="1.6"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <strong>No KYC checks yet</strong>
        <p>Validate a customer ID and the result appears here.</p>
      </div>`;
    return;
  }
  list.innerHTML = state.kyc
    .map(
      (c) => `
    <button class="row" data-kyc="${esc(c.id)}">
      <span class="row-icon ${esc(c.status)}">
        <svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" stroke="currentColor" stroke-width="1.7"/></svg>
      </span>
      <span class="row-main">
        <span class="row-title"><span class="row-name">${esc(c.idNumberMasked || c.idNumber)}</span>
          <span class="status-pill ${esc(c.status)}">${esc(KYC_STATUS[c.status] || c.status)}</span>
        </span>
        <span class="row-sub">${esc(c.msisdn)} · ${esc(c.ref)}</span>
      </span>
      <span class="row-right">
        <span class="row-amount">${esc(c.mode || 'live')}</span>
        <span class="row-time">${esc(timeAgo(c.createdAt))}</span>
      </span>
    </button>`
    )
    .join('');
}

function showB2bResult(p) {
  state.showB2bResult = true;
  $('#b2bResult').hidden = false;
  $('#b2bResultTitle').textContent =
    p.status === 'success' ? 'B2B payment completed' : p.status === 'failed' ? 'B2B payment failed' : 'Request accepted';
  $('#b2bResultSub').textContent = p.resultDesc || 'Waiting for the M-Pesa result.';
  $('#b2bRing').className = `pulse-ring ${p.status === 'success' ? 'success' : p.status === 'pending' ? '' : 'failed'}`;
  $('#b2bResultAmount').textContent = kes(p.amount);
  $('#b2bResultRef').textContent = p.ref;
  $('#b2bResultParty').textContent = p.partyB;
  $('#b2bResultTxn').textContent = p.transactionId || '—';
  $('#b2bRaw').textContent = JSON.stringify({ conversationId: p.conversationId, resultCode: p.resultCode, resultDesc: p.resultDesc, raw: p.raw }, null, 2);
  $('#b2bCopyConvBtn').dataset.conv = p.conversationId || '';
  $('#b2bResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showKycResult(c) {
  state.showKycResult = true;
  $('#kycResult').hidden = false;
  $('#kycResultTitle').textContent =
    c.status === 'valid' ? 'ID verified' : c.status === 'invalid' ? 'Could not verify' : 'Check failed';
  $('#kycResultSub').textContent = c.description || '';
  $('#kycRing').className = `pulse-ring ${c.status === 'valid' ? 'success' : 'failed'}`;
  $('#kycResultRef').textContent = c.ref;
  $('#kycResultPhone').textContent = c.msisdn;
  $('#kycResultId').textContent = c.idNumberMasked || c.idNumber;
  $('#kycRaw').textContent = JSON.stringify(c.raw || {}, null, 2);
  $('#kycResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitB2B(event) {
  event.preventDefault();
  const btn = $('#b2bSubmit');
  const amount = Number($('#b2bAmount').value);
  const partyB = $('#b2bPartyB').value.trim();

  if (!Number.isFinite(amount) || amount < 1) return toast('Enter an amount of at least KES 1.', 'error');
  if (!/^\d{5,7}$/.test(partyB)) return toast('Receiver shortcode must be 5-7 digits.', 'error');

  setBusy(btn, true);
  try {
    const body = {
      amount,
      partyB,
      commandId: $('#b2bCommand').value,
      accountReference: $('#b2bReference').value.trim() || 'Jimmy Pro',
      remarks: $('#b2bRemarks').value.trim() || 'B2B payment',
    };
    if ($('#b2bPartyA').value.trim()) body.partyA = $('#b2bPartyA').value.trim();
    body.receiverIdentifierType = $('#b2bReceiverType').value;

    const { payment } = await api('/api/b2b/payments', { method: 'POST', body });
    toast(payment.status === 'failed' ? 'B2B request failed' : `B2B ${payment.ref} sent`, payment.status === 'failed' ? 'error' : 'success');
    showB2bResult(payment);
    pollB2b(payment.id);
    loadBusiness();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

function pollB2b(id) {
  if (state.b2bPollTimer) clearInterval(state.b2bPollTimer);
  const startedAt = Date.now();
  state.b2bPollTimer = setInterval(async () => {
    if (Date.now() - startedAt > 60000) {
      clearInterval(state.b2bPollTimer);
      state.b2bPollTimer = null;
      return;
    }
    try {
      const { payments } = await api('/api/b2b/payments?limit=50');
      state.b2b = payments;
      const fresh = payments.find((p) => p.id === id);
      if (!fresh) return;
      if (fresh.status !== 'pending') {
        clearInterval(state.b2bPollTimer);
        state.b2bPollTimer = null;
        showB2bResult(fresh);
        if (fresh.status === 'success') toast(`B2B settled · ${fresh.transactionId || fresh.ref}`, 'success');
      }
      renderB2bList();
    } catch (_) {
      /* transient */
    }
  }, 2500);
}

async function submitKyc(event) {
  event.preventDefault();
  const btn = $('#kycSubmit');
  const msisdn = $('#kycMsisdn').value.trim();
  const idNumber = $('#kycIdNumber').value.trim();
  if (!msisdn) return toast('Enter the customer number.', 'error');
  if (!idNumber) return toast('Enter the ID number.', 'error');

  setBusy(btn, true);
  try {
    const { check } = await api('/api/kyc/validate', {
      method: 'POST',
      body: { msisdn, idNumber, idType: $('#kycIdType').value.trim() || '01' },
    });
    showKycResult(check);
    toast(check.status === 'valid' ? 'ID verified' : 'ID could not be verified', check.status === 'valid' ? 'success' : 'error');
    loadBusiness();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

/* ------------------------------------------------------------ PWA install */

  function initInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.installPrompt = e;
      $('#installBtn').hidden = false;
      $('#installBtn2').textContent = 'Install';
    });

    window.addEventListener('appinstalled', () => {
      state.installPrompt = null;
      $('#installBtn').hidden = true;
      toast('Jimmy Pro installed', 'success');
    });

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (isStandalone) {
      $('#installBtn').hidden = true;
      $('#installBtn2').textContent = 'Installed';
      $('#installBtn2').disabled = true;
    }
  }

  async function triggerInstall() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      const choice = await state.installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        toast('Installing Jimmy Pro…', 'success');
      }
      state.installPrompt = null;
      $('#installBtn').hidden = true;
      return;
    }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    toast(
      ios
        ? 'Tap Share, then "Add to Home Screen" to install.'
        : 'Use your browser menu → "Install app" / "Add to Home screen".',
      'info'
    );
  }

  /* ------------------------------------------------------------- SSE stream */

  function connectStream() {
    if (!('EventSource' in window)) return;
    const es = new EventSource('/api/events');
    es.addEventListener('payment', async (event) => {
      try {
        const payload = JSON.parse(event.data);
        const p = payload.payment;
        if (state.activePayment && p && p.id === state.activePayment.id) {
          /* Refetch so the record carries pretty phone numbers and its pay URL. */
          const fresh = await api(`/api/payments/${state.activePayment.id}`);
          state.activePayment = fresh.payment;
          if (!$('#resultCard').hidden) updateResultCard(fresh.payment);
          if (!$('#sheetBackdrop').hidden) openSheet(fresh.payment);
        }
        scheduleRefresh();
      } catch (_) {
        scheduleRefresh();
      }
    });
    es.addEventListener('payment_deleted', () => scheduleRefresh());
    es.addEventListener('b2b', () => {
      if (currentView() === 'business') loadBusiness();
    });
    es.addEventListener('kyc', () => {
      if (currentView() === 'business') loadBusiness();
    });
    es.onerror = () => {
      /* EventSource reconnects automatically */
    };
  }

  /* ------------------------------------------------------------------- wire */

  function wire() {
    $$('.tab, [data-goto]').forEach((el) => {
      el.addEventListener('click', () => setView(el.dataset.goto));
    });

    $$('[data-goto-history]').forEach((el) => {
      el.addEventListener('click', () => {
        const f = el.getAttribute('data-goto-history');
        state.filter = f === 'failed' ? 'failed' : f;
        $$('#filterChips .chip').forEach((c) =>
          c.classList.toggle('is-active', c.dataset.filter === state.filter)
        );
        setView('history');
        loadPayments();
      });
    });

    window.addEventListener('hashchange', () => setView(currentView()));

    $('#refreshBtn').addEventListener('click', async () => {
      toast('Refreshing…', 'info');
      await refreshAll();
      toast('Up to date', 'success');
    });

    $('#b2bForm').addEventListener('submit', submitB2B);
    $('#kycForm').addEventListener('submit', submitKyc);

    $('#tabB2B').addEventListener('click', () => switchBusinessTab('b2b'));
    $('#tabKyc').addEventListener('click', () => switchBusinessTab('kyc'));

    $('#b2bRefreshBtn').addEventListener('click', async () => {
      await loadBusiness();
      toast('B2B list refreshed', 'info');
    });
    $('#b2bRefreshList').addEventListener('click', loadBusiness);
    $('#kycRefreshList').addEventListener('click', loadBusiness);

    $('#b2bCopyConvBtn').addEventListener('click', (e) => {
      const conv = e.currentTarget.dataset.conv;
      if (conv) copyText(conv, 'ConversationID');
      else toast('No ConversationID yet', 'info');
    });

    document.addEventListener('click', (event) => {
      const b2bRow = event.target.closest('[data-b2b]');
      if (b2bRow) {
        const record = state.b2b.find((p) => p.id === b2bRow.dataset.b2b);
        if (record) showB2bResult(record);
        return;
      }
      const kycRow = event.target.closest('[data-kyc]');
      if (kycRow) {
        const record = state.kyc.find((c) => c.id === kycRow.dataset.kyc);
        if (record) showKycResult(record);
        return;
      }
      const copyBtn = event.target.closest('[data-copy]');
      if (copyBtn) copyText(copyBtn.dataset.copy, 'Endpoint URL');
    });

    $('#installBtn').addEventListener('click', triggerInstall);
    $('#installBtn2').addEventListener('click', triggerInstall);

    $('#homeShareBtn').addEventListener('click', () => {
      setView('new');
      switchTab('link');
      setTimeout(() => $('#linkAmount').focus(), 140);
      toast('Set an amount to create a shareable link', 'info');
    });

    /* new-payment tabs */
    $('#tabPrompt').addEventListener('click', () => switchTab('prompt'));
    $('#tabLink').addEventListener('click', () => switchTab('link'));

    $('#promptForm').addEventListener('submit', submitPrompt);
    $('#linkForm').addEventListener('submit', submitLink);

    $$('#amountChips .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        $('#amount').value = chip.dataset.amount;
        $$('#amountChips .chip').forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
      });
    });

    $('#contactsBtn').addEventListener('click', () => {
      const numbers = Array.from(
        new Set(state.payments.map((p) => p.phonePretty || p.phone).filter(Boolean))
      ).slice(0, 8);
      if (!numbers.length) return toast('No recent numbers yet — send one first.', 'info');
      const current = $('#phone').value.trim();
      const idx = numbers.indexOf(current);
      const next = numbers[(idx + 1) % numbers.length];
      $('#phone').value = next.replace(/^0/, '');
      toast(`Filled ${next}`, 'info');
    });

    $('#checkStatusBtn').addEventListener('click', () => {
      if (state.activePayment) queryPayment(state.activePayment.id);
    });
    $('#copyResultLinkBtn').addEventListener('click', () => {
      if (state.activePayment) copyText(state.activePayment.payUrl, 'Payment link');
    });
    $('#shareResultBtn').addEventListener('click', () => {
      if (state.activePayment) {
        shareLink(state.activePayment.payUrl, 'Pay ' + kes(state.activePayment.amount), state.activePayment.description);
      }
    });
    $('#newAnotherBtn').addEventListener('click', () => {
      stopPolling();
      $('#resultCard').hidden = true;
      switchTab('prompt');
      $('#phone').focus();
    });

    /* link result actions */
    $('#copyLinkBtn').addEventListener('click', () => {
      copyText($('#linkResultUrl').value, 'Payment link');
    });
    $('#openLinkBtn').addEventListener('click', () => {
      window.open($('#linkResultUrl').value, '_blank', 'noopener');
    });
    $('#shareLinkBtn').addEventListener('click', () => {
      shareLink($('#linkResultUrl').value, 'Jimmy Pro payment', 'Pay securely with M-Pesa');
    });
    $('#viewLinkPaymentBtn').addEventListener('click', () => {
      const id = $('#linkResult').dataset.id;
      if (id) openById(id);
    });

    /* history */
    let searchTimer = null;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const value = e.target.value.trim();
      searchTimer = setTimeout(() => {
        state.query = value;
        loadPayments();
      }, 220);
    });

    $$('#filterChips .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.filter = chip.dataset.filter;
        $$('#filterChips .chip').forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        loadPayments();
      });
    });

    $('#exportBtn').addEventListener('click', () => {
      window.location.href = '/api/export.csv';
      toast('Exporting CSV…', 'info');
    });

    document.addEventListener('click', (event) => {
      const row = event.target.closest('.row');
      if (row && row.dataset.id) openById(row.dataset.id);
    });

    /* sheet */
    $('#sheetClose').addEventListener('click', closeSheet);
    $('#sheetBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'sheetBackdrop') closeSheet();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#sheetBackdrop').hidden) closeSheet();
    });
    $('#sheetQueryBtn').addEventListener('click', () => {
      if (state.activePayment) queryPayment(state.activePayment.id);
    });
    $('#sheetRetryBtn').addEventListener('click', () => {
      if (state.activePayment) retryPayment(state.activePayment.id);
    });
    $('#sheetCopyBtn').addEventListener('click', () => {
      if (state.activePayment) copyText(state.activePayment.payUrl, 'Payment link');
    });
    $('#sheetShareBtn').addEventListener('click', () => {
      if (state.activePayment) shareLink(state.activePayment.payUrl, 'Pay ' + kes(state.activePayment.amount));
    });
    $('#sheetReceiptBtn').addEventListener('click', () => {
      if (state.activePayment && state.activePayment.mpesaReceipt) {
        copyText(state.activePayment.mpesaReceipt, 'Receipt number');
      }
    });
    $('#sheetDeleteBtn').addEventListener('click', () => {
      if (state.activePayment) deletePayment(state.activePayment.id);
    });
    /* settings */
    $$('#envToggle .seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#envToggle .seg').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        if (btn.dataset.env === 'sandbox' && !$('#setShortcode').value) {
          $('#setShortcode').value = '174379';
        }
      });
    });

    $$('[data-reveal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.reveal);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Hide' : 'Show';
      });
    });

    $('#useSandboxKey').addEventListener('click', () => {
      const key = state.settings && state.settings.sandboxPasskeyHint;
      if (!key) return;
      $('#setPasskey').value = key;
      toast('Sandbox passkey filled — remember to save', 'info');
    });

    $('#useSuggestedCallback').addEventListener('click', () => {
      if (state.settings) {
        $('#setCallback').value = state.settings.callbackSuggestion;
        toast('Callback set to this host', 'info');
      }
    });

    $('#settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#saveSettingsBtn');
      setBusy(btn, true);
      try {
        const { settings } = await api('/api/settings', { method: 'PUT', body: settingsPayload() });
        state.settings = Object.assign({}, state.settings, settings);
        toast('Settings saved', 'success');
        renderMode();
        renderSettings();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        setBusy(btn, false);
      }
    });

    $('#testBtn').addEventListener('click', async () => {
      const btn = $('#testBtn');
      setBusy(btn, true);
      try {
        const result = await api('/api/settings/test', { method: 'POST' });
        toast(`${result.message} (${result.tokenPreview})`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        setBusy(btn, false);
      }
    });

    $('#copyCallbackBtn').addEventListener('click', () => {
      copyText($('#callbackDisplay').value, 'Callback URL');
    });

    $('#resetSettingsBtn').addEventListener('click', async () => {
      if (!confirm('Clear all saved M-Pesa credentials?')) return;
      try {
        const { settings } = await api('/api/settings/reset', { method: 'POST' });
        state.settings = Object.assign({}, state.settings, settings);
        toast('Settings reset', 'success');
        renderMode();
        renderSettings();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    $('#clearCacheBtn').addEventListener('click', async () => {
      try {
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        toast('Cache cleared — reloading', 'success');
        setTimeout(() => location.reload(), 900);
      } catch (_) {
        toast('Could not clear the cache', 'error');
      }
    });

    window.addEventListener('online', () => {
      $('#offlineBar').hidden = true;
      refreshAll();
    });
    window.addEventListener('offline', () => {
      $('#offlineBar').hidden = false;
    });
    if (!navigator.onLine) $('#offlineBar').hidden = false;
  }

  function switchBusinessTab(tab) {
    const isB2b = tab === 'b2b';
    $('#tabB2B').classList.toggle('is-active', isB2b);
    $('#tabKyc').classList.toggle('is-active', !isB2b);
    $('#tabB2B').setAttribute('aria-selected', String(isB2b));
    $('#tabKyc').setAttribute('aria-selected', String(!isB2b));

    $('#b2bForm').hidden = !isB2b;
    $('#b2bHead').hidden = !isB2b;
    $('#b2bList').hidden = !isB2b;
    $('#b2bResult').hidden = !isB2b || !state.showB2bResult;

    $('#kycForm').hidden = isB2b;
    $('#kycHead').hidden = isB2b;
    $('#kycList').hidden = isB2b;
    $('#kycResult').hidden = isB2b || !state.showKycResult;
  }

  function switchTab(tab) {
    const prompt = tab === 'prompt';
    $('#tabPrompt').classList.toggle('is-active', prompt);
    $('#tabLink').classList.toggle('is-active', !prompt);
    $('#tabPrompt').setAttribute('aria-selected', String(prompt));
    $('#tabLink').setAttribute('aria-selected', String(!prompt));
    $('#promptForm').hidden = !prompt;
    $('#linkForm').hidden = prompt;
    $('#resultCard').hidden = true;
  }

  /* ------------------------------------------------------------------- boot */

  async function boot() {
    wire();
    initInstall();
    setView(currentView());

    try {
      await Promise.all([loadSettings(), loadStats(), loadPayments(), loadEndpoints()]);
      if (currentView() === 'business') loadBusiness();
      /* Deep links (#settings) paint before the config arrives - repaint once it does. */
      if (currentView() === 'settings') renderSettings();
      applyEndpointDefaults();
    } catch (err) {
      toast('Could not reach the server. Is it running?', 'error');
    }

    connectStream();

    if ('serviceWorker' in navigator) {
      /* Register straight away: waiting for "load" can miss the event entirely. */
      const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
      if (document.readyState === 'complete') register();
      else window.addEventListener('load', register, { once: true });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
