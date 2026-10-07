#!/usr/bin/env node
// Cost model: built-in summary compaction vs fast-decide-compaction, per model.
// No dependencies. Run: node scripts/cost-model.mjs [--trigger 600000] [--new 4000] [--out 600] [--summary 20000]
// Prices are USD per million tokens, copied from OpenRouter's public model list on 2026-10-06; edit PRICES for yours.
//
// The model, per compaction cycle (the context grows from K tokens after compaction up to the trigger C):
//   turns per cycle   T = (C - K) / n                      (n = new tokens added per turn)
//   per-turn cost       = avgContext * cacheRead + n * cacheWrite + o * output       (avgContext = (K + C) / 2)
//   compaction cost     = [summary call: C * cacheRead + S * output]   (only for the built-in summary)
//                         + K * cacheWrite                              (the first turn after compaction rebuilds the cache)
//   Mercury Decide      = $0 on the free tier (you bring your own OpenRouter key)
// Cached = the prompt cache hits on the old prefix. Uncached = every turn pays full input price.

const PRICES = {
  'Claude Sonnet 5.5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'Claude Opus 5.5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'GPT-6.1 Sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'GPT-6 Astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const TRIGGER = arg('trigger', 600_000); // context size when compaction starts
const C = TRIGGER;
const n = arg('new', 4_000); // new tokens per turn (tool results + replies)
const o = arg('out', 600); // output tokens per turn
const S = arg('summary', 20_000); // tokens an LLM summary writes
const K0 = arg('summary-base', 20_000); // context left after a summary (system prompt + summary + recent turns)

// Share of the trigger context that fast-decide-compaction keeps (measured on real sessions, see README).
const CONFIGS = [
  ['fast-decide, small floor (~90% smaller)', 0.1],
  ['fast-decide, floor 6 on real sessions (~70% smaller)', 0.3],
  ['fast-decide, floor 40 + reuse (~50% smaller)', 0.5],
];

const M = 1e-6;
function perTurn(p, K, summary, cached, C = TRIGGER) {
  const T = (C - K) / n;
  const avg = (K + C) / 2;
  const read = cached ? p.cacheRead : p.input;
  const turn = avg * read * M + n * (cached ? p.cacheWrite : p.input) * M + o * p.output * M;
  const compaction =
    (summary ? C * read * M + S * p.output * M : 0) + K * (cached ? p.cacheWrite : p.input) * M;
  return { perTurn: (turn * T + compaction) / T, turns: T, compaction };
}

const fmt = (x) => '$' + x.toFixed(x < 0.1 ? 4 : 3);
const rows = [];
for (const cached of [true, false]) {
  for (const [model, p] of Object.entries(PRICES)) {
    const base = perTurn(p, K0, true, cached);
    for (const [label, share] of CONFIGS) {
      const ours = perTurn(p, C * share, false, cached);
      rows.push({
        cache: cached ? 'cached' : 'uncached',
        model,
        config: label,
        summaryPerTurn: base.perTurn,
        oursPerTurn: ours.perTurn,
        change: (ours.perTurn / base.perTurn - 1) * 100,
        summaryCompactionCost: base.compaction,
        oursCompactionCost: ours.compaction,
        turnsSummary: base.turns,
        turnsOurs: ours.turns,
      });
    }
  }
}

console.log(`trigger ${C} tokens, ${n} new tokens/turn, ${o} output/turn, summary writes ${S}, summary leaves ${K0}`);
for (const cache of ['cached', 'uncached']) {
  console.log(`\n== prompt cache: ${cache} ==`);
  console.log('model'.padEnd(20) + 'config'.padEnd(56) + 'summary $/turn  ours $/turn   change   compaction event: summary / ours');
  for (const r of rows.filter((x) => x.cache === cache)) {
    console.log(
      r.model.padEnd(20) +
        r.config.padEnd(56) +
        fmt(r.summaryPerTurn).padEnd(16) +
        fmt(r.oursPerTurn).padEnd(14) +
        ((r.change >= 0 ? '+' : '') + r.change.toFixed(0) + '%').padEnd(9) +
        fmt(r.summaryCompactionCost) + ' / ' + fmt(r.oursCompactionCost),
    );
  }
}
console.log('Break-even: extra "re-read" turns per summary cycle that the built-in summary would need to cause for fast-decide to cost the same (cached):');
for (const r of rows.filter((x) => x.cache === 'cached' && x.model === 'Claude Sonnet 5.5')) {
  console.log('  ' + r.config.padEnd(56) + (Math.max(0, (r.change / 100) * r.turnsSummary)).toFixed(0) + ' turns per ' + r.turnsSummary.toFixed(0) + '-turn cycle');
}

if (process.argv.includes('--sweep')) {
  // The biggest cost lever is how early you compact, not how you compact: every turn re-reads the whole context.
  const keepTokens = arg('keep', 40_000); // context left after compaction in the sweep (both methods)
  console.log('Trigger sweep (cached), context left after compaction = ' + keepTokens + ' tokens, $/turn:');
  const triggers = [100_000, 200_000, 400_000, 600_000, 900_000];
  console.log('model'.padEnd(20) + triggers.map((t) => ('@' + t / 1000 + 'k').padStart(10)).join(''));
  for (const [model, p] of Object.entries(PRICES)) {
    const cells = triggers.map((t) => fmt(perTurn(p, keepTokens, true, true, t).perTurn).padStart(10));
    console.log(model.padEnd(20) + cells.join(''));
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
