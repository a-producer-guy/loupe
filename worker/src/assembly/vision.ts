// Who each take is on, read from the picture: one strip per take (five frames
// from across it) goes to the same vision model as the posters (on fal), which
// says which actor the shot is about and how close it is, or that it's an
// insert (a phone, hands).
// Sound alone can't always tell: on some shoots the mic only favours one of
// the actors (shoot 1033, Oct 1).

import { readFile } from "node:fs/promises";
import { dataUri, type FalClient } from "../ai/fal.js";

export const VISION_ENDPOINT = "openrouter/router/vision";
export const VISION_MODEL = "anthropic/claude-sonnet-5.5";

export type Seen = { who: "A" | "B" | "insert" | null; framing: "wide" | "medium" | "close" | null };

export function coveragePrompt(labels: string[]): string {
  return [
    `These are the takes of one dialogue scene, filmed with one camera. Each image is one take: five frames from across it, left to right in time order. In this order: ${labels.join(", ")}.`,
    'Two actors play the scene. Call the actor who is the subject of the first take "A" and the other actor "B" (tell them apart by face, hair, clothes and build).',
    "For each take, say who the shot is on and how close it is:",
    '- who: "A" or "B": the actor the camera is on for most of the take, facing it and in focus. In an over-the-shoulder shot it is the actor facing the camera, not the head or shoulder in the foreground; if a handheld camera swings to the other actor for a moment, go by most of the frames. "insert" when no actor\'s face is the subject (an object, hands, a phone), or "unclear".',
    '- framing: "wide" (most of the room, full figure), "medium" (about waist up), or "close" (chest up or tighter, including tight over-the-shoulder shots).',
    `Answer with JSON only, one entry per take, like {"${labels[0]}": {"who": "A", "framing": "medium"}}.`,
  ].join("\n");
}

export function parseCoverage(output: string, labels: string[]): Record<string, Seen> | null {
  const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const answers = ("takes" in parsed && typeof (parsed as { takes: unknown }).takes === "object" ? (parsed as { takes: object }).takes : parsed) as Record<string, unknown>;
  const out: Record<string, Seen> = {};
  for (const label of labels) {
    const raw = answers[label] as { who?: unknown; framing?: unknown } | undefined;
    const who = typeof raw?.who === "string" ? raw.who.trim().toUpperCase() : "";
    const framing = typeof raw?.framing === "string" ? raw.framing.trim().toLowerCase() : "";
    out[label] = {
      who: who === "A" || who === "B" ? who : who === "INSERT" ? "insert" : null,
      framing: framing === "wide" || framing === "medium" || framing === "close" ? framing : null,
    };
  }
  // At least one take of each actor, or the answer can't be right for a two-hander.
  const whos = Object.values(out).map((s) => s.who);
  return whos.includes("A") && whos.includes("B") ? out : null;
}

/** Asks the vision model about every take; null when it can't say (the sound decides then). */
export async function lookAtTakes(fal: FalClient, stills: { label: string; file: string }[], signal?: AbortSignal): Promise<Record<string, Seen> | null> {
  if (stills.length < 2) return null;
  const labels = stills.map((s) => s.label);
  const answer = await fal.run<{ output?: string }>(
    VISION_ENDPOINT,
    {
      model: VISION_MODEL,
      system_prompt: "You are an assistant editor logging the coverage of a single-camera dialogue scene. You answer with JSON only.",
      prompt: coveragePrompt(labels),
      image_urls: await Promise.all(stills.map(async (s) => dataUri(await readFile(s.file), "image/jpeg"))),
      // Claude Sonnet 5.5 on fal only answers with its reasoning on (fal answers 400 otherwise).
      reasoning: true,
      max_tokens: 4000,
    },
    { signal },
  );
  return parseCoverage(answer.output ?? "", labels);
}
