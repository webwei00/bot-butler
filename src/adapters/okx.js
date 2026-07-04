// THE single OKX seam. Every exchange interaction — market data, bot
// create/pause/resume/stop/status/amend — goes through this adapter and
// nowhere else.
//
//   OKX_MODE=mock (default)  Fully working simulation: seeded random-walk
//                            market + discrete grid/DCA fill engines. State
//                            lives in the butler state file.
//   OKX_MODE=real            Marked stubs. Each throws OKX_REAL_NOT_WIRED with
//                            the exact `okx` CLI command (npm package
//                            @okx_ai/okx-trade-cli, from github.com/okx/agent-skills)
//                            the wiring is expected to shell out to, plus the
//                            required auth. Nothing real is callable until
//                            keys/login exist — by design.
//
// Real-mode wiring plan (when auth exists): `npm install @okx_ai/okx-trade-cli`
// (binary at ./node_modules/.bin/okx), replace each stub body with
// `execFile('./node_modules/.bin/okx', [...args, '--json'])`, parse the
// `{code, msg, data}` envelope from stdout, and map fields to the same return
// shapes the mock produces. Command names/flags below match the published
// skill docs and the CLI's own `okx list-tools --json` schema (v1.3.9);
// authed bot endpoints are documented-but-not-exercised until keys exist.

import { okxMode, FEE_RATE } from '../config.js';
import { nowIso } from '../util.js';
import * as market from '../mock/market.js';
import {
  initGridSim,
  processGridTick,
  gridUnrealized,
  rebaseGridSim,
  initDcaSim,
  processDcaTick,
  dcaUnrealized,
  rebaseDcaSim,
} from '../mock/gridsim.js';

const REQUIRED_ENV =
  'auth via `okx auth login --manual --site global --demo` (OAuth device flow) or an API-key profile in ' +
  '~/.okx/config.toml via `okx config init` (Read + Trade permissions only, never Withdraw; start on demo trading). ' +
  'Market-data commands are public and need no auth.';

// OKX public market data — no credentials needed. Used by real mode for the
// read-only strategist path (listInstruments / fetchCandles / fetchTicker).
const OKX_BASE = process.env.OKX_API_BASE_URL || 'https://www.okx.com';
const OKX_HTTP_TIMEOUT_MS = Number(process.env.OKX_HTTP_TIMEOUT_MS || 6000);
// Curated liquid majors (so we fetch a handful of candle series, not hundreds).
const REAL_MAJORS = [
  'BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT',
  'DOGE-USDT', 'ADA-USDT', 'AVAX-USDT', 'LINK-USDT', 'TON-USDT',
];

async function okxGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OKX_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${OKX_BASE}${path}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'bot-butler' },
    });
    if (!res.ok) throw new Error(`OKX HTTP ${res.status} for ${path}`);
    const json = await res.json();
    if (String(json.code) !== '0') throw new Error(`OKX API error ${json.code}: ${json.msg}`);
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

function realNotWired(what, cliExample, note = '') {
  const err = new Error(
    `[OKX real mode] '${what}' is not wired yet — no API keys exist.\n` +
      `  Expected integration (@okx_ai/okx-trade-cli):\n` +
      `    ${cliExample}\n` +
      `  Requires: ${REQUIRED_ENV}\n` +
      (note ? `  Note: ${note}\n` : '') +
      `  Run with OKX_MODE=mock (default) for the full simulation.`
  );
  err.code = 'OKX_REAL_NOT_WIRED';
  throw err;
}

/**
 * Create the adapter bound to a state object (mock mode reads/writes
 * `state.market` and the sim inside each `state.bots[]` record; real mode
 * ignores the market and stores exchange algoIds on the bot records).
 */
