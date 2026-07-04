// Unit tests: x402 payment gate + mock facilitator (challenge shape, amount
// math, off-mode passthrough, mock verify/settle round trip, bad payments).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createX402Gate,
  buildPaymentRequirements,
  buildChallengePayload,
  paymentRequiredResponse,
  pickPaymentHeader,
  x402Mode,
} from '../src/x402/gate.js';
import {
  createFacilitatorAdapter,
  encodeB64Json,
  decodeB64Json,
} from '../src/adapters/facilitator.js';

const REQS = buildPaymentRequirements();

/** A well-formed exact-scheme PaymentPayload covering the asked price. */
function goodPayload(overrides = {}) {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:196',
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: REQS.payTo,
        value: REQS.maxAmountRequired,
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 60),
        nonce: '0x' + '42'.repeat(32),
      },
    },
    ...overrides,
  };
}

// --- mode plumbing ----------------------------------------------------------

test('x402: default mode is off (no env)', () => {
  const prev = process.env.X402_MODE;
  delete process.env.X402_MODE;
  try {
    assert.equal(x402Mode(), 'off');
  } finally {
    if (prev !== undefined) process.env.X402_MODE = prev;
  }
});

test('x402: off mode gate is disabled and always grants (passthrough)', async () => {
  const gate = createX402Gate({ mode: 'off' });
  assert.equal(gate.enabled, false);
  // No header, garbage header, good header — all pass, no facilitator involved.
  for (const header of [undefined, 'garbage!!!', encodeB64Json(goodPayload())]) {
    const verdict = await gate.check(header);
    assert.deepEqual(verdict, { ok: true, receipt: null });
  }
});

// --- challenge shape ---------------------------------------------------------

test('x402: PaymentRequirements has the exact listed-service shape', () => {
  assert.equal(REQS.x402Version, 1);
  assert.equal(REQS.scheme, 'exact');
  assert.equal(REQS.network, 'eip155:196');
  assert.equal(REQS.resource, '/api/propose');
  assert.equal(REQS.mimeType, 'application/json');
  assert.equal(REQS.maxTimeoutSeconds, 60);
  assert.equal(REQS.asset, '0x779ded0c9e1022225f8e0630b35a9b54be713736');
  assert.deepEqual(REQS.extra, { name: 'USDT', decimals: 6 });
  assert.ok(REQS.payTo.startsWith('0x'));
  assert.ok(REQS.description.includes('grid/DCA'));
});

test('x402: amount math — 8 USDT at 6 decimals = "8000000" base units', () => {
  assert.equal(REQS.maxAmountRequired, String(8 * 10 ** REQS.extra.decimals));
  assert.equal(REQS.maxAmountRequired, '8000000');
});

test('x402: PAYMENT-REQUIRED header decodes to the FULL challenge (accepts[] inside)', () => {
  const r = paymentRequiredResponse(REQS);
  assert.equal(r.status, 402);
  // OKX's validator decodes this header and reads accepts[] from it — a bare
  // PaymentRequirements object would be rejected as "accepts is empty".
  const decoded = decodeB64Json(r.headers['PAYMENT-REQUIRED']);
  assert.deepEqual(decoded, {
    x402Version: 1,
    resource: REQS.resource,
    accepts: [REQS],
  });
  assert.deepEqual(decoded, buildChallengePayload(REQS));
  assert.ok(Array.isArray(decoded.accepts) && decoded.accepts.length > 0);
  // 402 JSON body echoes the same challenge fields.
  assert.equal(r.body.ok, false);
  assert.equal(r.body.x402Version, 1);
  assert.equal(r.body.resource, REQS.resource);
  assert.deepEqual(r.body.accepts, [REQS]);
  assert.equal(r.body.error, undefined); // plain challenge has no error field
  const rejected = paymentRequiredResponse(REQS, 'nope');
  assert.equal(rejected.body.error, 'nope');
});

test('x402: pickPaymentHeader prefers PAYMENT-SIGNATURE (v2), falls back to X-PAYMENT', () => {
  assert.equal(pickPaymentHeader({}), undefined);
  assert.equal(pickPaymentHeader({ 'x-payment': 'legacy' }), 'legacy');
  assert.equal(pickPaymentHeader({ 'payment-signature': 'v2' }), 'v2');
  assert.equal(pickPaymentHeader({ 'payment-signature': 'v2', 'x-payment': 'legacy' }), 'v2');
});

