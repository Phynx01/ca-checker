// netlify/functions/paper.js
// Paper trading for Moonscan picks. Virtual money only. No schedule here on purpose:
// scan-cron.js calls  /paper?tick=1  every 5 minutes. Read state: /paper

import { getStore } from "@netlify/blobs";

// ---- rules (all tunable) ----
const START = 50;              // virtual dollars
const SIZE = 5;                // dollars per trade
const MAX_OPEN = 3;
const MIN_SCORE = 80;          // Moonscan score needed (scan's own pick bar is 65)
const MIN_LIQ = 10000;         // live pool liquidity, USD
const MAX_TOP10 = 25;          // top 10 holders %, must be known
const MIN_MCAP = 15000, MAX_MCAP = 500000;
const CONFIRMS = 3;            // must be a pick in 3 scans in a row (about 15 min)
const MAX_RUN_UP = 1.5;        // reset if price is 1.5x its first sighting (chasing)
const MIN_DIP = 0.85;          // reset if price is below 0.85x its first sighting
const MAX_H1_PUMP = 150;       // skip if already up 150% in 1h
const TP = 2.0;                // sell at 2x entry (+100%)
const SL = 0.7;                // sell at 0.7x entry (-30%)
const MAX_HOLD_MS = 12 * 3600 * 1000;
const BUY_HAIRCUT = 0.03;      // buys fill 3% worse
const SELL_HAIRCUT = 0.03;     // sells fill 3% worse
const THIN_LIQ = 3000;         // below this liquidity, sells fill 10% worse
const THIN_SELL_HAIRCUT = 0.10;
const HALT_EQUITY = 40;        // stop opening trades if equity falls under this
const MAX_MISSES = 6;          // no price for 6 ticks (30 min) = assume dead, write off

function fresh() {
  return { start: START, cash: START, open: [], closed: [], watch: {}, everTraded: {},
           wins: 0, losses: 0, halted: false, lastRanAt: 0, startedAt: Date.now() };
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
  const pnl = proceeds - pos.cost;
  st.cash += proceeds;
  if (pnl >= 0) st.wins++; else st.losses++;
  st.closed.unshift({ ca: pos.ca, label: pos.label, cost: r2(pos.cost), proceeds: r2(proceeds),
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
  if (!f.mcap || f.mcap < MIN_MCAP || f.mcap > MAX_MCAP) return "mcap";
  if (!f.liquidity || f.liquidity < MIN_LIQ) return "scan liquidity";
  if (pair.liq < MIN_LIQ) return "live liquidity";
  if (pair.h1 !== null && pair.h1 > MAX_H1_PUMP) return "already pumped";
  return null;
}

async function tick(store) {
  const now = Date.now();
  const st = (await store.get("state", { type: "json" })) || fresh();

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
    const mult = pair.price / pos.entryPrice;
    let why = null;
    if (mult >= TP) why = "take profit";
    else if (mult <= SL) why = "stop loss";
    else if (pair.liq < 1000) why = "liquidity collapsed";
    else if (now - pos.openedAt >= MAX_HOLD_MS) why = "time limit";
    if (why) closePos(st, pos, pair.price, pair.liq, why, now); else still.push(pos);
  }
  st.open = still;

  if (!st.halted && equity(st) < HALT_EQUITY) st.halted = true;

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
      if (st.halted || st.open.length >= MAX_OPEN || st.cash < SIZE) continue;
      const fill = pair.price * (1 + BUY_HAIRCUT);
      st.cash -= SIZE;
      st.open.push({ ca: p.ca, label: p.label, entryPrice: fill, qty: SIZE / fill, cost: SIZE,
        openedAt: now, lastPrice: pair.price, lastLiq: pair.liq, score: p.score, misses: 0 });
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
    halted: st.halted, wins: st.wins, losses: st.losses, lastRanAt: st.lastRanAt,
    open: st.open.map(p => ({ ca: p.ca, label: p.label, mult: r2((p.lastPrice || 0) / p.entryPrice),
      cost: p.cost, openedAt: p.openedAt, liq: Math.round(p.lastLiq || 0) })),
    closed: st.closed.slice(0, 15),
    watch: Object.entries(st.watch).map(([ca, w]) => ({ ca, label: w.label, count: w.count, need: CONFIRMS })),
    rules: { size: SIZE, maxOpen: MAX_OPEN, minScore: MIN_SCORE, minLiq: MIN_LIQ, maxTop10: MAX_TOP10,
      confirms: CONFIRMS, takeProfit: "+" + Math.round((TP - 1) * 100) + "%",
      stopLoss: "-" + Math.round((1 - SL) * 100) + "%", haltBelow: HALT_EQUITY },
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
