// State persistence: one JSON file (state/butler-state.json), no database.
// Holds the simulated market, proposals, bot records (incl. fill sims), and
// the append-only action log — the audit trail behind "no silent changes".

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_PATH, okxMode } from './config.js';
import { nowIso } from './util.js';
import { initMarket } from './mock/market.js';

export function stateExists() {
  return fs.existsSync(STATE_PATH);
}

export function initState({ seed = 42, mode = okxMode() } = {}) {
  const state = {
    version: 1,
    createdAt: nowIso(),
    mode,
    seed,
    market: mode === 'mock' ? initMarket(seed) : null,
    proposals: [],
    bots: [],
    actions: [],
    counters: { proposal: 0, bot: 0 },
    lastDigestAt: null,
  };
  saveState(state);
  return state;
}

export function loadState() {
  if (!stateExists()) return null;
  const raw = fs.readFileSync(STATE_PATH, 'utf8');
  const state = JSON.parse(raw);
  const mode = okxMode();
  if (state.mode !== mode) {
    console.error(
      `[state] Warning: state file was created in '${state.mode}' mode but OKX_MODE is '${mode}'. ` +
        `Run 'node src/index.js reset --confirm' to start fresh in the new mode.`
    );
  }
  return state;
}

/** Load existing state or initialize a fresh one. */
export function loadOrInitState(opts = {}) {
  return loadState() ?? initState(opts);
}

export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH); // atomic-ish: never leaves a half-written state file
}

export function resetState() {
  if (fs.existsSync(STATE_PATH)) fs.rmSync(STATE_PATH);
  const tmp = STATE_PATH + '.tmp';
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
}

/**
 * Append to the action log. Every bot-affecting decision goes through here —
 * this is the audit trail the digest reports from.
 * action: { type, botId?, instId?, reason, details? }
 */
export function appendAction(state, action) {
  const entry = {
    ts: nowIso(),
    tick: state.market?.tick ?? null,
    ...action,
  };
  state.actions.push(entry);
  return entry;
}

export function statePathForDisplay() {
  return path.relative(process.cwd(), STATE_PATH) || STATE_PATH;
}
