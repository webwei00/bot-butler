// Discrete grid-bot fill simulator with average-cost inventory accounting.
//
// Model: gridCount+1 price levels. Levels below the launch price start with a
// BUY order, levels above start with a SELL order (backed by base bought at
// launch — same as a real spot grid's initial market buy). When price crosses
// a level with an order, the order fills and the opposite order is placed one
// level over (buy@L fills -> sell@L+1 placed; sell@L fills -> buy@L-1 placed).
// Realized P&L uses average-cost accounting; fees charged per fill notional.
//
// DCA-martingale simulator: base order + scaled safety orders on deviation
// steps; take-profit closes the cycle and restarts at the current price.

import { FEE_RATE } from '../config.js';

// ---------------------------------------------------------------------------
// GRID
// ---------------------------------------------------------------------------

export function initGridSim(params, launchPrice, feeRate = FEE_RATE) {
  const { lower, upper, gridCount, perGridQuote } = params;
  const spacing = (upper - lower) / gridCount;
  const levels = [];
  for (let i = 0; i <= gridCount; i++) levels.push(lower + i * spacing);

  // 'buy' | 'sell' | null per level
  const orders = levels.map((L) =>
    L < launchPrice ? 'buy' : L > launchPrice ? 'sell' : null
  );

  // Initial base inventory backs the sell side, bought at launch price.
  const sellSlots = orders.filter((o) => o === 'sell').length;
  const inventoryCost = sellSlots * perGridQuote;
  const inventoryQty = launchPrice > 0 ? inventoryCost / launchPrice : 0;
  const fees = inventoryCost * feeRate;

  return {
    levels,
    orders,
    spacing,
    perGridQuote,
    feeRate,
    lastPrice: launchPrice,
    inventoryQty,
    inventoryCost,
    realizedPnl: fees > 0 ? -fees : 0, // realized is net of all fees paid so far
    fees,
    fills: 0,
    buyFills: 0,
    sellFills: 0,
  };
}

/**
 * Process a price move from sim.lastPrice to `price`, filling crossed orders.
 * Returns the fill events. Call only while the bot is RUNNING — a paused bot
 * has its orders pulled (use `rebase` on resume instead).
 */
export function processGridTick(sim, price) {
  const prev = sim.lastPrice;
  const events = [];
  if (price === prev) return events;

  if (price < prev) {
    // Walk levels downward. Strictly below prev: sitting exactly ON a level
    // (e.g. right after a resume rebase) is not a crossing of that level.
    for (let i = sim.levels.length - 1; i >= 0; i--) {
      const L = sim.levels[i];
      if (L < prev && L >= price && sim.orders[i] === 'buy') {
        const qty = sim.perGridQuote / L;
        sim.inventoryQty += qty;
        sim.inventoryCost += sim.perGridQuote;
        const fee = sim.perGridQuote * sim.feeRate;
        sim.fees += fee;
        sim.realizedPnl -= fee;
        sim.fills++;
        sim.buyFills++;
        sim.orders[i] = null;
        if (i + 1 < sim.orders.length) sim.orders[i + 1] = 'sell';
        events.push({ side: 'buy', level: L, qty });
      }
    }
  } else {
    // Walk levels upward: strictly above prev, up to and including price.
    for (let i = 0; i < sim.levels.length; i++) {
      const L = sim.levels[i];
      if (L > prev && L <= price && sim.orders[i] === 'sell') {
        if (sim.inventoryQty <= 1e-12) continue; // nothing left to sell (shouldn't happen in practice)
        const qty = Math.min(sim.perGridQuote / L, sim.inventoryQty);
        const avgCost = sim.inventoryCost / sim.inventoryQty;
        const proceeds = qty * L;
        const fee = proceeds * sim.feeRate;
        sim.inventoryQty -= qty;
        sim.inventoryCost -= qty * avgCost;
        sim.realizedPnl += proceeds - qty * avgCost - fee;
        sim.fees += fee;
        sim.fills++;
        sim.sellFills++;
        sim.orders[i] = null;
        if (i - 1 >= 0) sim.orders[i - 1] = 'buy';
        events.push({ side: 'sell', level: L, qty });
      }
    }
  }

  sim.lastPrice = price;
  return events;
}

/** Mark-to-market P&L of held inventory. */
export function gridUnrealized(sim, price) {
  return sim.inventoryQty * price - sim.inventoryCost;
}

/**
 * Re-sync after a pause (orders were pulled while paused; no fills happened).
 * Resumes tracking from the current price without phantom back-fills.
 */
export function rebaseGridSim(sim, price) {
  sim.lastPrice = price;
}

// ---------------------------------------------------------------------------
// DCA-MARTINGALE
// ---------------------------------------------------------------------------

export function initDcaSim(params, launchPrice, feeRate = FEE_RATE) {
  const sim = {
    params: { ...params },
    feeRate,
    lastPrice: launchPrice,
    cycles: 0,
    realizedPnl: 0,
    fees: 0,
    fills: 0,
    cycle: null,
  };
  startDcaCycle(sim, launchPrice);
  return sim;
}

function startDcaCycle(sim, price) {
  const { baseOrderQuote, safetyOrders, priceDeviationPct, volumeScale } = sim.params;
  const orders = [];
  for (let i = 1; i <= safetyOrders; i++) {
    orders.push({
      price: price * (1 - (priceDeviationPct / 100) * i),
      quote: baseOrderQuote * Math.pow(volumeScale, i),
      filled: false,
    });
  }
  const fee = baseOrderQuote * sim.feeRate;
  sim.fees += fee;
  sim.realizedPnl -= fee;
  sim.fills++;
  sim.cycle = {
    entry: price,
    qty: baseOrderQuote / price,
    cost: baseOrderQuote,
    safety: orders,
  };
}

export function processDcaTick(sim, price) {
  const events = [];
  const cyc = sim.cycle;
  if (!cyc) return events;

  // Fill safety orders the price has dropped through.
  for (const so of cyc.safety) {
    if (!so.filled && price <= so.price) {
      so.filled = true;
      cyc.qty += so.quote / so.price;
      cyc.cost += so.quote;
      const fee = so.quote * sim.feeRate;
      sim.fees += fee;
      sim.realizedPnl -= fee;
      sim.fills++;
      events.push({ side: 'buy', level: so.price, quote: so.quote });
    }
  }

  // Take profit on the averaged position?
  const avg = cyc.cost / cyc.qty;
  const tpPrice = avg * (1 + sim.params.takeProfitPct / 100);
  if (price >= tpPrice) {
    const proceeds = cyc.qty * price;
    const fee = proceeds * sim.feeRate;
    sim.realizedPnl += proceeds - cyc.cost - fee;
    sim.fees += fee;
    sim.fills++;
    sim.cycles++;
    events.push({ side: 'take-profit', level: price, profit: proceeds - cyc.cost - fee });
    startDcaCycle(sim, price); // roll into a fresh cycle
  }

  sim.lastPrice = price;
  return events;
}

export function dcaUnrealized(sim, price) {
  if (!sim.cycle) return 0;
  return sim.cycle.qty * price - sim.cycle.cost;
}

export function rebaseDcaSim(sim, price) {
  sim.lastPrice = price;
}
