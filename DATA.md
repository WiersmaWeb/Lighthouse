# Meetgegevens

De ruwe data achter het onderzoek naar FlyingPress. Alles is gemeten op een
staging-omgeving bij Rocket.net (Frankfurt), mobiel, met de standaardsimulatie
van Lighthouse: trage 4G en een langzame telefoon.

## De bestanden

**`ab-results-aa.json`** — de nulmeting. Twaalf blokken waarin niets veranderde,
maar wel als twee groepen gelabeld. Alles wat hier als verschil uitkomt is
meetfout. Dit is de ondergrens waaronder je niets mag geloven.

**`ab-results-standaard.json`** — FlyingPress aan tegen uit, met alle
instellingen op standaard.

**`ab-results.json`** — hetzelfde, maar met vier extra instellingen aan:
scripts van derden bij interactie, emoji-scripts uit, block-editor CSS uit en
RSS-feed uit.

**`feature-results.json`** — 23 losse instellingen, elk apart omgezet en
gemeten op bestandsgroottes en aantallen in plaats van op tijd. Elke meting
heeft zijn eigen basislijn.

## Hoe je het leest

Elke regel in de A/B-bestanden is één Lighthouse-run:

```json
{
  "block": 0,           // welk blok in de ABBA-volgorde
  "variant": "on",      // plugin aan of uit
  "url": "...",         // welke pagina
  "run": 0,             // hoeveelste meting binnen dit blok
  "cfCacheStatus": "MISS",
  "fcp": 955.6,         // milliseconden, onafgerond
  "lcp": 2433.4,
  "bytes": 348284
}
```

Alle tijden staan in milliseconden en zijn niet afgerond. Dat is met opzet:
"2,7 s" is niet meer terug te rekenen naar iets waar je statistiek op kunt
doen.

Opwarmrondes zitten er niet in — die worden tijdens het meten weggegooid.

## Zelf narekenen

```bash
npm run report                          # de effectmeting
npm run report:noise                    # de nulmeting
node vergelijk-metingen.js standaard=ab-results-standaard.json optimaal=ab-results.json
```

## Wat er niet in zit

Metingen van vóór 19 augustus 2026. Tot dat moment wachtte het script acht
seconden na het legen van de cache, en dat bleek te kort: de eerste metingen in
een blok kregen nog bestanden uit de oude cache en de latere de verse, waardoor
dezelfde situatie 1679 of 2734 milliseconde kon opleveren. Die data is
weggegooid, inclusief de conclusies die eruit volgden.

De wachttijd staat nu op zestig seconden. Alles in deze map is daarna gemeten.
