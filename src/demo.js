// The 90-second demo backbone, end to end in mock mode:
//   1. "I have $500, medium risk, prefer majors" -> strategist proposal
//   2. confirm -> launch (safety rails shown)
//   3. ~32 steward ticks over a scripted market: range -> breakout (forces an
//      auto-PAUSE) -> reversion -> range (forces an auto-RESUME)
//   4. daily digest
// The run is deterministic (fixed seed + scripted regimes) and self-verifies
// that at least one pause AND one resume actually happened.

import { initState, saveState } from './state.js';
import { createOkxAdapter } from './adapters/okx.js';
import { createLlmAdapter } from './adapters/llm.js';
import { buildProposal, renderProposal } from './strategist.js';
import { launchProposal } from './launch.js';
import { runTick } from './steward.js';
import { writeDigest } from './digest.js';
import { setScript } from './mock/market.js';
import { c, fmtPx, fmtNum, fmtSignedUsd, sleep } from './util.js';

export const DEMO_SCRIPT = [
  { regime: 'range', ticks: 6 },                      // calm start: grid harvests
  { regime: 'trend-up', ticks: 10 },                  // breakout beyond the grid ceiling -> PAUSE
  { regime: 'trend-down', ticks: 10 },                // the move exhausts and retraces
  { regime: 'revert', ticks: 4, anchor: 'origin' },   // snaps back to the old level
  { regime: 'range', ticks: 16, anchor: 'origin' },   // settles into a calm range -> RESUME
];

export async function runDemo({ seed = 7, tickDelayMs = null } = {}) {
  const delay = tickDelayMs ?? (process.stdout.isTTY ? 90 : 0);
  const say = (s = '') => console.log(s);
  const banner = (s) => {
    say('');
    say(c.bold(c.cyan(`━━ ${s} `.padEnd(62, '━'))));
    say('');
  };

  banner('BOT BUTLER — demo (mock mode, deterministic seed)');
  say(c.dim(`Fresh simulated world (seed ${seed}). State: state/butler-state.json`));

  // 1 ── fresh state
  const state = initState({ seed, mode: 'mock' });
  const okx = createOkxAdapter({ state, mode: 'mock' });
  const llm = createLlmAdapter({ mode: 'mock' });
  const ctx = { state, okx, llm };

  // 2 ── strategist
  banner('1/4  STRATEGIST — "I have $500, medium risk, prefer majors"');
  const proposal = await buildProposal(ctx, { budget: 500, risk: 'medium', preference: 'majors' });
  say(renderProposal(proposal));
  saveState(state);

  // 3 ── confirm + launch
  banner('2/4  LAUNCH — user confirms');
  say(c.dim('  (demo supplies the confirmation; interactively this is a y/N prompt or --confirm)'));
  const bot = await launchProposal(ctx, proposal.id, { confirmedBy: 'demo --confirm' });
  say(`  ${c.green('✔')} ${bot.id} is ${c.green('RUNNING')}: ${bot.type.toUpperCase()} on ${bot.instId}, ` +
      `$${bot.investment} across [${fmtPx(bot.params.lower)} … ${fmtPx(bot.params.upper)}]`);
  saveState(state);

  // 4 ── steward loop over a scripted market
  setScript(state.market, DEMO_SCRIPT);
  const totalTicks = DEMO_SCRIPT.reduce((s, p) => s + p.ticks, 0);
  banner(`3/4  STEWARD — ${totalTicks} ticks: range → breakout → reversion → range`);
  say(c.dim(`  script: ${DEMO_SCRIPT.map((p) => `${p.regime}×${p.ticks}`).join(' → ')}  (each tick = 1 simulated hour)`));
  say('');

  for (let i = 0; i < totalTicks; i++) {
    const report = await runTick(ctx);
    saveState(state);
    const b = report.bots[0];
    if (!b) break;
    const m = b.m;
    const statusNow = state.bots[0].status;
    const statusColored =
      statusNow === 'running' ? c.green(statusNow.padEnd(7)) : c.yellow(statusNow.padEnd(7));
    let line =
      c.dim(`  t=${String(report.tick).padStart(3)} `) +
      `${bot.instId.split('-')[0]} ${fmtPx(m.price).padStart(9)} ` +
      c.dim(`trend ${fmtNum(m.trendScore, 2).padStart(5)} ${m.regime.padEnd(10)}`) +
      ` ${statusColored}` +
      c.dim(` fills:${String(report.fills).padStart(2)}`);
    say(line);
    for (const a of report.actions) {
      const tag =
        a.type === 'auto_pause' ? c.red('‼ PAUSE ') :
        a.type === 'auto_resume' ? c.green('✔ RESUME') :
        c.yellow('… ' + a.type.replace('_proposed', ' PROPOSAL').toUpperCase());
      say(`        ${tag} ${c.bold(a.botId ?? '')} — ${a.reason}`);
    }
    if (delay) await sleep(delay);
  }

  // 5 ── verify the demo invariant: at least one pause AND one resume
  const pauses = state.actions.filter((a) => a.type === 'auto_pause').length;
  const resumes = state.actions.filter((a) => a.type === 'auto_resume').length;
  say('');
  if (pauses >= 1 && resumes >= 1) {
    say(`  ${c.green('DEMO INVARIANT PASS')} — steward intervened: ${pauses} pause(s), ${resumes} resume(s), all logged with reasons.`);
  } else {
    say(`  ${c.red('DEMO INVARIANT FAIL')} — pauses=${pauses} resumes=${resumes} (expected ≥1 of each)`);
    process.exitCode = 1;
  }

  // 6 ── digest
  banner('4/4  DIGEST — "here\'s what your bot did"');
  const digest = await writeDigest(ctx);
  saveState(state);
  say(c.dim(`  written to ${digest.file}`));
  say('');
  say(digest.markdown.split('\n').map((l) => '  ' + l).join('\n'));

  const snap = await okx.getBot(bot.id);
  banner('DONE — set, but never forget');
  say(
    `  Bot ${bot.id}: ${snap.status}, ${snap.fills} fills, total P&L ${fmtSignedUsd(snap.totalPnl)} ` +
      `(simulated). ${pauses} auto-pause, ${resumes} auto-resume, every action logged.`
  );
  say(c.dim('  Next: node src/index.js tick --watch --interval 2    (keep stewarding)'));
  say(c.dim('        node src/index.js status                       (inspect any time)'));
  say('');
  return { pauses, resumes, digestFile: digest.file };
}
