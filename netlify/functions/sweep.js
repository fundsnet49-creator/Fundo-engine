// FUNDO Engine — SELF-TRIGGERING withdrawal autopilot sweep.
//
// The engine only acts on withdrawals when something calls
// /.netlify/functions/engine?sweep=1. Until now that "something" was a timer on
// your phone (Sketchware) — if the phone was off or had no data, withdrawals
// sat there forever, which is exactly the "I placed a withdrawal in the morning
// and the bot never declined it" bug.
//
// This scheduled function makes Netlify itself ring the engine every minute,
// so the autopilot (approve/decline + stale cleanup) works 24/7 with the
// phone completely off. No Sketchware timer needed anymore (you can keep it as
// a backup, it does no harm).
//
// Scheduling is declared in netlify.toml (see the README): this file only
// contains the handler.
const BASE = (process.env.URL || 'https://fundo-engine.netlify.app').replace(/\/$/, '');

exports.handler = async () => {
  const key = process.env.HOOK_KEY || '';
  if (!key) {
    console.error('sweep: HOOK_KEY env var is missing — cannot authenticate to the engine');
    return { statusCode: 500, body: 'HOOK_KEY missing' };
  }
  try {
    const res = await fetch(BASE + '/.netlify/functions/engine?sweep=1', {
      headers: { 'x-autopilot-key': key }
    });
    const text = await res.text();
    console.log('sweep -> engine:', res.status, text.slice(0, 400));
    return { statusCode: 200, body: 'sweep done: ' + res.status };
  } catch (e) {
    console.error('sweep failed:', e && e.message);
    return { statusCode: 502, body: 'sweep failed: ' + (e && e.message) };
  }
};
