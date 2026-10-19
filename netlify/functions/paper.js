// netlify/functions/paper.js
// Paper trading for Moonscan picks. Virtual money only. No schedule here on purpose:
// scan-cron.js calls  /paper?tick=1  every 5 minutes. Read state: /paper
// Reset the sim: /paper?reset=yes  (wipes all history — only on purpose)
//
// strategy v2: half out at +50% then trail, no-chase entries,
// loss-streak cooldown, daily loss limit, halt re-checked every tick.

import { getStore } from "@netlify/blobs";

// ---- entries ----
const START = 50;              // virtual dollars
const SIZE = 2;                // dollars per trade (was 5)
const MAX_OPEN = 2;            // was 3
const MIN_SCORE = 80;          // Moonscan score needed (scan's own pick bar is 65)
const MIN_LIQ = 15000;         // live pool liquidity, USD (was 10000)
const MAX_TOP10 = 25;          // top 10 holders %, must be known
const MIN_LP_LOCK = 90;
const MIN_MCAP = 15000, MAX_MCAP = 500000;
const CONFIRMS = 3;            // must be a pick in 3 scans in a row (about 15 min)
const MAX_RUN_UP = 1.15;       // was 1.5 — reset if +15% above first sighting (no chasing)
const MIN_DIP = 0.90;          // was 0.85
const MAX_H1_PUMP = 60;        // was 150 — skip if already up 60% in 1h

// ---- exits ----
const TP1 = 1.5;               // sell half at +50%
const SL = 0.75;               // hard stop -25% before TP1
const TRAIL = 0.85;            // after TP1, remainder exits on 15% pullback from peak
const MAX_HOLD_MS = 4 * 3600 * 1000;    // was 12h
const TIME_STOP_MS = 3 * 3600 * 1000;   // if not +5% after 3h, the coin is dead
const TIME_STOP_MULT = 1.05;

// ---- costs (slippage simulation) ----
const BUY_HAIRCUT = 0.03;      // buys fill 3% worse
const SELL_HAIRCUT = 0.03;     // sells fill 3% worse
const THIN_LIQ = 3000;         // below this liquidity, sells fill 10% worse
const THIN_SELL_HAIRCUT = 0.10;

// ---- safety ----
const HALT_EQUITY = 40;        // re-checked every tick (not latched)
const MAX_MISSES = 6;          // no price for 6 ticks (30 min) = assume dead, write off
const LOSS_STREAK_HALT = 3;    // after 3 straight losses...
const COOLDOWN_TICKS = 12;     // ...no new entries for ~1 hour
const DAILY_LOSS_PCT = 0.20;   // down 20% from day's start = no new entries until tomorrow

function fresh() {
  return { start: START, cash: START, open: [], closed: [], watch: {}, everTraded: {},
           wins: 0, losses: 0, lossStreak: 0, cooldownUntil: 0,
           dayKey: "", dayStartEquity: START,
           halted: false, lastRanAt: 0, startedAt: Date.now() };
}

async function getPair(ca) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(ca),
      { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const d = await r.json();
    const pairs = ((d && d.pairs) || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return null;
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const p = pairs[0];
    const price = Number(p.priceUsd);
    if (!Number.isFinite(price) || price <= 0) return null;
    const h1 = p.priceChange && Number.isFinite(Number(p.priceChange.h1)) ? Number(p.priceChange.h1) : null;
    return { price, liq: (p.liquidity && Number(p.liquidity.usd)) || 0, h1 };
  } catch { return null; } finally { clearTimeout(t); }
}

const r2 = (x) => Math.round(x * 100) / 100;
function equity(st) { return st.cash + st.open.reduce((s, p) => s + p.qty * (p.lastPrice || 0), 0); }

