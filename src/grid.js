// Grid & DCA-martingale parameter math, sized from risk profile + measured ATR.

import { CAPS, FEE_RATE, MIN_SPACING_PCT, RISK_PROFILES } from './config.js';
import { round2, roundPx } from './util.js';

/**
 * How much of the stated budget actually gets deployed, after risk-profile
 * scaling and the hard per-bot cap. (Safety rail: never exceeds the cap,
 * regardless of what the user asked for.)
 */
export function sizeInvestment(budget, risk) {
  const prof = RISK_PROFILES[risk];
  if (!prof) throw new Error(`Unknown risk profile '${risk}'`);
  const scaled = budget * prof.budgetUse;
  return round2(Math.min(scaled, CAPS.maxAllocationPerBot));
}

/**
 * Plan grid parameters around the current price.
 *   range half-width = atrMult(risk) * ATR
 *   spacing must clear MIN_SPACING_PCT (round-trip fees + margin), or we
 *   reduce the grid count until it does.
 *
 * Returns { lower, upper, gridCount, spacing, spacingPct, perGridQuote, atrMult }.
 */
export function planGridParams({ price, atr, risk, investment, feeRate = FEE_RATE }) {
  const prof = RISK_PROFILES[risk];
  if (!prof) throw new Error(`Unknown risk profile '${risk}'`);
  if (!(price > 0) || !(atr > 0)) throw new Error('planGridParams needs positive price and atr');

  const half = prof.atrMult * atr;
  let lower = Math.max(price - half, price * 0.3); // sanity clamp: never a non-positive bound
  let upper = price + half;

  // Every grid step must clear round-trip fees with margin: first drop grids,
  // and if even a coarse grid can't clear the floor (dead-calm ATR), widen the
  // range itself so profitability per step is guaranteed.
  let gridCount = prof.gridCount;
  const minSpacing = (MIN_SPACING_PCT / 100) * price;
  while (gridCount > 4 && (upper - lower) / gridCount < minSpacing) {
    gridCount -= 2;
  }
  if ((upper - lower) / gridCount < minSpacing) {
    const widenedHalf = (minSpacing * gridCount) / 2;
    lower = Math.max(price - widenedHalf, price * 0.3);
    upper = price + widenedHalf;
  }

  lower = roundPx(lower);
  upper = roundPx(upper);
  const spacing = (upper - lower) / gridCount;
  const spacingPct = (spacing / price) * 100;
  const perGridQuote = round2(investment / gridCount);

  // Estimated profit captured per completed grid round trip, net of fees.
  const estProfitPerFillPct = spacingPct - 2 * feeRate * 100;

  return {
    lower,
    upper,
    gridCount,
    spacing,
    spacingPct,
    perGridQuote,
    atrMult: prof.atrMult,
    estProfitPerFillPct,
  };
}

/**
 * Plan DCA-martingale parameters. The whole safety-order ladder is sized to
 * fit inside `investment`, so a fully-averaged-down position can never exceed
 * the allocation cap.
 *
 * Returns { baseOrderQuote, safetyOrders, priceDeviationPct, volumeScale,
 *           takeProfitPct, ladderTotal, maxDrawdownPct }.
 */
export function planDcaParams({ price, atr, risk, investment }) {
  const prof = RISK_PROFILES[risk];
  if (!prof) throw new Error(`Unknown risk profile '${risk}'`);
  const d = prof.dca;

  // base * (1 + s + s^2 + ... + s^n) = investment  => solve for base order
  let ladderUnits = 0;
  for (let i = 0; i <= d.safetyOrders; i++) ladderUnits += Math.pow(d.volumeScale, i);
  const baseOrderQuote = round2(investment / ladderUnits);

  const priceDeviationPct = Math.max(0.3, (d.deviationAtrMult * atr * 100) / price);
  const maxDrawdownPct = priceDeviationPct * d.safetyOrders;

  return {
    baseOrderQuote,
    safetyOrders: d.safetyOrders,
    priceDeviationPct,
    volumeScale: d.volumeScale,
    takeProfitPct: d.takeProfitPct,
    ladderTotal: round2(baseOrderQuote * ladderUnits),
    maxDrawdownPct,
  };
}
