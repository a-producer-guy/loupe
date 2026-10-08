import type { TakeSetup } from "@/lib/db/schema";

// The shapes of a scene's cut, shared by the server (cuts.ts) and the cutting room in the browser (no database here).

/** The steps the worker reports, in order, in Loupe's words. */
export const CUT_STEPS = [
  { key: "listening", label: "Watching every take" },
  { key: "script", label: "Lining the takes up with the script" },
  { key: "cutting", label: "Choosing the best performances" },
  { key: "dialogue", label: "Cleaning the dialogue" },
  { key: "music", label: "Adding the extras you asked for" },
  { key: "mixing", label: "Mixing the sound" },
  { key: "packing", label: "Building the Premiere timeline" },
] as const;

export const CUT_FOLDER = "Loupe Cut";

export type Shot = {
  n: number;
  at: number;
  seconds: number;
  take: string;
  who: string;
  framing: "medium" | "close";
  kind: "shot" | "reaction" | "establishing";
  pushIn?: number;
  snap?: boolean;
  line: string;
  speaker: string;
  listening: boolean;
  why: string;
  alternates: string[];
  cut: "straight" | "J" | "L" | null;
};

/** One line in one take: where it's said in the take's preview (seconds), how much of it (0-1), the words heard. */
export type LineInTake = { s: number; e: number; match: number; said: string };

export type CutResult = {
  title: string;
  fromTakes: boolean;
  scriptId: number | null;
  scriptTitle: string | null;
  match: number;
  /** The lead (whose scene it is), and the other actor. */
  client: string;
  partner: string;
  roles: string[];
  seconds: number;
  shots: Shot[];
  counts: { shots: number; reactions: number; splits: number; lines: number; pushIns?: number; snaps?: number };
  establishing?: boolean;
  extras?: { establishing: boolean; ambience: boolean; score: boolean };
  tone?: string;
  camera?: "handheld" | "steady";
  takes: { take: string; path: string; found: TakeSetup | "insert" | null; setup: TakeSetup | null; used: boolean }[];
  lines: { who: string; text: string }[];
  /** Subtitles as heard: each line's words and when they're heard in the preview (cuts made from Oct 7 evening on). */
  subs?: { line: number; s: number; e: number; words: { t: string; s: number }[] }[];
  /** Every line in every take ("Other takes"): per take, its score and each line, in `lines` order (null: not in it). */
  lineTakes?: Record<string, { q: number | null; why: string[]; complete: number | null; performance: number | null; lines: (LineInTake | null)[] }>;
  dropped: string[];
  jumps: number[];
  heard: number | null;
  place: string;
  lut: string | null;
  look?: { note: string; said: string; grade: Record<string, unknown> } | null;
  performances?: Record<string, string>;
  /** How to build this version again from the camera originals (versions from Oct 8 on): the final file needs it. */
  render?: { seconds: number };
  preview: { path: string; size: number };
  files: { path: string; size: number }[];
};

/** A final file of a version: from the camera originals, or made 4K with Topaz. */
export type FinalView = {
  id: number;
  cutId: number;
  kind: "original" | "topaz";
  status: "waiting" | "working" | "done" | "failed";
  progress: number | null;
  error: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  /** A link that saves the file, once it's done. */
  download: string | null;
};

export type LoupeNote = { note: string; reply: string | null; at: string };

/** The director's notes to Loupe and what they set (worker/src/assembly/direction.ts). */
export type Direction = {
  notes?: LoupeNote[];
  look?: string | null;
  music?: string | null;
  picks?: { line: string; take: string }[];
  reactions?: "more" | "fewer" | null;
  pace?: "tighter" | "looser" | null;
  clean?: "isolate" | "standard" | null;
  extras?: { establishing?: boolean; ambience?: boolean; score?: boolean };
  /** A request made while Loupe was busy: its notes are read against the version made before it. */
  queued?: boolean;
};

export type CutView = {
  id: number;
  status: "waiting" | "working" | "done" | "failed";
  step: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  scriptId: number | null;
  leadRole: string | null;
  coverage: Record<string, TakeSetup | null> | null;
  direction: Direction | null;
  result: CutResult | null;
};

export type CutState = {
  latest: CutView | null;
  done: CutView | null;
  /** The version being made, and the one waiting behind it (a queued request). */
  working: CutView | null;
  waiting: CutView | null;
  versions: number;
  /** A link to the finished version's preview, for the player. */
  preview: string | null;
  steps: readonly { key: string; label: string }[];
  ready: number;
  script: { id: number; title: string; roles: string[] } | null;
};

/** What the cutting room gets from GET /api/shoots/[id]/cut. */
export type RoomCut = CutState & {
  /** Each take's still and playable preview, by take label, for the filmstrip and Other takes. */
  takes: Record<string, { still: string | null; preview: string | null; seconds: number | null }>;
  heading: string | null;
};
