// Loupe's tables, in Loupe's own Supabase project. Every table is prefixed loupe_.
// The app and the proxy worker connect as the loupe_app role, which can only
// reach these tables (see db/migrations).
//
// Loupe has many customers, so everything a customer owns hangs off an account:
// its people (members), its scenes (projects) and its LUTs. Every page and API
// route checks that what it touches belongs to the signed-in member's account.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Everything the app and worker may do with a Loupe table, and nothing else.
const appAccess = () =>
  pgPolicy("loupe_app_all", { for: "all", to: "loupe_app", using: sql`true`, withCheck: sql`true` });

export const PLANS = ["free", "indie", "pro", "studio"] as const;
export type Plan = (typeof PLANS)[number];

/** A customer: one filmmaker, editor or studio. Created the first time someone signs in. */
export const accounts = pgTable(
  "loupe_accounts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    plan: text("plan", { enum: PLANS }).notNull().default("free"),
    // Stripe: the account's customer, and its Pro or Studio subscription (kept in step by Stripe's webhook).
    stripeCustomerId: text("stripe_customer_id").unique(),
    subscriptionId: text("subscription_id"),
    subscriptionStatus: text("subscription_status"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [check("loupe_accounts_plan_valid", sql`${t.plan} in ('free', 'indie', 'pro', 'studio')`), appAccess()],
).enableRLS();

export const MEMBER_ROLES = ["owner", "editor", "director", "viewer"] as const;

/** A person who can sign in, and the account they belong to. One account per email. */
export const members = pgTable(
  "loupe_members",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    email: text("email").notNull().unique(),
    role: text("role", { enum: MEMBER_ROLES }).notNull().default("owner"),
    createdAt: createdAt(),
  },
  (t) => [
    index("loupe_members_account_idx").on(t.accountId),
    check("loupe_members_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check("loupe_members_role_valid", sql`${t.role} in ('owner', 'editor', 'director', 'viewer')`),
    appAccess(),
  ],
).enableRLS();

/**
 * Wrong sign-in codes per email, so a 6-digit code can't be guessed: after 5 wrong ones in 15
 * minutes, that email has to wait. The count starts again with the first wrong code after that.
 */
export const signInAttempts = pgTable(
  "loupe_sign_in_attempts",
  {
    email: text("email").primaryKey(),
    failures: integer("failures").notNull().default(0),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [appAccess()],
).enableRLS();

/**
 * An account's LUTs (.cube files), kept in B2 under LUTs/. A scene and, where a
 * card came from another camera, a card point at one; the proxy worker bakes
 * it into that footage's proxies.
 */
export const luts = pgTable(
  "loupe_luts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // Points along each side of the 3D cube (17, 33, 65...), checked on upload.
    cubeSize: integer("cube_size").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("loupe_luts_account_idx").on(t.accountId), appAccess()],
).enableRLS();

export const PROJECT_STATUSES = ["scheduled", "uploading", "uploaded", "delivered", "purged"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * One scene: the footage of one shoot, its proxies and (from stage 2) its cut. Called a project in
 * the code. The id is part of its B2 folder name (2026-09-23_the-offer_p1042).
 */
export const UNLOCKED_HOW = ["free", "plan", "paid"] as const;

export const projects = pgTable(
  "loupe_projects",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ startWith: 1001 }),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    shootDate: date("shoot_date", { mode: "string" }).notNull(),
    // Fixed when the shoot is created, so renaming a shoot never moves files.
    storagePrefix: text("storage_prefix").notNull().unique(),
    status: text("status", { enum: PROJECT_STATUSES }).notNull().default("scheduled"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    // The LUT the scene was filmed with, for every card unless a card says otherwise.
    lutId: bigint("lut_id", { mode: "number" }).references(() => luts.id),
    // Exporting is what's paid for: when the scene was unlocked, and how (the first free scene, a plan's monthly
    // scenes, or paid for on its own).
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }),
    unlockedHow: text("unlocked_how", { enum: UNLOCKED_HOW }),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    check("loupe_projects_unlocked_how_valid", sql`${t.unlockedHow} in ('free', 'plan', 'paid')`),
    check(
      "loupe_projects_status_valid",
      sql`${t.status} in ('scheduled', 'uploading', 'uploaded', 'delivered', 'purged')`,
    ),
    index("loupe_projects_account_idx").on(t.accountId, t.shootDate),
    appAccess(),
  ],
).enableRLS();

