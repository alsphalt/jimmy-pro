'use strict';
/**
 * B2B payment request.
 * POST /mpesa/b2b/v1/paymentrequest
 *
 * Moves money from one shortcode (PartyA) to another (PartyB): paybill to
 * paybill, till to paybill, or a business disbursement. The call is
 * asynchronous - Safaricom answers with a ConversationID and later posts the
 * final result to ResultURL, which /api/b2b/callback handles.
 */
const endpoints = require('./endpoints');
const { resolveSettings, getAccessToken, darajaFetch } = require('./mpesa');
const { securityCredential } = require('./security');

const COMMANDS = [
  {
    id: 'BusinessPayBill',
    label: 'Business → Paybill',
    hint: 'Pay a paybill from your shortcode.',
  },
  {
    id: 'BusinessBuyGoods',
    label: 'Business → Till (Buy Goods)',
    hint: 'Pay a till number from your shortcode.',
  },
  {
    id: 'DisburseFundsToBusiness',
    label: 'Disburse funds to business',
    hint: 'Send funds to another business shortcode.',
  },
  {
    id: 'BusinessToBusinessTransfer',
    label: 'Business → Business transfer',
    hint: 'Direct shortcode to shortcode transfer.',
  },
  {
    id: 'MerchantToMerchantTransfer',
    label: 'Merchant → Merchant',
    hint: 'Merchant settlement transfer.',
  },
];

const IDENTIFIER_TYPES = { 2: 'Till number', 4: 'Shortcode / Paybill' };

function validate(input) {
  const errors = [];
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 1) errors.push('Amount must be at least KES 1.');
  if (amount > 500000) errors.push('Amount looks too large for a single B2B request.');

  const partyB = String(input.partyB || '').replace(/\s/g, '');
  if (!/^\d{5,7}$/.test(partyB)) errors.push('Party B (receiver shortcode) must be 5-7 digits.');

  const partyA = String(input.partyA || '').replace(/\s/g, '');
  if (!/^\d{5,7}$/.test(partyA)) errors.push('Party A (your shortcode) is missing or invalid.');

  if (!COMMANDS.some((c) => c.id === input.commandId)) {
    errors.push('Choose a valid CommandID.');
  }
  if (!input.resultUrl || !/^https?:\/\//i.test(input.resultUrl)) {
    errors.push('ResultURL must be a public http(s) URL.');
  }
  if (!input.timeoutUrl || !/^https?:\/\//i.test(input.timeoutUrl)) {
    errors.push('QueueTimeOutURL must be a public http(s) URL.');
  }
  return errors;
}

async function sendPayment(input) {
  const s = resolveSettings();
  if (!s.live) {
    throw new Error('Live mode is required for B2B payments. Add M-Pesa credentials first.');
  }

  const commandId = COMMANDS.some((c) => c.id === input.commandId)
    ? input.commandId
    : 'BusinessPayBill';

  const partyA = String(input.partyA || s.senderShortcode).replace(/\s/g, '');
  const partyB = String(input.partyB).replace(/\s/g, '');
  const senderType = String(input.senderIdentifierType || '4');
  const receiverType = String(input.receiverIdentifierType || '4');

  const problems = validate({
    amount: input.amount,
    partyA,
    partyB,
    commandId,
    resultUrl: input.resultUrl || s.resultUrl,
    timeoutUrl: input.timeoutUrl || s.timeoutUrl,
  });
  if (problems.length) {
    const err = new Error(problems.join(' '));
    err.status = 400;
    throw err;
  }

  if (!input.initiatorName && !s.initiatorName) {
    const err = new Error(
      'Initiator name is missing. Add MPESA_INITIATOR_NAME (the API operator username from Daraja).'
    );
    err.status = 400;
    throw err;
  }

  const token = await getAccessToken();
  const credential = securityCredential(input.securityCredential);

  const payload = {
    Initiator: input.initiatorName || s.initiatorName,
    SecurityCredential: credential,
    CommandID: commandId,
    SenderIdentifierType: senderType,
    RecieverIdentifierType: receiverType,
    Amount: Math.round(Number(input.amount)),
    PartyA: partyA,
    PartyB: partyB,
    AccountReference: String(input.accountReference || 'JimmyPro').slice(0, 12),
    Remarks: String(input.remarks || 'B2B payment').slice(0, 100),
    QueueTimeOutURL: input.timeoutUrl || s.timeoutUrl,
    ResultURL: input.resultUrl || s.resultUrl,
  };

  const { ok, status, body } = await darajaFetch(endpoints.url(s.environment, 'b2bPayment'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseCode = body.ResponseCode !== undefined ? String(body.ResponseCode) : null;

  if (!ok || responseCode !== '0') {
    const detail =
      body.errorMessage ||
      body.ResponseDescription ||
      body.error_description ||
      `HTTP ${status}`;
    const err = new Error(`M-Pesa rejected the B2B request: ${detail}`);
    err.safaricom = body;
    err.status = 502;
    throw err;
  }

  return {
    responseCode,
    responseDescription: body.ResponseDescription || 'Accepted for processing',
    conversationId: body.ConversationID || null,
    originatorConversationId: body.OriginatorConversationID || null,
    raw: body,
    request: { ...payload, SecurityCredential: '***' },
  };
}

/** Flatten the async result Safaricom posts to ResultURL. */
function parseResult(body) {
  const result = body?.Result;
  if (!result) return null;
  const params = {};
  for (const item of result.ResultParameters?.ResultParameter || []) {
    params[item.Key] = item.Value;
  }
  return {
    resultCode: String(result.ResultCode),
    resultDesc: result.ResultDesc,
    conversationId: result.ConversationID,
    originatorConversationId: result.OriginatorConversationID,
    transactionId: result.TransactionID,
    params,
  };
}

module.exports = { COMMANDS, IDENTIFIER_TYPES, validate, sendPayment, parseResult };
