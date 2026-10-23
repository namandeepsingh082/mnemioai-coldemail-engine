import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.DB_PATH = path.join(process.cwd(), "data", "test-templates.db");
process.env.OPENROUTER_API_KEY = "test-key-for-staleness-check";

let fetchCallCount = 0;
const originalFetch = globalThis.fetch;
// A non-429/503 failure short-circuits client.ts's retry/backoff loop immediately,
// so this test stays fast while still proving whether a network attempt was made.
globalThis.fetch = (async () => {
  fetchCallCount++;
  return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
}) as typeof fetch;

const { getDb, closeDb } = await import("../src/db/index.js");
const { getOrCreateTemplate } = await import("../src/openrouter/templates.js");

function resetDb() {
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = process.env.DB_PATH! + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

describe("template cache staleness (fallback entries are retried once a key is present)", () => {
  after(() => {
    globalThis.fetch = originalFetch;
    resetDb();
  });

  it("retries generation for a cached fallback template now that an API key is configured", async () => {
    resetDb();
    const db = getDb();
    db.prepare(
      `INSERT INTO ai_templates (segment, step, subject, body, source, created_at_ms) VALUES (?, ?, 'old subject', 'old body', 'fallback', 0)`
    ).run("Founder/CEO", "first");

    fetchCallCount = 0;
    await getOrCreateTemplate("Founder/CEO", "first");
    assert.ok(fetchCallCount > 0, "expected a network attempt — a stale fallback entry should be retried once a key is present");
  });

  it("does not retry a cached AI-sourced template (it's not stale)", async () => {
    const db = getDb();
    db.exec("DELETE FROM ai_templates");
    db.prepare(
      `INSERT INTO ai_templates (segment, step, subject, body, source, created_at_ms) VALUES (?, ?, 'ai subject', 'ai body', 'ai', 0)`
    ).run("Founder/CEO", "first");

    fetchCallCount = 0;
    const template = await getOrCreateTemplate("Founder/CEO", "first");
    assert.equal(fetchCallCount, 0);
    assert.equal(template.subject, "ai subject");
  });
});