function closePos(st, pos, price, liq, why, now) {
  const hc = liq < THIN_LIQ ? THIN_SELL_HAIRCUT : SELL_HAIRCUT;
  const proceeds = price == null ? 0 : pos.qty * price * (1 - hc);
  const pnl = (pos.realized || 0) + proceeds - pos.cost;   // includes earlier half-sale
  st.cash += proceeds;
  if (pnl >= 0) { st.wins++; st.lossStreak = 0; }
  else {
    st.losses++; st.lossStreak++;
    if (st.lossStreak >= LOSS_STREAK_HALT) st.cooldownUntil = now + COOLDOWN_TICKS * 5 * 60 * 1000;
  }
  st.closed.unshift({ ca: pos.ca, label: pos.label, cost: r2(pos.cost), proceeds: r2((pos.realized || 0) + proceeds),
    pnl: r2(pnl), pnlPct: r2((pnl / pos.cost) * 100), why, openedAt: pos.openedAt, closedAt: now });
  st.closed = st.closed.slice(0, 100);
}

// every condition must pass. one failure resets the coin's confirmation count.
function gate(p, pair) {
  const f = p.facts || {};
  if (p.tier !== "pick") return "not a pick";
  if (!(p.score >= MIN_SCORE)) return "score " + p.score;
  if (p.hard && p.hard.length) return "hard flag";
  if (f.top10 === null || f.top10 === undefined || f.top10 > MAX_TOP10) return "top10";
  if (p.lp === null || p.lp === undefined || p.lp < MIN_LP_LOCK) return "LP not locked";
  if (!f.mcap || f.mcap < MIN_MCAP || f.mcap > MAX_MCAP) return "mcap";
  if (!f.liquidity || f.liquidity < MIN_LIQ) return "scan liquidity";
  if (pair.liq < MIN_LIQ) return "live liquidity";
  if (pair.h1 !== null && pair.h1 > MAX_H1_PUMP) return "already pumped";
  return null;
}

async function tick(store) {
  const now = Date.now();
  const st = (await store.get("state", { type: "json" })) || fresh();
  // defaults so old saved states keep working
  st.lossStreak = st.lossStreak || 0;
  st.cooldownUntil = st.cooldownUntil || 0;
  if (!st.dayKey) { st.dayKey = ""; st.dayStartEquity = st.start; }

  // daily loss limit
  const today = new Date(now).toISOString().slice(0, 10);
  if (st.dayKey !== today) { st.dayKey = today; st.dayStartEquity = equity(st); }
  const dailyStop = equity(st) < st.dayStartEquity * (1 - DAILY_LOSS_PCT);

  // 1. manage open positions
  const still = [];
  for (const pos of st.open) {
    const pair = await getPair(pos.ca);
    if (!pair) {
      pos.misses = (pos.misses || 0) + 1;
      if (pos.misses >= MAX_MISSES) closePos(st, pos, null, 0, "no price, written off", now);
      else still.push(pos);
      continue;
    }
    pos.misses = 0; pos.lastPrice = pair.price; pos.lastLiq = pair.liq;
    pos.highWater = Math.max(pos.highWater || 0, pair.price);
    const mult = pair.price / pos.entryPrice;
    const age = now - pos.openedAt;
    const hc = pair.liq < THIN_LIQ ? THIN_SELL_HAIRCUT : SELL_HAIRCUT;

    if (pair.liq < 1000) { closePos(st, pos, pair.price, pair.liq, "liquidity collapsed", now); continue; }
    if (age >= MAX_HOLD_MS) { closePos(st, pos, pair.price, pair.liq, "time limit", now); continue; }
    if (age >= TIME_STOP_MS && mult < TIME_STOP_MULT) { closePos(st, pos, pair.price, pair.liq, "time stop (dead coin)", now); continue; }

    if (!pos.tp1Done) {
      if (mult >= TP1) {
        // sell half now; the rest runs with a breakeven/trailing stop
        const halfQty = pos.qty / 2;
        const proceeds = halfQty * pair.price * (1 - hc);
        st.cash += proceeds;
        pos.qty = halfQty;
        pos.realized = (pos.realized || 0) + proceeds;
        pos.tp1Done = true;
        still.push(pos);
        continue;
      }
      if (mult <= SL) { closePos(st, pos, pair.price, pair.liq, "stop loss", now); continue; }
      still.push(pos);
    } else {
      // after TP1: exit at breakeven or on a 15% pullback from the peak
      const stop = Math.max(pos.entryPrice, pos.highWater * TRAIL);
      if (pair.price <= stop) { closePos(st, pos, pair.price, pair.liq, "trail/breakeven stop", now); continue; }
      still.push(pos);
    }
  }
  st.open = still;

  st.halted = equity(st) < HALT_EQUITY;   // re-checked every tick, resumes on its own

  // 2. look at new picks (only once per scan run)
  const latest = await getStore("moonscan").get("latest", { type: "json" });
  if (latest && latest.ranAt && latest.ranAt !== st.lastRanAt) {
    st.lastRanAt = latest.ranAt;
    const picks = latest.picks || [];
    const inPicks = new Set(picks.map(p => p.ca));
    for (const ca of Object.keys(st.watch)) if (!inPicks.has(ca)) delete st.watch[ca];

    for (const p of picks.slice(0, 5)) {
      if (st.everTraded[p.ca]) continue;
      const pair = await getPair(p.ca);
      if (!pair || gate(p, pair)) { delete st.watch[p.ca]; continue; }
      let w = st.watch[p.ca];
      if (!w) { st.watch[p.ca] = { count: 1, firstPrice: pair.price, label: p.label, firstAt: now }; continue; }
      const ratio = pair.price / w.firstPrice;
      if (ratio > MAX_RUN_UP || ratio < MIN_DIP) { delete st.watch[p.ca]; continue; }
      w.count++;
      if (w.count < CONFIRMS) continue;
      if (st.halted || dailyStop || now < st.cooldownUntil || st.open.length >= MAX_OPEN || st.cash < SIZE) continue;
      const fill = pair.price * (1 + BUY_HAIRCUT);
      st.cash -= SIZE;
      st.open.push({ ca: p.ca, label: p.label, entryPrice: fill, qty: SIZE / fill, cost: SIZE,
        openedAt: now, lastPrice: pair.price, lastLiq: pair.liq, score: p.score, misses: 0,
        highWater: pair.price, tp1Done: false, realized: 0 });
      st.everTraded[p.ca] = now;
      delete st.watch[p.ca];
    }
  }

  await store.setJSON("state", st);
  return st;
}

