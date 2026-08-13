// Vult .env voor je in door de server te vragen hoe hij in elkaar zit.
//
//   node setup.js user@jouw-server.nl
//
// Zoekt zelf het WordPress-pad, de actieve plugins en mogelijke
// purge-commando's op, en schrijft .env weg. Verandert niets op de server.
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const target = process.argv[2] || process.env.SSH_TARGET;

if (!target) {
  console.error(`Geef je SSH-doel mee:

  node setup.js user@jouw-server.nl

Dat vind je in het controlepaneel van je hosting, onder SSH of SFTP. Je hebt
een gebruikersnaam en een hostnaam nodig; die plak je aan elkaar met een @.

Werkt de verbinding nog niet, dan moet je publieke sleutel eerst op de server
staan. Dit is de jouwe:

  type $env:USERPROFILE\\.ssh\\id_ed25519.pub

Plak de inhoud daarvan in het veld voor SSH-sleutels van je hosting.`);
  process.exit(1);
}

async function ssh(command, { timeout = 60000 } = {}) {
  const { stdout } = await execFileAsync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      // Alleen hier, niet in ab-test.js: bij de allereerste verbinding staat
      // de server nog niet in known_hosts, en BatchMode blokkeert de vraag of
      // je hem vertrouwt. accept-new legt de sleutel bij eerste contact vast;
      // wijzigt hij later, dan slaat ssh alsnog alarm. Zodra setup.js een keer
      // gedraaid heeft, werkt ab-test.js met de strengere standaardinstelling.
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      target,
      command,
    ],
    { timeout, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

async function trySsh(command, options) {
  try {
    return { ok: true, out: await ssh(command, options) };
  } catch (err) {
    return { ok: false, out: err.stderr || err.message };
  }
}

console.log(`Verbinden met ${target}...\n`);

const hello = await trySsh("echo verbonden");
if (!hello.ok) {
  console.error(`Verbinding mislukt:\n${hello.out.trim()}\n`);
  console.error(
    "Meest voorkomende oorzaken:\n" +
      "  - je publieke sleutel staat nog niet op de server\n" +
      "  - de gebruikersnaam of hostnaam klopt niet\n" +
      "  - je host gebruikt een andere poort (dan: user@host -p 2222 werkt niet,\n" +
      "    maak in dat geval een ~/.ssh/config aan)",
  );
  process.exit(1);
}
console.log("1. Verbinding werkt.");

// ---------------------------------------------------------------------------

const wpCli = await trySsh("command -v wp || echo GEEN");
if (!wpCli.ok || wpCli.out.includes("GEEN")) {
  console.error("\n2. WP-CLI (`wp`) niet gevonden op de server. Zonder dat werkt dit script niet.");
  process.exit(1);
}
console.log(`2. WP-CLI gevonden: ${wpCli.out.trim()}`);

// ---------------------------------------------------------------------------

const found = await trySsh(
  "find ~ -maxdepth 4 -name wp-config.php 2>/dev/null; find /var/www -maxdepth 4 -name wp-config.php 2>/dev/null",
  { timeout: 120000 },
);
const paths = [
  ...new Set(
    found.out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((file) => file.replace(/\/wp-config\.php$/, "")),
  ),
];

if (paths.length === 0) {
  console.error("\n3. Geen wp-config.php gevonden. Vul WP_PATH handmatig in .env in.");
  process.exit(1);
}

// Welke site achter elk pad zit, niet alleen welk pad bestaat. Staging en
// productie staan vaak naast elkaar onder hetzelfde SSH-account, en dit script
// zet straks plugins aan en uit - dan wil je niet op het verkeerde pad zitten.
console.log("3. WordPress gevonden op:\n");
const sites = [];
for (const path of paths) {
  const home = await trySsh(`wp --path='${path}' option get home 2>/dev/null`, {
    timeout: 60000,
  });
  const url = home.ok ? home.out.trim() : "(onbekend)";
  sites.push({ path, url });
  console.log(`     ${url}`);
  console.log(`       ${path}\n`);
}

const wpPath = sites[0].path;
if (sites.length > 1) {
  console.log(
    `   Ik gebruik de eerste. Meet je een andere site, zet dan het\n` +
      `   bijbehorende pad in WP_PATH. ab-test.js controleert dit sowieso\n` +
      `   nog een keer tegen de URL's die je meet en weigert bij een mismatch.\n`,
  );
}

// ---------------------------------------------------------------------------

const wp = (args) => trySsh(`wp --path='${wpPath}' ${args}`, { timeout: 120000 });

const version = await wp("core version");
console.log(`4. WordPress ${version.ok ? version.out.trim() : "(versie onbekend)"}`);

const plugins = await wp("plugin list --format=csv --fields=name,status,title");
console.log("\n5. Plugins op deze site:\n");
console.log(
  plugins.out
    .split("\n")
    .filter(Boolean)
    .map((line) => `     ${line}`)
    .join("\n"),
);

const pluginNames = plugins.out
  .split("\n")
  .slice(1)
  .map((line) => line.split(",")[0])
  .filter(Boolean);
const flyingPress =
  pluginNames.find((n) => n.includes("flying")) || "flying-press";

// ---------------------------------------------------------------------------

// Top-level commando's uit `wp help`. De interessante zijn die zonder
// beschrijving of met cache in de naam: die komen niet van WP-CLI zelf maar
// zijn door een host-plugin geregistreerd.
const help = await wp("help 2>&1 | cat");
const topLevel = help.out
  .split("\n")
  // Het einde-van-regel-alternatief is essentieel: commando's die door een
  // plugin zijn geregistreerd hebben vaak geen beschrijving achter zich, en
  // dat zijn nu juist de commando's waar we naar op zoek zijn.
  .map((line) => line.match(/^\s{2}([a-z][a-z0-9-]*)(?:\s|$)/i))
  .filter(Boolean)
  .map((match) => match[1]);

const interesting = topLevel.filter((name) => /cdn|cache|rocket|edge|purge/i.test(name));

console.log("\n6. Commando's die de edge-cache zouden kunnen legen:\n");
let purgeCommand = "";
for (const name of interesting) {
  const sub = await wp(`help ${name} 2>&1 | cat`);
  const hasPurge = /^\s+purge\s/m.test(sub.out);
  console.log(`     wp ${name}${hasPurge ? "  -> heeft een 'purge' subcommando" : ""}`);
  // Object-cache is niet de edge-cache: `wp cache flush` leegt alleen de
  // cache binnen WordPress zelf en raakt Cloudflare niet aan.
  if (hasPurge && !purgeCommand && name !== "cache") {
    purgeCommand = `${name} purge`;
  }
}
if (interesting.length === 0) {
  console.log("     (geen gevonden - vul PURGE_WP_COMMAND handmatig in)");
}

// ---------------------------------------------------------------------------

const envPath = "./.env";
if (fs.existsSync(envPath)) {
  const backup = `.env.backup-${Date.now()}`;
  fs.copyFileSync(envPath, backup);
  console.log(`\nBestaande .env bewaard als ${backup}`);
}

fs.writeFileSync(
  envPath,
  `SSH_TARGET=${target}
WP_PATH=${wpPath}
PLUGIN_SLUG=${flyingPress}

# Commando dat de edge-cache leegt, zonder "wp" ervoor.
PURGE_WP_COMMAND=${purgeCommand}

PURGE_SETTLE_MS=8000
`,
);

console.log(`
.env aangemaakt met:
  SSH_TARGET=${target}
  WP_PATH=${wpPath}
  PLUGIN_SLUG=${flyingPress}
  PURGE_WP_COMMAND=${purgeCommand || "(niet gevonden - vul zelf in)"}
`);

console.log(
  purgeCommand
    ? "Klaar. Draai nu `npm run noise` om je ruisvloer te bepalen."
    : "Vul PURGE_WP_COMMAND nog in, draai daarna `npm run noise`.",
);
