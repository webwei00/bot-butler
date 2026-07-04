#!/usr/bin/env node
// Bot Butler web layer — concierge dashboard + JSON service API. Zero
// dependencies: node:http serving one self-contained HTML file, driving the
// exact same engine the CLI uses. Web and CLI share state/butler-state.json,
// so they operate the same simulated world interchangeably.
//
//   npm run serve                      -> http://localhost:4102
//   $env:PORT=4200; npm run serve      -> port override (PowerShell)
//
// API (full contract documented in STATUS.md — this is the surface a
// pay-per-call service listing would meter):
//   GET  /api/health    liveness probe -> { ok: true, ... }
//   GET  /api/status    market snapshot, bots + P&L, action log, caps
//   POST /api/propose   { budget, risk, preference } or { ask } -> proposal
//                       THE pay-per-call route: when X402_MODE=mock|real it is
//                       gated by the x402 payment handshake (src/x402/gate.js);
//                       default X402_MODE=off leaves it open exactly as before
//   POST /api/launch    { proposalId? } — THE explicit confirmation step;
//                       hard caps re-checked, cap violations return 400
//   POST /api/tick      { ticks? } -> advance the steward loop (max 24/call)
//   GET  /api/digest    today's digest, read-only preview (the CLI `digest`
//                       command is what writes the file and closes the day)
//
// Mutating handlers are serialized through a promise queue so an auto-ticking
// dashboard can never interleave with a launch mid-save.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CAPS, MAJORS, okxMode } from './config.js';
import { loadState, loadOrInitState, saveState } from './state.js';
import { createOkxAdapter } from './adapters/okx.js';
import { createLlmAdapter } from './adapters/llm.js';
import { buildProposal, parseAsk } from './strategist.js';
import { launchProposal } from './launch.js';
import { runTick } from './steward.js';
import { buildDigest } from './digest.js';
import { detectRegime } from './regime.js';
import {
  createX402Gate,
  paymentRequiredResponse,
  pickPaymentHeader,
  encodeB64Json,
} from './x402/gate.js';
import { c, hr, round2 } from './util.js';

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 4102;
const HTML_PATH = path.join(ROOT, 'web', 'index.html');
const RISK_ALIASES = { low: 'low', med: 'medium', medium: 'medium', high: 'high' };

// --------------------------------------------------------------------------
// plumbing

function makeCtx(state) {
  return { state, okx: createOkxAdapter({ state }), llm: createLlmAdapter({}) };
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

/** Map a thrown error onto an HTTP status; flag safety-rail/cap violations. */
function toHttpError(err, fallbackStatus) {
  if (err.status) return err;
  if (err.code === 'OKX_REAL_NOT_WIRED' || err.code === 'LLM_REAL_NOT_WIRED') {
    err.status = 501;
    return err;
  }
  err.status = fallbackStatus;
  err.rail = /^(cap|safety rail)/i.test(err.message);
  return err;
}

// Serialize state-touching handlers: one at a time, in arrival order.
let queueTail = Promise.resolve();
function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
    ...extraHeaders,
  });
  res.end(body);
}

// --------------------------------------------------------------------------
// API handlers

async function apiHealth() {
  return { ok: true, service: 'bot-butler', mode: okxMode(), simulated: okxMode() === 'mock' };
}

