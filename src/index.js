#!/usr/bin/env node
// Bot Butler CLI — propose / launch / tick / digest / demo, plus manual
// overrides. Mock mode (default) is a full simulation; real mode surfaces
// documented not-wired stubs from the single OKX adapter.

import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { CAPS, MAJORS, okxMode } from './config.js';
import {
  loadState,
  loadOrInitState,
  saveState,
  resetState,
  appendAction,
  statePathForDisplay,
} from './state.js';
import { createOkxAdapter } from './adapters/okx.js';
import { createLlmAdapter } from './adapters/llm.js';
import { buildProposal, renderProposal, parseAsk } from './strategist.js';
import { launchProposal } from './launch.js';
import { runTick } from './steward.js';
import { writeDigest } from './digest.js';
import { runDemo } from './demo.js';
import { planGridParams } from './grid.js';
import { detectRegime } from './regime.js';
import { c, hr, fmtPx, fmtNum, fmtUsd, fmtSignedUsd, sleep } from './util.js';

const HELP = `
${c.bold('Bot Butler')} — grid/DCA strategist with an ongoing stewardship loop
mode: ${okxMode()} (set OKX_MODE=mock|real; mock is a full simulation)

USAGE
  node src/index.js <command> [options]

COMMANDS
  propose ["ask"]        Get a strategy proposal.
                         e.g. propose "I have $500, medium risk, prefer majors"
                         or   propose --budget 500 --risk medium --prefer majors
  launch [proposalId]    Launch a proposal (latest if omitted). Asks y/N, or
                         pass --confirm. Re-checks all hard caps first.
  status                 Market snapshot, bots, recent actions.
  tick                   One steward tick (advances the mock market 1 candle).
    --watch              Keep ticking on an interval.
    --interval <sec>     Seconds between watch ticks (default 5).
    --ticks <n>          Stop after n ticks (default: until Ctrl+C).
  digest                 Write out/digest-<date>.md and print it.
  demo                   Scripted end-to-end run: propose -> confirm -> launch
                         -> 34 ticks with a breakout (pause) + reversion
                         (resume) -> digest. [--seed <n>]
  pause|resume|stop <botId>   Manual override (asks y/N, or --confirm).
  resize <botId>         Apply the latest proposed re-center (asks y/N, or --confirm).
  reset                  Delete state and start fresh (asks y/N, or --confirm).

SAFETY RAILS (config.js)
  max ${fmtUsd(CAPS.maxAllocationPerBot, 0)}/bot, ${fmtUsd(CAPS.maxTotalAllocation, 0)} total, ${CAPS.maxActiveBots} active bots; majors-only default
  (${MAJORS.join(', ')}); every action logged to ${statePathForDisplay()}
`;

