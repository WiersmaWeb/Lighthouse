// Legt twee of meer A/B-metingen naast elkaar.
//
//   node vergelijk-metingen.js standaard=pad/naar/a.json optimaal=pad/naar/b.json
//
// Elke meting bevat zowel een uit- als een aan-toestand. De uit-toestanden
// horen identiek te zijn - de plugin was immers in beide gevallen gedeactiveerd
// - en dat is meteen je controle: lopen die uiteen, dan is er tussen de twee
// sessies iets anders veranderd dan alleen je configuratie, en is de
// vergelijking van de aan-toestanden niet te vertrouwen.
import fs from "fs";
import { METRICS, formatValue } from "./metrics.js";

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

const argumenten = process.argv.slice(2);
if (argumenten.length < 2) {
  console.error(
    "Geef minstens twee metingen mee, met een label ervoor:\n" +
      "  node vergelijk-metingen.js standaard=a.json optimaal=b.json",
  );
  process.exit(1);
}

const metingen = argumenten.map((arg) => {
  const index = arg.indexOf("=");
  if (index === -1) throw new Error(`Ontbrekend label: ${arg} (gebruik label=pad.json)`);
  const label = arg.slice(0, index);
  const pad = arg.slice(index + 1);
  const data = JSON.parse(fs.readFileSync(pad, "utf8"));
  if (data.mode !== "ab") throw new Error(`${pad} is geen A/B-meting (mode: ${data.mode}).`);
  return { label, pad, runs: data.runs };
});

const urls = [...new Set(metingen[0].runs.map((r) => r.url))];

const waarde = (meting, url, variant, key) => {
  const values = meting.runs
    .filter((r) => r.url === url && r.variant === variant && r[key] !== null)
    .map((r) => r[key]);
  return values.length ? median(values) : NaN;
};

for (const url of urls) {
  console.log(`\n===== ${url.replace(/^https?:\/\/[^/]+/, "") || "/"} =====\n`);

  const kolommen = metingen.map((m) => m.label);
  const kop = ["metric", "plugin uit", ...kolommen.map((l) => `aan (${l})`)];
  const rijen = [];

  for (const metric of METRICS) {
    if (metric.key === "cls" || metric.key === "tbt") continue;

    const uitWaarden = metingen.map((m) => waarde(m, url, "off", metric.key));
    const aanWaarden = metingen.map((m) => waarde(m, url, "on", metric.key));
    if (aanWaarden.some(Number.isNaN)) continue;

    const rij = { metric: metric.label };
    rij[kop[1]] = formatValue(metric.unit, median(uitWaarden));
    aanWaarden.forEach((v, i) => {
      rij[kop[2 + i]] = formatValue(metric.unit, v);
    });

    // Alleen zinvol bij twee metingen: wat de configuratiewijziging deed.
    if (metingen.length === 2) {
      rij["verschil"] = formatValue(metric.unit, aanWaarden[1] - aanWaarden[0], { signed: true });
    }
    rijen.push(rij);
  }
  console.table(rijen);

  // De controle: liggen de uit-toestanden op elkaar?
  const afwijkend = [];
  for (const metric of METRICS) {
    if (metric.unit !== "ms") continue;
    const uitWaarden = metingen.map((m) => waarde(m, url, "off", metric.key));
    if (uitWaarden.some(Number.isNaN)) continue;
    const spreiding = Math.max(...uitWaarden) - Math.min(...uitWaarden);
    if (spreiding > 200) {
      afwijkend.push(
        `${metric.label} ${uitWaarden.map((v) => formatValue(metric.unit, v)).join(" vs ")}`,
      );
    }
  }
  if (afwijkend.length) {
    console.log(
      `LET OP: de uit-toestanden lopen uiteen (${afwijkend.join("; ")}).\n` +
        `Er is tussen de sessies meer veranderd dan alleen de configuratie; ` +
        `vergelijk de aan-kolommen dan met de nodige terughoudendheid.`,
    );
  } else {
    console.log("Uit-toestanden liggen op elkaar: de sessies zijn vergelijkbaar.");
  }
}
