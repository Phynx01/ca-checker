// Server-side aggregator: no CORS limits, and it reads the pump.fun bonding curve straight from the chain.
const crypto = require("crypto");
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const dec58 = s => { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); let h = n.toString(16); if (h.length % 2) h = "0" + h; let z = 0; for (const c of s) { if (c === "1") z++; else break; } return Buffer.concat([Buffer.alloc(z), Buffer.from(h, "hex")]); };
const enc58 = b => { let n = BigInt("0x" + (b.toString("hex") || "0")), o = ""; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } for (const x of b) { if (x === 0) o = "1" + o; else break; } return o; };
const pw = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; };
const onCurve = b => { const y = BigInt("0x" + Buffer.from(b).reverse().toString("hex")) & ((1n << 255n) - 1n); if (y >= P) return false; const y2 = y * y % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P, x2 = u * pw(v, P - 2n) % P; return x2 === 0n || pw(x2, (P - 1n) / 2n) === 1n; };
const pda = (seeds, prog) => { for (let bump = 255; bump >= 0; bump--) { const h = crypto.createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), prog, Buffer.from("ProgramDerivedAddress")])).digest(); if (!onCurve(h)) return h; } };
const PUMP = dec58("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];

async function curve(mint) {
  const address = enc58(pda([Buffer.from("bonding-curve"), dec58(mint)], PUMP));
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64" }] }) });
      const j = await r.json();
      if (!j.result) continue;
      if (!j.result.value) return { address, exists: false };
      const b = Buffer.from(j.result.value.data[0], "base64");
      if (b.length < 49) continue;
      return { address, exists: true, vTok: b.readBigUInt64LE(8).toString(), vSol: b.readBigUInt64LE(16).toString(),
        rTok: b.readBigUInt64LE(24).toString(), rSol: b.readBigUInt64LE(32).toString(), supply: b.readBigUInt64LE(40).toString(), complete: b[48] === 1 };
    } catch (e) {}
  }
  return null;
}
const g = (u, ms = 8000) => fetch(u, { signal: AbortSignal.timeout(ms), headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } }).then(r => r.ok ? r.json() : null).catch(() => null);

exports.handler = async e => {
  const ca = (e.queryStringParameters || {}).ca || "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return { statusCode: 400, body: "{}" };
  const [dex, rug, jup, pump, cv, sol] = await Promise.all([
    g("https://api.dexscreener.com/latest/dex/tokens/" + ca),
    g("https://api.rugcheck.xyz/v1/tokens/" + ca + "/report"),
    g("https://lite-api.jup.ag/tokens/v2/search?query=" + ca),
    g("https://frontend-api-v3.pump.fun/coins/" + ca),
    curve(ca),
    g("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112")]);
  const top = (sol && sol.pairs || []).filter(p => p.chainId === "solana" && Number(p.priceUsd) > 0).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 5).map(p => Number(p.priceUsd)).sort((a, b) => a - b);
  const med = top.length ? top[Math.floor(top.length / 2)] : null;
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, dex, rug, jup, pump, curve: cv, solUsd: med }) };
};
