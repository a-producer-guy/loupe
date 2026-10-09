#!/usr/bin/env node
// The bridge from Footage (footage.reelarc.com) to Loupe: find a Reelarc shoot and download
// what's in it, read-only. Needs BRIDGE_SECRET, the same key Footage has in Vercel.
//
//   node scripts/footage.mjs find <words…>            shoots whose name has every word
//   node scripts/footage.mjs date 2026-10-08          shoots on that day
//   node scripts/footage.mjs shoot <id>               what's in one: files, versions, assembly, script
//   node scripts/footage.mjs get <id> <key> <file>    download one file (key as `shoot` lists it)
//
// FOOTAGE_URL points it somewhere other than https://footage.reelarc.com (a local copy).

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BASE = (process.env.FOOTAGE_URL ?? "https://footage.reelarc.com").replace(/\/$/, "");
const KEY = process.env.BRIDGE_SECRET?.trim();

function stop(message) {
  console.error(message);
  process.exit(1);
}

async function ask(path, init = {}) {
  if (!KEY) stop("BRIDGE_SECRET isn't set. It's the bridge's key, the same one Footage has in Vercel.");
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}` } });
  if (!response.ok && !(response.status >= 300 && response.status < 400)) {
    const body = await response.json().catch(() => ({}));
    stop(`Footage said no (${response.status}): ${body.error ?? response.statusText}`);
  }
  return response;
}

const [command, ...rest] = process.argv.slice(2);

if (command === "find" || command === "date") {
  const query = command === "find" ? `q=${encodeURIComponent(rest.join(" "))}` : `date=${encodeURIComponent(rest[0] ?? "")}`;
  const { shoots } = await (await ask(`/api/bridge/shoots?${query}`)).json();
  for (const s of shoots) console.log(`${s.id}\t${s.shootDate}\t${s.status}\t${s.name}`);
  if (!shoots.length) console.log("No shoots found.");
} else if (command === "shoot") {
  const shoot = await (await ask(`/api/bridge/shoots/${encodeURIComponent(rest[0] ?? "")}`)).json();
  console.log(JSON.stringify(shoot, null, 2));
} else if (command === "get") {
  const [id, key, out] = rest;
  if (!id || !key || !out) stop("Usage: node scripts/footage.mjs get <id> <key> <file>");
  const hop = await ask(`/api/bridge/shoots/${encodeURIComponent(id)}/file?key=${encodeURIComponent(key)}`, { redirect: "manual" });
  const link = hop.headers.get("location");
  if (!link) stop("Footage didn't hand back a download link.");
  // Backblaze's own link: no bridge key goes along to it.
  const file = await fetch(link);
  if (!file.ok || !file.body) stop(`The download didn't start (${file.status}).`);
  await mkdir(dirname(out), { recursive: true });
  await pipeline(Readable.fromWeb(file.body), createWriteStream(out));
  console.log(`Saved ${out}`);
} else {
  stop("Usage: node scripts/footage.mjs find <words…> | date <yyyy-mm-dd> | shoot <id> | get <id> <key> <file>");
}
