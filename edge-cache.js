// Edge-cache (Cloudflare) zonder API-toegang. De cf-cache-status-header staat
// gewoon op elk antwoord van je eigen site, dus we kunnen de cachestand lezen
// en zelfs controleren of een purge echt werkt - zonder dashboard of token.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cacheStatus(url) {
  try {
    const res = await fetch(url, { redirect: "follow", cache: "no-store" });
    await res.arrayBuffer();
    return res.headers.get("cf-cache-status") ?? "geen header";
  } catch (err) {
    return `onbekend (${err.message})`;
  }
}

/**
 * Bewijst dat het purge-mechanisme daadwerkelijk de edge leegt, door te kijken
 * of cf-cache-status van HIT naar iets anders springt. Zonder deze controle
 * ontdek je een niet-werkende purge pas nadat je een uur lang twee keer
 * dezelfde gecachete pagina hebt gemeten - met een keurig ogende uitkomst van
 * "geen verschil".
 */
export async function verifyPurgeWorks({ url, purge, settleMs, log = console.log }) {
  log("Purge-mechanisme controleren...");

  let status = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    status = await cacheStatus(url);
    if (status === "HIT") break;
  }

  if (status !== "HIT") {
    log(
      `  cf-cache-status blijft '${status}': deze URL wordt niet aan de edge\n` +
        `  gecachet. Dan valt er ook niets te purgen en meet je de origin direct.`,
    );
    return { edgeCached: false, purgeWorks: null };
  }

  log("  edge geeft HIT, nu purgen...");
  await purge();
  await sleep(settleMs);
  const after = await cacheStatus(url);

  if (after === "HIT") {
    throw new Error(
      "Purge lijkt niets te doen: cf-cache-status is na de purge nog steeds HIT.\n" +
        "Controleer PURGE_WP_COMMAND, of verhoog PURGE_SETTLE_MS als je host er\n" +
        "langer over doet. Doormeten heeft nu geen zin: je zou beide varianten\n" +
        "vanuit dezelfde edge-cache meten.",
    );
  }

  log(`  na purge: ${after} - purge werkt.`);
  return { edgeCached: true, purgeWorks: true };
}