async function apiStatus() {
  const state = loadOrInitState(); // first web visit initializes a fresh simulated world
  const ctx = makeCtx(state);

  const instruments = await ctx.okx.listInstruments();
  const market = [];
  for (const inst of instruments.filter((i) => i.major)) {
    const candles = await ctx.okx.fetchCandles(inst.instId, { limit: 60 });
    const m = detectRegime(candles);
    market.push({
      instId: inst.instId,
      price: m.price,
      atrPct: round2(m.atrPct),
      trendScore: round2(m.trendScore),
      regime: m.regime,
    });
  }

  const bots = [];
  for (const b of state.bots) {
    const s = await ctx.okx.getBot(b.id);
    bots.push({
      ...s,
      realizedPnl: round2(s.realizedPnl),
      unrealizedPnl: round2(s.unrealizedPnl),
      totalPnl: round2(s.totalPnl),
      fees: round2(s.fees),
    });
  }
  const active = bots.filter((b) => b.status !== 'stopped');

  return {
    ok: true,
    mode: ctx.okx.mode,
    simulated: ctx.okx.mode === 'mock',
    tick: state.market?.tick ?? null,
    caps: CAPS,
    majors: MAJORS,
    market,
    bots,
    totals: {
      invested: round2(active.reduce((s, b) => s + b.investment, 0)),
      totalPnl: round2(bots.reduce((s, b) => s + b.totalPnl, 0)),
      fills: bots.reduce((s, b) => s + b.fills, 0),
      activeBots: active.length,
    },
    pendingProposals: state.proposals
      .filter((p) => p.status === 'proposed')
      .map((p) => ({ id: p.id, instId: p.instId, botType: p.botType, investment: p.investment })),
    actions: state.actions.slice(-80),
    actionCount: state.actions.length,
  };
}

async function apiPropose(body) {
  const state = loadOrInitState();
  const ctx = makeCtx(state);

  const parsed = body.ask ? parseAsk(String(body.ask)) : {};
  const riskRaw = String(body.risk ?? parsed.risk ?? 'medium').toLowerCase();
  const input = {
    budget: Number(body.budget ?? parsed.budget),
    risk: RISK_ALIASES[riskRaw] ?? riskRaw,
    preference: String(body.preference ?? parsed.preference ?? 'majors'),
  };
  if (!Number.isFinite(input.budget)) {
    throw httpError(400, 'Budget is required — e.g. { "budget": 500, "risk": "medium", "preference": "majors" }.');
  }

  try {
    const proposal = await buildProposal(ctx, input);
    saveState(state);
    return { ok: true, proposal };
  } catch (err) {
    throw toHttpError(err, 400);
  }
}

async function apiLaunch(body) {
  const state = loadState();
  if (!state) throw httpError(400, 'No proposals exist yet — request a proposal first.');
  const ctx = makeCtx(state);

  const proposalId =
    body.proposalId ?? state.proposals.filter((p) => p.status === 'proposed').at(-1)?.id;
  if (!proposalId) throw httpError(400, 'No pending proposal to launch — request a proposal first.');

  try {
    // The POST itself is the explicit confirmation (the dashboard's
    // "Confirm & launch" button). Hard caps are re-checked inside.
    const bot = await launchProposal(ctx, proposalId, { confirmedBy: 'web UI — Confirm & launch button' });
    saveState(state);
    const snapshot = await ctx.okx.getBot(bot.id);
    return { ok: true, proposalId, bot: snapshot };
  } catch (err) {
    throw toHttpError(err, 400);
  }
}

async function apiTick(body) {
  const state = loadOrInitState();
  const ctx = makeCtx(state);
  const n = Math.max(1, Math.min(24, Number(body?.ticks) || 1));

  const actions = [];
  let fills = 0;
  for (let i = 0; i < n; i++) {
    const report = await runTick(ctx);
    actions.push(...report.actions);
    fills += report.fills ?? 0;
  }
  saveState(state);

  return {
    ok: true,
    ticked: n,
    tick: state.market?.tick ?? null,
    fills,
    actions,
    bots: state.bots
      .filter((b) => b.status !== 'stopped')
      .map((b) => ({ botId: b.id, instId: b.instId, status: b.status })),
  };
}

async function apiDigest() {
  const state = loadOrInitState();
  const ctx = makeCtx(state);
  const digest = await buildDigest(ctx); // read-only: does not move lastDigestAt or write the file
  return {
    ok: true,
    date: digest.date,
    markdown: digest.markdown,
    actions: digest.actions,
    totalPnl: round2(digest.totalPnl),
    note: 'Read-only preview. `node src/index.js digest` writes out/digest-<date>.md and marks the day reported.',
  };
}

// --------------------------------------------------------------------------
// routing

