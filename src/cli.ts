import fs from "node:fs";
import { DB_PATH } from "./config.js";
import { seed } from "./seed.js";
import { advanceDays, nowMs } from "./clock.js";
import { runWorkflow, prewarmTemplates } from "./workflow/scheduler.js";
import { buildReport, formatReport } from "./report/report.js";
import { closeDb } from "./db/index.js";

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "seed": {
      const start = Date.now();
      seed();
      console.log(`Seeded 10,000 contacts in ${Date.now() - start}ms, clock set to ${new Date(nowMs()).toISOString()}`);
      break;
    }

    case "prewarm": {
      const start = Date.now();
      const result = await prewarmTemplates();
      console.log(`Prewarmed templates: ${JSON.stringify(result)} in ${Date.now() - start}ms`);
      break;
    }

    case "run": {
      const start = Date.now();
      const summary = await runWorkflow();
      console.log(`Workflow pass at ${new Date(nowMs()).toISOString()} took ${Date.now() - start}ms:`);
      console.log(JSON.stringify(summary, null, 2));
      break;
    }

    case "advance": {
      const daysArg = args.find((a) => a.startsWith("--days="));
      const days = daysArg ? Number(daysArg.split("=")[1]) : Number(args[0] ?? "1");
      const newNow = advanceDays(days);
      console.log(`Clock advanced by ${days} day(s) to ${new Date(newNow).toISOString()}`);
      break;
    }

    case "report": {
      const report = buildReport();
      console.log(formatReport(report));
      break;
    }

    case "reset": {
      if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
      for (const ext of ["-wal", "-shm"]) {
        if (fs.existsSync(DB_PATH + ext)) fs.rmSync(DB_PATH + ext);
      }
      console.log("Database reset.");
      break;
    }

    default:
      console.log(`Usage: tsx src/cli.ts <seed|prewarm|run|advance [--days=N]|report|reset>`);
      process.exitCode = 1;
  }

  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
