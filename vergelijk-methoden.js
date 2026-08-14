// Hoe onzeker was de oude meetmethode eigenlijk?
//
// Reproduceert de oude aanpak (5 runs, computeMedianRun, dat ene getal
// rapporteren) op A/A-data - metingen waarin aantoonbaar niets veranderd is.
// Twee zulke metingen naast elkaar leggen is precies wat je vroeger deed als
// je "voor" en "na" vergeleek. Het verschil dat daaruit komt is dus volledig
// meetfout, en laat zien hoe groot een schijnbaar effect kon worden.
//
//   node vergelijk-methoden.js [pad-naar-aa-resultaten.json]
import fs from "fs";
import { METRICS, formatValue } from "./metrics.js";

const path = process.argv[2] || "./ab-results-aa.json";
const RUNS_PER_TEST = 5; // zoals in het oorspronkelijke script
const ITERATIONS = 20000;

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// Lighthouse kiest niet per metric een mediaan, maar de run die qua FCP en TTI
// het dichtst bij de mediaan ligt - euclidische afstand. Daarna rapporteert
// het alle metrics van die ene run. Vier van de vijf runs gaan dus het raam
// uit, inclusief hun informatie over de spreiding.
function medianRun(runs) {
  const medFcp = median(runs.map((r) => r.fcp));
  const medTti = median(runs.map((r) => r.tti));
  let best = runs[0];
  let bestDistance = Infinity;
  for (const run of runs) {
    const distance = (medFcp - run.fcp) ** 2 + (medTti - run.tti) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = run;
    }
  }
  return best;
}

const data = JSON.parse(fs.readFileSync(path, "utf8"));
if (data.mode !== "aa") {
  console.error(
    `Dit hoort op een A/A-dataset te draaien (gevonden: mode="${data.mode}").\n` +
      `Alleen daar weet je zeker dat elk gevonden verschil meetfout is.`,
  );
  process.exit(1);
}

const urls = [...new Set(data.runs.map((r) => r.url))];

console.log(
  `Oude methode (${RUNS_PER_TEST} runs + computeMedianRun) toegepast op A/A-data.\n` +
    `Twee zulke metingen naast elkaar = wat je vroeger "voor vs na" noemde.\n` +
    `Alles wat hieronder als verschil verschijnt, is dus meetfout.\n`,
);

for (const url of urls) {
  const runs = data.runs.filter((r) => r.url === url);

  // Alle vensters van 5 opeenvolgende runs, in de volgorde waarin ze gemeten
  // zijn - net zoals het oude script vijf runs achter elkaar deed.
  const windows = [];
  for (let i = 0; i + RUNS_PER_TEST <= runs.length; i++) {
    windows.push(medianRun(runs.slice(i, i + RUNS_PER_TEST)));
  }

  console.log(`\n===== ${url} =====`);
  console.log(`${runs.length} runs, ${windows.length} mogelijke metingen van ${RUNS_PER_TEST} runs\n`);

  const table = [];
  for (const metric of METRICS) {
    if (windows.some((w) => w[metric.key] === null)) continue;

    const waarden = windows.map((w) => w[metric.key]);

    // Twee niet-overlappende vensters trekken en het verschil bepalen: dat is
    // wat de oude methode je als "effect" zou hebben voorgeschoteld.
    const verschillen = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const a = Math.floor(Math.random() * windows.length);
      let b = Math.floor(Math.random() * windows.length);
      if (Math.abs(a - b) < RUNS_PER_TEST) continue; // overlap uitsluiten
      verschillen.push(windows[b][metric.key] - windows[a][metric.key]);
    }
    verschillen.sort((x, y) => x - y);

    table.push({
      metric: metric.label,
      laagst: formatValue(metric.unit, Math.min(...waarden)),
      hoogst: formatValue(metric.unit, Math.max(...waarden)),
      "schijnbaar effect (95%)":
        `${formatValue(metric.unit, quantile(verschillen, 0.025), { signed: true })} tot ` +
        `${formatValue(metric.unit, quantile(verschillen, 0.975), { signed: true })}`,
    });
  }
  console.table(table);
}

console.log(
  `\nLees de laatste kolom als: met de oude methode kon je dit verschil vinden\n` +
    `tussen twee metingen van een site die niet veranderd was. Een echt effect\n` +
    `kleiner dan dat was er met die aanpak niet uit te halen.`,
);
