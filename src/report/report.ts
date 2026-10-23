import { getDb } from "../db/index.js";
import { nowMs, daysToMs } from "../clock.js";
import { STATUSES } from "../config.js";

export interface ReportData {
  generatedAt: string;
  totalContacts: number;
  byStatus: Record<string, number>;
  sentToday: number;
  dueToday: number;
  dueTomorrow: number;
  totalSent: number;
  totalBounced: number;
  totalReplied: number;
  totalUnsubscribed: number;
  totalDeactivated: number;
  replyRate: number;
  bounceRate: number;
  replyClassificationBreakdown: Record<string, number>;
}

export function buildReport(): ReportData {
  const db = getDb();
  const now = nowMs();
  const dayStart = now - (now % daysToMs(1));
  const dayEnd = dayStart + daysToMs(1);
  const tomorrowEnd = dayEnd + daysToMs(1);

  const byStatus: Record<string, number> = {};
  for (const status of STATUSES) {
    const row = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status = ?").get(status) as { c: number };
    byStatus[status] = row.c;
  }

  const totalContacts = (db.prepare("SELECT COUNT(*) as c FROM contacts").get() as { c: number }).c;

  const sentToday = (
    db
      .prepare("SELECT COUNT(*) as c FROM events WHERE type = 'sent' AND occurred_at_ms >= ? AND occurred_at_ms < ?")
      .get(dayStart, dayEnd) as { c: number }
  ).c;

  const dueToday = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM contacts WHERE next_action_ms IS NOT NULL AND next_action_ms >= ? AND next_action_ms < ?"
      )
      .get(dayStart, dayEnd) as { c: number }
  ).c;

  const dueTomorrow = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM contacts WHERE next_action_ms IS NOT NULL AND next_action_ms >= ? AND next_action_ms < ?"
      )
      .get(dayEnd, tomorrowEnd) as { c: number }
  ).c;

  const totalSent = (db.prepare("SELECT COUNT(*) as c FROM events WHERE type = 'sent'").get() as { c: number }).c;
  const totalBounced = (db.prepare("SELECT COUNT(*) as c FROM events WHERE type = 'bounced'").get() as { c: number }).c;
  const totalReplied = byStatus["replied"] ?? 0;
  const totalUnsubscribed = byStatus["unsubscribed"] ?? 0;
  const totalDeactivated = byStatus["deactivated"] ?? 0;

  const replyRate = totalSent > 0 ? totalReplied / totalSent : 0;
  const bounceRate = totalSent > 0 ? totalBounced / totalSent : 0;

  const classificationRows = db
    .prepare("SELECT reply_classification as c, COUNT(*) as n FROM contacts WHERE status = 'replied' GROUP BY reply_classification")
    .all() as { c: string; n: number }[];
  const replyClassificationBreakdown: Record<string, number> = {};
  for (const row of classificationRows) replyClassificationBreakdown[row.c] = row.n;

  return {
    generatedAt: new Date(now).toISOString(),
    totalContacts,
    byStatus,
    sentToday,
    dueToday,
    dueTomorrow,
    totalSent,
    totalBounced,
    totalReplied,
    totalUnsubscribed,
    totalDeactivated,
    replyRate,
    bounceRate,
    replyClassificationBreakdown,
  };
}

export function formatReport(r: ReportData): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Report as of ${r.generatedAt} (simulated clock)`,
    `Total contacts: ${r.totalContacts}`,
    "",
    "By status:",
    ...Object.entries(r.byStatus).map(([s, n]) => `  ${s.padEnd(20)} ${n}`),
    "",
    `Sent today: ${r.sentToday}`,
    `Due today: ${r.dueToday}`,
    `Due tomorrow: ${r.dueTomorrow}`,
    "",
    `Total emails sent: ${r.totalSent}`,
    `Total bounced: ${r.totalBounced} (${pct(r.bounceRate)})`,
    `Total replied: ${r.totalReplied} (${pct(r.replyRate)})`,
    `  - interested: ${r.replyClassificationBreakdown["interested"] ?? 0}`,
    `  - not_interested: ${r.replyClassificationBreakdown["not_interested"] ?? 0}`,
    `  - out_of_office: ${r.replyClassificationBreakdown["out_of_office"] ?? 0}`,
    `Total unsubscribed: ${r.totalUnsubscribed}`,
    `Total deactivated: ${r.totalDeactivated}`,
  ];
  return lines.join("\n");
}
