// Deterministische signalen van een pagina: bestandsgroottes, aantallen,
// aanwezigheid. Geen statistiek nodig - een bestand van 42 kB is 42 kB, hoe
// vaak je ook kijkt. Daarmee kun je per plugin-instelling vaststellen wat hij
// doet, zonder er een uur Lighthouse tegenaan te gooien.
import https from "https";
import zlib from "zlib";

const UA =
  "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// Zowel de bytes over de lijn als uitgepakt. Dat verschil is groot en het
// bepaalt welke conclusie je trekt: over de lijn = wachttijd voor je bezoeker,
// uitgepakt = werk voor zijn telefoon.
export function fetchResource(url, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": UA,
          "Accept-Encoding": "br, gzip",
          Accept: "text/html,image/avif,image/webp,*/*",
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const wire = Buffer.concat(chunks);
          let raw = wire;
          try {
            const enc = (res.headers["content-encoding"] || "").toLowerCase();
            if (enc === "br") raw = zlib.brotliDecompressSync(wire);
            else if (enc === "gzip") raw = zlib.gunzipSync(wire);
            else if (enc === "deflate") raw = zlib.inflateSync(wire);
          } catch {
            // Niet te decomprimeren: dan is uitgepakt gelijk aan over de lijn.
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            wireBytes: wire.length,
            rawBytes: raw.length,
            body: raw.toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const absolute = (href, base) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Uit de HTML te halen zonder browser
// ---------------------------------------------------------------------------

export function parseHtml(html, pageUrl) {
  const stylesheets = [];
  for (const tag of html.match(/<link[^>]*>/gi) || []) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    const url = href && absolute(href, pageUrl);
    if (url) stylesheets.push(url);
  }

  // De spatie voor `src` is essentieel. Zonder die eis matcht dit patroon ook
  // binnenin `data-src=`, en juist dat attribuut gebruikt FlyingPress om een
  // script pas bij interactie te laden. Dan tel je een bestand mee dat de
  // browser nooit ophaalt - bij Google Tag Manager schoot dat 169 kB mis.
  const scripts = [];
  const interactionScripts = [];
  for (const tag of html.match(/<script[^>]*>/gi) || []) {
    const dataSrc = tag.match(/\sdata-src\s*=\s*["']([^"']+)["']/i)?.[1];
    if (dataSrc) {
      interactionScripts.push(dataSrc);
      continue;
    }
    const src = tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!src) continue;
    scripts.push({
      src,
      url: src.startsWith("data:") ? null : absolute(src, pageUrl),
      isData: src.startsWith("data:"),
      deferred: /\s(defer|async)[\s>=]/i.test(tag) || /type\s*=\s*["']module/i.test(tag),
    });
  }

  const images = [];
  for (const match of html.matchAll(/<img[^>]*>/gi)) {
    const src = match[0].match(/\ssrc\s*=\s*["']([^"']+)["']/i)?.[1];
    const url = src && !src.startsWith("data:") && absolute(src, pageUrl);
    if (url) images.push(url);
  }

  const count = (re) => (html.match(re) || []).length;
  const hosts = new Set();
  for (const url of [...stylesheets, ...scripts.map((s) => s.url), ...images]) {
    if (!url) continue;
    try {
      const host = new URL(url).host;
      if (host !== new URL(pageUrl).host) hosts.add(host);
    } catch {
      /* ongeldige URL overslaan */
    }
  }

  return {
    stylesheets: [...new Set(stylesheets)],
    scripts,
    interactionScripts,
    images: [...new Set(images)],
    externalHosts: [...hosts],
    inlineStyleBlocks: count(/<style[\s>]/gi),
    lazyImages: count(/loading\s*=\s*["']lazy["']/gi),
    srcsetAttrs: count(/\ssrcset\s*=/gi),
    fontPreloads: (html.match(/<link[^>]*rel\s*=\s*["']?preload[^>]*>/gi) || []).filter((t) =>
      /as\s*=\s*["']?font/i.test(t),
    ).length,
    youtubeRefs: count(/youtube(?:-nocookie)?\.com|youtu\.be/gi),
    gravatarRefs: count(/gravatar\.com/gi),
    emojiRefs: count(/wp-emoji|\/emoji\//gi),
    dashiconsRefs: count(/dashicons/gi),
    contentVisibility: /content-visibility/i.test(html),
    jqueryMigrate: /jquery-migrate/i.test(html),
  };
}

// ---------------------------------------------------------------------------
// Volledige meting: HTML plus alle stylesheets, scripts en afbeeldingen
// ---------------------------------------------------------------------------

async function sumResources(urls) {
  let wire = 0;
  let raw = 0;
  let ok = 0;
  for (const url of urls) {
    try {
      const res = await fetchResource(url);
      if (res.status >= 200 && res.status < 300) {
        wire += res.wireBytes;
        raw += res.rawBytes;
        ok++;
      }
    } catch {
      // Onbereikbaar bestand telt niet mee; het aantal verschilt dan van de
      // lijst, wat zichtbaar blijft in het aantal.
    }
  }
  return { count: ok, wire, raw };
}

export async function collectSignals(pageUrl, { warmup = true } = {}) {
  const page = await fetchResource(pageUrl);
  const dom = parseHtml(page.body, pageUrl);

  // Opwarmen voordat we tellen. Cloudflare Polish comprimeert afbeeldingen als
  // achtergrondtaak na het eerste verzoek: op een cache-miss krijg je de
  // originele PNG, daarna pas de WebP. Meet je koud, dan meet je een bestand
  // dat je bezoekers nooit zo binnenkrijgen - bij ons scheelde dat een factor
  // twintig op het totaal.
  if (warmup) {
    const all = [
      ...dom.stylesheets,
      ...dom.scripts.filter((s) => s.url).map((s) => s.url),
      ...dom.images,
    ];
    for (const url of all) {
      try {
        await fetchResource(url);
      } catch {
        /* onbereikbaar bestand valt straks vanzelf op in het aantal */
      }
    }
  }

  const [css, js, img] = await Promise.all([
    sumResources(dom.stylesheets),
    sumResources(dom.scripts.filter((s) => s.url).map((s) => s.url)),
    sumResources(dom.images),
  ]);

  // Als font-display niet in de CSS staat, wachten bezoekers op je lettertype
  // voordat ze tekst zien. Dat staat in de stylesheets, niet in de HTML.
  let fontDisplaySwap = false;
  for (const url of dom.stylesheets) {
    try {
      const res = await fetchResource(url);
      if (/font-display\s*:\s*swap/i.test(res.body)) {
        fontDisplaySwap = true;
        break;
      }
    } catch {
      /* overslaan */
    }
  }

  return {
    htmlWire: page.wireBytes,
    htmlRaw: page.rawBytes,
    cfCacheStatus: page.headers["cf-cache-status"] ?? null,

    cssCount: css.count,
    cssWire: css.wire,
    cssRaw: css.raw,

    jsCount: js.count,
    jsWire: js.wire,
    jsRaw: js.raw,
    jsBlocking: dom.scripts.filter((s) => !s.deferred && !s.isData).length,
    jsDataUris: dom.scripts.filter((s) => s.isData).length,
    // Scripts die pas bij klikken of scrollen worden opgehaald. Die tellen
    // niet mee in jsWire, want bij het laden komen ze niet binnen.
    jsUntilInteraction: dom.interactionScripts.length,

    imgCount: img.count,
    imgWire: img.wire,

    externalHosts: dom.externalHosts.length,
    externalHostList: dom.externalHosts,

    inlineStyleBlocks: dom.inlineStyleBlocks,
    lazyImages: dom.lazyImages,
    srcsetAttrs: dom.srcsetAttrs,
    fontPreloads: dom.fontPreloads,
    fontDisplaySwap,
    youtubeRefs: dom.youtubeRefs,
    gravatarRefs: dom.gravatarRefs,
    emojiRefs: dom.emojiRefs,
    dashiconsRefs: dom.dashiconsRefs,
    contentVisibility: dom.contentVisibility,
    jqueryMigrate: dom.jqueryMigrate,
  };
}

// Kenmerk dat FlyingPress zijn werk gedaan heeft: hij serveert zijn bewerkte
// stylesheets vanuit een eigen cachemap.
export const OPTIMIZED_MARKER = "/cache/flying-press/";

/**
 * Wacht tot de pagina klaar is om gemeten te worden.
 *
 * Twee voorwaarden, en de tweede is er na schade en schande bij gekomen.
 * Stabiliteit alleen volstaat niet: direct na een purge serveert de site een
 * onbewerkte pagina, en die is óók twee ophaalacties lang identiek. Vier van
 * mijn metingen kwamen daardoor als "geslaagd" binnen terwijl ze de pagina
 * zonder enige optimalisatie hadden geteld. Daarom eist dit nu ook een
 * positief kenmerk dat de bewerking daadwerkelijk is toegepast.
 */
export async function waitUntilStable(
  pageUrl,
  { attempts = 20, delayMs = 3000, requireMarker = true, marker = OPTIMIZED_MARKER } = {},
) {
  let previous = null;
  for (let i = 0; i < attempts; i++) {
    let html;
    try {
      html = (await fetchResource(pageUrl)).body;
    } catch {
      html = null;
    }
    const optimized = !requireMarker || (html ? html.includes(marker) : false);
    if (html && previous && html === previous && optimized) {
      return { stable: true, optimized: true, attempts: i + 1 };
    }
    previous = html;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return {
    stable: false,
    optimized: previous ? previous.includes(marker) : false,
    attempts,
  };
}
