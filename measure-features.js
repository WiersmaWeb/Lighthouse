// Meet per FlyingPress-functie wat hij doet, met deterministische signalen in
// plaats van Lighthouse. Zet elke instelling los om, leegt de caches, wacht tot
// de pagina stabiel is, en telt bytes, verzoeken en aanwezigheid.
//
//   node measure-features.js
//
// Duurt een kwartier tot een half uur. Zet aan het eind elke instelling terug
// zoals hij hem aantrof, ook als er iets misgaat.
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { collectSignals, waitUntilStable } from "./page-signals.js";

try {
  process.loadEnvFile();
} catch {
  /* geen .env: variabelen worden uit de omgeving verwacht */
}

const execFileAsync = promisify(execFile);

const URL_TO_MEASURE =
  process.env.FEATURE_URL || "https://zfb2u17p7j-staging.onrocket.site/";
const SSH_TARGET = process.env.SSH_TARGET;
const WP_PATH = process.env.WP_PATH;
const SETTLE_MS = Number(process.env.PURGE_SETTLE_MS || 8000);
const OUTPUT_PATH = "./feature-results.json";

// Welke instelling hoort bij welke functie, en wat de standaardwaarde is. We
// zetten hem naar `test` en kijken wat er verandert ten opzichte van standaard.
const FEATURES = [
  // Meet de site-snelheid van je bezoekers en stuurt dat naar FlyingPress. Het
  // maakt je site dus niet sneller maar kost wel een script - de moeite waard
  // om apart te wegen.
  { key: "vitals", label: "Vitals-monitoring", standaard: true },
  { key: "css_js_minify", label: "CSS en JavaScript minificeren", standaard: true },
  { key: "css_rucss", label: "Ongebruikte CSS verwijderen", standaard: true },
  { key: "js_delay", label: "Alle JavaScript uitstellen", standaard: true },
  { key: "css_js_self_host_third_party", label: "Externe CSS/JS lokaal hosten", standaard: true },
  { key: "lazy_load", label: "Afbeeldingen lazyloaden", standaard: true },
  { key: "properly_size_images", label: "Afbeeldingen correct schalen", standaard: true },
  { key: "youtube_placeholder", label: "Lichte YouTube-voorvertoningen", standaard: true },
  { key: "self_host_gravatars", label: "Gravatars lokaal hosten", standaard: true },
  { key: "fonts_preload", label: "Lettertypen preloaden", standaard: true },
  { key: "fonts_optimize_google", label: "Google Fonts lokaal hosten", standaard: true },
  { key: "fonts_display_swap", label: "Systeemlettertype eerst tonen", standaard: true },
  { key: "lazy_render", label: "Elementen lazy renderen", standaard: true },
  { key: "cache_link_prefetch", label: "Links preloaden bij hover", standaard: true },
  // Deze staan standaard uit. Hier meten we wat aanzetten oplevert - relevant
  // voor de vraag welke configuratie je uiteindelijk wilt.
  { key: "bloat_disable_emojis", label: "Emoji-scripts uitschakelen", standaard: false },
  { key: "bloat_disable_dashicons", label: "Dashicons verwijderen", standaard: false },
  { key: "bloat_disable_block_css", label: "Block-editor CSS uitschakelen", standaard: false },
  { key: "bloat_disable_jquery_migrate", label: "jQuery Migrate uitschakelen", standaard: false },
  { key: "bloat_disable_xml_rpc", label: "XML-RPC uitschakelen", standaard: false },
  { key: "bloat_disable_rss_feed", label: "RSS-feed uitschakelen", standaard: false },
  { key: "bloat_disable_oembeds", label: "oEmbeds uitschakelen", standaard: false },
  { key: "bloat_heartbeat_control", label: "Heartbeat API beperken", standaard: false },
  // Stelt scripts van derden uit tot interactie. Op deze site gaat dat over
  // Google Tag Manager, veruit het zwaarste bestand op de pagina.
  { key: "js_delay_third_party", label: "Scripts van derden bij interactie", standaard: false },
];

