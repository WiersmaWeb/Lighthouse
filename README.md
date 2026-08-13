# Lighthouse CI

Twee tools met verschillende doelen.

| Tool | Waarvoor |
| --- | --- |
| `lighthouse-analyse.js` | Snelle snapshot: hoe staat de site er nu voor? |
| `ab-test.js` | Betrouwbaar meten of een wijziging (FlyingPress aan/uit) echt effect heeft. |

## Snapshot

```bash
npm run snapshot
```

Draait alle URL's uit de lijst bovenin het bestand, op mobile en desktop, met
3 parallelle workers. Schrijft `lighthouse-results.json`.

Let op: dit is een indicatie, geen meting. De mediaan-run wordt gekozen met
Lighthouse's `computeMedianRun`, die niet per metric een mediaan berekent maar
één representatieve run uitkiest en de rest weggooit. Prima om te zien of er
iets grondig mis is; niet geschikt om twee situaties te vergelijken.

## A/B-meting

### Eenmalig instellen

Laat `setup.js` het werk doen. Die logt in op de server, zoekt zelf het
WordPress-pad, de plugin-slug en mogelijke purge-commando's op, en schrijft
`.env` weg. Hij verandert niets op de server.

```bash
npm run setup -- user@jouw-server.nl
```

Je SSH-gegevens staan in het controlepaneel van je hosting, onder SSH of SFTP.
`.env` staat in `.gitignore` en hoort daar te blijven.