async function confirmOrAbort(question, opts) {
  if (opts.confirm) {
    console.log(c.dim('  (confirmed via --confirm)'));
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log(c.yellow('  Aborted: no TTY for an interactive prompt and no --confirm flag (safety rail).'));
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

function makeCtx(state) {
  return {
    state,
    okx: createOkxAdapter({ state }),
    llm: createLlmAdapter({}),
  };
}

function requireState() {
  const state = loadState();
  if (!state) {
    console.error(`No state yet (${statePathForDisplay()}). Start with:  node src/index.js propose --budget 500 --risk medium`);
    process.exit(1);
  }
  return state;
}

// --------------------------------------------------------------------------

async function cmdPropose(positionals, opts) {
  const state = loadOrInitState({ seed: opts.seed ? Number(opts.seed) : 42 });
  const ctx = makeCtx(state);

  const ask = positionals.join(' ');
  const parsed = ask ? parseAsk(ask) : {};
  const input = {
    budget: opts.budget ? Number(opts.budget) : parsed.budget,
    risk: opts.risk ?? parsed.risk ?? 'medium',
    preference: opts.prefer ?? parsed.preference ?? 'majors',
  };
  if (ask) console.log(c.dim(`Heard: "${ask}" -> budget=${input.budget} risk=${input.risk} prefer=${input.preference}\n`));
  if (!input.budget) {
    console.error('Need a budget: propose "I have $500, medium risk" or --budget 500');
    process.exit(1);
  }

  const proposal = await buildProposal(ctx, input);
  saveState(state);
  console.log(renderProposal(proposal));
  console.log('');
  console.log(`Launch it:  ${c.bold(`node src/index.js launch ${proposal.id}`)}   (asks y/N; add --confirm to skip)`);
}

async function cmdLaunch(positionals, opts) {
  const state = requireState();
  const ctx = makeCtx(state);
  const proposalId =
    positionals[0] ?? state.proposals.filter((p) => p.status === 'proposed').at(-1)?.id;
  if (!proposalId) {
    console.error('No pending proposal. Run `propose` first.');
    process.exit(1);
  }
  const proposal = state.proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    console.error(`Unknown proposal '${proposalId}'.`);
    process.exit(1);
  }
  console.log(renderProposal(proposal));
  console.log('');
  const ok = await confirmOrAbort(
    `Deploy ${fmtUsd(proposal.investment, 0)} into this ${proposal.botType.toUpperCase()} bot on ${proposal.instId}?`,
    opts
  );
  if (!ok) return;
  const confirmedBy = opts.confirm ? '--confirm flag' : 'interactive y';
  const bot = await launchProposal(ctx, proposalId, { confirmedBy });
  saveState(state);
  console.log(`${c.green('✔')} ${bot.id} launched and ${c.green('running')}. The steward now watches it: node src/index.js tick --watch`);
}

async function cmdStatus() {
  const state = requireState();
  const ctx = makeCtx(state);
  console.log(c.bold(`\nBot Butler status — mode ${ctx.okx.mode}, tick ${state.market?.tick ?? 'n/a'}`));
  console.log(hr());

  const instruments = await ctx.okx.listInstruments();
  console.log(c.bold('Market'));
  for (const inst of instruments.filter((i) => i.major)) {
    const candles = await ctx.okx.fetchCandles(inst.instId, { limit: 60 });
    const m = detectRegime(candles);
    console.log(
      `  ${inst.instId.padEnd(10)} ${fmtPx(m.price).padStart(10)}  ATR ${fmtNum(m.atrPct, 2)}%  trend ${fmtNum(m.trendScore, 2).padStart(6)}  ${m.regime}`
    );
  }

  console.log('');
  console.log(c.bold('Bots'));
  if (!state.bots.length) console.log(c.dim('  none — run propose, then launch'));
  for (const bot of state.bots) {
    const b = await ctx.okx.getBot(bot.id);
    const st = b.status === 'running' ? c.green(b.status) : b.status === 'paused' ? c.yellow(b.status) : c.dim(b.status);
    console.log(
      `  ${b.botId}  ${b.instId}  ${b.type}  ${st}  invested ${fmtUsd(b.investment, 0)}  fills ${b.fills}  P&L ${fmtSignedUsd(b.totalPnl)}` +
        (bot.type === 'grid' ? c.dim(`  range [${fmtPx(bot.params.lower)} … ${fmtPx(bot.params.upper)}]`) : '')
    );
  }

  console.log('');
  console.log(c.bold(`Recent actions (${state.actions.length} total)`));
  for (const a of state.actions.slice(-6)) {
    console.log(c.dim(`  t=${a.tick ?? '–'} ${a.type}${a.botId ? ' ' + a.botId : ''} — ${a.reason}`));
  }
  console.log('');
}

async function cmdTick(opts) {
  const state = requireState();
  const ctx = makeCtx(state);
  const watch = Boolean(opts.watch);
  const intervalMs = Math.max(0.2, Number(opts.interval ?? 5)) * 1000;
  const maxTicks = opts.ticks ? Number(opts.ticks) : watch ? Infinity : 1;

  let n = 0;
  let stop = false;
  if (watch) {
    console.log(c.dim(`Steward watch: every ${intervalMs / 1000}s${Number.isFinite(maxTicks) ? `, ${maxTicks} ticks` : ''} (Ctrl+C to stop)`));
    process.on('SIGINT', () => {
      stop = true;
      console.log(c.dim('\nStopping after this tick — state is saved every tick.'));
    });
  }

  while (n < maxTicks && !stop) {
    const report = await runTick(ctx);
    saveState(state);
    n++;
    const parts = [`t=${report.tick}`];
    for (const b of report.bots) {
      parts.push(
        `${b.instId} ${fmtPx(b.m.price)} trend ${fmtNum(b.m.trendScore, 2)} ${b.m.regime} | ${b.botId}:${state.bots.find((x) => x.id === b.botId)?.status}`
      );
    }
    if (!report.bots.length) parts.push(c.dim('(no bots to steward — market still advances)'));
    console.log(parts.join('  '));
    for (const a of report.actions) {
      const tag = a.type === 'auto_pause' ? c.red(a.type) : a.type === 'auto_resume' ? c.green(a.type) : c.yellow(a.type);
      console.log(`    ${tag}: ${a.reason}`);
    }
    if (watch && n < maxTicks && !stop) await sleep(intervalMs);
  }
}

async function cmdDigest() {
  const state = requireState();
  const ctx = makeCtx(state);
  const digest = await writeDigest(ctx);
  saveState(state);
  console.log(digest.markdown);
  console.log(c.dim(`\nWritten to ${digest.file}`));
}

async function cmdManual(action, positionals, opts) {
  const state = requireState();
  const ctx = makeCtx(state);
  const botId = positionals[0];
  if (!botId) {
    console.error(`Usage: node src/index.js ${action} <botId> [--confirm]`);
    process.exit(1);
  }
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) {
    console.error(`Unknown bot '${botId}'.`);
    process.exit(1);
  }
  const ok = await confirmOrAbort(`${action.toUpperCase()} ${botId} (${bot.instId}, currently ${bot.status})?`, opts);
  if (!ok) return;

  if (action === 'pause') await ctx.okx.pauseBot(botId);
  else if (action === 'resume') await ctx.okx.resumeBot(botId);
  else await ctx.okx.stopBot(botId);
  if (action === 'pause') bot.pausedAtTick = state.market?.tick ?? null;

  appendAction(state, {
    type: `manual_${action}`,
    botId,
    instId: bot.instId,
    reason: `user requested ${action} via CLI`,
  });
  saveState(state);
  console.log(`${c.green('✔')} ${botId} is now ${state.bots.find((b) => b.id === botId).status}.`);
}

