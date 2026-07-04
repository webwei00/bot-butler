// Small shared utilities: seeded PRNG, formatting, ANSI colors, time helpers.

/**
 * Mulberry32 PRNG with externally persistable state (a uint32).
 * `rng()` returns a float in [0,1); `rng.getState()` returns the state to store.
 */
export function makeRng(seedOrState) {
  let s = (seedOrState >>> 0) || 1;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => s;
  return rng;
}

/** Standard normal via Box-Muller. */
export function randNorm(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export const nowIso = () => new Date().toISOString();
export const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Round a price to a sensible tick precision based on its magnitude. */
export function roundPx(px) {
  if (!Number.isFinite(px)) return px;
  if (px >= 10000) return Math.round(px);
  if (px >= 1000) return Math.round(px * 10) / 10;
  if (px >= 10) return Math.round(px * 100) / 100;
  if (px >= 0.1) return Math.round(px * 10000) / 10000;
  return Math.round(px * 1e6) / 1e6;
}

export const round2 = (n) => Math.round(n * 100) / 100;

export function fmtPx(px) {
  const r = roundPx(px);
  return r >= 1000
    ? r.toLocaleString('en-US', { maximumFractionDigits: 1 })
    : String(r);
}

export function fmtUsd(n, digits = 2) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtSignedUsd(n, digits = 2) {
  return `${n >= 0 ? '+' : ''}${fmtUsd(n, digits)}`.replace('+-', '-');
}

export function fmtPct(n, digits = 2) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function fmtNum(n, digits = 2) {
  return Number(n).toFixed(digits);
}

// --- ANSI colors (degrade to plain text when not a TTY or NO_COLOR is set) ---
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  magenta: wrap('35'),
};

export function hr(char = '─', width = 62) {
  return char.repeat(width);
}
