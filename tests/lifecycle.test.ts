import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);

process.env.DB_PATH = path.join(process.cwd(), "data", "test-lifecycle.db");

const { getDb, closeDb } = await import("../src/db/index.js");
const { seed } = await import("../src/seed.js");
const { nowMs, advanceDays } = await import("../src/clock.js");
const { runWorkflow } = await import("../src/workflow/scheduler.js");
const { TERMINAL_STATUSES } = await import("../src/config.js");

function resetDb() {
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = process.env.DB_PATH! + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

describe("lifecycle + idempotency", () => {
  beforeEach(() => {
    resetDb();
    seed();
  });

  after(() => {
    resetDb();
  });

  it("re-seeding without deleting the db file still reproduces identical results (fixed seed)", async () => {
    // seed() already ran once in beforeEach; re-seed over the same (non-deleted) db
    // file a couple more times and confirm outcomes never drift. Contact ids must
    // reset to the same values each time (AUTOINCREMENT counter reset in seed()),
    // since the mock send/reply simulation is keyed by contact id.
    seed();
    const first = await runWorkflow();

    seed();
    const second = await runWorkflow();

    assert.deepEqual(first, second);

    const db = getDb();
    const ids = db.prepare("SELECT MIN(id) as min, MAX(id) as max FROM contacts").get() as {
      min: number;
      max: number;
    };
    assert.equal(ids.min, 1);
    assert.equal(ids.max, 10_000);
  });

  it("running the workflow twice at the same simulated time never double-sends", async () => {
    const db = getDb();
    const before = db.prepare("SELECT COUNT(*) as c FROM events WHERE type = 'sent'").get() as { c: number };

    const first = await runWorkflow();
    const afterFirst = db.prepare("SELECT COUNT(*) as c FROM events WHERE type = 'sent'").get() as { c: number };
    assert.ok(afterFirst.c > before.c);
    assert.ok(first.sent + first.bounced > 0);

    const second = await runWorkflow();
    const afterSecond = db.prepare("SELECT COUNT(*) as c FROM events WHERE type = 'sent'").get() as { c: number };

    assert.equal(afterSecond.c, afterFirst.c);
    assert.equal(second.sent, 0);
    assert.equal(second.bounced, 0);
  });

  it("every contact has at most one 'sent' event per step, even after many runs", async () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) {
      await runWorkflow();
    }
    advanceDays(60);
    for (let i = 0; i < 5; i++) {
      await runWorkflow();
    }

    const dupes = db
      .prepare(
        `SELECT contact_id, step, COUNT(*) as c FROM events WHERE type = 'sent' GROUP BY contact_id, step HAVING c > 1`
      )
      .all();
    assert.equal(dupes.length, 0);
  });

  it("a reply stops the sequence and the contact is never sent to again", async () => {
    const db = getDb();
    advanceDays(60);
    await runWorkflow();

    const repliedContacts = db.prepare("SELECT id FROM contacts WHERE status = 'replied'").all() as { id: number }[];
    assert.ok(repliedContacts.length > 0);

    const sentCountBefore = db.prepare("SELECT COUNT(*) as c FROM events WHERE type = 'sent'").get() as { c: number };
    advanceDays(30);
    await runWorkflow();
    const sentCountAfter = db.prepare("SELECT COUNT(*) as c FROM events WHERE type = 'sent'").get() as { c: number };

    // No events of any kind should be added for already-replied contacts.
    const ids = repliedContacts.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");
    const postReplyEvents = db
      .prepare(`SELECT COUNT(*) as c FROM events WHERE contact_id IN (${placeholders}) AND occurred_at_ms > ?`)
      .get(...ids, nowMs() - 1) as { c: number };

    assert.equal(postReplyEvents.c, 0);
    assert.ok(sentCountAfter.c >= sentCountBefore.c);
  });

  it("bounced and unsubscribed contacts are suppressed permanently (status never changes again)", async () => {
    const db = getDb();
    advanceDays(90);
    await runWorkflow();
    advanceDays(90);
    await runWorkflow();

    const bounced = db.prepare("SELECT id, email, status FROM contacts WHERE status = 'bounced'").all() as {
      id: number;
      email: string;
      status: string;
    }[];
    const unsub = db.prepare("SELECT id, email, status FROM contacts WHERE status = 'unsubscribed'").all() as {
      id: number;
      email: string;
      status: string;
    }[];
    assert.ok(bounced.length > 0);
    assert.ok(unsub.length > 0);

    // Both outcomes must also land in the standalone suppression list, independent of status.
    const suppressed = new Set(
      (db.prepare("SELECT email FROM suppression").all() as { email: string }[]).map((r) => r.email)
    );
    for (const row of [...bounced, ...unsub]) {
      assert.ok(suppressed.has(row.email), `expected ${row.email} to be in the suppression list`);
    }

    const checkpointMs = nowMs();
    advanceDays(365);
    await runWorkflow();

    for (const row of [...bounced, ...unsub]) {
      const current = db.prepare("SELECT status FROM contacts WHERE id = ?").get(row.id) as { status: string };
      assert.equal(current.status, row.status);
    }

    // Still suppressed after more runs — never removed, and never retried as a send attempt.
    const suppressedAfter = new Set(
      (db.prepare("SELECT email FROM suppression").all() as { email: string }[]).map((r) => r.email)
    );
    const ids = [...bounced, ...unsub].map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const sentToSuppressed = db
      .prepare(
        `SELECT COUNT(*) as c FROM events WHERE type = 'sent' AND contact_id IN (${placeholders}) AND occurred_at_ms > ?`
      )
      .get(...ids, checkpointMs) as { c: number };
    assert.equal(sentToSuppressed.c, 0);
    for (const row of [...bounced, ...unsub]) {
      assert.ok(suppressedAfter.has(row.email));
    }
  });

  it("deactivates contacts once all follow-ups are sent and the final wait passes with no reply", async () => {
    advanceDays(120);
    await runWorkflow();
    advanceDays(60);
    await runWorkflow();

    const db = getDb();
    const deactivated = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status = 'deactivated'").get() as {
      c: number;
    };
    assert.ok(deactivated.c > 0);

    const stillActive = db
      .prepare(
        `SELECT COUNT(*) as c FROM contacts WHERE status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")}) AND next_action_ms < ?`
      )
      .get(...TERMINAL_STATUSES, nowMs() - 1000 * 60 * 60 * 24 * 30) as { c: number };
    // Nothing should be sitting more than 30 days overdue after enough runs — the scheduler should have caught up.
    assert.equal(stillActive.c, 0);
  });
});

