import fs from "fs";
import { pathToFileURL } from "url";
import { METRICS, formatValue } from "./metrics.js";

// ---------------------------------------------------------------------------
// Statistiek
// ---------------------------------------------------------------------------

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Median absolute deviation: robuuste spreidingsmaat. Ongevoelig voor de ene
// run waarin je virusscanner besloot wakker te worden.
function mad(values) {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// Block bootstrap: we trekken hele blokken met teruglegging, niet losse runs.
// Runs binnen een blok delen dezelfde servertoestand en cachestand en zijn dus
// onderling gecorreleerd; wie losse runs trekt doet alsof hij veel meer
// onafhankelijke metingen heeft dan waar en krijgt een veel te smal interval.
function blockBootstrapDiff(onRows, offRows, key, iterations = 5000) {
  const blocksOf = (rows) => [...groupBy(rows, (r) => r.block).values()];
  const onBlocks = blocksOf(onRows);
  const offBlocks = blocksOf(offRows);

  const resample = (blocks) => {
    const values = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[Math.floor(Math.random() * blocks.length)];
      for (const row of block) {
        if (row[key] !== null) values.push(row[key]);
      }
    }
    return values;
  };

  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    diffs.push(median(resample(onBlocks)) - median(resample(offBlocks)));
  }
  diffs.sort((a, b) => a - b);

  return { low: quantile(diffs, 0.025), high: quantile(diffs, 0.975) };
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

export function report(rows, { mode = "ab" } = {}) {
  const perTarget = groupBy(rows, (r) => `${r.url}||${r.device}`);

  for (const [target, targetRows] of perTarget) {
    const [url, device] = target.split("||");
    const onRows = targetRows.filter((r) => r.variant === "on");
    const offRows = targetRows.filter((r) => r.variant === "off");

    console.log(`\n\n===== ${device.toUpperCase()} - ${url} =====`);
    if (onRows.length === 0 || offRows.length === 0) {
      console.log("Onvoldoende data: een van beide varianten ontbreekt.");
      continue;
    }

    const onBlocks = new Set(onRows.map((r) => r.block)).size;
    const offBlocks = new Set(offRows.map((r) => r.block)).size;
    console.log(
      `n = ${onRows.length} runs over ${onBlocks} blokken (aan) ` +
        `vs ${offRows.length} runs over ${offBlocks} blokken (uit)`,
    );

    // Was de edge-cache niet in elk blok in dezelfde staat, dan zit het
    // verschil tussen HIT en MISS in je cijfers en is de vergelijking stuk.
    const statuses = new Set(
      targetRows.map((r) => r.cfCacheStatus).filter((s) => s !== null && s !== undefined),
    );
    if (statuses.size > 1) {
      console.log(
        `LET OP: wisselende cf-cache-status (${[...statuses].join(", ")}). ` +
          `Verhoog PURGE_SETTLE_MS of WARMUP_RUNS; deze cijfers zijn nu niet te vertrouwen.`,
      );
    }

    const table = [];
    for (const metric of METRICS) {
      const onValues = onRows.map((r) => r[metric.key]).filter((v) => v !== null);
      const offValues = offRows.map((r) => r[metric.key]).filter((v) => v !== null);
      if (onValues.length === 0 || offValues.length === 0) continue;

      const onMedian = median(onValues);
      const offMedian = median(offValues);
      const diff = onMedian - offMedian;
      const ci = blockBootstrapDiff(onRows, offRows, metric.key);

      // Sluit het interval 0 uit, dan is het verschil niet met ruis te
      // verklaren. Zo niet, dan zegt deze meting simpelweg niets - dat is een
      // uitkomst, geen mislukking.
      const significant = (ci.low > 0 && ci.high > 0) || (ci.low < 0 && ci.high < 0);

      table.push({
        metric: metric.label,
        uit: formatValue(metric.unit, offMedian),
        aan: formatValue(metric.unit, onMedian),
        spreiding: `+/- ${formatValue(metric.unit, mad(offValues))}`,
        verschil: formatValue(metric.unit, diff, { signed: true }),
        "95% CI": `[${formatValue(metric.unit, ci.low, { signed: true })}, ${formatValue(
          metric.unit,
          ci.high,
          { signed: true },
        )}]`,
        oordeel: significant ? "aantoonbaar" : "ruis",
      });
    }
    console.table(table);
  }

  if (mode === "aa") {
    console.log(
      "\nA/A-run: beide 'varianten' zijn dezelfde configuratie. Alles wat hier\n" +
        "'aantoonbaar' heet is per definitie ruis - gebruik die getallen als\n" +
        "ondergrens voor wat je in een echte A/B-meting mag geloven.",
    );
  } else {
    console.log(
      "\nLees 'verschil' als aan-min-uit: negatief = sneller met FlyingPress.\n" +
        "Alleen regels met oordeel 'aantoonbaar' zijn aan de plugin toe te wijzen.",
    );
  }
}

// Los te draaien op een eerder weggeschreven dataset: node ab-report.js
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] || "./ab-results.json";
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  report(data.runs, { mode: data.mode });
}
