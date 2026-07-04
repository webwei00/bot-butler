// Unit tests: grid & DCA parameter math + investment sizing (safety caps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planGridParams, planDcaParams, sizeInvestment } from '../src/grid.js';
import { CAPS, MIN_SPACING_PCT, RISK_PROFILES } from '../src/config.js';

const BASE = { price: 64000, atr: 350 }; // ~0.55% ATR, BTC-ish

test('grid range brackets the price at ±atrMult×ATR', () => {
  for (const risk of ['low', 'medium', 'high']) {
    const p = planGridParams({ ...BASE, risk, investment: 400 });
    const half = RISK_PROFILES[risk].atrMult * BASE.atr;
    assert.ok(p.lower < BASE.price && p.upper > BASE.price, `${risk}: price inside range`);
    assert.ok(Math.abs(p.upper - (BASE.price + half)) < half * 0.02, `${risk}: upper ≈ price + ${half}`);
    assert.ok(Math.abs(p.lower - (BASE.price - half)) < half * 0.02, `${risk}: lower ≈ price - ${half}`);
  }
});

test('risk ordering: lower risk = wider range, fewer grids', () => {
  const low = planGridParams({ ...BASE, risk: 'low', investment: 400 });
  const med = planGridParams({ ...BASE, risk: 'medium', investment: 400 });
  const high = planGridParams({ ...BASE, risk: 'high', investment: 400 });
  assert.ok(low.upper - low.lower > med.upper - med.lower);
  assert.ok(med.upper - med.lower > high.upper - high.lower);
  assert.ok(low.gridCount <= med.gridCount && med.gridCount <= high.gridCount);
});

test('spacing × gridCount spans the range exactly', () => {
  const p = planGridParams({ ...BASE, risk: 'medium', investment: 400 });
  assert.ok(Math.abs(p.spacing * p.gridCount - (p.upper - p.lower)) < 1e-6);
});

test('per-grid allocation never exceeds the investment in total', () => {
  const p = planGridParams({ ...BASE, risk: 'high', investment: 500 });
  assert.ok(p.perGridQuote * p.gridCount <= 500 + 0.01 * p.gridCount);
});

test('grid count shrinks until spacing clears the fee floor', () => {
  // Tiny ATR forces a spacing squeeze: planner must widen steps by dropping grids.
  const p = planGridParams({ price: 64000, atr: 40, risk: 'high', investment: 400 });
  assert.ok(p.spacingPct >= MIN_SPACING_PCT * 0.999, `spacing ${p.spacingPct}% >= floor ${MIN_SPACING_PCT}%`);
  assert.ok(p.gridCount < RISK_PROFILES.high.gridCount, 'grid count was reduced');
  assert.ok(p.gridCount >= 2);
});

test('grid spacing stays profitable net of round-trip fees', () => {
  for (const risk of ['low', 'medium', 'high']) {
    const p = planGridParams({ ...BASE, risk, investment: 400 });
    assert.ok(p.estProfitPerFillPct > 0, `${risk}: ${p.estProfitPerFillPct}% net per fill`);
  }
});

test('lower bound is always positive even with absurd ATR', () => {
  const p = planGridParams({ price: 100, atr: 60, risk: 'low', investment: 400 });
  assert.ok(p.lower > 0);
});

test('sizeInvestment applies risk deployment fraction', () => {
  assert.equal(sizeInvestment(500, 'medium'), 400); // 80%
  assert.equal(sizeInvestment(500, 'low'), 300); // 60%
  assert.equal(sizeInvestment(500, 'high'), 500); // 100%
});

test('sizeInvestment enforces the per-bot hard cap', () => {
  assert.equal(sizeInvestment(50000, 'high'), CAPS.maxAllocationPerBot);
  assert.equal(sizeInvestment(50000, 'medium'), CAPS.maxAllocationPerBot);
});

test('dca ladder total fits inside the investment', () => {
  for (const risk of ['low', 'medium', 'high']) {
    const p = planDcaParams({ ...BASE, risk, investment: 400 });
    assert.ok(p.ladderTotal <= 400 + 1, `${risk}: ladder ${p.ladderTotal} <= 400`);
    assert.ok(p.baseOrderQuote > 0);
    assert.equal(p.safetyOrders, RISK_PROFILES[risk].dca.safetyOrders);
    assert.ok(p.priceDeviationPct > 0);
    assert.ok(p.takeProfitPct > 0);
  }
});

test('dca deviation scales with ATR but has a floor', () => {
  const calm = planDcaParams({ price: 64000, atr: 10, risk: 'medium', investment: 400 });
  const wild = planDcaParams({ price: 64000, atr: 800, risk: 'medium', investment: 400 });
  assert.ok(calm.priceDeviationPct >= 0.3, 'floor holds in dead-calm markets');
  assert.ok(wild.priceDeviationPct > calm.priceDeviationPct);
});
