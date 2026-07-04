// x402 facilitator adapter — THE single seam for payment verification and
// settlement, mirroring the okx.js / llm.js adapter pattern: mock mode is a
// fully working in-process simulation, real mode targets OKX's x402
// facilitator API and fails fast until credentials exist.
//
//   X402_MODE=off  (default)  No facilitator is ever consulted — the gate in
//                             src/x402/gate.js is a no-op and this module is
//                             never exercised.
//   X402_MODE=mock            In-process verify/settle. verify() checks the
//                             PaymentPayload is well-formed base64 JSON whose
//                             scheme/network match the PaymentRequirements and
//                             whose declared amount covers the price. settle()
//                             returns a deterministic receipt whose fake tx
//                             hash is SHA-256 of the payload — same payment,
//                             same "transaction", so demos are reproducible.
//   X402_MODE=real            POSTs to OKX's x402 facilitator endpoints:
//                               POST https://web3.okx.com/api/v6/pay/x402/verify
//                               POST https://web3.okx.com/api/v6/pay/x402/settle
//                             body: { paymentPayload, paymentRequirements }
//                             signed with OKX v5-style HMAC headers (see
//                             signedHeaders below). Requires env:
//                               OKX_X402_API_KEY, OKX_X402_SECRET,
//                               OKX_X402_PASSPHRASE
//                             Missing creds -> fail fast at adapter creation.
//
// NOTE (ASSUMED, flagged in STATUS.md): the real endpoint paths and the exact
// header names (OK-ACCESS-KEY / OK-ACCESS-SIGN / OK-ACCESS-TIMESTAMP /
// OK-ACCESS-PASSPHRASE) follow OKX's v5 REST signing convention and are
// pending confirmation against the published x402 facilitator docs. The
// official SDKs (@okxweb3/x402-core, x402-express, x402-evm) are the
// alternative once npm dependencies are allowed.

import crypto from 'node:crypto';

const FACILITATOR_BASE = 'https://web3.okx.com';
const VERIFY_PATH = '/api/v6/pay/x402/verify';
const SETTLE_PATH = '/api/v6/pay/x402/settle';

