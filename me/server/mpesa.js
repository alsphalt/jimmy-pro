'use strict';
/**
 * Safaricom Daraja client.
 *
 * Implements the two endpoints a payment-request product actually needs:
 *   - GET  /oauth/v1/generate                      (OAuth 2.0 client credentials)
 *   - POST /mpesa/stkpush/v1/processrequest         (Lipa na M-Pesa Online = prompt)
 *   - POST /mpesa/stkpushquery/v1/query             (transaction status)
 *
 * Plus the callback shape for STK results.
 */
const store = require('./store');

const BASES = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

const SANDBOX_PASSKEY =
  'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

/* ------------------------------------------------------------------ config */

function envOr(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const trimmed = String(v).trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Effective settings = environment variables (highest priority) over values
 * saved through the UI.
 */
function resolveSettings() {
  const saved = store.settings || {};
  const pick = (envKey, savedKey, fallback = '') =>
    envOr(envKey, '') || (saved[savedKey] ?? fallback);

  const environment =
    String(pick('MPESA_ENV', 'environment', 'sandbox')).toLowerCase() === 'production'
      ? 'production'
      : 'sandbox';

  const settings = {
    environment,
    consumerKey: String(pick('MPESA_CONSUMER_KEY', 'consumerKey')),
    consumerSecret: String(pick('MPESA_CONSUMER_SECRET', 'consumerSecret')),
    passkey: String(pick('MPESA_PASSKEY', 'passkey')),
    shortcode: String(pick('MPESA_SHORTCODE', 'shortcode', environment === 'sandbox' ? '174379' : '')),
    transactionType:
      pick('MPESA_TRANSACTION_TYPE', 'transactionType', 'CustomerPayBillOnline') ===
      'CustomerBuyGoodsOnline'
        ? 'CustomerBuyGoodsOnline'
        : 'CustomerPayBillOnline',
    /* PUBLIC_URL alone is enough: derive the callback from it before giving up,
       so a host only has to set one public-address variable. */
    callbackUrl: String(
      pick('MPESA_CALLBACK_URL', 'callbackUrl') ||
        (process.env.PUBLIC_URL
          ? `${String(process.env.PUBLIC_URL).trim().replace(/\/+$/, '')}/api/mpesa/callback`
          : '')
    ),
    businessName: String(pick('BUSINESS_NAME', 'businessName', 'Jimmy Pro')),

    /* B2B (business to business) */
    initiatorName: String(pick('MPESA_INITIATOR_NAME', 'initiatorName')),
    senderShortcode: String(
      pick('MPESA_B2B_PARTY_A', 'senderShortcode', '') ||
        pick('MPESA_SHORTCODE', 'shortcode', environment === 'sandbox' ? '174379' : '')
    ),
    b2bCommandId: String(pick('MPESA_B2B_COMMAND_ID', 'b2bCommandId', 'BusinessPayBill')),
    resultUrl: String(pick('MPESA_RESULT_URL', 'resultUrl')),
    timeoutUrl: String(pick('MPESA_TIMEOUT_URL', 'timeoutUrl')),

    /* KYC validation */
    kycShortcode: String(
      pick('MPESA_KYC_SHORTCODE', 'kycShortcode', '') ||
        pick('MPESA_SHORTCODE', 'shortcode', environment === 'sandbox' ? '174379' : '')
    ),

    /* The operator's own handset. Used for the "owner" label and as the default
       destination for payouts; it can NOT be the receiver of an STK push -
       Daraja settles STK to the shortcode, never to a personal number. */
    ownerMsisdn: normalizePhone(pick('MPESA_OWNER_MSISDN', 'ownerMsisdn')) || '',
  };

  settings.missing = [];
  if (!settings.consumerKey) settings.missing.push('consumer key');
  if (!settings.consumerSecret) settings.missing.push('consumer secret');
  if (!settings.passkey) settings.missing.push('passkey');
  if (!settings.shortcode) settings.missing.push('shortcode');
  settings.hasCredentials = settings.missing.length === 0;

  /* No simulation fallback: without credentials every money endpoint refuses. */
  settings.live = settings.hasCredentials;
  settings.baseUrl = BASES[settings.environment];
  return settings;
}

function publicSettings() {
  const s = resolveSettings();
  return {
    environment: s.environment,
    shortcode: s.shortcode,
    transactionType: s.transactionType,
    callbackUrl: s.callbackUrl,
    businessName: s.businessName,
    live: s.live,
    missing: s.missing,
    hasCredentials: s.hasCredentials,
    initiatorName: s.initiatorName,
    senderShortcode: s.senderShortcode,
    b2bCommandId: s.b2bCommandId,
    resultUrl: s.resultUrl,
    timeoutUrl: s.timeoutUrl,
    kycShortcode: s.kycShortcode,
    hasSecurityCredential: Boolean(
      (process.env.MPESA_SECURITY_CREDENTIAL || '').trim() ||
        (process.env.MPESA_INITIATOR_PASSWORD || '').trim()
    ),
    certificate: require('./security').certificateInfo(),
    hasConsumerKey: Boolean(s.consumerKey),
    hasConsumerSecret: Boolean(s.consumerSecret),
    hasPasskey: Boolean(s.passkey),
    envLockedFields: envLockedFields(),
    ownerMsisdn: s.ownerMsisdn,
    /* Only ever expose the well-known *public sandbox* passkey, and only before
       a real passkey exists. Production passkeys are never returned. */
    sandboxPasskeyHint:
      s.environment !== 'production' && !s.passkey ? SANDBOX_PASSKEY : null,
  };
}

/** Fields supplied through .env cannot be edited from the UI. */
function envLockedFields() {
  const fields = {};
  const map = {
    environment: 'MPESA_ENV',
    consumerKey: 'MPESA_CONSUMER_KEY',
    consumerSecret: 'MPESA_CONSUMER_SECRET',
    passkey: 'MPESA_PASSKEY',
    shortcode: 'MPESA_SHORTCODE',
    transactionType: 'MPESA_TRANSACTION_TYPE',
    callbackUrl: 'MPESA_CALLBACK_URL',
    businessName: 'BUSINESS_NAME',
  };
  for (const [field, key] of Object.entries(map)) {
    if (envOr(key, '') !== '') fields[field] = true;
  }
  return fields;
}

/* ------------------------------------------------------------------- utils */

/** 0712345678 / +254712345678 / 254712345678 -> 254712345678 */
function normalizePhone(input) {
  if (!input) return null;
  let digits = String(input).replace(/[^\d+]/g, '');
  digits = digits.replace(/^\+/, '');
  if (digits.startsWith('254')) {
    /* already international */
  } else if (digits.startsWith('0') && digits.length === 10) {
    digits = `254${digits.slice(1)}`;
  } else if (digits.startsWith('7') && digits.length === 9) {
    digits = `254${digits}`;
  } else if (digits.startsWith('1') && digits.length === 9) {
    digits = `254${digits}`;
  }
  if (!/^254(7|1)\d{8}$/.test(digits)) return null;
  return digits;
}

function prettyPhone(msisdn) {
  if (!msisdn) return '';
  const s = String(msisdn);
  if (s.startsWith('254') && s.length === 12) return `0${s.slice(3, 6)} ${s.slice(6, 9)} ${s.slice(9)}`;
  return s;
}

/** Daraja wants YYYYMMDDHHmmss in Africa/Nairobi (UTC+3, no DST). */
function nairobiTimestamp(date = new Date()) {
  const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function stkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

const RESULT_MESSAGES = {
  '0': 'Payment completed successfully',
  '1': 'Not enough funds in the M-Pesa account',
  '1001': 'Another transaction is in progress on this number',
  '1019': 'Transaction expired before it was confirmed',
  '1032': 'Request cancelled by the customer',
  '1037': 'No response from the phone (request timed out)',
  '1011': 'The customer could not be reached',
  '2001': 'Wrong M-Pesa PIN entered',
  '9999': 'Request failed on the M-Pesa side',
};

function resultMessage(code) {
  return RESULT_MESSAGES[String(code)] || `M-Pesa returned result code ${code}`;
}

function mapStatus(resultCode) {
  const code = String(resultCode);
  if (code === '0') return 'success';
  if (code === '1032') return 'cancelled';
  if (code === '1037' || code === '1019') return 'timeout';
  return 'failed';
}

/* --------------------------------------------------------------------- http */

async function darajaFetch(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Safaricom did not respond in time. Check your connection and try again.');
    }
    throw new Error(`Could not reach Safaricom: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------- auth */

let tokenCache = { token: null, expiresAt: 0, key: '' };

async function getAccessToken({ force = false } = {}) {
  const s = resolveSettings();
  if (!s.consumerKey || !s.consumerSecret) {
    throw new Error('Consumer key and secret are not configured.');
  }
  const cacheKey = `${s.environment}:${s.consumerKey}`;
  if (
    !force &&
    tokenCache.token &&
    tokenCache.key === cacheKey &&
    Date.now() < tokenCache.expiresAt
  ) {
    return tokenCache.token;
  }

  const basic = Buffer.from(`${s.consumerKey}:${s.consumerSecret}`).toString('base64');
  const url = `${s.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
  const { ok, status, body } = await darajaFetch(url, {
    method: 'GET',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
  });

  if (!ok || !body.access_token) {
    /* Daraja answers 400 with an empty body when the key/secret pair is wrong. */
    const detail =
      body.errorMessage ||
      body.error_description ||
      body.error ||
      (status === 400 || status === 401
        ? 'the consumer key or secret is not valid for this environment'
        : `unexpected response (HTTP ${status})`);
    throw new Error(`Safaricom rejected the credentials: ${detail}`);
  }

  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 3599) * 1000 - 60_000,
    key: cacheKey,
  };
  return tokenCache.token;
}

/* ----------------------------------------------------------------- STK push */

async function stkPush(payment) {
  const s = resolveSettings();
  if (!s.live) throw new Error('M-Pesa is not configured. Add your consumer key, secret, passkey and shortcode in Settings.');

  const token = await getAccessToken();
  const timestamp = nairobiTimestamp();
  const password = stkPassword(s.shortcode, s.passkey, timestamp);
  const callback = s.callbackUrl;

  if (!callback) {
    throw new Error(
      'Callback URL is missing. Safaricom needs a public https URL to send the result to.'
    );
  }

  const payload = {
    BusinessShortCode: s.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: s.transactionType,
    Amount: Math.round(Number(payment.amount)),
    PartyA: payment.phone,
    PartyB: s.shortcode,
    PhoneNumber: payment.phone,
    CallBackURL: callback,
    AccountReference: String(payment.accountReference || 'JimmyPro').slice(0, 12),
    TransactionDesc: String(payment.description || 'Payment').slice(0, 100),
  };

  const { ok, status, body } = await darajaFetch(
    `${s.baseUrl}/mpesa/stkpush/v1/processrequest`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  if (!ok || String(body.ResponseCode) !== '0') {
    const detail =
      body.errorMessage ||
      body.ResponseDescription ||
      body.error_description ||
      `HTTP ${status}`;
    const err = new Error(`M-Pesa rejected the request: ${detail}`);
    err.safaricom = body;
    throw err;
  }

  return {
    merchantRequestId: body.MerchantRequestID,
    checkoutRequestId: body.CheckoutRequestID,
    responseCode: body.ResponseCode,
    responseDescription: body.ResponseDescription,
    customerMessage: body.CustomerMessage,
    raw: body,
  };
}

/* ---------------------------------------------------------------- STK query */

async function stkQuery(payment) {
  const s = resolveSettings();
  if (!s.live) throw new Error('M-Pesa is not configured.');

  const token = await getAccessToken();
  const timestamp = nairobiTimestamp();
  const password = stkPassword(s.shortcode, s.passkey, timestamp);

  const { ok, status, body } = await darajaFetch(
    `${s.baseUrl}/mpesa/stkpushquery/v1/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: s.shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: payment.checkoutRequestId,
      }),
    }
  );

  /* Daraja answers 500 with an error body while the customer is still on the
     PIN screen. That is "still waiting", not a failure. */
  const code = body.ResultCode !== undefined ? String(body.ResultCode) : null;
  const description = body.ResultDesc || body.errorMessage || '';

  if (code === null) {
    if (
      /still under processing|processing/i.test(description) ||
      (status === 500 && /process/i.test(description))
    ) {
      return { pending: true, description: description || 'Waiting for the customer' };
    }
    return { pending: true, description: description || `HTTP ${status}` };
  }

  return {
    pending: false,
    resultCode: code,
    resultDesc: description || resultMessage(code),
    status: mapStatus(code),
  };
}

/* ---------------------------------------------------------------- callback */

/**
 * Turns a Daraja STK callback into a flat result.
 * Body.stkCallback.CallbackMetadata.Item is [{Name, Value}]
 */
function parseStkCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;
  const items = cb.CallbackMetadata?.Item || [];
  const get = (name) => items.find((i) => i.Name === name)?.Value;
  return {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: String(cb.ResultCode),
    resultDesc: cb.ResultDesc,
    amount: get('Amount'),
    mpesaReceipt: get('MpesaReceiptNumber'),
    transactionDate: get('TransactionDate'),
    phone: get('PhoneNumber'),
  };
}

module.exports = {
  SANDBOX_PASSKEY,
  darajaFetch,
  resolveSettings,
  publicSettings,
  envLockedFields,
  normalizePhone,
  prettyPhone,
  nairobiTimestamp,
  stkPassword,
  getAccessToken,
  stkPush,
  stkQuery,
  parseStkCallback,
  resultMessage,
  mapStatus,
};