async function cmdResize(positionals, opts) {
  const state = requireState();
  const ctx = makeCtx(state);
  const botId = positionals[0];
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) {
    console.error(`Unknown bot '${botId}'. Usage: resize <botId> [--confirm]`);
    process.exit(1);
  }
  if (bot.type !== 'grid') {
    console.error('Resize applies to grid bots only.');
    process.exit(1);
  }
  const candles = await ctx.okx.fetchCandles(bot.instId, { limit: 60 });
  const m = detectRegime(candles);
  const suggested = planGridParams({ price: m.price, atr: m.atr, risk: bot.risk, investment: bot.investment });
  console.log(
    `Re-center ${botId} (${bot.instId}): [${fmtPx(bot.params.lower)} … ${fmtPx(bot.params.upper)}] -> ` +
      `[${fmtPx(suggested.lower)} … ${fmtPx(suggested.upper)}] (${suggested.gridCount} grids around price ${fmtPx(m.price)})`
  );
  const ok = await confirmOrAbort('Apply this resize (stop + recreate around current price)?', opts);
  if (!ok) return;
  await ctx.okx.amendBotRange(botId, {
    lower: suggested.lower,
    upper: suggested.upper,
    gridCount: suggested.gridCount,
    spacing: suggested.spacing,
    spacingPct: suggested.spacingPct,
    perGridQuote: suggested.perGridQuote,
  });
  bot.pausedAtTick = null;
  appendAction(state, {
    type: 'resize_applied',
    botId,
    instId: bot.instId,
    reason: `user confirmed re-center to [${fmtPx(suggested.lower)} … ${fmtPx(suggested.upper)}] around price ${fmtPx(m.price)}`,
    details: { range: [suggested.lower, suggested.upper], gridCount: suggested.gridCount },
  });
  saveState(state);
  console.log(`${c.green('✔')} ${botId} resized and running.`);
}

async function cmdReset(opts) {
  const ok = await confirmOrAbort('Delete state/butler-state.json and start fresh?', opts);
  if (!ok) return;
  resetState();
  console.log('State cleared.');
}

// --------------------------------------------------------------------------

async function main() {
  const { values: opts, positionals } = parseArgs({
    options: {
      budget: { type: 'string' },
      risk: { type: 'string' },
      prefer: { type: 'string' },
      confirm: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string' },
      ticks: { type: 'string' },
      seed: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const [command, ...rest] = positionals;
  if (!command || opts.help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'propose': return cmdPropose(rest, opts);
    case 'launch': return cmdLaunch(rest, opts);
    case 'status': return cmdStatus();
    case 'tick': return cmdTick(opts);
    case 'digest': return cmdDigest();
    case 'demo': return void (await runDemo({ seed: opts.seed ? Number(opts.seed) : 7 }));
    case 'pause':
    case 'resume':
    case 'stop': return cmdManual(command, rest, opts);
    case 'resize': return cmdResize(rest, opts);
    case 'reset': return cmdReset(opts);
    case 'help': return void console.log(HELP);
    default:
      console.error(`Unknown command '${command}'. Try: node src/index.js help`);
      process.exit(1);
  }
}

main().catch((err) => {
  if (err.code === 'OKX_REAL_NOT_WIRED' || err.code === 'LLM_REAL_NOT_WIRED') {
    console.error(c.yellow(err.message));
  } else {
    console.error(c.red(`Error: ${err.message}`));
    if (process.env.DEBUG) console.error(err.stack);
  }
  process.exit(1);
});