test('x402: unpaid request through a mock gate -> 402 challenge, no error', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  assert.equal(gate.enabled, true);
  const verdict = await gate.check(undefined);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 402);
  assert.equal(verdict.error, null);
  assert.equal(verdict.requirements.maxAmountRequired, '8000000');
});

// --- mock facilitator round trip ---------------------------------------------

test('x402: mock round trip pays via PAYMENT-SIGNATURE (v2) — gate grants with receipt', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  const headers = { 'payment-signature': encodeB64Json(goodPayload()) };
  const verdict = await gate.check(pickPaymentHeader(headers));
  assert.equal(verdict.ok, true);
  const r = verdict.receipt;
  assert.equal(r.success, true);
  assert.equal(r.status, 'success');
  assert.equal(r.network, 'eip155:196');
  assert.equal(r.payer, '0x1111111111111111111111111111111111111111');
  assert.match(r.transaction, /^0x[0-9a-f]{64}$/);
});

test('x402: legacy X-PAYMENT round trip still pays — gate grants with receipt', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  const headers = { 'x-payment': encodeB64Json(goodPayload()) };
  const verdict = await gate.check(pickPaymentHeader(headers));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.receipt.success, true);
  assert.match(verdict.receipt.transaction, /^0x[0-9a-f]{64}$/);
});

test('x402: mock settle transaction is deterministic from the payload hash', async () => {
  const fac = createFacilitatorAdapter({ mode: 'mock' });
  const header = encodeB64Json(goodPayload());
  const a = await fac.settle(header, REQS);
  const b = await fac.settle(header, REQS);
  assert.equal(a.transaction, b.transaction);
  const expected = '0x' + crypto.createHash('sha256').update(header).digest('hex');
  assert.equal(a.transaction, expected);
  // A different payment lands in a different "transaction".
  const other = await fac.settle(encodeB64Json(goodPayload({ network: 'eip155:196', nonceSalt: 1 })), REQS);
  assert.notEqual(other.transaction, a.transaction);
});

test('x402: overpaying (declared amount > required) still verifies', async () => {
  const fac = createFacilitatorAdapter({ mode: 'mock' });
  const p = goodPayload();
  p.payload.authorization.value = '9000000'; // 9 USDT >= 8 USDT
  const v = await fac.verify(encodeB64Json(p), REQS);
  assert.equal(v.isValid, true);
});

// --- bad payments are rejected -------------------------------------------------

test('x402: rejects X-PAYMENT that is not base64 JSON', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  const verdict = await gate.check('!!!not-base64-json!!!');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 402);
  assert.match(verdict.error, /base64/i);
});

test('x402: rejects scheme mismatch', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  const verdict = await gate.check(encodeB64Json(goodPayload({ scheme: 'upto' })));
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /scheme mismatch/i);
});

test('x402: rejects network mismatch', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  const verdict = await gate.check(encodeB64Json(goodPayload({ network: 'eip155:1' })));
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /network mismatch/i);
});

test('x402: rejects underpayment (7.999999 USDT < 8 USDT)', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  const p = goodPayload();
  p.payload.authorization.value = '7999999';
  const verdict = await gate.check(encodeB64Json(p));
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /does not cover/i);
});

test('x402: rejects payload with no declared amount', async () => {
  const gate = createX402Gate({ mode: 'mock' });
  const p = goodPayload();
  delete p.payload.authorization.value;
  const verdict = await gate.check(encodeB64Json(p));
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /does not cover/i);
});

// --- real mode guard rails -----------------------------------------------------

test('x402: real mode with no creds fails fast at adapter creation', () => {
  for (const k of ['OKX_X402_API_KEY', 'OKX_X402_SECRET', 'OKX_X402_PASSPHRASE']) {
    assert.equal(process.env[k], undefined, `test requires ${k} unset`);
  }
  assert.throws(
    () => createFacilitatorAdapter({ mode: 'real' }),
    (err) => err.code === 'X402_REAL_NOT_CONFIGURED'
  );
});

test('x402: X402_PAY_TO env overrides the payTo placeholder', () => {
  const prev = process.env.X402_PAY_TO;
  process.env.X402_PAY_TO = '0x2222222222222222222222222222222222222222';
  try {
    assert.equal(buildPaymentRequirements().payTo, '0x2222222222222222222222222222222222222222');
  } finally {
    if (prev === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = prev;
  }
});
