import fs from "fs";
import { fork } from "child_process";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Voeg hier alle URL's toe die je wilt testen
const urls = [
  "https://zfb2u17p7j-staging.onrocket.site/",
  "https://zfb2u17p7j-staging.onrocket.site/check/",
  "https://zfb2u17p7j-staging.onrocket.site/websitesnelheid-getest-met-pagespeed-insights/",
  "https://zfb2u17p7j-staging.onrocket.site/contact/",
];

// Aantal Lighthouse runs per URL/device-combinatie (mediaan wordt hiervan berekend)
const RUNS_PER_TEST = 5;

// Aantal workers dat gelijktijdig draait. Hoger = sneller, maar zwaarder voor
// je machine (en meer CPU-drukte kan je meetwaarden beinvloeden). 3-4 is
// meestal een goede balans.
const CONCURRENCY = 3;

// Elke worker is een apart Node-proces: Lighthouse houdt zijn interne timings
// bij in globale performance-marks, dus twee Lighthouse-runs in hetzelfde
// proces lopen elkaar in de weg. Vandaar fork() in plaats van een simpele
// async worker-pool.
const workerPath = fileURLToPath(new URL("./lighthouse-worker.js", import.meta.url));

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

// Zet de resultaten terug in de volgorde van de urls-lijst, zodat de tabel
// leesbaar blijft ongeacht welke worker als eerste klaar was.
function sortResults(results) {
  const order = (r) => urls.indexOf(r.url) * 2 + (r.device === "desktop" ? 0 : 1);
  return [...results].sort((a, b) => order(a) - order(b));
}

// ---------------------------------------------------------------------------
// Worker: start een child-proces en voed het taken uit de gedeelde wachtrij
// tot die leeg is. Protocol (zie lighthouse-worker.js):
//   worker -> ready | result | error
//   ons    -> task | shutdown
// ---------------------------------------------------------------------------

function runWorker(workerId, taskQueue, allResults, failures) {
  return new Promise((resolve) => {
    const child = fork(workerPath, [], {
      env: { ...process.env, RUNS_PER_TEST: String(RUNS_PER_TEST) },
    });

    let currentTask = null;

    function sendNextTask() {
      const task = taskQueue.shift();
      currentTask = task ?? null;

      if (!task) {
        child.send({ type: "shutdown" });
        return;
      }

      console.log(`[Worker ${workerId}] start ${task.device} - ${task.url}`);
      child.send({ type: "task", task });
    }

    child.on("message", (msg) => {
      if (msg.type === "ready") {
        console.log(`Worker ${workerId} gestart (pid ${child.pid})`);
        sendNextTask();
        return;
      }

      if (msg.type === "result") {
        allResults.push({ url: msg.task.url, device: msg.task.device, ...msg.metrics });
        console.log(
          `[Worker ${workerId}] klaar: ${msg.task.device} score ${msg.metrics.performanceScore} (${msg.task.url})`,
        );
        sendNextTask();
        return;
      }

      if (msg.type === "error") {
        console.error(
          `[Worker ${workerId}] FOUT bij ${msg.task.device} - ${msg.task.url}: ${msg.message}`,
        );
        failures.push({ ...msg.task, reden: msg.message });
        sendNextTask();
      }
    });

    child.on("error", (err) => {
      console.error(`[Worker ${workerId}] procesfout: ${err.message}`);
    });

    // Valt de worker onverwacht om, dan is de taak waar hij mee bezig was
    // verloren. We laten de overige workers gewoon doorlopen.
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        const reden = `worker gestopt (code ${code}${signal ? `, signaal ${signal}` : ""})`;
        console.error(`[Worker ${workerId}] ${reden}`);
        if (currentTask) failures.push({ ...currentTask, reden });
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const taskQueue = buildTasks();
  const allResults = [];
  const failures = [];

  const workerCount = Math.min(CONCURRENCY, taskQueue.length);
  console.log(
    `${taskQueue.length} taken x ${RUNS_PER_TEST} runs, verdeeld over ${workerCount} worker(s)\n`,
  );

  const workers = [];
  for (let i = 1; i <= workerCount; i++) {
    workers.push(runWorker(i, taskQueue, allResults, failures));
  }
  await Promise.all(workers);

  console.log("\n\n===== SAMENVATTING =====");
  const sorted = sortResults(allResults);
  console.table(sorted);

  if (failures.length > 0) {
    console.log(`\n${failures.length} taak/taken mislukt:`);
    console.table(failures);
  }

  const outputPath = "./lighthouse-results.json";
  fs.writeFileSync(outputPath, JSON.stringify(sorted, null, 2));
  console.log(`\nResultaten opgeslagen in ${outputPath}`);

  if (allResults.length === 0) process.exit(1);
}

main().catch((err) => {
  console.error("Er ging iets mis:", err);
  process.exit(1);
});
