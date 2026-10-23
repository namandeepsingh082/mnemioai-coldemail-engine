import { OPENROUTER_CLASSIFIER_MODEL } from "../config.js";
import { chatCompletion } from "./client.js";

export type ReplyClassification = "interested" | "not_interested" | "out_of_office";

const REPLY_BODY_TEMPLATES: Record<ReplyClassification, string[]> = {
  interested: [
    "Hi, this looks interesting — can we set up a quick call this week?",
    "Thanks for reaching out, I'd like to learn more. Let's schedule some time.",
    "Sounds good, I'm interested. What are your available times?",
  ],
  not_interested: [
    "Thanks, but we're not interested at this time.",
    "No thanks, please don't follow up again on this.",
    "We'll pass on this for now, but appreciate the note.",
  ],
  out_of_office: [
    "I am currently out of office with limited access to email. I will respond when I return.",
    "Auto-reply: I'm on vacation (OOO) until next week and will reply after I'm back.",
    "Thank you for your email. I am out of the office and will reply to your message when I return.",
  ],
};

/** Deterministic reply body text for a given ground-truth classification (used by the simulator). */
export function mockReplyBody(classification: ReplyClassification, seedIndex: number): string {
  const options = REPLY_BODY_TEMPLATES[classification];
  return options[seedIndex % options.length];
}

function keywordClassify(text: string): ReplyClassification {
  const lower = text.toLowerCase();
  if (lower.includes("out of office") || lower.includes("ooo") || lower.includes("vacation")) {
    return "out_of_office";
  }
  if (
    lower.includes("not interested") ||
    lower.includes("no thanks") ||
    lower.includes("pass on this") ||
    lower.includes("don't follow up")
  ) {
    return "not_interested";
  }
  return "interested";
}

export interface ClassifyOutcome {
  classification: ReplyClassification;
  source: "ai" | "fallback";
}

/**
 * Classifies a batch of reply texts in a single OpenRouter call (keeps calls
 * O(batch) not O(replies)), falling back to a fast keyword classifier per-item
 * for any text the model call fails on or returns unparsable output for.
 */
export async function classifyReplyBatch(texts: string[]): Promise<ClassifyOutcome[]> {
  if (texts.length === 0) return [];

  const prompt = `Classify each numbered customer email reply below into exactly one label: "interested", "not_interested", or "out_of_office".
Respond with strict JSON only, an array of labels in the same order, e.g. ["interested","not_interested"].

${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;

  const result = await chatCompletion(OPENROUTER_CLASSIFIER_MODEL, [
    { role: "system", content: "You classify email replies. Respond with a JSON array of labels only." },
    { role: "user", content: prompt },
  ]);

  if (result.ok && result.content) {
    try {
      const match = result.content.match(/\[[\s\S]*\]/);
      const labels = JSON.parse(match ? match[0] : result.content) as unknown[];
      if (Array.isArray(labels) && labels.length === texts.length) {
        const valid = new Set(["interested", "not_interested", "out_of_office"]);
        if (labels.every((l) => typeof l === "string" && valid.has(l))) {
          return (labels as ReplyClassification[]).map((c) => ({ classification: c, source: "ai" as const }));
        }
      }
    } catch {
      // fall through to fallback classifier below
    }
  }

  return texts.map((t) => ({ classification: keywordClassify(t), source: "fallback" as const }));
}
