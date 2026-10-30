'use strict';
/**
 * SecurityCredential for B2B / B2C style APIs.
 *
 * Safaricom expects the initiator password RSA-encrypted with their public
 * certificate, then base64 encoded. Three ways to satisfy it, in order:
 *   1. MPESA_SECURITY_CREDENTIAL  - a ready-made base64 value
 *   2. MPESA_INITIATOR_PASSWORD + Safaricom certificate on disk
 *   3. MPESA_CERT_PEM             - certificate pasted into the environment
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANDIDATES = [
  process.env.MPESA_CERT_PATH,
  path.join(__dirname, '..', 'certs', 'safaricom.cer'),
  path.join(__dirname, '..', 'certs', 'SafaricomCertificate.cer'),
  path.join(__dirname, '..', 'certs', 'safaricom.pem'),
].filter(Boolean);

let cachedCredential = null;

function readCertificate() {
  if (process.env.MPESA_CERT_PEM) {
    return Buffer.from(process.env.MPESA_CERT_PEM.replace(/\\n/g, '\n'), 'utf8');
  }
  for (const file of CANDIDATES) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file);
    } catch (_) {
      /* try the next candidate */
    }
  }
  return null;
}

function certificateInfo() {
  const raw = readCertificate();
  if (!raw) return { present: false };
  try {
    const cert = new crypto.X509Certificate(raw);
    return {
      present: true,
      subject: cert.subject.replace(/\n/g, ', '),
      issuer: cert.issuer.replace(/\n/g, ', '),
      validTo: cert.validTo,
    };
  } catch (err) {
    return { present: true, error: `Unreadable certificate: ${err.message}` };
  }
}

/**
 * @param {string} [override] a credential supplied per-request
 * @returns {string} base64 SecurityCredential
 */
function securityCredential(override) {
  if (override && String(override).trim()) return String(override).trim();
  if (cachedCredential) return cachedCredential;

  const ready = (process.env.MPESA_SECURITY_CREDENTIAL || '').trim();
  if (ready) {
    cachedCredential = ready;
    return ready;
  }

  const password = (process.env.MPESA_INITIATOR_PASSWORD || '').trim();
  if (!password) {
    throw new Error(
      'SecurityCredential is missing: set MPESA_INITIATOR_PASSWORD and drop the Safaricom certificate in certs/, or set MPESA_SECURITY_CREDENTIAL directly.'
    );
  }

  const raw = readCertificate();
  if (!raw) {
    throw new Error(
      'Safaricom public certificate not found. Save it as certs/safaricom.cer (or set MPESA_CERT_PATH), then retry.'
    );
  }

  let cert;
  try {
    cert = new crypto.X509Certificate(raw);
  } catch (err) {
    throw new Error(`Could not read the Safaricom certificate: ${err.message}`);
  }

  try {
    cachedCredential = crypto
      .publicEncrypt(
        { key: cert.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(password, 'utf8')
      )
      .toString('base64');
    return cachedCredential;
  } catch (err) {
    throw new Error(`Could not encrypt the initiator password: ${err.message}`);
  }
}

function resetCache() {
  cachedCredential = null;
}

module.exports = { securityCredential, certificateInfo, resetCache };
