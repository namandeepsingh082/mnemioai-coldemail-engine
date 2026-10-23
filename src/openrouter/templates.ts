import { getDb } from "../db/index.js";
import { nowMs } from "../clock.js";
import { OPENROUTER_API_KEY, OPENROUTER_WRITER_MODEL, ROLE_SEGMENTS, STEPS, type Step } from "../config.js";
import { chatCompletion } from "./client.js";

export interface Template {
  subject: string;
  body: string;
  source: "ai" | "fallback";
}

const FALLBACK_SUBJECTS: Record<Step, string> = {
  first: "Quick idea for {{company}}",
  follow_up_1: "Following up — {{company}}",
  follow_up_2: "Still worth a look? — {{company}}",
  follow_up_3: "Last note from me — {{company}}",
};

const FALLBACK_BODIES: Record<Step, string> = {
  first: `Hi {{first_name}},

I work with teams like {{company}} and thought this might be relevant to your work as {{role}}. Happy to share more if it's useful — no pressure either way.

Best,
Alex`,
  follow_up_1: `Hi {{first_name}},

Circling back in case my last note got buried. Still think this could help {{company}} — worth a quick chat?

Best,
Alex`,
  follow_up_2: `Hi {{first_name}},

One more nudge — I know {{role}}s are busy. If now isn't the right time, happy to check back later. Just let me know either way.

Best,
Alex`,
  follow_up_3: `Hi {{first_name}},

Last note from me on this — I don't want to keep filling your inbox. If it's ever relevant for {{company}}, feel free to reach out anytime.

Best,
Alex`,
};

export function fallbackTemplate(step: Step): Template {
  return { subject: FALLBACK_SUBJECTS[step], body: FALLBACK_BODIES[step], source: "fallback" };
}

function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

export function renderTemplate(
  template: Template,
  vars: { first_name: string; company: string; role: string }
): { subject: string; body: string } {
  return {
    subject: render(template.subject, vars),
    body: render(template.body, vars),
  };
}

function cacheGet(segment: string, step: Step): Template | null {
  const row = getDb()
    .prepare("SELECT subject, body, source FROM ai_templates WHERE segment = ? AND step = ?")
    .get(segment, step) as { subject: string; body: string; source: "ai" | "fallback" } | undefined;
  return row ?? null;
}

function cacheSet(segment: string, step: Step, t: Template): void {
  getDb()
    .prepare(
      `INSERT INTO ai_templates (segment, step, subject, body, source, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(segment, step) DO UPDATE SET subject=excluded.subject, body=excluded.body, source=excluded.source`
    )
    .run(segment, step, t.subject, t.body, t.source, nowMs());
}

const STEP_LABEL: Record<Step, string> = {
  first: "first cold outreach email",
  follow_up_1: "first follow-up email (no reply yet)",
  follow_up_2: "second follow-up email (still no reply)",
  follow_up_3: "third and final follow-up email",
};

async function generateWithAi(segment: string, step: Step): Promise<Template | null> {
  const prompt = `Write a short, friendly B2B cold outreach email. This is the ${STEP_LABEL[step]} in a sequence, targeting a "${segment}" persona.

Use exactly these placeholders where appropriate: {{first_name}}, {{company}}, {{role}}.
Keep it under 90 words, no markdown, no subject line formatting tricks, sign off as "Alex".
Respond with strict JSON only: {"subject": "...", "body": "..."}`;

  const result = await chatCompletion(OPENROUTER_WRITER_MODEL, [
    { role: "system", content: "You write concise, natural cold outreach emails. Respond with JSON only." },
    { role: "user", content: prompt },
  ]);

  if (!result.ok || !result.content) return null;

  try {
    const match = result.content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : result.content) as { subject?: string; body?: string };
    if (!parsed.subject || !parsed.body) return null;
    return { subject: parsed.subject, body: parsed.body, source: "ai" };
  } catch {
    return null;
  }
}

/**
 * A cached fallback template is only "stale" (worth retrying against the AI
 * model) once an API key is actually configured — if there's still no key,
 * retrying would just fail again for the same reason it fell back before.
 */
function isStaleFallback(cached: Template): boolean {
  return cached.source === "fallback" && Boolean(OPENROUTER_API_KEY);
}

/** Gets a cached template or generates+caches one. One call per (segment, step), not per contact. */
export async function getOrCreateTemplate(segment: string, step: Step): Promise<Template> {
  const cached = cacheGet(segment, step);
  if (cached && !isStaleFallback(cached)) return cached;

  const aiTemplate = await generateWithAi(segment, step);
  const template = aiTemplate ?? fallbackTemplate(step);
  cacheSet(segment, step, template);
  return template;
}

/** Pre-generates every (segment, step) template up front so the scheduler never blocks on AI mid-run. */
export async function prewarmTemplates(): Promise<{ segments: number; steps: number; generated: number; fromAi: number }> {
  let generated = 0;
  let fromAi = 0;
  for (const segment of ROLE_SEGMENTS) {
    for (const step of STEPS) {
      const existing = cacheGet(segment, step);
      if (existing && !isStaleFallback(existing)) continue;
      const t = await getOrCreateTemplate(segment, step);
      generated++;
      if (t.source === "ai") fromAi++;
    }
  }
  return { segments: ROLE_SEGMENTS.length, steps: STEPS.length, generated, fromAi };
}
