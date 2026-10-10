// netlify/functions/scan.js
// Moonscan for CA Checker. Runs every 5 minutes, pulls the newest Solana tokens
// from DexScreener's trending proxies, runs each through the deployed check
// function, scores them, and stores the ranked list for the site to read.
//
// Two ways it is triggered:
//   1. Netlify schedule (see config.schedule at the bottom)
//   2. By hand: open https://degen-checker.netlify.app/.netlify/functions/scan
// Reading results (no trigger):  https://degen-checker.netlify.app/.netlify/functions/scan?results=1
//
// Version: v3.1-moonscan1

import { getStore } from "@netlify/blobs";

const VERSION = "v3.1-moonscan1";
const SITE = "https://degen-checker.netlify.app";
const SELF_CHECK = SITE + "/.netlify/functions/check?ca=";

// ---- knobs you can tune ----
const CAP = 10;             // max candidates checked per run. Invocation budget:
                            // 10 * 288 runs/day * 31 = ~89k/month of the 125k free tier,
                            // plus ~9k for the scheduled runs themselves. Raise with care.
const CONCURRENCY = 3;      // checks run in parallel, be kind to public APIs
const CHECK_TIMEOUT = 15000;
const GRAD_SOL = 85;        // approx SOL in a curve at graduation (from the handoff)
const BOND_MIN = 10, BOND_MAX = 70;   // sweet spot: early but proven
const MCAP_IDEAL = 500000;  // under this, a 10x is plausible; over it, harder
const LIQ_MIN = 500;        // below this there is nothing to sell into
const LIQ_FULL = 5000;      // above this the exit model is comfortable at $1 size

const DISCOVERY = [
  "https://api.dexscreener.com/token-boosts/latest/v1",
  "https://api.dexscreener.com/token-boosts/top/v1",
  "https://api.dexscreener.com/token-profiles/recent-updates/v1",
];
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------- small helpers ----------
function n(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }

// reads "a.b.c" paths, not just flat keys (the first version got this wrong)
function g(obj, path) {
  let o = obj;
  for (const k of path.split(".")) { if (o === null || o === undefined) return undefined; o = o[k]; }
  return o === null ? undefined : o;
}
function pick(obj, keys) {
  for (const k of keys) { const v = g(obj, k); if (v !== undefined) return v; }
  return undefined;
}

