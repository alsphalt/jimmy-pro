'use strict';
/**
 * KYC / ID validation.
 * POST /v1/KYC-validation/validateID
 *
 * Checks that an ID number belongs to the owner of a Safaricom MSISDN.
 * The response shape is not formally documented, so this normalises whatever
 * comes back instead of assuming one schema.
 */
const endpoints = require('./endpoints');
const { resolveSettings, getAccessToken, darajaFetch, normalizePhone } = require('./mpesa');

function validate(input) {
  const errors = [];
  if (!normalizePhone(input.msisdn)) {
    errors.push('Enter a valid Safaricom number, e.g. 0712 345 678.');
  }
  const idNumber = String(input.idNumber || '').trim();
  if (!/^[A-Za-z0-9]{5,12}$/.test(idNumber)) {
    errors.push('ID number should be 5-12 letters or digits.');
  }
  if (!String(input.idType || '').trim()) {
    errors.push('ID type is required (for example 01 for National ID).');
  }
  return errors;
}

function normalise(body, status) {
  const code =
    body.responseCode ?? body.ResponseCode ?? body.statusCode ?? body.status ?? null;
  const description =
    body.responseDescription ||
    body.ResponseDescription ||
    body.description ||
    body.message ||
    body.errorMessage ||
    (status ? `HTTP ${status}` : 'No description returned');

  const codeText = code === null ? null : String(code);
  const success = codeText === null ? false : ['0', '00', '200'].includes(codeText);

  return {
    success,
    code: codeText,
    description,
    raw: body,
  };
}

async function validateId(input) {
  const s = resolveSettings();
  if (!s.live) {
    throw new Error('Live mode is required for KYC validation. Add M-Pesa credentials first.');
  }

  const errors = validate(input);
  if (errors.length) {
    const err = new Error(errors.join(' '));
    err.status = 400;
    throw err;
  }

  const token = await getAccessToken();
  const payload = {
    requestRefID: String(input.requestRefID || `JP-${Date.now()}`),
    shortCode: String(input.shortCode || s.kycShortcode),
    msisdn: normalizePhone(input.msisdn),
    idType: String(input.idType || '01'),
    idNumber: String(input.idNumber).trim(),
  };

  const { ok, status, body } = await darajaFetch(endpoints.url(s.environment, 'kycValidateId'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = normalise(body, status);

  if (!ok && !result.code) {
    const err = new Error(`KYC validation failed: ${result.description}`);
    err.safaricom = body;
    err.status = 502;
    throw err;
  }

  return { ...result, request: payload };
}

module.exports = { validate, validateId, normalise };
