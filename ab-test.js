import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { deviceConfigs } from "./device-configs.js";
import { extractMetrics } from "./metrics.js";
import { report } from "./ab-report.js";
import { cacheStatus, verifyPurgeWorks } from "./edge-cache.js";
import { waitUntilStable } from "./page-signals.js";

// Servergegevens komen uit .env (zie .env.example). Dat bestand staat in
// .gitignore - je SSH-gegevens horen niet in git.
try {
  process.loadEnvFile();
} catch {
  // Geen .env: dan verwachten we de variabelen gewoon in de omgeving.
}

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Houd deze lijst kort. Betrouwbaar meten kost runs, en runs kosten tijd;
// twee URL's diep meten is meer waard dan acht URL's oppervlakkig.
const URLS = [
  "https://zfb2u17p7j-staging.onrocket.site/",
  "https://zfb2u17p7j-staging.onrocket.site/websitesnelheid-getest-met-pagespeed-insights/",
  "https://zfb2u17p7j-staging.onrocket.site/contact/",
  "https://zfb2u17p7j-staging.onrocket.site/boost/",
];

// Mobiel is waar de ruimte zit en waar de ruis het grootst is. Zet er
// "desktop" bij als je die ook wilt, maar het verdubbelt de looptijd.
const DEVICES = ["mobile"];

// Metingen per blok, na de warm-up.
const RUNS_PER_BLOCK = Number(process.env.RUNS_PER_BLOCK || 4);

// Runs die worden weggegooid direct na een toggle. FlyingPress is een cache:
// de eerste hit na (de)activeren is een miss en is systematisch trager. Zonder
// warm-up meet je willekeurig cache-hits en -misses door elkaar.
const WARMUP_RUNS = Number(process.env.WARMUP_RUNS || 1);

// Elke cyclus is een ABBA-blok. Die volgorde is bewust: als de server in de
// loop van de sessie langzaam trager wordt, treft die drift beide varianten
// gelijk in plaats van in het voordeel van degene die je eerst mat.
const CYCLES = Number(process.env.CYCLES || 3);

// "ab" = echt meten, "aa" = ruisvloer bepalen. In aa-modus wordt de plugin
// nooit omgezet, maar worden de blokken wel als aan/uit gelabeld. Alles wat
// daar als verschil uitkomt is per definitie ruis.
// Via --aa en niet alleen via een env-variabele, want `MODE=aa node ...` werkt
// niet in PowerShell of cmd.
const MODE = process.argv.includes("--aa") || process.env.MODE === "aa" ? "aa" : "ab";

// Aparte bestanden per modus, zodat een A/B-run je ruisvloer niet overschrijft.
// Die twee horen bij elkaar: zonder de A/A-meting weet je niet vanaf welk
// verschil je de A/B-uitkomst mag geloven.
const OUTPUT_PATH = MODE === "aa" ? "./ab-results-aa.json" : "./ab-results.json";

// Serieel meten, altijd. Parallelle Chrome-instanties vechten om CPU en dat
// lekt door in je cijfers; throttlingMethod "simulate" dempt dat wel, maar de
// trace zelf wordt op echte CPU verzameld. Doorlooptijd inruilen voor
// betrouwbaarheid is hier het hele punt.

// SSH / WP-CLI. Zie .env.example.
const SSH_TARGET = process.env.SSH_TARGET;
const WP_PATH = process.env.WP_PATH;
const PLUGIN_SLUG = process.env.PLUGIN_SLUG || "flying-press";

// WP-CLI-commando dat de edge-cache leegt, zonder "wp" ervoor. Welk commando
// dat is verschilt per host; zie README.md voor hoe je het opzoekt.
// Bijvoorbeeld: "rocket purge" of "eval 'do_action(\"...\");'"
const PURGE_WP_COMMAND = process.env.PURGE_WP_COMMAND;

