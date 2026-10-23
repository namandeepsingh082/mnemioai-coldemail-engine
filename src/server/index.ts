import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "../config.js";
import { buildReport } from "../report/report.js";
import { nowMs, advanceDays } from "../clock.js";
import { runWorkflow } from "../workflow/scheduler.js";
import { getDb } from "../db/index.js";
import { STATUSES } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/report", (_req, res) => {
  res.json(buildReport());
});

app.get("/api/clock", (_req, res) => {
  res.json({ nowMs: nowMs(), now: new Date(nowMs()).toISOString() });
});

app.post("/api/advance", (req, res) => {
  const days = Number(req.body?.days ?? 1);
  const next = advanceDays(days);
  res.json({ nowMs: next, now: new Date(next).toISOString() });
});

app.post("/api/run", async (_req, res) => {
  const summary = await runWorkflow();
  res.json(summary);
});

app.get("/api/contacts", (req, res) => {
  const db = getDb();
  const status = typeof req.query.status === "string" && STATUSES.includes(req.query.status as any) ? req.query.status : null;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);

  const where = status ? "WHERE status = ?" : "";
  const params = status ? [status] : [];

  const rows = db
    .prepare(
      `SELECT id, name, email, company, role, segment, status, next_action_ms, next_action_type, reply_classification
       FROM contacts ${where} ORDER BY id LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const total = (db.prepare(`SELECT COUNT(*) as c FROM contacts ${where}`).get(...params) as { c: number }).c;

  res.json({ total, limit, offset, rows });
});

app.get("/api/contacts/:id", (req, res) => {
  const db = getDb();
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(req.params.id);
  if (!contact) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const events = db
    .prepare("SELECT * FROM events WHERE contact_id = ? ORDER BY occurred_at_ms ASC")
    .all(req.params.id);
  res.json({ contact, events });
});

app.get("/api/activity", (req, res) => {
  const db = getDb();
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const rows = db
    .prepare(
      `SELECT e.*, c.name as contact_name, c.email as contact_email
       FROM events e JOIN contacts c ON c.id = e.contact_id
       ORDER BY e.occurred_at_ms DESC, e.id DESC LIMIT ?`
    )
    .all(limit);
  res.json({ rows });
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
