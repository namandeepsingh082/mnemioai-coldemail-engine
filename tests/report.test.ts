import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.DB_PATH = path.join(process.cwd(), "data", "test-report.db");

const { closeDb, getDb } = await import("../src/db/index.js");
const { seed } = await import("../src/seed.js");
const { advanceDays } = await import("../src/clock.js");
const { runWorkflow } = await import("../src/workflow/scheduler.js");
const { buildReport } = await import("../src/report/report.js");
const { STATUSES } = await import("../src/config.js");

function resetDb() {
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = process.env.DB_PATH! + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

describe("reporting", () => {
  before(async () => {
    resetDb();
    seed();
    advanceDays(90);
    await runWorkflow();
  });

  after(() => {
    resetDb();
  });

  it("status counts add up to the total contact count", () => {
    const report = buildReport();
    const sum = STATUSES.reduce((acc, s) => acc + (report.byStatus[s] ?? 0), 0);
    assert.equal(sum, report.totalContacts);
    assert.equal(report.totalContacts, 10_000);
  });

  it("reply rate and bounce rate are within [0, 1]", () => {
    const report = buildReport();
    assert.ok(report.replyRate >= 0 && report.replyRate <= 1);
    assert.ok(report.bounceRate >= 0 && report.bounceRate <= 1);
  });

  it("replied contact count matches the sum of reply classification breakdown", () => {
    const report = buildReport();
    const classSum = Object.values(report.replyClassificationBreakdown).reduce((a, b) => a + b, 0);
    assert.equal(classSum, report.totalReplied);
  });

  it("every contact's recorded status matches its latest terminal event, where one exists", () => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT c.id, c.status, e.type FROM contacts c
         LEFT JOIN events e ON e.id = (
           SELECT id FROM events WHERE contact_id = c.id AND type IN ('replied','bounced','unsubscribed','deactivated')
           ORDER BY occurred_at_ms DESC LIMIT 1
         )
         WHERE c.status IN ('replied','bounced','unsubscribed','deactivated')`
      )
      .all() as { id: number; status: string; type: string | null }[];

    for (const row of rows) {
      assert.equal(row.type, row.status);
    }
  });
});
