// Simulated market: seeded random-walk hourly candles with regime changes
// (range -> trend -> range). Fully deterministic for a given seed, and
// persisted inside the state file so separate CLI invocations continue the
// same simulated world.
//
// A "scenario script" can override the random regime engine — the demo uses
// this to guarantee a breakout (pause) followed by a reversion (resume).

import { makeRng, randNorm, randInt } from '../util.js';

export const PAIR_META = [
  { instId: 'BTC-USDT', px: 64000, sigma: 0.0035, major: true },
  { instId: 'ETH-USDT', px: 3300, sigma: 0.0045, major: true },
  { instId: 'SOL-USDT', px: 152, sigma: 0.008, major: true },
  { instId: 'XRP-USDT', px: 2.15, sigma: 0.007, major: true },
  { instId: 'DOGE-USDT', px: 0.31, sigma: 0.011, major: false },
];

const WARMUP_CANDLES = 96; // enough history for EMA(21)/ATR(14) from the first tick
const MAX_CANDLES = 240;

// Per-regime dynamics (fraction-of-price per tick). Trends are impulsive:
// strong drift, modest extra noise — they need to be able to escape a grid
// range sized at ±6-12 hourly ATRs within a dozen candles. 'revert' is a
// script-only regime (the random engine never picks it): a hard snap-back
// toward the anchor, used to close out an overshoot quickly.
const DYNAMICS = {
  range: { drift: 0, sigmaMult: 1.0, reversion: 0.12 },
  'trend-up': { drift: +0.018, sigmaMult: 1.2, reversion: 0 },
  'trend-down': { drift: -0.017, sigmaMult: 1.2, reversion: 0 },
  revert: { drift: 0, sigmaMult: 0.9, reversion: 0.35 },
};

/** Create a fresh simulated market with warmed-up candle history. */
export function initMarket(seed = 42) {
  const rng = makeRng(seed);
  const startTs = Math.floor(Date.now() / 3600000) * 3600000 - WARMUP_CANDLES * 3600000;

  const market = {
    rngState: 0,
    tick: 0,
    ts: startTs,
    regime: 'range',
    regimeTicksLeft: randInt(rng, 12, 24),
    script: [], // optional scripted regime sequence: [{ regime, ticks, anchor? }]
    originAnchors: null,
    anchors: {},
    candles: {},
    prices: {},
  };

  for (const meta of PAIR_META) {
    market.candles[meta.instId] = [];
    market.prices[meta.instId] = meta.px;
    market.anchors[meta.instId] = meta.px;
  }

  // Warm-up history is generated in 'range' regime so bots launch into a calm market.
  for (let i = 0; i < WARMUP_CANDLES; i++) {
    stepOnce(market, rng, 'range');
  }
  market.tick = 0; // warm-up doesn't count as steward ticks
  market.rngState = rng.getState();
  return market;
}

/**
 * Install a scripted regime sequence (used by the demo). Captures the current
 * prices as "origin" anchors so a later `{ anchor: 'origin' }` phase can
 * mean-revert back inside the original grid range.
 */
export function setScript(market, script) {
  market.script = script.map((s) => ({ ...s }));
  market.originAnchors = { ...market.prices };
}

/** Advance the simulation by one tick (one hourly candle per pair). */
export function advance(market) {
  const rng = makeRng(market.rngState);
  const regime = nextRegime(market, rng);
  stepOnce(market, rng, regime);
  market.tick += 1;
  market.rngState = rng.getState();
  return { tick: market.tick, regime: market.regime };
}

function nextRegime(market, rng) {
  // Scripted mode consumes the script first, then falls back to the random engine.
  while (market.script.length && market.script[0].ticks <= 0) market.script.shift();
  if (market.script.length) {
    const phase = market.script[0];
    if (market.regime !== phase.regime || phase._entered !== true) {
      enterRegime(market, phase.regime, phase.anchor);
      phase._entered = true;
    }
    phase.ticks -= 1;
    return market.regime;
  }

  market.regimeTicksLeft -= 1;
  if (market.regimeTicksLeft <= 0) {
    let next;
    if (market.regime === 'range') {
      const r = rng();
      next = r < 0.6 ? 'range' : r < 0.8 ? 'trend-up' : 'trend-down';
    } else {
      next = rng() < 0.8 ? 'range' : market.regime === 'trend-up' ? 'trend-down' : 'trend-up';
    }
    enterRegime(market, next);
    market.regimeTicksLeft = next === 'range' ? randInt(rng, 12, 30) : randInt(rng, 5, 12);
  }
  return market.regime;
}

function enterRegime(market, regime, anchorMode) {
  market.regime = regime;
  if (regime === 'range' || regime === 'revert') {
    // Ranges/reversions oscillate around / pull toward an anchor.
    // 'origin' pulls back to pre-script levels.
    market.anchors =
      anchorMode === 'origin' && market.originAnchors
        ? { ...market.originAnchors }
        : { ...market.prices };
  }
}

function stepOnce(market, rng, regime) {
  const dyn = DYNAMICS[regime];
  for (const meta of PAIR_META) {
    const { instId, sigma } = meta;
    const open = market.prices[instId];

    let drift = dyn.drift;
    if (dyn.reversion > 0) {
      const anchor = market.anchors[instId] ?? open;
      drift += (dyn.reversion * (anchor - open)) / open;
    }
    const ret = drift + randNorm(rng) * sigma * dyn.sigmaMult;
    const close = Math.max(open * (1 + ret), open * 0.5);

    const wickUp = Math.abs(randNorm(rng)) * sigma * dyn.sigmaMult * 0.6;
    const wickDn = Math.abs(randNorm(rng)) * sigma * dyn.sigmaMult * 0.6;
    const high = Math.max(open, close) * (1 + wickUp);
    const low = Math.min(open, close) * (1 - wickDn);
    const volume = 100 * (1 + rng());

    const arr = market.candles[instId];
    arr.push({ ts: market.ts, o: open, h: high, l: low, c: close, v: Math.round(volume * 100) / 100 });
    if (arr.length > MAX_CANDLES) arr.splice(0, arr.length - MAX_CANDLES);

    market.prices[instId] = close;
  }
  market.ts += 3600000;
}

export function getCandles(market, instId, limit = 96) {
  const arr = market.candles[instId];
  if (!arr) throw new Error(`Unknown instrument '${instId}' in mock market`);
  return arr.slice(-limit);
}

export function getPrice(market, instId) {
  const px = market.prices[instId];
  if (px == null) throw new Error(`Unknown instrument '${instId}' in mock market`);
  return px;
}