// Wachttijd na een purge voordat we gaan warmdraaien. De purge is asynchroon:
// het commando keert meteen terug, maar de edge loopt er achteraan.
//
// Deze stond op 8 seconden en dat was aantoonbaar te kort. Bij die instelling
// klapte de gemeten FCP halverwege een blok om van 1679 naar 2734 ms, met
// exact dezelfde HTML - de eerste metingen kregen nog de oude bestanden uit de
// cache, de latere de verse. Welke waarde je kreeg hing dus af van waar in het
// blok je toevallig mat. Met 60 seconden blijft de meting stabiel.
const PURGE_SETTLE_MS = Number(process.env.PURGE_SETTLE_MS || 60000);

// ---------------------------------------------------------------------------
// WP-CLI over SSH
// ---------------------------------------------------------------------------

async function wp(args) {
  if (!SSH_TARGET || !WP_PATH) {
    throw new Error(
      "SSH_TARGET en WP_PATH moeten gezet zijn. Zie README.md voor een voorbeeld.",
    );
  }
  if (WP_PATH.includes("'")) {
    throw new Error("WP_PATH mag geen enkele aanhalingstekens bevatten.");
  }

  // BatchMode zorgt dat ssh meteen faalt in plaats van om een wachtwoord te
  // vragen en dan te blijven hangen. Key-based auth is dus een vereiste.
  const remote = `wp --path='${WP_PATH}' ${args}`;
  const { stdout } = await execFileAsync(
    "ssh",
    ["-o", "BatchMode=yes", SSH_TARGET, remote],
    { timeout: 120000 },
  );
  return stdout.trim();
}

async function pluginStatus() {
  return wp(`plugin get ${PLUGIN_SLUG} --field=status`);
}

async function setPlugin(state) {
  const action = state === "on" ? "activate" : "deactivate";
  await wp(`plugin ${action} ${PLUGIN_SLUG}`);

  // Verifieren, niet aannemen. Een stilletjes mislukte toggle maakt je hele
  // meetsessie waardeloos, en dat merk je anders pas achteraf.
  const expected = state === "on" ? "active" : "inactive";
  const actual = await pluginStatus();
  if (actual !== expected) {
    throw new Error(
      `Toggle mislukt: ${PLUGIN_SLUG} is '${actual}', verwacht '${expected}'.`,
    );
  }
}

// Controleert dat WP_PATH echt de site is die we meten. Dit script
// deactiveert plugins; op de verkeerde installatie betekent dat dat je een
// live site aan het slopen bent. Meerdere WordPress-installaties onder een
// SSH-account is heel normaal - staging en productie staan vaak naast elkaar.
async function assertRightSite() {
  const home = (await wp("option get home")).trim();
  const expected = new URL(URLS[0]).origin;

  if (new URL(home).origin !== expected) {
    throw new Error(
      `WP_PATH wijst naar de verkeerde site.\n` +
        `  WP_PATH (${WP_PATH}) heeft home: ${home}\n` +
        `  maar de URL's in dit script staan op: ${expected}\n` +
        `Corrigeer WP_PATH in .env voordat je verder gaat.`,
    );
  }

  const afwijkend = URLS.filter((url) => new URL(url).origin !== expected);
  if (afwijkend.length > 0) {
    throw new Error(
      `Niet alle URL's staan op dezelfde site: ${afwijkend.join(", ")}\n` +
        `Het togglen van de plugin geldt maar voor een installatie.`,
    );
  }

  return home;
}

async function preflight() {
  console.log("Verbinding en WP-CLI controleren...");
  const version = await wp("--version");
  const home = await assertRightSite();
  const status = await pluginStatus();
  console.log(`  ${version}`);
  console.log(`  site: ${home}`);
  console.log(`  ${PLUGIN_SLUG}: ${status}`);
  if (status !== "active" && status !== "inactive") {
    throw new Error(
      `Onverwachte pluginstatus '${status}'. Klopt PLUGIN_SLUG (${PLUGIN_SLUG})?`,
    );
  }

  return status;
}

