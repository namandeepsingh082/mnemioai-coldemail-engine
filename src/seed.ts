import { faker } from "@faker-js/faker";
import { getDb, runInTransaction } from "./db/index.js";
import { setNowMs, daysToMs } from "./clock.js";
import { STEPS, WAIT_DAYS, ROLE_SEGMENTS, REPLY_CLASSIFICATION_SHARES, type Status, type Step } from "./config.js";
import { fallbackTemplate, renderTemplate } from "./openrouter/templates.js";
import { mockReplyBody, type ReplyClassification } from "./openrouter/replies.js";

const SEED = 42;
const CONTACT_COUNT = 10_000;

// Fixed anchor so the dataset (and "today") is reproducible across machines/runs.
const SEED_NOW = Date.parse("2026-10-20T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_WEIGHTS: [Status, number][] = [
  ["new", 0.15],
  ["first_sent", 0.15],
  ["follow_up_1_sent", 0.12],
  ["follow_up_2_sent", 0.1],
  ["follow_up_3_sent", 0.08],
  ["replied", 0.15],
  ["bounced", 0.08],
  ["unsubscribed", 0.07],
  ["deactivated", 0.1],
];

const SEGMENT_ROLES: Record<(typeof ROLE_SEGMENTS)[number], string[]> = {
  "Founder/CEO": ["Founder", "CEO", "Co-Founder"],
  "VP Sales": ["VP of Sales", "Sales Director", "Head of Sales"],
  "VP Marketing": ["VP of Marketing", "Marketing Director", "Head of Marketing"],
  "Head of Growth": ["Head of Growth", "Growth Lead", "Growth Manager"],
  "Operations Manager": ["Operations Manager", "COO", "Head of Operations"],
  "Product Manager": ["Product Manager", "Senior Product Manager", "Head of Product"],
};

function pickWeightedStatus(): Status {
  const roll = faker.number.float({ min: 0, max: 1 });
  let acc = 0;
  for (const [status, weight] of STATUS_WEIGHTS) {
    acc += weight;
    if (roll <= acc) return status;
  }
  return STATUS_WEIGHTS[STATUS_WEIGHTS.length - 1][0];
}

/** Matches the same 40/45/15 shares the live workflow uses (`rollLifecycleOutcome`), so seeded history is consistent with simulated history. */
function pickWeightedReplyClassification(): ReplyClassification {
  const roll = faker.number.float({ min: 0, max: 1 });
  const { interested, not_interested } = REPLY_CLASSIFICATION_SHARES;
  if (roll < interested) return "interested";
  if (roll < interested + not_interested) return "not_interested";
  return "out_of_office";
}

interface SeededEvent {
  type: "sent" | "bounced" | "replied" | "unsubscribed" | "deactivated";
  step?: Step;
  classification?: ReplyClassification;
  subject?: string;
  body?: string;
  occurredAtMs: number;
}

interface HistoryResult {
  events: SeededEvent[];
  nextActionMs: number | null;
  nextActionType: Step | "deactivate" | null;
  replyClassification: ReplyClassification | null;
  createdAtMs: number;
}

/** Builds a forward chain of sent-event timestamps for steps[0..uptoIndex], anchored so the last one is `lastSentAt`. */
function buildSentChain(lastSentAt: number, uptoIndex: number): number[] {
  const times: number[] = new Array(uptoIndex + 1);
  times[uptoIndex] = lastSentAt;
  for (let i = uptoIndex - 1; i >= 0; i--) {
    times[i] = times[i + 1] - daysToMs(WAIT_DAYS[STEPS[i]]);
  }
  return times;
}

function sentEventFor(contact: { name: string; company: string; role: string; segment: string }, step: Step, at: number): SeededEvent {
  const template = fallbackTemplate(step);
  const rendered = renderTemplate(template, {
    first_name: contact.name.split(" ")[0] ?? contact.name,
    company: contact.company,
    role: contact.role,
  });
  return { type: "sent", step, subject: rendered.subject, body: rendered.body, occurredAtMs: at };
}

