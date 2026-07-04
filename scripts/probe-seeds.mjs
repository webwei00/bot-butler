// Dev tool: dry-run the demo scenario across many seeds and report whether
// the steward invariant (>=1 auto-pause AND >=1 auto-resume) holds, plus
// when the interventions land. Used to tune the scripted market dynamics.
//
//   node scripts/probe-seeds.mjs [firstSeed lastSeed] [--verbose]

import { initState } from '../src/state.js';
import { createOkxAdapter } from '../src/adapters/okx.js';
import { buildProposal } from '../src/strategist.js';
import { launchProposal } from '../src/launch.js';
import { runTick } from '../src/steward.js';
import { setScript } from '../src/mock/market.js';
import { DEMO_SCRIPT } from '../src/demo.js';

const verbose = process.argv.includes('--verbose');
const nums = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(Number);
const [from = 1, to = 16] = nums;

for (let seed = from; seed <= to; seed++) {
  const state = initState({ seed, mode: 'mock' });
  const okx = createOkxAdapter({ state, mode: 'mock' });
  const ctx = { state, okx };

  const proposal = await buildProposal(ctx, { budget: 500, risk: 'medium', preference: 'majors' });
  await launchProposal(ctx, proposal.id, { confirmedBy: 'probe' });
  setScript(state.market, DEMO_SCRIPT);
  const totalTicks = DEMO_SCRIPT.reduce((s, p) => s + p.ticks, 0);

  for (let i = 0; i < totalTicks; i++) {
    const rep = await runTick(ctx);
    if (verbose) {
      const b = rep.bots[0];
      console.log(
        `  t=${String(rep.tick).padStart(3)} px=${b.m.price.toFixed(2)} ts=${b.m.trendScore.toFixed(2)} ` +
          `${b.m.regime.padEnd(10)} sim=${rep.simRegime.padEnd(10)} ${state.bots[0].status}` +
          (rep.actions.length ? '  << ' + rep.actions.map((a) => a.type).join(', ') : '')
      );
    }
  }

  const pauses = state.actions.filter((a) => a.type === 'auto_pause');
  const resumes = state.actions.filter((a) => a.type === 'auto_resume');
  const resizes = state.actions.filter((a) => a.type.endsWith('_proposed'));
  const bot = state.bots[0];
  const ok = pauses.length >= 1 && resumes.length >= 1;
  console.log(
    `seed ${String(seed).padStart(3)}  ${ok ? 'PASS' : 'FAIL'}  ` +
      `pair=${proposal.instId.padEnd(9)} pauses=${pauses.length}@t${pauses[0]?.tick ?? '-'} ` +
      `resumes=${resumes.length}@t${resumes[0]?.tick ?? '-'} proposals=${resizes.length} ` +
      `final=${bot.status} pnl=${(bot.sim.realizedPnl + (bot.sim.inventoryQty * state.market.prices[bot.instId] - bot.sim.inventoryCost)).toFixed(2)}`
  );
}