export const FILE_STATUSES = ["pending", "uploading", "uploaded", "unreadable"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * Every file in a shoot's folder. Phase 1 only has raw footage (path starts
 * with "Raw/"). A file only counts as safe once its size in B2 was checked.
 */
export const files = pgTable(
  "loupe_files",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    // Top-level folder as dropped ("A001", or "Untitled 2" when a second card
    // shares a name). Empty for loose files dropped without a folder.
    card: text("card").notNull().default(""),
    // Relative to the shoot's folder, e.g. "Raw/A001/PRIVATE/M4ROOT/CLIP/C0001.MP4".
    path: text("path").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // From the DIT's computer; with size it recognises the same file on a re-drop.
    lastModifiedMs: bigint("last_modified_ms", { mode: "number" }),
    isVideo: boolean("is_video").notNull().default(false),
    status: text("status", { enum: FILE_STATUSES }).notNull().default("pending"),
    // Why an "unreadable" file couldn't be copied, in plain words.
    problem: text("problem"),
    // Multipart upload in progress, so a re-dropped card can resume it.
    uploadId: text("upload_id"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    uploadedBy: text("uploaded_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("loupe_files_project_path_idx").on(t.projectId, t.path),
    index("loupe_files_project_card_idx").on(t.projectId, t.card),
    check("loupe_files_status_valid", sql`${t.status} in ('pending', 'uploading', 'uploaded', 'unreadable')`),
    check("loupe_files_size_valid", sql`${t.sizeBytes} >= 0`),
    appAccess(),
  ],
).enableRLS();

/**
 * A card filmed with a different LUT from the rest of its shoot (another
 * camera). A null lutId means that card has no LUT at all.
 */
export const cardLuts = pgTable(
  "loupe_card_luts",
  {
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    card: text("card").notNull(),
    lutId: bigint("lut_id", { mode: "number" }).references(() => luts.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.card] }), appAccess()],
).enableRLS();

/** Written by the worker (see worker/src/proxy.ts describeMedia). */
export type ClipMedia = {
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: string;
  codec?: string;
  audioTracks: number;
  audioChannels: number;
  timecode?: string;
};

