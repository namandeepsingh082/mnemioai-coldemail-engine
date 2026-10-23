import { getDb } from "./db/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Current simulated time, in epoch milliseconds. Never use Date.now() for scheduling logic. */
export function nowMs(): number {
  const row = getDb().prepare("SELECT now_ms FROM clock WHERE id = 1").get() as { now_ms: number };
  return row.now_ms;
}

export function setNowMs(ms: number): void {
  getDb().prepare("UPDATE clock SET now_ms = ? WHERE id = 1").run(ms);
}

/** Fast-forward the simulated clock by N days (fractional allowed). */
export function advanceDays(days: number): number {
  const next = nowMs() + Math.round(days * DAY_MS);
  setNowMs(next);
  return next;
}

export function daysToMs(days: number): number {
  return Math.round(days * DAY_MS);
}