async function j(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- candidate discovery ----------
async function discover() {
  const feeds = await Promise.all(DISCOVERY.map(u => j(u, 12000)));
  const seen = new Map();
  for (const feed of feeds) {
    if (!Array.isArray(feed)) continue;
    for (const t of feed) {
      if (!t || t.chainId !== "solana") continue;
      const ca = t.tokenAddress;
      if (!ca || !SOLANA_MINT.test(ca) || seen.has(ca)) continue;
      seen.set(ca, { ca, label: (t.description || t.header || "").slice(0, 60) });
    }
  }
  // newest first is not knowable from these feeds, so just cap
  return [...seen.values()].slice(0, CAP);
}

// ---------- reading the raw payloads ----------
// NOTE: field names below are written defensively because the handoff says some
// Jupiter and RugCheck fields were noted from memory. If a field name here does
// not match what check.js returns, that reading silently drops out of the score
// instead of crashing. Align these with index.html once and write a test.

function bestPair(dex) {
  if (!dex || !Array.isArray(dex.pairs) || !dex.pairs.length) return null;
  const sol = dex.pairs.filter(p => p.chainId === "solana");
  const list = sol.length ? sol : dex.pairs;
  return list.reduce((a, b) => (n(pick(b, ["liquidity.usd"])) || 0) > (n(pick(a, ["liquidity.usd"])) || 0) ? b : a);
}

function poolAddresses(rug, pair) {
  const set = new Set();
  for (const m of (rug && rug.markets) || []) { if (m && m.address) set.add(m.address); }
  for (const key of ["pairAddress", "pair", "address"]) { if (pair && pair[key]) set.add(pair[key]); }
  // the bonding-curve PDA cannot be derived here without web3.js; check.js already
  // excludes it on single scans. Worst case a curve token over-counts ~1 holder.
  return set;
}

function top10Pct(rug, pair) {
  const holders = (rug && rug.topHolders) || [];
  const pools = poolAddresses(rug, pair);
  let sum = 0, counted = 0;
  for (const h of holders.slice(0, 10)) {
    const who = h.owner || h.address || h.pubkey;
    if (who && pools.has(who)) continue;
    const p = n(pick(h, ["pctSupply", "pct", "percent", "percentage"]));
    if (p !== null) { sum += p; counted++; }
  }
  return counted ? sum : null;
}

function insiderInfo(rug) {
  if (!rug) return { count: 0, pct: 0, unknown: true };
  const nets = (rug && rug.insiderNetworks) || [];
  const insiders = (rug && rug.insiders) || [];
  let pct = 0;
  for (const x of nets) pct += n(pick(x, ["pctSupply", "pct", "percentage"])) || 0;
  return { count: nets.length + insiders.length, pct, unknown: false };
}

function authoritiesOk(rug, jup) {
  const auths = (rug && rug.authorities) || [];
  const found = auths.filter(a => /mint|freeze/i.test(String(a.type || a.label || "")));
  if (found.length) return found.every(a => a.revoked === true || a.revoked === "true");
  // fallback: Jupiter audit flags
  const flags = (jup && (jup.auditFlags || jup.audit)) || [];
  return !flags.some(f => /mint|freeze|authority/i.test(String(f)));
}

function flow(pair) {
  const t = pair && pair.txns;
  const h1 = t && t.h1, m5 = t && t.m5;
  return {
    h1Buys: n(pick(h1 || {}, ["buys"])) || 0,
    h1Sells: n(pick(h1 || {}, ["sells"])) || 0,
    m5Buys: n(pick(m5 || {}, ["buys"])) || 0,
    m5Sells: n(pick(m5 || {}, ["sells"])) || 0,
  };
}

function momentum(jup, pair) {
  const j5 = n(pick(jup || {}, ["stats5m.priceChange", "stats5m", "priceChange5m"]));
  const j1h = n(pick(jup || {}, ["stats1h.priceChange", "stats1h"]));
  const d5 = pair && pair.priceChange ? n(pair.priceChange.m5) : null;
  const d1h = pair && pair.priceChange ? n(pair.priceChange.h1) : null;
  return { fiveMin: j5 !== null ? j5 : d5, oneHour: j1h !== null ? j1h : d1h };
}

function curveNumbers(curve, solUsd) {
  if (!curve || curve.exists === false || !solUsd) return null;
  const realSol = n(pick(curve, ["realSol", "realSolReserves", "realSOL", "real_sol_reserves"]));
  const virtSol = n(pick(curve, ["virtualSol", "virtualSolReserves", "virtual_sol_reserves"]));
  const virtTok = n(pick(curve, ["virtualTokens", "virtualTokenReserves", "virtual_token_reserves"]));
  const supply = n(pick(curve, ["totalSupply", "tokenTotalSupply"]));
  if (realSol === null || virtSol === null || virtTok === null || !virtTok) return null;
  const complete = curve.complete === true || curve.completed === true;
  // mcap math: price = (virtSol/1e9 SOL) / (virtTok/1e^d token); supply scales in 1e^d, decimals cancel
  const mcap = supply ? (virtSol * solUsd * supply) / (virtTok * 1e9) : null;
  return {
    complete,
    realSol,
    bondingPct: (realSol / GRAD_SOL) * 100,
    liquidity: realSol * solUsd,
    mcap,
  };
}

function poolLiquidity(pair) {
  const q = n(pick(pair || {}, ["liquidity.quote"]));
  const pu = n(pick(pair || {}, ["priceUsd"]));
  const pn = n(pick(pair || {}, ["priceNative"]));
  if (q === null || q <= 0 || !pu || !pn) return null;
  return q * (pu / pn);
}

// ---------- the moonshot filter ----------
// Honest label: this ranks candidates. It does not and cannot promise a 10x.
// Hard rejects mirror the single-scan rug checks. Soft scoring rewards early,
// liquid, holder-healthy coins with buy pressure and no insiders.

function evaluate(payload) {
  const { dex, rug, jup, curve, solUsd } = payload || {};
  const pair = bestPair(dex);
  const c = curveNumbers(curve, solUsd);
  const onCurve = !!(c && !c.complete);
  const liq = onCurve ? c.liquidity : poolLiquidity(pair);
  const mcap = onCurve ? c.mcap : n(pick(pair || {}, ["fdv", "marketCap"]));
  const t10 = top10Pct(rug, pair);
  const ins = insiderInfo(rug);
  const f = flow(pair);
  const mom = momentum(jup, pair);
  const links = ((pair && pair.links) || []).length;
  const rugged = rug && (rug.rugged === true || (rug.score === 0 && Array.isArray(rug.risks) && rug.risks.some(r => /danger/i.test(r.level || ""))));

  const hard = [];   // reasons it cannot be a pick
  const good = [];   // reasons it scores well
  let score = 0;

  if (!payload || payload.ok === false) hard.push("check failed");
  if (rugged) hard.push("rugged or danger risk");
  if (!authoritiesOk(rug, jup)) hard.push("mint/freeze authority live");

  if (onCurve) {
    if (c.bondingPct < 5) hard.push("curve nearly dead");
    else if (c.bondingPct < BOND_MIN) { score += 10; good.push("very early"); }
    else if (c.bondingPct <= BOND_MAX) { score += 30; good.push(`bonding ${Math.round(c.bondingPct)}%`); }
    else { score += 8; good.push("late on curve"); }
  }

  if (liq === null) hard.push("liquidity unknown");
  else if (liq < LIQ_MIN) hard.push(`thin liquidity $${Math.round(liq)}`);
  else if (liq >= LIQ_FULL) { score += 20; good.push(`liq $${Math.round(liq).toLocaleString()}`); }
  else { score += 8; good.push(`liq $${Math.round(liq)}`); }

  if (t10 !== null) {
    if (t10 > 40) hard.push(`top10 ${Math.round(t10)}%`);
    else if (t10 > 25) score += 0;
    else { score += 15; good.push(`top10 ${Math.round(t10)}%`); }
  }
  if (ins.unknown) { /* no claim either way when RugCheck is missing */ }
  else if (ins.count > 0) { if (ins.pct >= 10) hard.push("insiders >= 10%"); else hard.push("insiders present"); }
  else { score += 15; good.push("no insiders"); }

  if (f.h1Buys + f.h1Sells < 20) { score += 0; }
  else if (f.h1Sells > f.h1Buys) hard.push("sells lead buys (1h)");
  else { score += 10; good.push(`${f.h1Buys} buys / ${f.h1Sells} sells 1h`); }
  if (f.m5Sells > f.m5Buys && f.m5Buys + f.m5Sells > 0) { score -= 5; }

  if (mom.fiveMin !== null && mom.fiveMin <= -5) hard.push(`5m ${Math.round(mom.fiveMin)}%`);
  if (mom.oneHour !== null && mom.oneHour <= -30) hard.push(`1h ${Math.round(mom.oneHour)}%`);
  if (mom.fiveMin !== null && mom.fiveMin > 0 && mom.fiveMin <= 40) { score += 5; good.push(`5m +${Math.round(mom.fiveMin)}%`); }
  if (mom.oneHour !== null && mom.oneHour > 0 && mom.oneHour <= 100) score += 5;

  if (mcap === null) { score += 3; }
  else if (mcap <= MCAP_IDEAL) { score += 15; good.push(`mcap $${Math.round(mcap).toLocaleString()}`); }
  else if (mcap <= MCAP_IDEAL * 4) { score += 5; }
  else { score += 0; good.push("big mcap"); }

  if (links >= 2) score += 5;

  score = Math.max(0, Math.min(100, score));
  const tier = hard.length ? null : (score >= 65 ? "pick" : score >= 40 ? "watch" : null);
  return { score, tier, hard, good, facts: {
    onCurve, bondingPct: onCurve ? Math.round(c.bondingPct) : null,
    liquidity: liq ? Math.round(liq) : null,
    mcap: mcap ? Math.round(mcap) : null,
    top10: t10 !== null ? Math.round(t10) : null,
  } };
}

// ---------- one full run ----------
async function runScan() {
  const started = Date.now();
  const cands = await discover();
  const checked = await mapLimit(cands, CONCURRENCY, async (c) => {
    const payload = await j(SELF_CHECK + encodeURIComponent(c.ca), CHECK_TIMEOUT);
    if (!payload) return { ...c, error: "check call failed" };
    const ev = evaluate(payload);
    return { ...c, ...ev };
  });

  const ok = checked.filter(x => x && !x.error && x.tier);
  ok.sort((a, b) => b.score - a.score);
  const result = {
    version: VERSION,
    ranAt: Date.now(),
    ranAtISO: new Date().toISOString(),
    durationMs: Date.now() - started,
    scanned: checked.length,
    picks: ok.filter(x => x.tier === "pick").slice(0, 10),
    watches: ok.filter(x => x.tier === "watch").slice(0, 10),
    errors: checked.filter(x => x && x.error).map(x => ({ ca: x.ca, error: x.error })),
    note: "Ranked candidates, not predictions. Rug checks are strict; the 10x part is luck and narrative.",
  };

  const store = getStore("moonscan");
  await store.setJSON("latest", result);
  return result;
}

// ---------- entry point: scheduled run, manual run, or read results ----------
export default async (req) => {
  const url = new URL(req.url);
  const headers = { "content-type": "application/json" };

  if (url.searchParams.has("results")) {
    try {
      const store = getStore("moonscan");
      const data = await store.get("latest", { type: "json" });
      if (!data) return new Response(JSON.stringify({ empty: true, hint: "no scan stored yet" }), { status: 200, headers: { ...headers, "access-control-allow-origin": "*" } });
      return new Response(JSON.stringify(data), { status: 200, headers: { ...headers, "access-control-allow-origin": "*" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers });
    }
  }

  try {
    const summary = await runScan();
    const { picks, watches, ...rest } = summary;
    return new Response(JSON.stringify({ ...rest, picks: picks.length, watches: watches.length }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers });
  }
};