function view(st) {
  const eq = equity(st);
  return {
    start: st.start, cash: r2(st.cash), equity: r2(eq), pnl: r2(eq - st.start),
    halted: st.halted, coolingDown: (st.cooldownUntil || 0) > Date.now(),
    wins: st.wins, losses: st.losses, lastRanAt: st.lastRanAt,
    open: st.open.map(p => ({ ca: p.ca, label: p.label, mult: r2((p.lastPrice || 0) / p.entryPrice),
      cost: p.cost, openedAt: p.openedAt, liq: Math.round(p.lastLiq || 0), tp1: !!p.tp1Done })),
    closed: st.closed.slice(0, 15),
    watch: Object.entries(st.watch).map(([ca, w]) => ({ ca, label: w.label, count: w.count, need: CONFIRMS })),
    rules: { size: SIZE, maxOpen: MAX_OPEN, minScore: MIN_SCORE, minLiq: MIN_LIQ, maxTop10: MAX_TOP10,
      confirms: CONFIRMS, takeProfit: "half at +" + Math.round((TP1 - 1) * 100) + "%, trail rest",
      stopLoss: "-" + Math.round((1 - SL) * 100) + "%", haltBelow: HALT_EQUITY,
      lossStreakHalt: LOSS_STREAK_HALT, dailyLossPct: DAILY_LOSS_PCT },
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
  try {
    const store = getStore("paper");
    if (url.searchParams.get("reset") === "yes") {
      const st = fresh(); await store.setJSON("state", st);
      return new Response(JSON.stringify({ reset: true }), { status: 200, headers });
    }
    const st = url.searchParams.has("tick") ? await tick(store)
      : ((await store.get("state", { type: "json" })) || fresh());
    return new Response(JSON.stringify(view(st)), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers });
  }
};
