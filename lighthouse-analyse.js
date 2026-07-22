import fs from "fs";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { computeMedianRun } from "lighthouse/core/lib/median-run.js";
import baseConfig from "./custom-config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Voeg hier alle URL's toe die je wilt testen
const urls = [
  "https://wiersmaweb.nl/",
  "https://wiersmaweb.nl/check/",
  "https://wiersmaweb.nl/websitesnelheid-getest-met-pagespeed-insights/",
];

// Aantal Lighthouse runs per URL/device-combinatie (mediaan wordt hiervan berekend)
const RUNS_PER_TEST = 5;

// Aantal Chrome-instanties dat gelijktijdig draait. Hoger = sneller, maar
// zwaarder voor je machine. 3-4 is meestal een goede balans.
const CONCURRENCY = 3;

// Standaard device-instellingen (mobile = Lighthouse default throttling/emulatie,
// desktop = geen mobile-emulatie en snellere throttling)
const deviceConfigs = {
  mobile: {
    ...baseConfig,
    settings: {
      ...baseConfig.settings,
      formFactor: "mobile",
      screenEmulation: {
        mobile: true,
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        disabled: false,
      },
      throttling: {
        rttMs: 150,
        throughputKbps: 1638.4,
        cpuSlowdownMultiplier: 4,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0,
      },
    },
  },
  desktop: {
    ...baseConfig,
    settings: {
      ...baseConfig.settings,
      formFactor: "desktop",
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false,
      },
      throttling: {
        rttMs: 40,
        throughputKbps: 10240,
        cpuSlowdownMultiplier: 1,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTasks() {
  const tasks = [];
  for (const url of urls) {
    for (const device of ["desktop", "mobile"]) {
      tasks.push({ url, device });
    }
  }
  return tasks;
}

// Windows gooit soms EPERM omdat het tijdelijke Chrome-profiel nog heel even
// "vastzit" vlak na het afsluiten van het proces. We proberen het daarom een
// paar keer met een oplopende vertraging voordat we het negeren.
async function safeKill(chrome, workerId) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await chrome.kill();
      return;
    } catch (err) {
      if (attempt === 5) {
        console.warn(
          `[Worker ${workerId}] Kon tijdelijke Chrome-map niet opruimen (genegeerd): ${err.message}`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

async function runLighthouseForUrlAndDevice(url, device, port) {
  const results = [];
  for (let i = 0; i < RUNS_PER_TEST; i++) {
    const runnerResult = await lighthouse(
      url,
      { port, logLevel: "error" },
      deviceConfigs[device],
    );
    results.push(runnerResult.lhr);
  }
  return computeMedianRun(results);
}

function extractMetrics(lhr) {
  return {
    performanceScore: Math.round(lhr.categories.performance.score * 100),
    fcp: lhr.audits["first-contentful-paint"].displayValue,
    lcp: lhr.audits["largest-contentful-paint"].displayValue,
    speedIndex: lhr.audits["speed-index"].displayValue,
    tbt: lhr.audits["total-blocking-time"].displayValue,
    cls: lhr.audits["cumulative-layout-shift"].displayValue,
  };
}

// ---------------------------------------------------------------------------
// Worker: elke worker heeft zijn eigen Chrome-instantie en trekt taken van
// de gedeelde wachtrij totdat die leeg is.
// ---------------------------------------------------------------------------

async function worker(workerId, taskQueue, allResults) {
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless"] });
  console.log(`Worker ${workerId} gestart (poort ${chrome.port})`);

  try {
    while (taskQueue.length > 0) {
      const task = taskQueue.shift();
      if (!task) break;

      console.log(`[Worker ${workerId}] start ${task.device} - ${task.url}`);
      const median = await runLighthouseForUrlAndDevice(
        task.url,
        task.device,
        chrome.port,
      );
      const metrics = extractMetrics(median);
      allResults.push({ url: task.url, device: task.device, ...metrics });
      console.log(
        `[Worker ${workerId}] klaar: ${task.device} score ${metrics.performanceScore} (${task.url})`,
      );
    }
  } finally {
    await safeKill(chrome, workerId);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const taskQueue = buildTasks();
  const allResults = [];

  const workerCount = Math.min(CONCURRENCY, taskQueue.length);
  const workers = [];
  for (let i = 1; i <= workerCount; i++) {
    workers.push(worker(i, taskQueue, allResults));
  }
  await Promise.all(workers);

  console.log("\n\n===== SAMENVATTING =====");
  console.table(allResults);

  const outputPath = "./lighthouse-results.json";
  fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResultaten opgeslagen in ${outputPath}`);
}

main().catch((err) => {
  console.error("Er ging iets mis:", err);
  process.exit(1);
});
