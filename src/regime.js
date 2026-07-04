// Regime detection: classify a candle series as range / trend-up / trend-down.
//
// trendScore = (EMA(fast) - EMA(slow)) / ATR
//   A dimensionless measure of directional pressure: how far the fast average
//   has pulled away from the slow one, in units of typical candle movement.
//   |score| >= trendThreshold  => trending (grids are unsafe: one-sided fills)
//   |score| <= calmThreshold   => calm range (safe to resume a paused grid)
//
// Candle shape used throughout: { ts, o, h, l, c, v }

import { REGIME } from './config.js';

/** Exponential moving average; returns the full series (ema[0] = values[0]). */
export function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/** True range of candle i given the previous close. */
function trueRange(candle, prevClose) {
  const hl = candle.h - candle.l;
  if (prevClose == null) return hl;
  return Math.max(hl, Math.abs(candle.h - prevClose), Math.abs(candle.l - prevClose));
}

/** Average True Range: simple mean of the last `period` true ranges. */
export function atr(candles, period = REGIME.atrPeriod) {
  if (candles.length < 2) return candles.length ? candles[0].h - candles[0].l : 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1].c));
  }
  const window = trs.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/**
 * Classify the market regime from candles.
 * Returns { regime, trendScore, atr, atrPct, price }.
 */
export function detectRegime(candles, cfg = REGIME) {
  if (!candles || candles.length < cfg.emaSlow + 2) {
    throw new Error(`detectRegime needs at least ${cfg.emaSlow + 2} candles (got ${candles?.length ?? 0})`);
  }
  const closes = candles.map((k) => k.c);
  const emaFast = ema(closes, cfg.emaFast).at(-1);
  const emaSlow = ema(closes, cfg.emaSlow).at(-1);
  const a = atr(candles, cfg.atrPeriod);
  const price = closes.at(-1);
  const trendScore = a > 0 ? (emaFast - emaSlow) / a : 0;

  let regime = 'range';
  if (trendScore >= cfg.trendThreshold) regime = 'trend-up';
  else if (trendScore <= -cfg.trendThreshold) regime = 'trend-down';

  return {
    regime,
    trendScore,
    atr: a,
    atrPct: price > 0 ? (a / price) * 100 : 0,
    price,
  };
}

/** Calm enough (with hysteresis) for a paused grid to safely resume. */
export function isCalm(trendScore, cfg = REGIME) {
  return Math.abs(trendScore) <= cfg.calmThreshold;
}

/**
 * How well a pair suits a grid bot right now: reward volatility (fills),
 * penalize directional pressure (one-sided inventory risk).
 * Higher is better; used by the strategist to rank pairs.
 */
export function gridFitScore({ atrPct, trendScore }, cfg = REGIME) {
  const trendPenalty = Math.min(1, Math.abs(trendScore) / cfg.trendThreshold);
  return atrPct * (1 - 0.7 * trendPenalty);
}
