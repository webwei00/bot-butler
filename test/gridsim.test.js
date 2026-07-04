// Unit tests: the mock grid fill engine (crossing detection + avg-cost P&L)
// and the steward's pure decision function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initGridSim, processGridTick, gridUnrealized, rebaseGridSim } from '../src/mock/gridsim.js';
import { decide } from '../src/steward.js';

// Grid: [90 … 110], 10 grids => levels 90,92,...,110, spacing 2.
// Launch at 99: buys at 90..98 (5), sells at 100..110 (6). Zero fees for exact math.
const PARAMS = { lower: 90, upper: 110, gridCount: 10, perGridQuote: 10 };
const mkSim = () => initGridSim(PARAMS, 99, 0);

test('init: levels, orders, and seeded sell-side inventory', () => {
  const sim = mkSim();
  assert.equal(sim.levels.length, 11);
  assert.equal(sim.orders.filter((o) => o === 'buy').length, 5);
  assert.equal(sim.orders.filter((o) => o === 'sell').length, 6);
  assert.ok(Math.abs(sim.inventoryCost - 60) < 1e-9, 'six sell slots × $10 bought at launch');
  assert.ok(Math.abs(sim.inventoryQty - 60 / 99) < 1e-9);
  assert.equal(sim.realizedPnl, 0, 'no fees in this test');
});

test('down-crossing fills a buy and places a sell above', () => {
  const sim = mkSim();
  const events = processGridTick(sim, 97.5); // crosses 98
  assert.equal(events.length, 1);
  assert.equal(events[0].side, 'buy');
  assert.equal(events[0].level, 98);
  assert.equal(sim.orders[sim.levels.indexOf(98)], null);
  assert.equal(sim.orders[sim.levels.indexOf(100)], 'sell');
  assert.ok(Math.abs(sim.inventoryCost - 70) < 1e-9);
});

test('buy low then sell high realizes ~ spacing-sized profit', () => {
  const sim = mkSim();
  processGridTick(sim, 97.5); // buy @98
  const events = processGridTick(sim, 100.5); // sell @100
  assert.equal(events.length, 1);
  assert.equal(events[0].side, 'sell');
  assert.equal(events[0].level, 100);
  // avg cost after the 98-buy is 70 / (60/99 + 10/98) ≈ 98.856; selling $10 @100
  // realizes ≈ 10/100 × (100 − 98.856) ≈ +0.114
  assert.ok(sim.realizedPnl > 0.10 && sim.realizedPnl < 0.13, `realized ${sim.realizedPnl}`);
  // the filled sell hands a fresh buy back to 98
  assert.equal(sim.orders[sim.levels.indexOf(98)], 'buy');
});

test('same level cannot double-fill without an opposite crossing', () => {
  const sim = mkSim();
  processGridTick(sim, 97.5); // buy @98
  processGridTick(sim, 98.5); // back above 98 — no sell order at 98, nothing fills
  const events = processGridTick(sim, 97.4); // down through 98 again — order is gone
  assert.equal(events.length, 0);
  assert.equal(sim.fills, 1);
});

test('a large candle fills every crossed level at once', () => {
  const sim = mkSim();
  const events = processGridTick(sim, 91.5); // crosses 98,96,94,92 => 4 buys
  assert.equal(events.filter((e) => e.side === 'buy').length, 4);
  assert.ok(Math.abs(sim.inventoryCost - 100) < 1e-9);
});

test('breakout above the range sells the whole ladder for profit', () => {
  const sim = mkSim();
  const initialQty = sim.inventoryQty;
  const events = processGridTick(sim, 112); // crosses 100..110 => 6 sells
  assert.equal(events.filter((e) => e.side === 'sell').length, 6);
  assert.ok(sim.realizedPnl > 0, `sold seeded inventory bought @99 across 100..110: ${sim.realizedPnl}`);
  // Avg-cost accounting sells $10-sized slots priced at each level, so a
  // little dust (< 6%) of the launch inventory remains — but the ladder is spent.
  assert.ok(sim.inventoryQty < initialQty * 0.06, `ladder unwound to dust: ${sim.inventoryQty}`);
});

