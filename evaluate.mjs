/**
 * Accuracy harness for the complexity classifier.
 * Run:  node evaluate.mjs
 *
 * Reads dataset.json (each item = { q, tier } where tier is the
 * expected label: "light" | "mid" | "heavy"), runs the classifier,
 * and reports overall accuracy, a confusion matrix, and every miss
 * so you know exactly what to tune.
 */
import { readFileSync } from "node:fs";
import { classify } from "./classifier.js";

const data = JSON.parse(readFileSync(new URL("./dataset.json", import.meta.url)));
const ORDER = ["light", "mid", "heavy"];

let correct = 0;
const matrix = {}; // matrix[expected][predicted] = count
for (const e of ORDER) matrix[e] = { light: 0, mid: 0, heavy: 0 };
const misses = [];

for (const item of data) {
  const r = classify(item.q);
  const predicted = r.tier;
  matrix[item.tier][predicted]++;
  if (predicted === item.tier) {
    correct++;
  } else {
    misses.push({ q: item.q, expected: item.tier, got: predicted, score: r.score });
  }
}

const total = data.length;
const acc = ((correct / total) * 100).toFixed(1);

console.log(`\n=== Accuracy: ${correct}/${total} (${acc}%) ===\n`);

// Confusion matrix (rows = expected, cols = predicted)
console.log("Confusion matrix (rows=expected, cols=predicted):");
console.log("            light   mid   heavy");
for (const e of ORDER) {
  const row = ORDER.map((p) => String(matrix[e][p]).padStart(5)).join("  ");
  console.log(`  ${e.padEnd(8)} ${row}`);
}

// Per-tier recall
console.log("\nPer-tier recall:");
for (const e of ORDER) {
  const totalE = ORDER.reduce((s, p) => s + matrix[e][p], 0);
  const rec = totalE ? ((matrix[e][e] / totalE) * 100).toFixed(0) : "0";
  console.log(`  ${e.padEnd(8)} ${rec}%  (${matrix[e][e]}/${totalE})`);
}

// Misclassifications
if (misses.length) {
  console.log(`\nMisses (${misses.length}) — tune weights/thresholds for these:`);
  for (const m of misses) {
    console.log(
      `  [want ${m.expected}, got ${m.got} @${m.score}] ${m.q.slice(0, 70)}`
    );
  }
} else {
  console.log("\nNo misses. 100% on this dataset.");
}

// Cost-savings estimate vs. always-heavy (rough, edit the $/1k prices)
const PRICE = { light: 0.1, mid: 0.3, heavy: 2.5 }; // $ per 1k requests, placeholder
let routed = 0;
for (const item of data) routed += PRICE[classify(item.q).tier];
const allHeavy = total * PRICE.heavy;
const saved = (((allHeavy - routed) / allHeavy) * 100).toFixed(1);
console.log(
  `\nEst. cost vs always-Pro on this set: ${saved}% cheaper ` +
    `($${routed.toFixed(2)} vs $${allHeavy.toFixed(2)} per run of the set)\n`
);