**SSH vereist key-based auth.** De scripts draaien `ssh` met `BatchMode=yes` en
falen bewust meteen, in plaats van om een wachtwoord te vragen en dan een uur
lang te blijven hangen op een prompt die niemand ziet. Staat je publieke
sleutel nog niet op de server, plak hem dan eerst in het SSH-sleutelveld van je
hosting:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub
```

Liever met de hand? Kopieer dan `.env.example` naar `.env` en vul het zelf in.

### Edge-cache

Staat er edge-caching (Cloudflare) voor je site, dan is purgen na elke toggle
niet optioneel. Zonder purge blijft de edge de HTML van de vórige variant
serveren en meet je een blok lang de verkeerde configuratie — met cijfers die
er volstrekt normaal uitzien.

Het purgen loopt via WP-CLI, niet via de Cloudflare-API: bij veel managed hosts
heb je geen dashboardtoegang maar wel een verplichte host-plugin die het
regelt. Zet het commando in `PURGE_WP_COMMAND`.

#### Het purge-commando vinden

`npm run setup` print de cache-gerelateerde WP-CLI-commando's die op jouw
server bestaan. Staat het purge-commando ertussen, vul dan die naam in zonder
`wp` ervoor.

Zo niet, dan kun je meestal de hook of functie van de host-plugin aanroepen via
`wp eval`:

```
PURGE_WP_COMMAND=eval 'do_action("naam_van_de_hook");'
```

Werkt het? Dat hoef je niet te gokken: de preflight controleert het (zie
hieronder).

#### Wat het script doet

1. Purget ná de WP-CLI-toggle — andersom trekt de edge de oude variant meteen weer binnen.
2. Wacht `PURGE_SETTLE_MS`, want de purge loopt asynchroon over de edge-nodes.
3. Draait pas daarna warm.
4. Legt per blok de `cf-cache-status` vast. Wisselt die tussen blokken, dan zegt het rapport dat expliciet: je meet dan HIT tegen MISS in plaats van de plugin.

#### De preflight bewijst dat je purge werkt

Vóór de meting haalt het script `URLS[0]` op tot de edge `HIT` geeft, purget,
wacht, en kijkt of de status omslaat. Blijft het `HIT`, dan stopt het met een
foutmelding in plaats van een uur lang twee keer dezelfde gecachete pagina te
meten — wat een keurig ogende uitkomst van "geen verschil" oplevert.

Dit werkt zonder enige Cloudflare-toegang: `cf-cache-status` is gewoon een
response-header op je eigen site.

**Belangrijk om te beseffen:** als de edge je HTML cachet, serveert hij na de
warm-up beide varianten even snel, en is het TTFB-verschil dat FlyingPress aan
de origin maakt grotendeels onzichtbaar. Wat je dan meet is de
asset-optimalisatie, niet de page cache. Dat is een prima meting — het is wat
je bezoekers ervaren — maar het is een andere vraag dan "wat doet FlyingPress
aan mijn origin".

### Stap 0: controleer de opzet

```bash
node ab-test.js --check
```

Doorloopt de hele preflight — SSH, WP-CLI, of `WP_PATH` echt de site is die je
meet, en of je purge daadwerkelijk werkt — en stopt dan. Kost seconden in
plaats van een uur.

Die site-controle is er niet voor niets: staging en productie staan vaak onder
hetzelfde SSH-account, en dit script deactiveert plugins. Wijst `WP_PATH` naar
een andere site dan de URL's die je meet, dan weigert het script te starten.

### Stap 1: bepaal je ruisvloer

```bash
npm run noise
```

Meet twee keer dezelfde configuratie alsof het A en B is. De plugin wordt niet
aangeraakt. Alles wat hier als verschil uitkomt is per definitie ruis. Noteer
die getallen: kleinere effecten dan dit kun je in een echte meting niet
geloven, hoeveel runs je er ook tegenaan gooit.

### Stap 2: de echte meting

```bash
npm run measure
```

Het script:

1. controleert de SSH-verbinding en WP-CLI vóór het aan een sessie van een uur begint;
2. draait ABBA-blokken (`CYCLES` keer), zodat drift in de tijd beide varianten gelijk treft;
3. zet FlyingPress per blok aan of uit via WP-CLI en **verifieert** de nieuwe status;
4. gooit na elke toggle `WARMUP_RUNS` runs weg — de eerste hit na (de)activeren is een cache-miss;
5. bewaart iedere run afzonderlijk met `numericValue` in `ab-results.json`;
6. zet de plugin aan het eind terug zoals hij hem aantrof, ook als er iets misgaat.

### Stap 3: analyse

De analyse draait automatisch na een meting, maar kan los op een bestaande
dataset:

```bash
npm run report
```

Per URL/device krijg je per metric de mediaan van beide varianten, de
spreiding (MAD), het verschil en een 95%-betrouwbaarheidsinterval op dat
verschil. Sluit het interval nul uit, dan heet het verschil `aantoonbaar`;
anders `ruis`.

Het interval komt uit een **block bootstrap**: er worden hele blokken met
teruglegging getrokken, geen losse runs. Runs binnen één blok delen dezelfde
server- en cachetoestand en zijn dus gecorreleerd; wie losse runs trekt doet
alsof hij veel meer onafhankelijke metingen heeft dan waar, en krijgt een veel
te smal interval.

### Knoppen

| Variabele | Default | Betekenis |
| --- | --- | --- |
| `CYCLES` | 3 | Aantal ABBA-cycli (dus 4× dit aantal blokken) |
| `RUNS_PER_BLOCK` | 4 | Metingen per blok, ná de warm-up |
| `WARMUP_RUNS` | 1 | Weggegooide runs direct na een toggle |
| `MODE` | `ab` | `aa` = ruisvloer bepalen zonder te togglen |
| `PURGE_WP_COMMAND` | — | WP-CLI-commando dat de edge-cache leegt |
| `PURGE_SETTLE_MS` | 8000 | Wachttijd na een purge |

Te weinig runs is de meest voorkomende reden dat een echt effect als `ruis`
uit de bus komt. Het interval vernauwt ruwweg met √n; verhoog `CYCLES` voordat
je `RUNS_PER_BLOCK` verhoogt, want meer blokken helpt tegen blokeffecten en
meer runs binnen een blok niet.

## Waarom serieel

`ab-test.js` draait bewust één Chrome tegelijk. Parallelle instanties vechten
om CPU en dat lekt door in de trace. `lighthouse-analyse.js` draait er wel drie
naast elkaar, omdat doorlooptijd daar belangrijker is dan precisie.

Draai je metingen bij voorkeur op een machine die verder niets doet, en
vergelijk nooit een dataset van een drukke werkdag met een van 's nachts.

## Lab versus veld

Deze tools meten **lab-data**: één browser, gesimuleerde throttling. Dat is het
bovenste blok van PageSpeed Insights. De Core Web Vitals waar Google op
beoordeelt zijn **veld-data** uit CrUX, verzameld bij echte bezoekers over 28
dagen. Winst die je hier meet is een goede voorspeller, maar je ziet hem pas
weken later terug in PSI.