function buildHistory(
  status: Status,
  contact: { name: string; company: string; role: string; segment: string }
): HistoryResult {
  const createdJitterDays = faker.number.int({ min: 5, max: 35 });
  const createdAtMs = SEED_NOW - createdJitterDays * DAY_MS;

  if (status === "new") {
    return { events: [], nextActionMs: createdAtMs, nextActionType: "first", replyClassification: null, createdAtMs };
  }

  // Active (waiting) statuses: first_sent .. follow_up_3_sent
  const activeIndex = ["first_sent", "follow_up_1_sent", "follow_up_2_sent", "follow_up_3_sent"].indexOf(status);
  if (activeIndex >= 0) {
    const lastStep = STEPS[activeIndex];
    const lastSentAt = SEED_NOW - faker.number.int({ min: 0, max: 9 }) * DAY_MS;
    const chain = buildSentChain(lastSentAt, activeIndex);
    const events = chain.map((t, i) => sentEventFor(contact, STEPS[i], t));
    const nextActionMs = lastSentAt + daysToMs(WAIT_DAYS[lastStep]);
    const nextActionType: Step | "deactivate" = activeIndex === STEPS.length - 1 ? "deactivate" : STEPS[activeIndex + 1];
    return { events, nextActionMs, nextActionType, replyClassification: null, createdAtMs: Math.min(createdAtMs, chain[0]) };
  }

  if (status === "replied" || status === "unsubscribed") {
    const stepsDone = faker.number.int({ min: 1, max: STEPS.length }); // reply can land after any step
    const lastStep = STEPS[stepsDone - 1];
    const lastSentAt = SEED_NOW - faker.number.int({ min: 2, max: 20 }) * DAY_MS;
    const chain = buildSentChain(lastSentAt, stepsDone - 1);
    const events = chain.map((t, i) => sentEventFor(contact, STEPS[i], t));

    const waitMs = daysToMs(WAIT_DAYS[lastStep]);
    const terminalAt = lastSentAt + Math.floor(faker.number.float({ min: 0.05, max: 0.9 }) * waitMs);

    if (status === "replied") {
      const classification = pickWeightedReplyClassification();
      const body = mockReplyBody(classification, stepsDone);
      events.push({ type: "replied", classification, body, occurredAtMs: terminalAt });
      return { events, nextActionMs: null, nextActionType: null, replyClassification: classification, createdAtMs: Math.min(createdAtMs, chain[0] ?? lastSentAt) };
    }

    events.push({ type: "unsubscribed", body: "Please remove me from this list. Unsubscribe.", occurredAtMs: terminalAt });
    return { events, nextActionMs: null, nextActionType: null, replyClassification: null, createdAtMs: Math.min(createdAtMs, chain[0] ?? lastSentAt) };
  }

  if (status === "bounced") {
    const bounceStepIndex = faker.number.int({ min: 0, max: STEPS.length - 1 });
    const bounceAt = SEED_NOW - faker.number.int({ min: 2, max: 20 }) * DAY_MS;
    const chain = buildSentChain(bounceAt, bounceStepIndex - 1 >= 0 ? bounceStepIndex - 1 : -1);
    const events = bounceStepIndex > 0 ? chain.map((t, i) => sentEventFor(contact, STEPS[i], t)) : [];
    const bouncingStep = STEPS[bounceStepIndex];
    events.push(sentEventFor(contact, bouncingStep, bounceAt));
    events.push({ type: "bounced", step: bouncingStep, occurredAtMs: bounceAt });
    return {
      events,
      nextActionMs: null,
      nextActionType: null,
      replyClassification: null,
      createdAtMs: Math.min(createdAtMs, events[0]?.occurredAtMs ?? bounceAt),
    };
  }

  // deactivated: all 4 steps sent, then deactivation after the final wait elapsed.
  const lastSentAt = SEED_NOW - faker.number.int({ min: 10, max: 30 }) * DAY_MS;
  const chain = buildSentChain(lastSentAt, STEPS.length - 1);
  const events = chain.map((t, i) => sentEventFor(contact, STEPS[i], t));
  const deactivatedAt = lastSentAt + daysToMs(WAIT_DAYS[STEPS[STEPS.length - 1]]) + faker.number.int({ min: 0, max: 2 }) * DAY_MS;
  events.push({ type: "deactivated", occurredAtMs: Math.min(deactivatedAt, SEED_NOW) });
  return { events, nextActionMs: null, nextActionType: null, replyClassification: null, createdAtMs: Math.min(createdAtMs, chain[0]) };
}

export function seed(): void {
  faker.seed(SEED);
  const db = getDb();

  db.exec("DELETE FROM events; DELETE FROM inbound_events; DELETE FROM contacts; DELETE FROM ai_templates;");

  // Reset AUTOINCREMENT counters so contact (and event) ids always start fresh at 1.
  // Without this, re-running `seed` against an existing db file leaves ids climbing
  // upward each time, which silently breaks reproducibility: the mock send/reply
  // simulation is keyed by contact id, so the same "fixed seed" data would still
  // produce different simulated bounce/reply outcomes across repeated seed runs.
  const hasSqliteSequence = db
    .prepare("SELECT 1 as x FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
    .get();
  if (hasSqliteSequence) {
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('contacts', 'events', 'inbound_events')");
  }

  const insertContact = db.prepare(
    `INSERT INTO contacts (name, email, company, role, segment, timezone, status, created_at_ms, next_action_ms, next_action_type, reply_classification)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (contact_id, type, step, classification, subject, body, occurred_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  runInTransaction(db, () => {
    for (let i = 0; i < CONTACT_COUNT; i++) {
      const firstName = faker.person.firstName();
      const lastName = faker.person.lastName();
      const name = `${firstName} ${lastName}`;
      const company = faker.company.name();
      const segment = faker.helpers.arrayElement(ROLE_SEGMENTS);
      const role = faker.helpers.arrayElement(SEGMENT_ROLES[segment]);
      const timezone = faker.location.timeZone();
      const email = `${firstName}.${lastName}.${i}@${faker.internet.domainName()}`.toLowerCase();

      const status = pickWeightedStatus();
      const history = buildHistory(status, { name, company, role, segment });

      const contactId = insertContact.run(
        name,
        email,
        company,
        role,
        segment,
        timezone,
        status,
        history.createdAtMs,
        history.nextActionMs,
        history.nextActionType,
        history.replyClassification
      ).lastInsertRowid as number;

      for (const ev of history.events) {
        insertEvent.run(contactId, ev.type, ev.step ?? null, ev.classification ?? null, ev.subject ?? null, ev.body ?? null, ev.occurredAtMs);
      }
    }
  });

  setNowMs(SEED_NOW);
}

if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const start = Date.now();
  seed();
  console.log(`Seeded ${CONTACT_COUNT} contacts in ${Date.now() - start}ms (seed=${SEED}, clock set to ${new Date(SEED_NOW).toISOString()})`);
}
