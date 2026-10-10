export default async () => {
  try {
    await fetch("https://degen-checker.netlify.app/.netlify/functions/scan");
  } catch (e) {
    console.log("scan-cron failed", String(e));
  }
};

export const config = { schedule: "*/5 * * * *" };
