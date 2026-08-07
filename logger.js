/**
 * Request logger for the Chrome extension side.
 * Wraps classify() so every routed question is recorded, and persists the
 * log to chrome.storage so your analytics page can read it.
 *
 *   import { logRequest, getLog, exportDataset } from "./logger.js";
 *   const { model, score, tier } = await logRequest(userQuestion);
 *   // ...then call Gemini with `model`
 */
import { classify } from "./classifier.js";

const STORE_KEY = "router_request_log";

// Cost per 1,000 requests, per tier. EDIT to your real Gemini pricing.
export const PRICE_PER_1K = { light: 0.10, mid: 0.30, heavy: 2.50 };

// Works in an extension (chrome.storage) OR falls back to in-memory for testing.
const hasChrome = typeof chrome !== "undefined" && chrome.storage?.local;
let memLog = [];

async function readLog() {
  if (!hasChrome) return memLog;
  const out = await chrome.storage.local.get(STORE_KEY);
  return out[STORE_KEY] || [];
}
async function writeLog(log) {
  if (!hasChrome) { memLog = log; return; }
  await chrome.storage.local.set({ [STORE_KEY]: log });
}

/** Classify + record a prompt. Returns the routing result. */
export async function logRequest(prompt) {
  const r = classify(prompt);
  const log = await readLog();
  log.push({
    ts: Date.now(),
    prompt,
    score: r.score,
    tier: r.tier,
    model: r.model,
  });
  await writeLog(log);
  return r;
}

/** Full log array (for the analytics page). */
export async function getLog() {
  return readLog();
}

/** { counts, requests, routedCost, allHeavyCost, percentSaved } */
export async function getSummary() {
  const log = await readLog();
  const counts = { light: 0, mid: 0, heavy: 0 };
  for (const e of log) counts[e.tier]++;
  const n = log.length;
  const routed =
    (counts.light * PRICE_PER_1K.light +
      counts.mid * PRICE_PER_1K.mid +
      counts.heavy * PRICE_PER_1K.heavy) / 1000;
  const allHeavy = (n * PRICE_PER_1K.heavy) / 1000;
  const percentSaved = allHeavy ? ((allHeavy - routed) / allHeavy) * 100 : 0;
  return { counts, requests: n, routedCost: routed, allHeavyCost: allHeavy, percentSaved };
}

/** Print prompts in DATASET format so you can grow your labeled test set. */
export async function exportDataset() {
  const log = await readLog();
  return log.map((e) => `    { "q": ${JSON.stringify(e.prompt)}, "tier": "${e.tier}" },`).join("\n");
}

/** Wipe the log (e.g. a "reset" button on your dashboard). */
export async function clearLog() {
  await writeLog([]);
}