export function createOkxAdapter({ state, mode = okxMode() } = {}) {
  const mock = mode === 'mock';

  const mustMarket = () => {
    if (!state?.market) throw new Error('Mock market missing from state — run a command that initializes state first');
    return state.market;
  };
  const findBot = (botId) => {
    const bot = state.bots.find((b) => b.id === botId);
    if (!bot) throw new Error(`Unknown bot '${botId}'`);
    return bot;
  };

  return {
    mode,

    // ------------------------------------------------------------------ data
    /** List the tradable universe with major/alt flags. */
    async listInstruments() {
      if (mock) {
        return market.PAIR_META.map(({ instId, major }) => ({ instId, major }));
      }
      // Real: curated liquid majors (public data — no auth). Alts are marked
      // non-major so the majors-only rail behaves like the sim.
      return REAL_MAJORS.map((instId) => ({ instId, major: true }));
    },

    /** Hourly candles, oldest first: [{ ts, o, h, l, c, v }] */
    async fetchCandles(instId, { limit = 96 } = {}) {
      if (mock) return market.getCandles(mustMarket(), instId, limit);
      // Real: public candles (no auth). bar is '1H'; OKX returns NEWEST first,
      // so reverse to oldest-first to match the sim's contract.
      const rows = await okxGet(
        `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1H&limit=${limit}`
      );
      return rows
        .map((r) => ({
          ts: Number(r[0]), o: Number(r[1]), h: Number(r[2]),
          l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
        }))
        .reverse();
    },

    async fetchTicker(instId) {
      if (mock) return { instId, last: market.getPrice(mustMarket(), instId), ts: nowIso() };
      const d = await okxGet(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
      return { instId, last: Number(d[0].last), ts: nowIso() };
    },

    // ------------------------------------------------------------------ bots
    /**
     * Create a bot from a spec:
     *   { id, instId, type: 'grid'|'dca', params, investment }
     * Mock: initializes the fill simulator and marks it running.
     * Returns { botId, status }.
     */
    async createBot(spec) {
      if (mock) {
        const m = mustMarket();
        const launchPrice = market.getPrice(m, spec.instId);
        const bot = {
          ...spec,
          status: 'running',
          createdAt: nowIso(),
          createdAtTick: m.tick,
          launchPrice,
          pausedAtTick: null,
          outsideSinceTick: null,
          calmStreak: 0,
          lastResizeProposalTick: null,
          resizes: 0,
          sim:
            spec.type === 'grid'
              ? initGridSim(spec.params, launchPrice, FEE_RATE)
              : initDcaSim(spec.params, launchPrice, FEE_RATE),
        };
        state.bots.push(bot);
        return { botId: bot.id, status: bot.status };
      }
      const p = spec.params;
      realNotWired(
        'createBot',
        spec.type === 'grid'
          ? `okx bot grid create --instId ${spec.instId} --algoOrdType grid --minPx ${p.lower} --maxPx ${p.upper} --gridNum ${p.gridCount} --quoteSz ${spec.investment} --json   # WRITE; gridNum 2-100; rate limit 20 req/2s/UID`
          : `okx bot dca create --algoOrdType spot_dca --instId ${spec.instId} --direction long --initOrdAmt ${p.baseOrderQuote} --safetyOrdAmt ${p.baseOrderQuote} --maxSafetyOrds ${p.safetyOrders} --pxSteps ${(p.priceDeviationPct / 100).toFixed(4)} --volMult ${p.volumeScale} --tpPct ${(p.takeProfitPct / 100).toFixed(4)} --json   # WRITE (martingale)`,
        'Bots run server-side on OKX (stopping the CLI does not stop them). The algoId in the response is the handle for every later call — store it on the bot record, never fabricate it.'
      );
    },

    /**
     * Pause = stop filling but keep inventory.
     * OKX's public grid API has stop (with position handling) but no true
     * pause; real wiring emulates pause as stop --keep-position and resume as
     * re-create over the kept position, unless the bots skill exposes pause.
     */
    async pauseBot(botId) {
      if (mock) {
        const bot = findBot(botId);
        if (bot.status !== 'running') return { botId, status: bot.status, changed: false };
        bot.status = 'paused';
        return { botId, status: 'paused', changed: true };
      }
      realNotWired(
        'pauseBot',
        `okx bot grid stop --algoId <algoId> --algoOrdType grid --instId <instId> --stopType 1 --json   # stopType 1 = cancel orders, KEEP position (no native pause in the grid API)`
      );
    },

    async resumeBot(botId) {
      if (mock) {
        const bot = findBot(botId);
        if (bot.status !== 'paused') return { botId, status: bot.status, changed: false };
        bot.status = 'running';
        const price = market.getPrice(mustMarket(), bot.instId);
        // Orders were pulled while paused — resume from the current price, no phantom fills.
        if (bot.type === 'grid') rebaseGridSim(bot.sim, price);
        else rebaseDcaSim(bot.sim, price);
        return { botId, status: 'running', changed: true };
      }
      realNotWired(
        'resumeBot',
        `okx bot grid create --instId <instId> --algoOrdType grid ... (same params) --json   # re-create over the kept position; no native resume in the public grid API`
      );
    },

    async stopBot(botId) {
      if (mock) {
        const bot = findBot(botId);
        if (bot.status === 'stopped') return { botId, status: 'stopped', changed: false };
        // Liquidate remaining inventory at market into realized P&L.
        const price = market.getPrice(mustMarket(), bot.instId);
        if (bot.type === 'grid') {
          const u = gridUnrealized(bot.sim, price);
          bot.sim.realizedPnl += u;
          bot.sim.inventoryQty = 0;
          bot.sim.inventoryCost = 0;
        } else if (bot.sim.cycle) {
          bot.sim.realizedPnl += dcaUnrealized(bot.sim, price);
          bot.sim.cycle = null;
        }
        bot.status = 'stopped';
        bot.stoppedAt = nowIso();
        return { botId, status: 'stopped', changed: true };
      }
      realNotWired(
        'stopBot',
        `okx bot grid stop --algoId <algoId> --algoOrdType grid --instId <instId> --stopType 2 --json   # stopType 2 = cancel orders and market-sell base to quote (DCA: okx bot dca stop)`
      );
    },

    /**
     * Amend a grid's range. Semantically stop(keep position) + create(new
     * range); the CLI also exposes an in-place `grid amend` (maxPx/minPx/
     * gridNum) whose live-range semantics should be verified on demo trading
     * before relying on it. Mock keeps cumulative P&L on the same bot record.
     */
    async amendBotRange(botId, newParams) {
      if (mock) {
        const bot = findBot(botId);
        if (bot.type !== 'grid') throw new Error('amendBotRange only applies to grid bots');
        const price = market.getPrice(mustMarket(), bot.instId);
        // Close the old sim into realized, re-open with the new range.
        const u = gridUnrealized(bot.sim, price);
        const carried = bot.sim.realizedPnl + u;
        const carriedFees = bot.sim.fees;
        const carriedFills = bot.sim.fills;
        bot.params = { ...bot.params, ...newParams };
        bot.sim = initGridSim(bot.params, price, FEE_RATE);
        bot.sim.realizedPnl += carried;
        bot.sim.fees += carriedFees;
        bot.sim.fills += carriedFills;
        bot.resizes += 1;
        bot.status = 'running';
        return { botId, status: 'running', params: bot.params };
      }
      realNotWired(
        'amendBotRange',
        `okx bot grid amend --algoId <algoId> --minPx <newLower> --maxPx <newUpper> --gridNum <n> --json   # verify amend semantics on demo trading first; fallback: stop --stopType 1, then create with the new range`,
        'If in-place amend proves unsupported for full range moves, resize = stop(keep position) + re-create.'
      );
    },

    /** Snapshot of one bot incl. simulated P&L (mock) / exchange P&L (real). */
    async getBot(botId) {
      if (mock) {
        const bot = findBot(botId);
        const price =
          bot.status === 'stopped' ? bot.sim.lastPrice : market.getPrice(mustMarket(), bot.instId);
        const unrealized =
          bot.status === 'stopped'
            ? 0
            : bot.type === 'grid'
              ? gridUnrealized(bot.sim, price)
              : dcaUnrealized(bot.sim, price);
        return {
          botId: bot.id,
          instId: bot.instId,
          type: bot.type,
          status: bot.status,
          investment: bot.investment,
          params: bot.params,
          price,
          fills: bot.sim.fills,
          realizedPnl: bot.sim.realizedPnl,
          unrealizedPnl: unrealized,
          totalPnl: bot.sim.realizedPnl + unrealized,
          fees: bot.sim.fees,
          resizes: bot.resizes,
        };
      }
      realNotWired(
        'getBot',
        `okx bot grid details --algoOrdType grid --algoId <algoId> --json   # config + pnlRatio + state; fills via 'okx bot grid sub-orders'; DCA: okx bot dca details --algoOrdType spot_dca`
      );
    },

    // ----------------------------------------------------------------- clock
    /**
     * Advance simulated time by n ticks (one hourly candle per pair per tick)
     * and run fill engines for every RUNNING bot. Real mode: markets advance
     * themselves — this is a no-op so the steward code is mode-agnostic.
     */
    async advanceMarket(n = 1) {
      if (!mock) return { advanced: 0, note: 'real mode: market advances itself' };
      const m = mustMarket();
      const fills = [];
      for (let i = 0; i < n; i++) {
        const { tick, regime } = market.advance(m);
        for (const bot of state.bots) {
          if (bot.status !== 'running') continue;
          const price = market.getPrice(m, bot.instId);
          const events =
            bot.type === 'grid' ? processGridTick(bot.sim, price) : processDcaTick(bot.sim, price);
          for (const e of events) fills.push({ tick, botId: bot.id, ...e });
        }
      }
      return { advanced: n, tick: m.tick, simRegime: m.regime, fills };
    },
  };
}