const purgeConfigured = Boolean(PURGE_WP_COMMAND);

async function purgeEdge() {
  if (!purgeConfigured) return;
  await wp(PURGE_WP_COMMAND);
}

// Los van de WP-preflight, want ook een A/A-run purget en moet dus weten dat
// het commando werkt.
async function purgePreflight() {
  if (!purgeConfigured) {
    console.warn(
      "LET OP: geen PURGE_WP_COMMAND. Staat er edge-caching voor je site, dan\n" +
        "serveert die de HTML van de vorige variant door en meet je het effect\n" +
        "van de plugin niet. Zie README.md om het purge-commando te vinden.",
    );
    return;
  }
  await verifyPurgeWorks({
    url: URLS[0],
    purge: purgeEdge,
    settleMs: PURGE_SETTLE_MS,
  });
}

// ---------------------------------------------------------------------------
// Meten
// ---------------------------------------------------------------------------

async function runOnce(url, device, port) {
  const runnerResult = await lighthouse(
    url,
    { port, logLevel: "error" },
    deviceConfigs[device],
  );
  return extractMetrics(runnerResult.lhr);
}

// Windows gooit soms EPERM omdat het tijdelijke Chrome-profiel nog heel even
// "vastzit" vlak na het afsluiten van het proces. We proberen het daarom een
// paar keer met een oplopende vertraging voordat we het negeren.
async function safeKill(chrome) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await chrome.kill();
      return;
    } catch (err) {
      if (attempt === 5) {
        console.warn(`Kon tijdelijke Chrome-map niet opruimen (genegeerd): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

async function runBlock(blockIndex, variant, runs) {
  // Chrome per blok opnieuw starten: schone profielstaat, geen geheugen dat
  // zich over een sessie van een uur opstapelt.
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless"] });
  try {
    for (const url of URLS) {
      for (const device of DEVICES) {
        for (let i = 0; i < WARMUP_RUNS; i++) {
          await runOnce(url, device, chrome.port);
        }

        // FlyingPress bouwt na een purge zijn geoptimaliseerde CSS opnieuw op.
        // Meet je daartussen, dan meet je een pagina die deels nog de
        // onbewerkte bestanden serveert - en dat zie je aan niets. We wachten
        // daarom tot twee opeenvolgende ophaalacties dezelfde HTML opleveren.
        // Bewust niet gebonden aan een specifieke instelling, zodat dit blijft
        // werken als de plugin verandert.
        // In een uit-blok is de plugin gedeactiveerd, dan hoort dat kenmerk er
        // juist niet te zijn.
        const stability = await waitUntilStable(url, { requireMarker: variant === "on" });
        if (!stability.stable) {
          console.warn(
            `  LET OP: ${url} was na ${stability.attempts} pogingen nog niet klaar ` +
              `(bewerkt: ${stability.optimized}); deze metingen kunnen een half ` +
              `opgebouwde cache bevatten.`,
          );
        }

        // Pas na de warm-up uitlezen: dit is de cachestand waarin de metingen
        // straks daadwerkelijk plaatsvinden. Kost een request en vereist geen
        // enkele configuratie, dus altijd doen.
        const cfStatus = await cacheStatus(url);

        for (let i = 0; i < RUNS_PER_BLOCK; i++) {
          const metrics = await runOnce(url, device, chrome.port);
          runs.push({
            block: blockIndex,
            variant,
            url,
            device,
            run: i,
            timestamp: new Date().toISOString(),
            cfCacheStatus: cfStatus,
            ...metrics,
          });
        }
        console.log(
          `  ${device} ${url} -> ${RUNS_PER_BLOCK} runs` +
            (cfStatus ? ` (cf-cache-status: ${cfStatus})` : ""),
        );
      }
    }
  } finally {
    await safeKill(chrome);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const blocks = [];
  for (let c = 0; c < CYCLES; c++) blocks.push("on", "off", "off", "on");

  const runsPerBlock = URLS.length * DEVICES.length * (RUNS_PER_BLOCK + WARMUP_RUNS);
  const totalRuns = blocks.length * runsPerBlock;
  console.log(
    `Modus: ${MODE.toUpperCase()} | ${blocks.length} blokken (ABBA x ${CYCLES}) | ` +
      `${URLS.length} URL's x ${DEVICES.length} device(s)\n` +
      `${totalRuns} Lighthouse-runs totaal, waarvan ` +
      `${blocks.length * URLS.length * DEVICES.length * WARMUP_RUNS} warm-up.\n` +
      `Reken op grofweg ${Math.round((totalRuns * 15) / 60)} minuten.\n`,
  );

  let originalStatus = null;
  if (MODE === "ab") {
    originalStatus = await preflight();
  } else {
    // De A/A-run moet exact dezelfde handelingen doen als de echte meting,
    // inclusief purgen. Anders meet je een ruisvloer die de purge-variatie
    // niet bevat en is hij te optimistisch.
    console.log("A/A-modus: de plugin wordt niet omgezet, wel gepurged.");
    // Ook hier controleren: we purgen via WP_PATH, en dat moet wel de site
    // zijn die we meten.
    if (purgeConfigured) console.log(`  site: ${await assertRightSite()}`);
  }
  await purgePreflight();
  console.log("");

  // Met --check alleen controleren of alles klopt, zonder een uur te meten.
  if (process.argv.includes("--check")) {
    console.log("Alles in orde. Draai zonder --check om echt te meten.");
    return;
  }

  const runs = [];
  try {
    for (let i = 0; i < blocks.length; i++) {
      const variant = blocks[i];
      // In A/A-modus is `variant` puur een groepslabel: er wordt niets omgezet.
      // Dat moet de melding ook zeggen, anders lijkt het alsof de plugin wel
      // aan en uit gaat.
      console.log(
        MODE === "ab"
          ? `\nBlok ${i + 1}/${blocks.length} - FlyingPress ${variant.toUpperCase()}`
          : `\nBlok ${i + 1}/${blocks.length} - groep ${variant === "off" ? "A" : "B"} ` +
              `(A/A: plugin blijft ongemoeid)`,
      );
      if (MODE === "ab") await setPlugin(variant);

      // Volgorde is essentieel: eerst de origin omzetten, dan pas de edge
      // leegmaken. Andersom trekt de edge de oude variant meteen weer binnen
      // en meet je een blok lang de verkeerde configuratie.
      if (purgeConfigured) {
        await purgeEdge();
        console.log(`  Edge gepurged, ${PURGE_SETTLE_MS / 1000}s wachten...`);
        await new Promise((resolve) => setTimeout(resolve, PURGE_SETTLE_MS));
      }

      await runBlock(i, variant, runs);
    }
  } finally {
    // Ook bij een fout: de site terugzetten zoals we hem aantroffen, en de
    // runs die we wel hebben wegschrijven.
    if (MODE === "ab" && originalStatus) {
      try {
        await setPlugin(originalStatus === "active" ? "on" : "off");
        console.log(`\nPlugin teruggezet op '${originalStatus}'.`);
      } catch (err) {
        console.error(`\nLET OP: kon plugin niet terugzetten op '${originalStatus}': ${err.message}`);
      }
    }
    if (runs.length > 0) {
      fs.writeFileSync(
        OUTPUT_PATH,
        JSON.stringify({ mode: MODE, createdAt: new Date().toISOString(), runs }, null, 2),
      );
      console.log(`${runs.length} runs opgeslagen in ${OUTPUT_PATH}`);
    }
  }

  report(runs, { mode: MODE });
}

main().catch((err) => {
  console.error("Er ging iets mis:", err.message);
  process.exit(1);
});
