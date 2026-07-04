// x402 payment gate — HTTP 402 handshake for the paid entry point.
//
// The OKX.AI listing meters exactly ONE route: POST /api/propose (8 USDT per
// call — design + launch + ongoing stewardship of one bot). Everything after
// a paid proposal (launch/tick/status/digest) plus the dashboard UI and
// /api/health stay free; the gate never touches them.
//
// Flow (X402_MODE=mock|real):
//   1. Client POSTs /api/propose with no payment header
//      -> 402, header PAYMENT-REQUIRED: base64(JSON {x402Version, resource,
//         accepts:[PaymentRequirements]}) — the FULL challenge object. OKX's
//         x402 validator and `onchainos payment pay` decode this header and
//         read `accepts[]` from it; a bare PaymentRequirements object is
//         rejected as "accepts is empty". Small JSON body echoes the same
//         challenge.
//   2. Client signs the chosen accepts[] entry and retries with
//      PAYMENT-SIGNATURE: base64(JSON PaymentPayload)   (v2 — what
//      `onchainos payment pay` replays with), or the legacy v1 form
//      X-PAYMENT: base64(JSON PaymentPayload). Same base64-JSON decode both.
//   3. Gate: facilitator.verify() then facilitator.settle().
//      success -> handler runs normally + PAYMENT-RESPONSE: base64(JSON receipt)
//      failure -> 402 again, body carries an `error` field.
//
// X402_MODE=off (default): gate.enabled is false and the server skips the
// gate entirely — every route behaves exactly as it did before x402 existed.

import { createFacilitatorAdapter, encodeB64Json } from '../adapters/facilitator.js';

/** Gate mode: 'off' (default) | 'mock' | 'real'. */
export function x402Mode() {
  const m = (process.env.X402_MODE || 'off').toLowerCase();
  if (m !== 'off' && m !== 'mock' && m !== 'real') {
    throw new Error(`X402_MODE must be 'off', 'mock' or 'real' (got '${m}')`);
  }
  return m;
}

/**
 * PaymentRequirements for the listed service: 8 USDT on X Layer (eip155:196),
 * expressed in USDT base units (6 decimals): 8 * 10^6 = "8000000".
 */
export function buildPaymentRequirements() {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:196', // X Layer mainnet
    maxAmountRequired: '8000000', // 8 USDT x 10^6 (6-decimal base units)
    resource: '/api/propose',
    description: 'Risk-sized grid/DCA bot proposal with ongoing stewardship',
    mimeType: 'application/json',
    payTo: process.env.X402_PAY_TO || '0xREPLACE_OWNER_WALLET',
    maxTimeoutSeconds: 60,
    asset: '0x779ded0c9e1022225f8e0630b35a9b54be713736', // USDT on X Layer
    extra: { name: 'USDT', decimals: 6 },
  };
}

/**
 * Create the gate. In 'off' mode `enabled` is false and check() always
 * grants — callers should skip the gate entirely when !enabled.
 */
export function createX402Gate({ mode = x402Mode(), facilitator } = {}) {
  const enabled = mode !== 'off';
  const fac = enabled ? (facilitator ?? createFacilitatorAdapter({ mode })) : null;

  return {
    mode,
    enabled,
    requirements: buildPaymentRequirements,

    /**
     * Evaluate one gated request.
     * @param {string|undefined} paymentHeaderB64 raw payment header value —
     *   PAYMENT-SIGNATURE (v2) or legacy X-PAYMENT; same base64-JSON encoding
     * @returns {Promise<
     *   | { ok: true, receipt: object|null }
     *   | { ok: false, status: 402, error: string|null, requirements: object }
     * >}
     */
    async check(paymentHeaderB64) {
      if (!enabled) return { ok: true, receipt: null };
      const requirements = buildPaymentRequirements();

      if (!paymentHeaderB64) {
        // Challenge: no error field — this is the normal first leg of x402.
        return { ok: false, status: 402, error: null, requirements };
      }

      const verdict = await fac.verify(paymentHeaderB64, requirements);
      if (!verdict?.isValid) {
        return {
          ok: false,
          status: 402,
          error: verdict?.invalidReason ?? 'Payment verification failed.',
          requirements,
        };
      }

      const receipt = await fac.settle(paymentHeaderB64, requirements);
      if (!receipt?.success) {
        return {
          ok: false,
          status: 402,
          error: receipt?.errorReason ?? 'Payment settlement failed.',
          requirements,
        };
      }
      return { ok: true, receipt };
    },
  };
}

/**
 * Pick the payment retry header from an incoming request's (lowercased)
 * headers: PAYMENT-SIGNATURE (v2 — what `onchainos payment pay` replays with)
 * first, legacy X-PAYMENT as fallback. Both carry the same base64-JSON
 * PaymentPayload.
 */
export function pickPaymentHeader(headers = {}) {
  return headers['payment-signature'] ?? headers['x-payment'];
}

/**
 * Full v2 challenge object for the PAYMENT-REQUIRED header. OKX's x402
 * validator decodes the header and reads `accepts[]` from it — a bare
 * PaymentRequirements object fails with "accepts is empty".
 */
export function buildChallengePayload(requirements = buildPaymentRequirements()) {
  return {
    x402Version: 1,
    resource: requirements.resource,
    accepts: [requirements],
  };
}

/** Headers + body for a 402 response (challenge or rejection). */
export function paymentRequiredResponse(requirements, error = null) {
  return {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': encodeB64Json(buildChallengePayload(requirements)) },
    body: {
      ok: false,
      x402Version: 1,
      resource: requirements.resource,
      ...(error ? { error } : {}),
      accepts: [requirements],
      hint:
        'Payment required. Decode the PAYMENT-REQUIRED header (base64 JSON challenge with accepts[]), ' +
        'sign an accepts[] entry, then retry with PAYMENT-SIGNATURE: base64(JSON PaymentPayload) ' +
        '(legacy X-PAYMENT also accepted).',
    },
  };
}

export { encodeB64Json };
