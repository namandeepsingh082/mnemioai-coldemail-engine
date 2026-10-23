/**
 * Seeds the full 10,000-contact dataset and drives the simulated clock
 * forward day by day, running the workflow at each step, until every contact
 * reaches a terminal status (or a safety cap of days is hit). Prints timing
 * and final counts for the README's "Results" section.
 */
import { seed } from "../src/seed.js";
import { nowMs, advanceDays } from "../src/clock.js";
import { runWorkflow } from "../src/workflow/scheduler.js";
import { buildReport, formatReport } from "../src/report/report.js";
import { getDb, closeDb } from "../src/db/index.js";
import { TERMINAL_STATUSES } from "../src/config.js";

const MAX_DAYS = 40;

function activeCount(): number {
  const db = getDb();
  const placeholders = TERMINAL_STATUSES.map(() => "?").join(",");
  const row = db.prepare(`SELECT COUNT(*) as c FROM contacts WHERE status NOT IN (${placeholders})`).get(
    ...TERMINAL_STATUSES
  ) as { c: number };
  return row.c;
}

async function main() {
  const totalStart = Date.now();

  const seedStart = Date.now();
  seed();
  const seedMs = Date.now() - seedStart;

  let passes = 0;
  let totalSent = 0;
  let totalBounced = 0;
  let totalDeactivated = 0;
  let totalReplies = 0;
  let totalUnsubs = 0;

  const workflowStart = Date.now();

  // First pass at the seeded "now" to process everything already due.
  let summary = await runWorkflow();
  passes++;
  totalSent += summary.sent;
  totalBounced += summary.bounced;
  totalDeactivated += summary.deactivated;
  totalReplies += summary.repliesApplied;
  totalUnsubs += summary.unsubscribesApplied;

  for (let day = 0; day < MAX_DAYS && activeCount() > 0; day++) {
    advanceDays(1);
    summary = await runWorkflow();
    passes++;
    totalSent += summary.sent;
    totalBounced += summary.bounced;
    totalDeactivated += summary.deactivated;
    totalReplies += summary.repliesApplied;
    totalUnsubs += summary.unsubscribesApplied;
  }

  const workflowMs = Date.now() - workflowStart;
  const totalMs = Date.now() - totalStart;

  const report = buildReport();

  console.log("=".repeat(60));
  console.log("BENCHMARK RESULT");
  console.log("=".repeat(60));
  console.log(`Seed time:            ${seedMs}ms`);
  console.log(`Workflow passes:      ${passes} (1 initial + up to ${MAX_DAYS} daily advances)`);
  console.log(`Workflow time:        ${workflowMs}ms total, ${(workflowMs / passes).toFixed(1)}ms/pass avg`);
  console.log(`Total wall time:      ${totalMs}ms`);
  console.log(`Final simulated date: ${new Date(nowMs()).toISOString()}`);
  console.log(`Still active (non-terminal): ${activeCount()}`);
  console.log("-".repeat(60));
  console.log(`Totals across all passes — sent: ${totalSent}, bounced: ${totalBounced}, deactivated: ${totalDeactivated}, replies applied: ${totalReplies}, unsubscribes applied: ${totalUnsubs}`);
  console.log("-".repeat(60));
  console.log(formatReport(report));

  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
