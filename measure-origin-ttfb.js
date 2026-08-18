// Meet de servertijd aan de origin, langs Cloudflare heen.
//
//   node measure-origin-ttfb.js object_cache
//   node measure-origin-ttfb.js --plugin        (hele plugin aan/uit)
//
// Waarom niet gewoon de publieke URL opvragen: dan meet je Cloudflare. Een
// paginacache aan de origin kan 222 ms schelen zonder dat je bezoeker er iets
// van merkt, omdat de CDN dat verschil al opvangt. Om de cache zelf te meten
// moet je alles wat ervoor staat uitschakelen - vandaar dat we vanaf de server
// zelf naar 127.0.0.1 vragen, met de juiste hostnaam erbij.
import { execFile } from "child_process";
import { promisify } from "util";

try {
  process.loadEnvFile();
} catch {
  /* geen .env */
}

const execFileAsync = promisify(execFile);

const SSH_TARGET = process.env.SSH_TARGET;
const WP_PATH = process.env.WP_PATH;
const PLUGIN_SLUG = process.env.PLUGIN_SLUG || "flying-press";
const SAMPLES = Number(process.env.TTFB_SAMPLES || 20);
const WARMUP = Number(process.env.TTFB_WARMUP || 3);

const target = process.argv[2];
if (!target) {
  console.error(
    "Geef een instelling mee, of --plugin voor de hele plugin.\n" +
      "  node measure-origin-ttfb.js object_cache\n" +
      "  node measure-origin-ttfb.js --plugin",
  );
  process.exit(1);
}

async function ssh(command, { timeout = 300000 } = {}) {
  const { stdout } = await execFileAsync("ssh", ["-o", "BatchMode=yes", SSH_TARGET, command], {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

const wp = (args) => ssh(`wp --path='${WP_PATH}' ${args}`);

async function siteHost() {
  return new URL(await wp("option get home")).host;
}

// Vanaf de server naar zichzelf, met --resolve zodat de hostnaam klopt voor
// zowel het certificaat als de virtual host.
async function sampleTtfb(host) {
  const curl =
    `curl -sk -o /dev/null -w '%{time_starttransfer}\\n' ` +
    `--resolve ${host}:443:127.0.0.1 https://${host}/`;
  const out = await ssh(`for i in $(seq 1 ${WARMUP + SAMPLES}); do ${curl}; done`);
  const all = out
    .split("\n")
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  return { koud: all.slice(0, WARMUP), warm: all.slice(WARMUP) };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const ms = (s) => `${(s * 1000).toFixed(0)} ms`;

async function meet(label, host) {
  await wp(`${PLUGIN_SLUG === "flying-press" ? "flying-press purge-everything" : "cache flush"}`)
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  const { koud, warm } = await sampleTtfb(host);
  console.log(
    `  ${label.padEnd(12)} eerste ${WARMUP}: ${koud.map(ms).join(", ")}` +
      `  |  daarna (n=${warm.length}): mediaan ${ms(median(warm))}, ` +
      `${ms(Math.min(...warm))}-${ms(Math.max(...warm))}`,
  );
  return { koud, warm, mediaan: median(warm) };
}

async function main() {
  if (!SSH_TARGET || !WP_PATH) throw new Error("SSH_TARGET en WP_PATH moeten gezet zijn.");
  const host = await siteHost();
  console.log(`Origin-TTFB op ${host}, langs Cloudflare heen.\n`);

  const isPlugin = target === "--plugin";
  const oorspronkelijk = isPlugin
    ? await wp(`plugin get ${PLUGIN_SLUG} --field=status`)
    : JSON.parse(await wp("option get FLYING_PRESS_CONFIG --format=json"))[target];

  if (!isPlugin && oorspronkelijk === undefined) {
    throw new Error(`Instelling '${target}' bestaat niet in FLYING_PRESS_CONFIG.`);
  }

  const zet = async (waarde) => {
    if (isPlugin) {
      await wp(`plugin ${waarde ? "activate" : "deactivate"} ${PLUGIN_SLUG}`);
    } else {
      await wp(`option patch update FLYING_PRESS_CONFIG ${target} ${waarde} --format=json`);
    }
  };

  try {
    await zet(true);
    const aan = await meet("aan", host);
    await zet(false);
    const uit = await meet("uit", host);

    const verschil = (uit.mediaan - aan.mediaan) * 1000;
    console.log(
      `\n  ${target}: ${verschil > 0 ? "+" : ""}${verschil.toFixed(0)} ms sneller met de instelling aan`,
    );
    // Overlappen de bereiken niet, dan is het verschil niet met toeval te
    // verklaren en heb je geen statistiek nodig om dat te zien.
    const gescheiden = Math.max(...aan.warm) < Math.min(...uit.warm);
    console.log(
      gescheiden
        ? "  Bereiken overlappen niet: het verschil is onmiskenbaar."
        : "  Bereiken overlappen: dit verschil kan toeval zijn.",
    );
  } finally {
    await zet(isPlugin ? oorspronkelijk === "active" : oorspronkelijk);
    console.log(`\n  Teruggezet op: ${oorspronkelijk}`);
  }
}

main().catch((err) => {
  console.error("Er ging iets mis:", err.message);
  process.exit(1);
});