// Met FEATURE_FILTER meet je een deelverzameling, gescheiden door komma's.
// Handig om er een paar bij te meten zonder de hele ronde over te doen.
const FILTER = (process.env.FEATURE_FILTER || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------

async function wp(args, { timeout = 180000 } = {}) {
  if (!SSH_TARGET || !WP_PATH) {
    throw new Error("SSH_TARGET en WP_PATH moeten gezet zijn. Zie .env.example.");
  }
  const { stdout } = await execFileAsync(
    "ssh",
    ["-o", "BatchMode=yes", SSH_TARGET, `wp --path='${WP_PATH}' ${args}`],
    { timeout, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

async function readConfig() {
  return JSON.parse(await wp("option get FLYING_PRESS_CONFIG --format=json"));
}

async function setFlag(key, value) {
  await wp(`option patch update FLYING_PRESS_CONFIG ${key} ${value} --format=json`);
  const config = await readConfig();
  if (config[key] !== value) {
    throw new Error(`Instelling ${key} bleef ${config[key]}, verwacht ${value}.`);
  }
}

// Beide caches, in deze volgorde: eerst die van de plugin zelf, dan de edge.
// Andersom trekt Cloudflare de oude versie meteen weer binnen.
async function purgeAll() {
  await wp("flying-press purge-everything");
  await wp("cdn purge");
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

async function measureCurrentState(label) {
  await purgeAll();
  const stability = await waitUntilStable(URL_TO_MEASURE);
  if (!stability.stable) {
    console.warn(
      `  LET OP: pagina niet meetklaar na ${stability.attempts} pogingen ` +
        `(bewerkt: ${stability.optimized}) - deze meting is niet te vertrouwen`,
    );
  }
  const signals = await collectSignals(URL_TO_MEASURE);
  console.log(
    `  ${label}: ${signals.cssCount} css (${signals.cssWire} b), ` +
      `${signals.jsCount} js (${signals.jsWire} b), ` +
      `${signals.imgCount} img (${signals.imgWire} b), ` +
      `${signals.jsBlocking} blokkerend`,
  );
  return { ...signals, stable: stability.stable, optimized: stability.optimized };
}

// ---------------------------------------------------------------------------

async function main() {
  const teMeten = FILTER.length ? FEATURES.filter((f) => FILTER.includes(f.key)) : FEATURES;
  if (FILTER.length && teMeten.length !== FILTER.length) {
    const onbekend = FILTER.filter((k) => !FEATURES.some((f) => f.key === k));
    throw new Error(`Onbekende sleutel(s) in FEATURE_FILTER: ${onbekend.join(", ")}`);
  }

  console.log(`Meet: ${URL_TO_MEASURE}`);
  console.log(`${teMeten.length} functies, elk apart omgezet.\n`);

  const original = await readConfig();
  fs.writeFileSync(
    "./flyingpress-config-backup.json",
    JSON.stringify(original, null, 2),
  );

  // Eerst alles op de standaardwaarden zetten, zodat de basislijn klopt
  // ongeacht waar we mee begonnen.
  console.log("Basislijn instellen op standaardwaarden...");
  for (const f of teMeten) {
    if (original[f.key] !== f.standaard) {
      console.log(`  ${f.key}: ${original[f.key]} -> ${f.standaard}`);
      await setFlag(f.key, f.standaard);
    }
  }

  // Bestaande metingen inlezen en aanvullen in plaats van overschrijven. Een
  // gefilterde run wiste eerder de rest van de dataset - dat kostte me vier
  // metingen die alleen nog in een terminalvenster stonden.
  let results = { url: URL_TO_MEASURE, features: [] };
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const bestaand = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
      if (bestaand.url === URL_TO_MEASURE && Array.isArray(bestaand.features)) {
        results = bestaand;
        console.log(`${bestaand.features.length} eerdere metingen behouden.`);
      }
    } catch {
      console.warn(`${OUTPUT_PATH} was niet te lezen; er wordt opnieuw begonnen.`);
    }
  }
  results.updatedAt = new Date().toISOString();

  // Elke meting krijgt zijn eigen basislijn mee. Anders vergelijk je metingen
  // uit verschillende sessies met een basislijn die inmiddels verschoven is.
  const bewaar = (entry) => {
    results.features = results.features.filter((f) => f.key !== entry.key);
    results.features.push(entry);
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));
  };

  try {
    console.log("\nBasislijn meten (alle standaardinstellingen)...");
    const baseline = await measureCurrentState("basislijn");
    results.baseline = baseline;

    for (const [i, f] of teMeten.entries()) {
      const test = !f.standaard;
      console.log(
        `\n[${i + 1}/${teMeten.length}] ${f.label}` +
          ` (${f.key}: ${f.standaard} -> ${test})`,
      );
      await setFlag(f.key, test);
      const measured = await measureCurrentState(test ? "aan" : "uit");
      await setFlag(f.key, f.standaard);

      bewaar({
        key: f.key,
        label: f.label,
        standaard: f.standaard,
        gemetenMet: test,
        gemetenOp: new Date().toISOString(),
        baseline,
        signals: measured,
      });
    }
  } finally {
    console.log("\nInstellingen terugzetten zoals aangetroffen...");
    for (const f of teMeten) {
      try {
        if (original[f.key] !== undefined) await setFlag(f.key, original[f.key]);
      } catch (err) {
        console.error(`  LET OP: ${f.key} niet teruggezet: ${err.message}`);
      }
    }
    await purgeAll();
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));
    console.log(`Resultaten in ${OUTPUT_PATH}`);
  }
}

main().catch((err) => {
  console.error("Er ging iets mis:", err.message);
  process.exit(1);
});
