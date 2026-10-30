'use strict';
/**
 * Every Safaricom URL the app talks to lives here - one place to change.
 * Override the base with MPESA_BASE_URL if you ever need a proxy.
 */
const BASES = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

const PATHS = {
  oauth: '/oauth/v1/generate',
  stkPush: '/mpesa/stkpush/v1/processrequest',
  stkQuery: '/mpesa/stkpushquery/v1/query',
  b2bPayment: '/mpesa/b2b/v1/paymentrequest',
  kycValidateId: '/v1/KYC-validation/validateID',
};

function baseUrl(environment) {
  const forced = (process.env.MPESA_BASE_URL || '').trim().replace(/\/+$/, '');
  if (forced) return forced;
  return BASES[environment === 'production' ? 'production' : 'sandbox'];
}

function url(environment, key) {
  if (!PATHS[key]) throw new Error(`Unknown Safaricom endpoint: ${key}`);
  return `${baseUrl(environment)}${PATHS[key]}`;
}

/** Handy for the settings screen: what the app will call, and why. */
function describe(environment) {
  return [
    {
      key: 'oauth',
      label: 'OAuth token',
      method: 'GET',
      url: `${url(environment, 'oauth')}?grant_type=client_credentials`,
      note: 'Bearer token used by every other call (cached ~1 hour).',
    },
    {
      key: 'stkPush',
      label: 'STK Push (prompt)',
      method: 'POST',
      url: url(environment, 'stkPush'),
      note: 'Lipa na M-Pesa Online - prompts a customer phone.',
    },
    {
      key: 'stkQuery',
      label: 'STK status query',
      method: 'POST',
      url: url(environment, 'stkQuery'),
      note: 'Checks whether a prompt was paid, cancelled or timed out.',
    },
    {
      key: 'b2bPayment',
      label: 'B2B payment request',
      method: 'POST',
      url: url(environment, 'b2bPayment'),
      note: 'Moves money between shortcodes (paybill / till).',
    },
    {
      key: 'kycValidateId',
      label: 'KYC ID validation',
      method: 'POST',
      url: url(environment, 'kycValidateId'),
      note: 'Validates a customer ID against their MSISDN.',
    },
  ];
}

module.exports = { BASES, PATHS, baseUrl, url, describe };