const ROUTES = {
  'GET /api/health': { handler: apiHealth, fallbackStatus: 500 },
  'GET /api/status': { handler: apiStatus, fallbackStatus: 500 },
  // `paid` = x402-gated when X402_MODE != off. ONLY the listed entry point is
  // metered; launch/tick/status/digest on a paid mandate stay free, as do the
  // dashboard UI and /api/health.
  'POST /api/propose': { handler: apiPropose, fallbackStatus: 400, paid: true },
  'POST /api/launch': { handler: apiLaunch, fallbackStatus: 400 },
  'POST /api/tick': { handler: apiTick, fallbackStatus: 500 },
  'GET /api/digest': { handler: apiDigest, fallbackStatus: 500 },
};

async function handle(req, res) {
  const started = Date.now();
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${pathname}`;

  const done = (status) => {
    const tone = status < 400 ? c.dim : c.yellow;
    console.log(tone(`[web] ${key} -> ${status} (${Date.now() - started}ms)`));
  };

  // Settled-payment receipt for this request (x402). Declared out here so the
  // error path can still attach PAYMENT-RESPONSE — if settlement succeeded but
  // the handler then rejected the input, the caller deserves their receipt.
  let paymentReceipt = null;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return done(204);
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      let html;
      try {
        html = fs.readFileSync(HTML_PATH);
      } catch {
        sendJson(res, 500, { ok: false, error: `Dashboard file missing: ${HTML_PATH}` });
        return done(500);
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(html);
      return done(200);
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return done(204);
    }

    const route = ROUTES[key];
    if (!route) {
      sendJson(res, 404, {
        ok: false,
        error: `No such endpoint: ${key}`,
        endpoints: Object.keys(ROUTES),
      });
      return done(404);
    }

    // x402 payment gate — only for `paid` routes, only when X402_MODE != off.
    // Gate BEFORE reading the body/touching state: an unpaid call must never
    // do any work. See src/x402/gate.js for the handshake contract.
    if (route.paid) {
      const gate = createX402Gate();
      if (gate.enabled) {
        // v2 PAYMENT-SIGNATURE (what `onchainos payment pay` replays with)
        // first, legacy v1 X-PAYMENT as fallback — same base64-JSON payload.
        const verdict = await gate.check(pickPaymentHeader(req.headers));
        if (!verdict.ok) {
          const r = paymentRequiredResponse(verdict.requirements, verdict.error);
          sendJson(res, r.status, r.body, r.headers);
          return done(r.status);
        }
        paymentReceipt = verdict.receipt;
      }
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    // Serialize everything that touches state (including reads, so a status
    // snapshot can never observe a half-applied tick).
    const result = await enqueue(() => route.handler(body));
    sendJson(
      res,
      200,
      result,
      paymentReceipt ? { 'PAYMENT-RESPONSE': encodeB64Json(paymentReceipt) } : {}
    );
    return done(200);
  } catch (err) {
    const e = toHttpError(err, ROUTES[key]?.fallbackStatus ?? 500);
    sendJson(
      res,
      e.status,
      {
        ok: false,
        error: e.message,
        ...(e.rail ? { rail: true } : {}),
        ...(e.code ? { code: e.code } : {}),
      },
      paymentReceipt ? { 'PAYMENT-RESPONSE': encodeB64Json(paymentReceipt) } : {}
    );
    return done(e.status);
  }
}

// --------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(c.red(`[web] handler crash: ${err.message}`));
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal error.' });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(c.red(`Port ${PORT} is already in use. Set PORT to another port, e.g.  $env:PORT=4200; npm run serve`));
  } else {
    console.error(c.red(`Server error: ${err.message}`));
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const mode = okxMode();
  console.log('');
  console.log(c.bold('  BOT BUTLER') + c.dim(' — concierge dashboard & service API'));
  console.log(`  ${hr('─', 58)}`);
  console.log(`  ${c.bold(`http://localhost:${PORT}`)}   mode: ${mode === 'mock' ? c.yellow('MOCK (simulated market — demo)') : c.red('REAL')}`);
  console.log(c.dim('  API: /api/health /api/status /api/propose /api/launch /api/tick /api/digest'));
  console.log(c.dim(`  State shared with the CLI: state/butler-state.json`));
  console.log(c.dim('  Ctrl+C to stop.'));
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(c.dim('\n[web] shutting down — state is saved after every mutation.'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
