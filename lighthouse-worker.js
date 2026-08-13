import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { computeMedianRun } from "lighthouse/core/lib/median-run.js";
import { deviceConfigs } from "./device-configs.js";

const RUNS_PER_TEST = Number(process.env.RUNS_PER_TEST || 3);

// Bewust displayValue: dit is de snapshot-tool, bedoeld om even naar te
// kijken. Voor iets waar je conclusies aan wilt verbinden is ab-test.js het
// juiste gereedschap - die slaat numericValue op en houdt alle runs bij.
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

async function main() {
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless"] });

  process.on("message", async (msg) => {
    if (msg.type === "task") {
      const { url, device } = msg.task;
      try {
        const median = await runLighthouseForUrlAndDevice(url, device, chrome.port);
        const metrics = extractMetrics(median);
        process.send({ type: "result", task: { url, device }, metrics });
      } catch (err) {
        process.send({ type: "error", task: { url, device }, message: err.message });
      }
    } else if (msg.type === "shutdown") {
      await safeKill(chrome);
      process.exit(0);
    }
  });

  // Laat de orchestrator weten dat deze worker klaar is om taken te ontvangen
  process.send({ type: "ready" });
}

main();
