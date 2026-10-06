// Footage tables. They live in the Reelarc backend's Supabase database, so
// every table is prefixed footage_ and nothing here touches the backend's own
// tables. The app and the proxy worker connect as the footage_app role, which
// can only reach these tables (see db/migrations).

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

// Everything the app and worker may do with a footage table, and nothing else.
const footageAppAccess = () =>
  pgPolicy("footage_app_all", { for: "all", to: "footage_app", using: sql`true`, withCheck: sql`true` });

export const MEMBER_ROLES = ["admin", "editor", "social"] as const;

/** Who may sign in to the footage app. Phase 1 only has admins. */
export const members = pgTable(
  "footage_members",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    email: text("email").notNull().unique(),
    role: text("role", { enum: MEMBER_ROLES }).notNull().default("admin"),
    createdAt: createdAt(),
  },
  (t) => [
    check("footage_members_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check("footage_members_role_valid", sql`${t.role} in ('admin', 'editor', 'social')`),
    footageAppAccess(),
  ],
).enableRLS();

/**
 * Wrong sign-in codes per email, so a 6-digit code can't be guessed: after 5 wrong ones in 15
 * minutes, that email has to wait. The count starts again with the first wrong code after that.
 */
export const signInAttempts = pgTable(
  "footage_sign_in_attempts",
  {
    email: text("email").primaryKey(),
    failures: integer("failures").notNull().default(0),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [footageAppAccess()],
).enableRLS();

/**
 * The team's LUTs (.cube files), kept in B2 under LUTs/. A shoot and, where a
 * card came from another camera, a card point at one; the proxy worker bakes
 * it into that footage's proxies.
 */
export const luts = pgTable(
  "footage_luts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // Points along each side of the 3D cube (17, 33, 65...), checked on upload.
    cubeSize: integer("cube_size").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  () => [footageAppAccess()],
).enableRLS();

export const PROJECT_STATUSES = ["scheduled", "uploading", "uploaded", "delivered", "purged"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** One shoot. The id is part of its B2 folder name (2026-09-23_jane-doe_p1042). */
export const projects = pgTable(
  "footage_projects",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ startWith: 1001 }),
    name: text("name").notNull(),
    shootDate: date("shoot_date", { mode: "string" }).notNull(),
    // Fixed when the shoot is created, so renaming a shoot never moves files.
    storagePrefix: text("storage_prefix").notNull().unique(),
    status: text("status", { enum: PROJECT_STATUSES }).notNull().default("scheduled"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    // The LUT the shoot was filmed with, for every card unless a card says otherwise.
    lutId: bigint("lut_id", { mode: "number" }).references(() => luts.id),
    // The DP (director of photography) who shot it. Typed in, not a login: DPs don't sign in.
    dpName: text("dp_name"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "footage_projects_status_valid",
      sql`${t.status} in ('scheduled', 'uploading', 'uploaded', 'delivered', 'purged')`,
    ),
    index("footage_projects_shoot_date_idx").on(t.shootDate),
    footageAppAccess(),
  ],
).enableRLS();

export const FILE_STATUSES = ["pending", "uploading", "uploaded", "unreadable"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * Every file in a shoot's folder. Phase 1 only has raw footage (path starts
 * with "Raw/"). A file only counts as safe once its size in B2 was checked.
 */
export const files = pgTable(
  "footage_files",
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
    uniqueIndex("footage_files_project_path_idx").on(t.projectId, t.path),
    index("footage_files_project_card_idx").on(t.projectId, t.card),
    check("footage_files_status_valid", sql`${t.status} in ('pending', 'uploading', 'uploaded', 'unreadable')`),
    check("footage_files_size_valid", sql`${t.sizeBytes} >= 0`),
    footageAppAccess(),
  ],
).enableRLS();

/**
 * A card filmed with a different LUT from the rest of its shoot (another
 * camera). A null lutId means that card has no LUT at all.
 */
export const cardLuts = pgTable(
  "footage_card_luts",
  {
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id),
    card: text("card").notNull(),
    lutId: bigint("lut_id", { mode: "number" }).references(() => luts.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.card] }), footageAppAccess()],
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
  "footage_proxy_jobs",
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
    index("footage_proxy_jobs_queue_idx").on(t.status, t.runAfter),
    index("footage_proxy_jobs_project_idx").on(t.projectId),
    check(
      "footage_proxy_jobs_status_valid",
      sql`${t.status} in ('queued', 'running', 'done', 'failed', 'skipped')`,
    ),
    footageAppAccess(),
  ],
).enableRLS();
