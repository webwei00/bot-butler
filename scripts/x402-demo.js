#!/usr/bin/env node
// x402 pay-per-call demo — the full handshake against the real server, end to
// end, zero dependencies:
//
//   1. Spawn `src/server.js` with X402_MODE=mock on a scratch port.
//   2. POST /api/propose with NO payment  -> expect HTTP 402 + PAYMENT-REQUIRED.
//   3. Decode the challenge (base64 JSON {x402Version, resource, accepts:[...]})
//      and pick accepts[0].
//   4. Build a mock exact-scheme PaymentPayload covering the price.
//   5. Retry with PAYMENT-SIGNATURE        -> expect 200 + PAYMENT-RESPONSE receipt
//      (v2 header; legacy X-PAYMENT           + the actual bot proposal.
//      is also still accepted)
//   6. Also show GET /api/health stays free (no 402).
//
//   npm run x402-demo
//
// Exits non-zero unless every leg of the handshake behaves — self-verifying,
// like `npm run demo`.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number.parseInt(process.env.X402_DEMO_PORT ?? '', 10) || 4177;
const BASE = `http://localhost:${PORT}`;

const b64json = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const fromB64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

function fail(msg) {
  console.error(`\nx402 demo FAILED: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), X402_MODE: 'mock', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 10s')), 10_000);
    child.stdout.on('data', (buf) => {
      if (String(buf).includes(`http://localhost:${PORT}`)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}) — is port ${PORT} free?`));
    });
  });
}

async function main() {
  console.log('\nX402 PAY-PER-CALL DEMO — Bot Butler (X402_MODE=mock)');
  console.log('─'.repeat(60));

  const server = await startServer();
  try {
    // -- free route stays free ------------------------------------------------
    const health = await fetch(`${BASE}/api/health`);
    if (health.status !== 200) fail(`/api/health should be free, got ${health.status}`);
    console.log(`\n[0] GET /api/health (free route)        -> ${health.status} OK, no payment asked`);

    // -- leg 1: unpaid call -> 402 challenge ----------------------------------
    const ask = { budget: 500, risk: 'medium', preference: 'majors' };
    const r1 = await fetch(`${BASE}/api/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ask),
    });
    if (r1.status !== 402) fail(`unpaid POST /api/propose should be 402, got ${r1.status}`);
    const challengeB64 = r1.headers.get('payment-required');
    if (!challengeB64) fail('402 response is missing the PAYMENT-REQUIRED header');
    const challenge = fromB64(challengeB64);
    if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
      fail('decoded PAYMENT-REQUIRED challenge has no accepts[] entries');
    }
    const requirements = challenge.accepts[0];
    console.log(`\n[1] POST /api/propose, no payment       -> 402 Payment Required`);
    console.log(`    PAYMENT-REQUIRED challenge decoded (x402Version ${challenge.x402Version}, ` +
      `resource ${challenge.resource}, ${challenge.accepts.length} accepts):`);
    console.log(`    using accepts[0]:`);
    console.log(
      `      pay ${Number(requirements.maxAmountRequired) / 10 ** requirements.extra.decimals} ` +
        `${requirements.extra.name} on ${requirements.network} (scheme '${requirements.scheme}')`
    );
    console.log(`      to ${requirements.payTo}`);
    console.log(`      asset ${requirements.asset}  resource ${requirements.resource}`);

    // -- leg 2: build a mock PaymentPayload from the challenge ----------------
    const paymentPayload = {
      x402Version: requirements.x402Version,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: {
        // exact-scheme EIP-3009 style authorization, mock-signed
        signature: '0x' + 'ab'.repeat(65),
        authorization: {
          from: '0x1111111111111111111111111111111111111111', // demo payer wallet
          to: requirements.payTo,
          value: requirements.maxAmountRequired, // pay exactly the asked amount
          validAfter: '0',
          validBefore: String(Math.floor(Date.now() / 1000) + requirements.maxTimeoutSeconds),
          nonce: '0x' + '42'.repeat(32),
        },
      },
    };
    console.log(`\n[2] Built mock PaymentPayload (exact scheme, ${requirements.maxAmountRequired} base units)`);

    // -- leg 3: retry with PAYMENT-SIGNATURE (v2) -> 200 + receipt + proposal --
    const r2 = await fetch(`${BASE}/api/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': b64json(paymentPayload) },
      body: JSON.stringify(ask),
    });
    if (r2.status !== 200) {
      fail(`paid POST /api/propose should be 200, got ${r2.status}: ${await r2.text()}`);
    }
    const receiptB64 = r2.headers.get('payment-response');
    if (!receiptB64) fail('200 response is missing the PAYMENT-RESPONSE header');
    const receipt = fromB64(receiptB64);
    if (!receipt.success || !/^0x[0-9a-f]{64}$/.test(receipt.transaction)) {
      fail(`receipt malformed: ${JSON.stringify(receipt)}`);
    }
    const result = await r2.json();
    if (!result.ok || !result.proposal) fail('paid call did not return a proposal');

    console.log(`\n[3] Retried with PAYMENT-SIGNATURE      -> 200 OK`);
    console.log(`    PAYMENT-RESPONSE receipt decoded:`);
    console.log(`      status      ${receipt.status}`);
    console.log(`      transaction ${receipt.transaction}`);
    console.log(`      network     ${receipt.network}   payer ${receipt.payer}`);
    const p = result.proposal;
    console.log(`\n    ...and the paid-for proposal:`);
    console.log(`      ${p.id}: ${p.botType} bot on ${p.instId}, invest $${p.investment}`);
    if (p.params?.lower != null) {
      console.log(`      range $${p.params.lower} - $${p.params.upper} (${p.params.gridCount} grids)`);
    }

    // -- leg 4: legacy X-PAYMENT header is still accepted ----------------------
    const r3 = await fetch(`${BASE}/api/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': b64json(paymentPayload) },
      body: JSON.stringify(ask),
    });
    if (r3.status !== 200) fail(`legacy X-PAYMENT retry should be 200, got ${r3.status}`);
    console.log(`\n[4] Retried with legacy X-PAYMENT       -> 200 OK (v1 header still supported)`);

    // -- leg 5: bad payment is rejected ---------------------------------------
    const r4 = await fetch(`${BASE}/api/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': 'not-base64-json!!!' },
      body: JSON.stringify(ask),
    });
    const r4body = await r4.json();
    if (r4.status !== 402 || !r4body.error) fail(`garbage PAYMENT-SIGNATURE should be 402 + error, got ${r4.status}`);
    console.log(`\n[5] Garbage PAYMENT-SIGNATURE           -> 402 again (error: ${r4body.error})`);

    console.log('\n' + '─'.repeat(60));
    console.log('x402 handshake PASS: 402 challenge -> mock pay -> 200 + receipt.');
    console.log('Set X402_MODE=off (default) to run the API unmetered.\n');
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err.message);
});
