// Unit tests: regime detection math (EMA, ATR, trend classification).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, atr, detectRegime, isCalm, gridFitScore } from '../src/regime.js';
import { REGIME } from '../src/config.js';

/** Build candles from a close series (open = previous close, small wicks). */
function candlesFromCloses(closes) {
  const out = [];
  let prev = closes[0];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const o = prev;
    out.push({
      ts: i * 3600000,
      o,
      h: Math.max(o, c) * 1.001,
      l: Math.min(o, c) * 0.999,
      c,
      v: 100,
    });
    prev = c;
  }
  return out;
}

test('ema of a constant series is the constant', () => {
  const series = ema(Array(50).fill(42), 8);
  assert.equal(series.length, 50);
  for (const v of series) assert.ok(Math.abs(v - 42) < 1e-9);
});

test('ema converges toward known value (period 3, 1..5)', () => {
  // k = 0.5: 1, 1.5, 2.25, 3.125, 4.0625
  const series = ema([1, 2, 3, 4, 5], 3);
  assert.ok(Math.abs(series.at(-1) - 4.0625) < 1e-9);
});

test('ema tracks a rising series from below', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + i);
  const fast = ema(values, 8).at(-1);
  const slow = ema(values, 21).at(-1);
  assert.ok(fast < values.at(-1), 'ema lags the price');
  assert.ok(fast > slow, 'fast ema sits above slow ema in an uptrend');
});

test('atr equals the constant true range when candles are uniform', () => {
  // Flat closes at 100, high 101 / low 99 every candle => TR = 2 exactly.
  const candles = Array.from({ length: 30 }, (_, i) => ({
    ts: i,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    v: 1,
  }));
  assert.ok(Math.abs(atr(candles, 14) - 2) < 1e-9);
});

test('atr includes gap moves via previous close', () => {
  // Candle bodies are tiny but each candle gaps +10 from the previous close:
  // TR = |h - prevC| ≈ 10, so ATR must be ≈ 10, not the intra-candle range.
  const candles = [];
  for (let i = 0; i < 20; i++) {
    const base = 100 + i * 10;
    candles.push({ ts: i, o: base, h: base + 0.5, l: base - 0.5, c: base, v: 1 });
  }
  const a = atr(candles, 14);
  assert.ok(a > 9 && a < 11.5, `expected ~10, got ${a}`);
});

test('detectRegime: steady uptrend classifies as trend-up with high score', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.01, i)); // +1%/candle
  const m = detectRegime(candlesFromCloses(closes));
  assert.equal(m.regime, 'trend-up');
  assert.ok(m.trendScore >= REGIME.trendThreshold, `score ${m.trendScore}`);
});

test('detectRegime: steady downtrend classifies as trend-down', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(0.99, i));
  const m = detectRegime(candlesFromCloses(closes));
  assert.equal(m.regime, 'trend-down');
  assert.ok(m.trendScore <= -REGIME.trendThreshold, `score ${m.trendScore}`);
});

test('detectRegime: flat oscillation classifies as range with calm score', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.005 * Math.sin(i / 2)));
  const m = detectRegime(candlesFromCloses(closes));
  assert.equal(m.regime, 'range');
  assert.ok(Math.abs(m.trendScore) < REGIME.trendThreshold, `score ${m.trendScore}`);
  assert.ok(isCalm(m.trendScore), 'oscillation should be calm enough to resume');
});

test('detectRegime: reports positive atr and atrPct', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 2);
  const m = detectRegime(candlesFromCloses(closes));
  assert.ok(m.atr > 0);
  assert.ok(m.atrPct > 0);
  assert.equal(m.price, closes.at(-1));
});

test('detectRegime: refuses series shorter than the slow EMA window', () => {
  assert.throws(() => detectRegime(candlesFromCloses([1, 2, 3])));
});

test('hysteresis thresholds are ordered (calm < trend)', () => {
  assert.ok(REGIME.calmThreshold < REGIME.trendThreshold);
});

test('gridFitScore prefers volatile ranges over trends', () => {
  const rangy = gridFitScore({ atrPct: 1.0, trendScore: 0.1 });
  const trendy = gridFitScore({ atrPct: 1.0, trendScore: 2.0 });
  const quiet = gridFitScore({ atrPct: 0.2, trendScore: 0.1 });
  assert.ok(rangy > trendy, 'same vol: range beats trend');
  assert.ok(rangy > quiet, 'same regime: vol beats quiet');
});