test('unrealized marks held inventory to market', () => {
  const sim = mkSim();
  processGridTick(sim, 93.5); // buys @98,96,94 => cost 90, qty ≈ 60/99+10/98+10/96+10/94
  const down = gridUnrealized(sim, 93.5);
  assert.ok(down < 0, 'held bags below cost mark negative');
  const up = gridUnrealized(sim, 99);
  assert.ok(up > down, 'marks improve as price recovers');
});

test('fees reduce realized P&L when enabled', () => {
  const noFee = initGridSim(PARAMS, 99, 0);
  const withFee = initGridSim(PARAMS, 99, 0.001);
  processGridTick(noFee, 97.5);
  processGridTick(noFee, 100.5);
  processGridTick(withFee, 97.5);
  processGridTick(withFee, 100.5);
  assert.ok(withFee.realizedPnl < noFee.realizedPnl);
  assert.ok(withFee.fees > 0);
});

test('rebase after a pause prevents phantom back-fills', () => {
  const sim = mkSim();
  processGridTick(sim, 97.5); // buy @98 while running
  // ...bot pauses; price walks to 104 with orders pulled...
  rebaseGridSim(sim, 104);
  const events = processGridTick(sim, 104.2); // resume: tiny move, no catch-up fills
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// steward.decide — pure decision logic
// ---------------------------------------------------------------------------

const BOT = () => ({
  status: 'running',
  params: { lower: 90, upper: 110 },
  pausedAtTick: null,
  outsideSinceTick: null,
  calmStreak: 2, // runTick maintains this; assume an established calm streak unless a test says otherwise
  lastResizeProposalTick: null,
});
const M = (price, trendScore, atr = 1) => ({
  price,
  trendScore,
  atr,
  regime: Math.abs(trendScore) >= 1.1 ? (trendScore > 0 ? 'trend-up' : 'trend-down') : 'range',
});

test('decide: pauses on breakout above the range', () => {
  const d = decide(BOT(), M(111.5, 0.8), 10);
  assert.equal(d.action, 'pause');
  assert.match(d.reason, /above/);
});

test('decide: pauses on strong trend even while price is inside', () => {
  const d = decide(BOT(), M(105, 1.5), 10);
  assert.equal(d.action, 'pause');
  assert.match(d.reason, /trend/);
});

test('decide: holds steady in a calm mid-range market', () => {
  const d = decide(BOT(), M(100, 0.2), 10);
  assert.equal(d.action, 'none');
});

test('decide: proposes a resize when price hugs an edge', () => {
  const d = decide(BOT(), M(108.5, 0.3), 10); // within 15% of upper edge
  assert.equal(d.action, 'propose_resize');
});

test('decide: resize proposal respects the cooldown', () => {
  const bot = BOT();
  bot.lastResizeProposalTick = 9;
  const d = decide(bot, M(108.5, 0.3), 10);
  assert.equal(d.action, 'none');
});

test('decide: paused bot resumes only when calm AND back inside', () => {
  const paused = { ...BOT(), status: 'paused', pausedAtTick: 0 };
  assert.equal(decide(paused, M(105, 0.3), 10).action, 'resume');
  assert.equal(decide(paused, M(115, 0.3), 10).action, 'none', 'still outside');
  assert.equal(decide(paused, M(105, 0.9), 10).action, 'none', 'not calm yet (hysteresis)');
});

test('decide: a single calm tick mid-reversal is not enough to resume', () => {
  const paused = { ...BOT(), status: 'paused', pausedAtTick: 0, calmStreak: 1 };
  assert.equal(decide(paused, M(105, 0.3), 10).action, 'none');
  paused.calmStreak = 2;
  assert.equal(decide(paused, M(105, 0.3), 10).action, 'resume');
});

test('decide: resume respects the post-pause cooldown', () => {
  const paused = { ...BOT(), status: 'paused', pausedAtTick: 10 };
  assert.equal(decide(paused, M(105, 0.2), 11).action, 'none');
  assert.equal(decide(paused, M(105, 0.2), 13).action, 'resume');
});

test('decide: stranded-outside pause turns into a re-center proposal', () => {
  const paused = { ...BOT(), status: 'paused', pausedAtTick: 0, outsideSinceTick: 0 };
  const d = decide(paused, M(120, 0.2), 9);
  assert.equal(d.action, 'propose_recenter');
});
