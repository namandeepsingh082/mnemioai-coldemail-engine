import { BOUNCE_RATE, REPLY_RATE, UNSUBSCRIBE_RATE, REPLY_CLASSIFICATION_SHARES } from "../config.js";
import { rngFor } from "../util/rng.js";
import { mockReplyBody, type ReplyClassification } from "../openrouter/replies.js";

export interface SendAttempt {
  delivered: boolean;
}

/** Mock SMTP-style send: configurable bounce rate, decided deterministically per (contact, step). */
export function attemptSend(contactId: number, step: string): SendAttempt {
  const rng = rngFor(`send:${contactId}:${step}`);
  const bounced = rng() < BOUNCE_RATE;
  return { delivered: !bounced };
}

export type LifecycleOutcome =
  | { kind: "silence" }
  | { kind: "reply"; rawText: string }
  | { kind: "unsubscribe"; rawText: string };

const UNSUBSCRIBE_BODY = "Please remove me from this list. Unsubscribe.";

/**
 * Rolls what happens after a delivered send: silence (sequence continues to
 * the next step), a reply (sequence stops once classified), or an
 * unsubscribe (sequence stops, suppressed). Deterministic per (contact, step)
 * so re-runs never re-roll an outcome that was already decided and recorded.
 *
 * The ground-truth bucket used to pick a mock reply body is NOT the recorded
 * classification — that comes later from the AI/fallback classifier reading
 * `rawText`, same as a real inbound reply would be classified.
 */
export function rollLifecycleOutcome(contactId: number, step: string): LifecycleOutcome {
  const rng = rngFor(`outcome:${contactId}:${step}`);
  const roll = rng();

  if (roll < UNSUBSCRIBE_RATE) {
    return { kind: "unsubscribe", rawText: UNSUBSCRIBE_BODY };
  }
  if (roll < UNSUBSCRIBE_RATE + REPLY_RATE) {
    const classRng = rngFor(`class:${contactId}:${step}`);
    const classRoll = classRng();
    const { interested, not_interested } = REPLY_CLASSIFICATION_SHARES;
    let groundTruth: ReplyClassification;
    if (classRoll < interested) groundTruth = "interested";
    else if (classRoll < interested + not_interested) groundTruth = "not_interested";
    else groundTruth = "out_of_office";
    return { kind: "reply", rawText: mockReplyBody(groundTruth, contactId) };
  }
  return { kind: "silence" };
}

/** Deterministic offset (in ms) within [0, windowMs) for when a reply/unsubscribe "arrives". */
export function rollInboundOffsetMs(contactId: number, step: string, windowMs: number): number {
  const rng = rngFor(`timing:${contactId}:${step}`);
  // Keep inbound events strictly before the window closes, and at least a little after send.
  const minOffset = Math.min(windowMs * 0.05, 60 * 60 * 1000);
  const span = Math.max(windowMs - minOffset, 1);
  return Math.floor(minOffset + rng() * span);
}