export const JOB_STATUSES = ["queued", "running", "done", "failed", "skipped"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** One proxy to make per raw video clip. The worker claims queued rows. */
export const proxyJobs = pgTable(
  "loupe_proxy_jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    fileId: bigint("file_id", { mode: "number" })
      .notNull()
      .unique()
      .references(() => files.id),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    rawKey: text("raw_key").notNull(),
    proxyKey: text("proxy_key").notNull().unique(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    // One try plus three retries, then "proxy failed".
    maxAttempts: integer("max_attempts").notNull().default(4),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    // Set while a worker holds the job; lockedAt doubles as its heartbeat.
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    progress: real("progress"),
    error: text("error"),
    proxySizeBytes: bigint("proxy_size_bytes", { mode: "number" }),
    // The browser-playable preview (Previews/...mp4) made in the same pass; null if there isn't one.
    previewSizeBytes: bigint("preview_size_bytes", { mode: "number" }),
    // What the worker learned about the clip: length, frame size, frame rate, codec, audio, timecode.
    media: jsonb("media").$type<ClipMedia>(),
    // The LUT this clip's proxy should have (null: none), and the one it was
    // last made with. When they differ, the proxy is being re-made.
    lutId: bigint("lut_id", { mode: "number" }).references(() => luts.id),
    madeWithLutId: bigint("made_with_lut_id", { mode: "number" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("loupe_proxy_jobs_queue_idx").on(t.status, t.runAfter),
    index("loupe_proxy_jobs_project_idx").on(t.projectId),
    check(
      "loupe_proxy_jobs_status_valid",
      sql`${t.status} in ('queued', 'running', 'done', 'failed', 'skipped')`,
    ),
    appAccess(),
  ],
).enableRLS();

// ─── Stage 2: scripts and cuts ────────────────────────────────────────────────
// Loupe cuts a scene's first assembly from its takes (worker/src/assembly, the Autoeditor brought over
// from Reelarc Footage): best take for every line with a reason, clean dialogue, a Premiere timeline,
// and a preview to watch. Notes in plain words make it again.

/** A line of a script: a stage direction, or a speech. */
export type ScriptLine = { kind: "action"; text: string } | { kind: "speech"; who: string; text: string };

/**
 * A scene's script (Final Draft or its PDF), read once into lines. Each account has its own: a script
 * is only ever matched against that account's scenes. One dropped with a scene's folder is tied to it.
 */
export const scripts = pgTable(
  "loupe_scripts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    // The scene it came in with, when it was in the dropped folder.
    projectId: bigint("project_id", { mode: "number" }).references(() => projects.id),
    title: text("title").notNull(),
    // The speaking parts, most lines first: ["ELLIS", "GRAHAM"].
    roles: jsonb("roles").$type<string[]>().notNull(),
    lines: jsonb("lines").$type<ScriptLine[]>().notNull(),
    // The scene heading, like "INT. CORNER OFFICE - DAY".
    heading: text("heading"),
    // The file as added, kept in B2.
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    addedBy: text("added_by"),
    createdAt: createdAt(),
  },
  (t) => [index("loupe_scripts_account_idx").on(t.accountId), index("loupe_scripts_project_idx").on(t.projectId), appAccess()],
).enableRLS();

export const CUT_STATUSES = ["waiting", "working", "done", "failed"] as const;
export type CutStatus = (typeof CUT_STATUSES)[number];

/** What one take frames: who's on camera, and how close. */
export type TakeSetup = { who: string; framing: "medium" | "close" };

/**
 * One version of a scene's cut. The newest row is the scene's cut; a note or "make again" adds a new
 * row (carrying the direction forward), so only one waits or works per scene at a time. The worker
 * fills in `result` (shots and their reasons, and every line in every take for "other takes"); the
 * files go to B2 in the scene's "Loupe Cut" folder.
 */
export const cuts = pgTable(
  "loupe_cuts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    // Corrections for this run. Null: worked out from the takes (the matching script, or the lines said
    // in the takes; the lead from the first take; who's framed how from the picture).
    scriptId: bigint("script_id", { mode: "number" }).references(() => scripts.id),
    leadRole: text("lead_role"),
    coverage: jsonb("coverage").$type<Record<string, TakeSetup | null>>(),
    // The director's notes to Loupe and what they set (the look, a take for a line, tighter cuts,
    // extras like an establishing shot or a score). Carried from one version to the next.
    direction: jsonb("direction").$type<Record<string, unknown>>(),
    status: text("status", { enum: CUT_STATUSES }).notNull().default("waiting"),
    // The step it's on while working, for the scene page.
    step: text("step"),
    attempts: integer("attempts").notNull().default(0),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // Why it failed, in plain words.
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    requestedBy: text("requested_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("loupe_cuts_status_valid", sql`${t.status} in ('waiting', 'working', 'done', 'failed')`),
    index("loupe_cuts_project_idx").on(t.projectId, t.id),
    index("loupe_cuts_queue_idx").on(t.status, t.id),
    // One version being made per scene, and one waiting behind it (Guy, Oct 7: requests queue, nothing is turned away).
    uniqueIndex("loupe_cuts_one_working_idx").on(t.projectId).where(sql`${t.status} = 'working'`),
    uniqueIndex("loupe_cuts_one_waiting_idx").on(t.projectId).where(sql`${t.status} = 'waiting'`),
    appAccess(),
  ],
).enableRLS();

// ─── Sharing and finals (Guy, Oct 7) ──────────────────────────────────────────

/**
 * A scene's share link: a secret address anyone can open to watch the newest cut and leave notes pinned to moments,
 * without being able to change anything. One working link per scene; turned off, it stops working for good.
 */
export const shareLinks = pgTable(
  "loupe_share_links",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    // The secret part of the address: 32 random bytes, base64url. Knowing it is what lets someone watch.
    token: text("token").notNull().unique(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    turnedOffAt: timestamp("turned_off_at", { withTimezone: true }),
    turnedOffBy: text("turned_off_by"),
  },
  (t) => [uniqueIndex("loupe_share_links_one_per_scene_idx").on(t.projectId).where(sql`${t.turnedOffAt} is null`), appAccess()],
).enableRLS();

/**
 * A note left on a share link: who (the name they typed), where in the cut, and what. It goes to the scene's people,
 * never straight to Loupe; one of them can pass it on (sentAt) or put it aside (doneAt).
 */
export const shareNotes = pgTable(
  "loupe_share_notes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    linkId: bigint("link_id", { mode: "number" })
      .notNull()
      .references(() => shareLinks.id),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    // The version they were watching.
    cutId: bigint("cut_id", { mode: "number" }).references(() => cuts.id),
    name: text("name").notNull(),
    // Seconds into that version.
    at: real("at").notNull(),
    note: text("note").notNull(),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (t) => [index("loupe_share_notes_project_idx").on(t.projectId, t.id), index("loupe_share_notes_link_idx").on(t.linkId), appAccess()],
).enableRLS();

export const FINAL_KINDS = ["original", "topaz"] as const;
export type FinalKind = (typeof FINAL_KINDS)[number];

/**
 * A finished file of one version of a cut: rendered from the camera originals at full resolution ("original"), or
 * that made 4K with Topaz on fal ("topaz"). The worker makes it; it goes in the scene's "Loupe Cut/Final" folder.
 */
export const finals = pgTable(
  "loupe_finals",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    cutId: bigint("cut_id", { mode: "number" })
      .notNull()
      .references(() => cuts.id),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    kind: text("kind", { enum: FINAL_KINDS }).notNull(),
    status: text("status", { enum: CUT_STATUSES }).notNull().default("waiting"),
    progress: real("progress"),
    attempts: integer("attempts").notNull().default(0),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    error: text("error"),
    storageKey: text("storage_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    // Topaz on fal: its request, saved the moment it's made so a restarted worker waits for it instead of paying
    // twice, and what it cost, in dollars.
    request: jsonb("request").$type<Record<string, unknown>>(),
    cost: real("cost"),
    requestedBy: text("requested_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("loupe_finals_kind_valid", sql`${t.kind} in ('original', 'topaz')`),
    check("loupe_finals_status_valid", sql`${t.status} in ('waiting', 'working', 'done', 'failed')`),
    index("loupe_finals_cut_idx").on(t.cutId, t.kind),
    index("loupe_finals_queue_idx").on(t.status, t.id),
    uniqueIndex("loupe_finals_one_at_a_time_idx").on(t.cutId, t.kind).where(sql`${t.status} in ('waiting', 'working')`),
    appAccess(),
  ],
).enableRLS();

export const PAYMENT_KINDS = ["scene", "topaz"] as const;
export const PAYMENT_STATUSES = ["pending", "paid", "expired"] as const;

/**
 * Every one-off payment through Stripe Checkout: a scene's export, or a cut made 4K with Topaz. Made "pending" when
 * the payment page opens; "paid" once Stripe says so (its webhook, or the person coming back from the page).
 */
export const payments = pgTable(
  "loupe_payments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    // The version made 4K (Topaz only).
    cutId: bigint("cut_id", { mode: "number" }).references(() => cuts.id),
    kind: text("kind", { enum: PAYMENT_KINDS }).notNull(),
    status: text("status", { enum: PAYMENT_STATUSES }).notNull().default("pending"),
    amountCents: integer("amount_cents").notNull(),
    stripeSessionId: text("stripe_session_id").notNull().unique(),
    stripePaymentIntent: text("stripe_payment_intent"),
    createdBy: text("created_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("loupe_payments_kind_valid", sql`${t.kind} in ('scene', 'topaz')`),
    check("loupe_payments_status_valid", sql`${t.status} in ('pending', 'paid', 'expired')`),
    index("loupe_payments_project_idx").on(t.projectId, t.kind, t.status),
    index("loupe_payments_account_idx").on(t.accountId),
    appAccess(),
  ],
).enableRLS();