describe("concurrent processes", () => {
  it("two `run` processes launched at the same instant never produce a duplicate sent event", async () => {
    const concurrentDbPath = path.join(process.cwd(), "data", "test-concurrency.db");
    for (const ext of ["", "-wal", "-shm"]) {
      const p = concurrentDbPath + ext;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    const env = { ...process.env, DB_PATH: concurrentDbPath };
    const run = (args: string[]) => execFileAsync("npx", ["tsx", "src/cli.ts", ...args], { env, cwd: process.cwd() });

    await run(["seed"]);
    await run(["advance", "--days=10"]); // make a large batch of contacts due at once, to widen the race window

    // Launch both `run` invocations without awaiting the first — they race against the same db file.
    const results = await Promise.allSettled([run(["run"]), run(["run"])]);
    for (const r of results) {
      assert.equal(r.status, "fulfilled", r.status === "rejected" ? String(r.reason) : undefined);
    }

    const db = new DatabaseSync(concurrentDbPath);
    try {
      const dupes = db
        .prepare(
          `SELECT contact_id, step, COUNT(*) as c FROM events WHERE type = 'sent' GROUP BY contact_id, step HAVING c > 1`
        )
        .all();
      assert.equal(dupes.length, 0);
    } finally {
      db.close();
      for (const ext of ["", "-wal", "-shm"]) {
        const p = concurrentDbPath + ext;
        if (fs.existsSync(p)) fs.rmSync(p);
      }
    }
  });
});
