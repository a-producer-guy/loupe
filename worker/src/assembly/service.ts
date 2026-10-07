// First assemblies on their own, without the Dropbox mover:
//
//   node dist/assembly/service.js
//
// The mover service runs the same loop alongside its moving; this is for
// running it anywhere else (a test against a throwaway database, or its own
// service later). Needs the worker's DATABASE_URL and B2 key, and FAL_KEY.

import { randomUUID } from "node:crypto";
import os from "node:os";
import { loadConfig } from "../config.js";
import { FalClient } from "../ai/fal.js";
import { connect } from "../jobs.js";
import { createStorage } from "../storage.js";
import { runAssemblyLoop } from "./job.js";

const config = loadConfig();
const key = process.env.FAL_KEY?.trim();
if (!key) throw new Error("FAL_KEY is not set.");
const sql = connect(config.databaseUrl);
const stop = new AbortController();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stop.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop.abort());

await runAssemblyLoop({
  sql,
  storage: createStorage(config.b2),
  fal: new FalClient(key),
  tools: config.tools,
  workDir: config.workDir,
  workerId: `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  signal: stop.signal,
  log,
  sleep,
});
await sql.end({ timeout: 10 });
