import { getDb, runInTransaction } from "../db/index.js";
import { nowMs, daysToMs } from "../clock.js";
import { WAIT_DAYS, TERMINAL_STATUSES, type Step } from "../config.js";
import { getOrCreateTemplate, renderTemplate, prewarmTemplates, type Template } from "../openrouter/templates.js";
import { classifyReplyBatch } from "../openrouter/replies.js";
import { attemptSend, rollLifecycleOutcome, rollInboundOffsetMs } from "../mailer/mockProvider.js";

const NEXT_STEP: Record<Step, Step | "deactivate"> = {
  first: "follow_up_1",
  follow_up_1: "follow_up_2",
  follow_up_2: "follow_up_3",
  follow_up_3: "deactivate",
};

const STEP_TO_STATUS: Record<Step, string> = {
  first: "first_sent",
  follow_up_1: "follow_up_1_sent",
  follow_up_2: "follow_up_2_sent",
  follow_up_3: "follow_up_3_sent",
};

const BATCH_SIZE = 1000;
const CLASSIFY_CHUNK_SIZE = 20;

export interface RunSummary {
  repliesApplied: number;
  unsubscribesApplied: number;
  sent: number;
  bounced: number;
  deactivated: number;
  templatesGenerated: number;
}

interface ContactRow {
  id: number;
  name: string;
  company: string;
  role: string;
  segment: string;
  status: string;
  next_action_type: string | null;
}

function firstName(fullName: string): string {
  return fullName.split(" ")[0] ?? fullName;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function applyDueReplies(now: number): Promise<number> {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT ie.id as inbound_id, ie.contact_id, ie.raw_text
       FROM inbound_events ie
       JOIN contacts c ON c.id = ie.contact_id
       WHERE ie.kind = 'reply' AND ie.applied = 0 AND ie.scheduled_at_ms <= ?
         AND c.status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`
    )
    .all(now, ...TERMINAL_STATUSES) as { inbound_id: number; contact_id: number; raw_text: string }[];

  if (due.length === 0) return 0;

  const updateContact = db.prepare(
    `UPDATE contacts SET status = 'replied', reply_classification = ?, next_action_ms = NULL, next_action_type = NULL WHERE id = ?`
  );
  const markApplied = db.prepare(`UPDATE inbound_events SET applied = 1 WHERE id = ?`);
  const insertEvent = db.prepare(
    `INSERT INTO events (contact_id, type, classification, body, occurred_at_ms) VALUES (?, 'replied', ?, ?, ?)`
  );

  for (const batch of chunk(due, CLASSIFY_CHUNK_SIZE)) {
    const outcomes = await classifyReplyBatch(batch.map((b) => b.raw_text));
    runInTransaction(db, () => {
      batch.forEach((row, i) => {
        const { classification } = outcomes[i];
        updateContact.run(classification, row.contact_id);
        insertEvent.run(row.contact_id, classification, row.raw_text, now);
        markApplied.run(row.inbound_id);
      });
    });
  }

  return due.length;
}

function applyDueUnsubscribes(now: number): number {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT ie.id as inbound_id, ie.contact_id, ie.raw_text
       FROM inbound_events ie
       JOIN contacts c ON c.id = ie.contact_id
       WHERE ie.kind = 'unsubscribe' AND ie.applied = 0 AND ie.scheduled_at_ms <= ?
         AND c.status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`
    )
    .all(now, ...TERMINAL_STATUSES) as { inbound_id: number; contact_id: number; raw_text: string }[];

  if (due.length === 0) return 0;

  const updateContact = db.prepare(
    `UPDATE contacts SET status = 'unsubscribed', next_action_ms = NULL, next_action_type = NULL WHERE id = ?`
  );
  const markApplied = db.prepare(`UPDATE inbound_events SET applied = 1 WHERE id = ?`);
  const insertEvent = db.prepare(
    `INSERT INTO events (contact_id, type, body, occurred_at_ms) VALUES (?, 'unsubscribed', ?, ?)`
  );

  runInTransaction(db, () => {
    for (const row of due) {
      updateContact.run(row.contact_id);
      insertEvent.run(row.contact_id, row.raw_text, now);
      markApplied.run(row.inbound_id);
    }
  });

  return due.length;
}

