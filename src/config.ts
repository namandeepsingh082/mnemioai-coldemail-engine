import "dotenv/config";
import path from "node:path";

export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "coldemail.db");
export const PORT = Number(process.env.PORT || 4000);

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
export const OPENROUTER_WRITER_MODEL =
  process.env.OPENROUTER_WRITER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
export const OPENROUTER_CLASSIFIER_MODEL =
  process.env.OPENROUTER_CLASSIFIER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";

/** Sequence steps, in order. */
export const STEPS = ["first", "follow_up_1", "follow_up_2", "follow_up_3"] as const;
export type Step = (typeof STEPS)[number];

/** Status a contact can be in. Mirrors the brief's example statuses. */
export const STATUSES = [
  "new",
  "first_sent",
  "follow_up_1_sent",
  "follow_up_2_sent",
  "follow_up_3_sent",
  "replied",
  "bounced",
  "unsubscribed",
  "deactivated",
] as const;
export type Status = (typeof STATUSES)[number];

/** Terminal statuses: never processed by the scheduler again. */
export const TERMINAL_STATUSES: Status[] = ["replied", "bounced", "unsubscribed", "deactivated"];

/**
 * Wait (in simulated days) between one step and the next, indexed by the step
 * that was just sent: after "first" wait 3 days before follow_up_1, etc. The
 * last entry is the wait after follow_up_3 before deactivation.
 */
export const WAIT_DAYS: Record<Step, number> = {
  first: 3,
  follow_up_1: 5,
  follow_up_2: 7,
  follow_up_3: 7,
};

/** Probability a send bounces (decided synchronously at send time, like a real SMTP bounce). */
export const BOUNCE_RATE = 0.06;

/** Of delivered (non-bounced) sends, probability the contact eventually replies before the next step is due. */
export const REPLY_RATE = 0.22;

/** Of delivered sends, probability the contact unsubscribes before the next step is due. */
export const UNSUBSCRIBE_RATE = 0.04;

/** Reply sub-classification shares (must sum to 1). */
export const REPLY_CLASSIFICATION_SHARES = {
  interested: 0.4,
  not_interested: 0.45,
  out_of_office: 0.15,
};

/** Roles used to bucket contacts into AI-template segments (keeps AI calls O(segments), not O(contacts)). */
export const ROLE_SEGMENTS = [
  "Founder/CEO",
  "VP Sales",
  "VP Marketing",
  "Head of Growth",
  "Operations Manager",
  "Product Manager",
] as const;

export const COMPANIES_SAMPLE_SIZE = 10_000;
