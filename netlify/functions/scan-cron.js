const BASE = "https://degen-checker.netlify.app/.netlify/functions/";

export default async () => {
  try { await fetch(BASE + "scan"); } catch (e) { console.log("scan failed", String(e)); }
  try { await fetch(BASE + "paper?tick=1"); } catch (e) { console.log("paper failed", String(e)); }
};

export const config = { schedule: "*/5 * * * *" };