async function processDueSendsAndDeactivations(
  now: number
): Promise<{ sent: number; bounced: number; deactivated: number }> {
  const db = getDb();
  let sent = 0;
  let bounced = 0;
  let deactivated = 0;

  const templateCache = new Map<string, Template>();
  const getTemplate = async (segment: string, step: Step): Promise<Template> => {
    const key = `${segment}:${step}`;
    const cached = templateCache.get(key);
    if (cached) return cached;
    const t = await getOrCreateTemplate(segment, step);
    templateCache.set(key, t);
    return t;
  };

  const selectDueBatch = db.prepare(
    `SELECT id, name, company, role, segment, status, next_action_type
     FROM contacts
     WHERE next_action_ms <= ? AND status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})
     ORDER BY id
     LIMIT ?`
  );

  const insertSentEvent = db.prepare(
    `INSERT INTO events (contact_id, type, step, subject, body, occurred_at_ms) VALUES (?, 'sent', ?, ?, ?, ?)`
  );
  const insertBouncedEvent = db.prepare(
    `INSERT INTO events (contact_id, type, step, occurred_at_ms) VALUES (?, 'bounced', ?, ?)`
  );
  const insertDeactivatedEvent = db.prepare(
    `INSERT INTO events (contact_id, type, occurred_at_ms) VALUES (?, 'deactivated', ?)`
  );
  const insertInbound = db.prepare(
    `INSERT INTO inbound_events (contact_id, kind, raw_text, scheduled_at_ms) VALUES (?, ?, ?, ?)`
  );

  const markBounced = db.prepare(
    `UPDATE contacts SET status = 'bounced', next_action_ms = NULL, next_action_type = NULL WHERE id = ?`
  );
  const markSentAdvance = db.prepare(
    `UPDATE contacts SET status = ?, next_action_ms = ?, next_action_type = ? WHERE id = ?`
  );
  const markDeactivated = db.prepare(
    `UPDATE contacts SET status = 'deactivated', next_action_ms = NULL, next_action_type = NULL WHERE id = ?`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = selectDueBatch.all(now, ...TERMINAL_STATUSES, BATCH_SIZE) as unknown as ContactRow[];
    if (batch.length === 0) break;

    // Resolve AI templates for this batch's (segment, step) combos before opening the DB transaction,
    // since template generation is async and node:sqlite's synchronous API can't run inside an async callback.
    const stepBatches = batch.filter((c) => c.next_action_type !== "deactivate" && c.next_action_type !== null);
    const resolved = new Map<number, { subject: string; body: string }>();
    for (const row of stepBatches) {
      const step = row.next_action_type as Step;
      const template = await getTemplate(row.segment, step);
      const rendered = renderTemplate(template, {
        first_name: firstName(row.name),
        company: row.company,
        role: row.role,
      });
      resolved.set(row.id, rendered);
    }

    runInTransaction(db, () => {
      for (const row of batch) {
        if (row.next_action_type === "deactivate") {
          markDeactivated.run(row.id);
          insertDeactivatedEvent.run(row.id, now);
          deactivated++;
          continue;
        }

        const step = row.next_action_type as Step;
        const rendered = resolved.get(row.id)!;
        insertSentEvent.run(row.id, step, rendered.subject, rendered.body, now);

        const { delivered } = attemptSend(row.id, step);
        if (!delivered) {
          insertBouncedEvent.run(row.id, step, now);
          markBounced.run(row.id);
          bounced++;
          continue;
        }

        sent++;
        const waitMs = daysToMs(WAIT_DAYS[step]);
        const nextActionMs = now + waitMs;
        const nextType = NEXT_STEP[step];
        markSentAdvance.run(STEP_TO_STATUS[step], nextActionMs, nextType, row.id);

        const outcome = rollLifecycleOutcome(row.id, step);
        if (outcome.kind === "reply") {
          const offset = rollInboundOffsetMs(row.id, step, waitMs);
          insertInbound.run(row.id, "reply", outcome.rawText, now + offset);
        } else if (outcome.kind === "unsubscribe") {
          const offset = rollInboundOffsetMs(row.id, step, waitMs);
          insertInbound.run(row.id, "unsubscribe", outcome.rawText, now + offset);
        }
      }
    });
  }

  return { sent, bounced, deactivated };
}

/**
 * Runs one pass of the workflow against the current simulated clock. Safe to
 * call repeatedly / concurrently-in-sequence: every contact's next action is
 * only picked up while next_action_ms <= now, and processing it always moves
 * next_action_ms forward or into a terminal state in the same transaction
 * that recorded the send — so a second run at the same simulated time is a
 * no-op for contacts already processed.
 */
export async function runWorkflow(): Promise<RunSummary> {
  const now = nowMs();
  const before = getDb().prepare("SELECT COUNT(*) as c FROM ai_templates").get() as { c: number };

  const repliesApplied = await applyDueReplies(now);
  const unsubscribesApplied = applyDueUnsubscribes(now);
  const { sent, bounced, deactivated } = await processDueSendsAndDeactivations(now);

  const after = getDb().prepare("SELECT COUNT(*) as c FROM ai_templates").get() as { c: number };

  return {
    repliesApplied,
    unsubscribesApplied,
    sent,
    bounced,
    deactivated,
    templatesGenerated: after.c - before.c,
  };
}

export { prewarmTemplates };