/** Decode a base64(JSON) string; returns null (never throws) on garbage. */
export function decodeB64Json(b64) {
  try {
    return JSON.parse(Buffer.from(String(b64 ?? ''), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Encode an object as base64(JSON) — the x402 header wire format. */
export function encodeB64Json(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Dig the declared amount out of a PaymentPayload (exact-scheme shapes). */
function declaredAmount(payload) {
  return (
    payload?.payload?.authorization?.value ??
    payload?.payload?.value ??
    payload?.value ??
    null
  );
}

/** Dig the payer address out of a PaymentPayload (exact-scheme shapes). */
function declaredPayer(payload) {
  return (
    payload?.payload?.authorization?.from ??
    payload?.payload?.from ??
    payload?.from ??
    null
  );
}

export function createFacilitatorAdapter({ mode = (process.env.X402_MODE || 'off').toLowerCase() } = {}) {
  if (mode === 'real') return realFacilitator();
  return mockFacilitator(mode);
}

// --------------------------------------------------------------------------
// mock: in-process facilitator

function mockFacilitator(mode) {
  return {
    mode,

    /**
     * @param {string} paymentHeaderB64 raw payment header (base64 JSON) —
     *   PAYMENT-SIGNATURE (v2) or legacy X-PAYMENT, same encoding
     * @param {object} requirements    PaymentRequirements the challenge advertised
     * @returns {{isValid: boolean, invalidReason?: string, payer?: string}}
     */
    async verify(paymentHeaderB64, requirements) {
      const payload = decodeB64Json(paymentHeaderB64);
      if (!payload || typeof payload !== 'object') {
        return { isValid: false, invalidReason: 'Payment header (PAYMENT-SIGNATURE or X-PAYMENT) is not valid base64-encoded JSON.' };
      }
      if (payload.scheme !== requirements.scheme) {
        return { isValid: false, invalidReason: `Scheme mismatch: expected '${requirements.scheme}', got '${payload.scheme}'.` };
      }
      if (payload.network !== requirements.network) {
        return { isValid: false, invalidReason: `Network mismatch: expected '${requirements.network}', got '${payload.network}'.` };
      }
      const amount = declaredAmount(payload);
      const required = BigInt(requirements.maxAmountRequired);
      let amountOk = false;
      try {
        amountOk = amount != null && BigInt(String(amount)) >= required;
      } catch {
        amountOk = false;
      }
      if (!amountOk) {
        return {
          isValid: false,
          invalidReason: `Declared amount '${amount}' does not cover the required ${requirements.maxAmountRequired} (${requirements.extra?.name ?? 'token'} base units).`,
        };
      }
      return { isValid: true, payer: declaredPayer(payload) ?? 'unknown' };
    },

    /**
     * Deterministic mock settlement: tx hash = SHA-256 of the raw payment
     * header, so the same payment always "lands" in the same transaction.
     * @returns {{success: boolean, transaction: string, network: string, payer: string, status: string}}
     */
    async settle(paymentHeaderB64, requirements) {
      const payload = decodeB64Json(paymentHeaderB64);
      const hash = crypto.createHash('sha256').update(String(paymentHeaderB64 ?? '')).digest('hex');
      return {
        success: true,
        transaction: `0x${hash}`,
        network: requirements.network,
        payer: declaredPayer(payload) ?? 'unknown',
        status: 'success',
      };
    },
  };
}

// --------------------------------------------------------------------------
// real: OKX x402 facilitator over HTTPS

function realFacilitator() {
  const key = process.env.OKX_X402_API_KEY;
  const secret = process.env.OKX_X402_SECRET;
  const passphrase = process.env.OKX_X402_PASSPHRASE;
  if (!key || !secret || !passphrase) {
    // Fail fast — a paid gate must never silently wave callers through.
    const err = new Error(
      '[x402 real mode] Missing facilitator credentials.\n' +
        '  Required env: OKX_X402_API_KEY, OKX_X402_SECRET, OKX_X402_PASSPHRASE\n' +
        '  (OKX dev-portal x402 facilitator keys). Run with X402_MODE=mock for the demo,\n' +
        '  or X402_MODE=off to disable the payment gate entirely.'
    );
    err.code = 'X402_REAL_NOT_CONFIGURED';
    throw err;
  }

  /**
   * OKX v5-style request signing. ASSUMED header names pending confirmation
   * against the x402 facilitator docs:
   *   OK-ACCESS-SIGN = base64( HMAC-SHA256( timestamp + method + requestPath + body, secret ) )
   */
  function signedHeaders(method, requestPath, bodyStr) {
    const timestamp = new Date().toISOString();
    const sign = crypto
      .createHmac('sha256', secret)
      .update(timestamp + method + requestPath + bodyStr)
      .digest('base64');
    return {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': key,           // ASSUMED header name
      'OK-ACCESS-SIGN': sign,         // ASSUMED header name
      'OK-ACCESS-TIMESTAMP': timestamp, // ASSUMED header name
      'OK-ACCESS-PASSPHRASE': passphrase, // ASSUMED header name
    };
  }

  async function post(requestPath, paymentHeaderB64, requirements) {
    const paymentPayload = decodeB64Json(paymentHeaderB64);
    if (!paymentPayload) {
      return { isValid: false, invalidReason: 'Payment header (PAYMENT-SIGNATURE or X-PAYMENT) is not valid base64-encoded JSON.' };
    }
    const bodyStr = JSON.stringify({ paymentPayload, paymentRequirements: requirements });
    const res = await fetch(FACILITATOR_BASE + requestPath, {
      method: 'POST',
      headers: signedHeaders('POST', requestPath, bodyStr),
      body: bodyStr,
    });
    if (!res.ok) {
      throw new Error(`[x402 facilitator] ${requestPath} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  return {
    mode: 'real',
    async verify(paymentHeaderB64, requirements) {
      return post(VERIFY_PATH, paymentHeaderB64, requirements);
    },
    async settle(paymentHeaderB64, requirements) {
      return post(SETTLE_PATH, paymentHeaderB64, requirements);
    },
  };
}
