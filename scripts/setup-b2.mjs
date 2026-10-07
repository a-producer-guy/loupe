#!/usr/bin/env node
// One-time Backblaze B2 setup for Loupe.
//
//   node scripts/setup-b2.mjs                 (first time)
//   node scripts/setup-b2.mjs --bucket-only   (just re-apply the bucket settings)
//
// Asks for your B2 Master Application Key (typed in, never saved), then:
//   1. creates the private "loupe-footage" bucket, or reuses it if it exists
//   2. sets it to keep every version of every file, and to clear out abandoned
//      half-finished uploads after 7 days
//   3. lets Loupe's pages upload straight to it (CORS)
//   4. makes two restricted keys that can read and write this bucket only and
//      cannot permanently delete anything: one for the app, one for the proxy
//      worker (skipped with --bucket-only)
//   5. writes them into app/.env.local and worker/.env
// Safe to run again; without --bucket-only it makes fresh keys each time.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, writeEnv } from "./prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = process.env.B2_BUCKET || "loupe-footage";
// The live site, and this Mac (the app runs on port 3210 locally; 3000 and 3001 are often taken).
const ORIGINS = ["https://editloupe.com", "https://www.editloupe.com", "http://localhost:3210"];
const KEY_CAPABILITIES = ["listBuckets", "listFiles", "readFiles", "writeFiles"]; // no deleteFiles

const CORS_RULES = [
  {
    corsRuleName: "loupeUploads",
    allowedOrigins: ORIGINS,
    allowedOperations: ["s3_put", "s3_post", "s3_get", "s3_head"],
    allowedHeaders: ["*"],
    exposeHeaders: ["ETag"],
    maxAgeSeconds: 3600,
  },
];

// Keep every version. A key that can write can also "hide" a file (that's what
// a delete through the S3 API does in B2), so hidden and replaced versions must
// never be cleared automatically: that would let a buggy or leaked key delete
// footage a day later. Only abandoned, unfinished uploads are cleared.
const LIFECYCLE = {
  fileNamePrefix: "",
  daysFromHidingToDeleting: null,
  daysFromUploadingToHiding: null,
  daysFromStartingToCancelingUnfinishedLargeFiles: 7,
};

async function b2(apiUrl, token, call, body) {
  const response = await fetch(`${apiUrl}/b2api/v2/${call}`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${call} failed: ${data.message || response.statusText} (${data.code || response.status})`);
    error.code = data.code;
    throw error;
  }
  return data;
}

async function main() {
  const bucketOnly = process.argv.includes("--bucket-only");
  console.log(`\nLoupe: Backblaze B2 setup${bucketOnly ? " (bucket settings only)" : ""}\n`);
  console.log("Paste your B2 Master Application Key. It's used for this setup only and never saved.\n");
  const keyId = await ask("  keyID: ");
  const appKey = await ask("  applicationKey (hidden): ", { hidden: true });
  if (!keyId || !appKey) throw new Error("Both the keyID and the applicationKey are needed.");

  const auth = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString("base64")}` },
  });
  const account = await auth.json().catch(() => ({}));
  if (!auth.ok) throw new Error(`Backblaze didn't accept that key: ${account.message || auth.statusText}`);
  const caps = account.allowed?.capabilities ?? [];
  if (!caps.includes("writeKeys") || !caps.includes("writeBuckets")) {
    throw new Error("That key can't create buckets and keys. Use the Master Application Key (App Keys page in Backblaze).");
  }
  const { accountId, apiUrl, authorizationToken: token, s3ApiUrl } = account;
  const region = new URL(s3ApiUrl).hostname.split(".")[1]; // s3.us-east-005.backblazeb2.com → us-east-005

  // If B2 won't take the abandoned-uploads rule, fall back to no rules at all:
  // still "keep every version", just without the tidy-up.
  const withLifecycle = async (call, body) => {
    try {
      return await b2(apiUrl, token, call, { ...body, lifecycleRules: [LIFECYCLE] });
    } catch (error) {
      if (!/lifecycle|daysFromStarting/i.test(error.message)) throw error;
      return b2(apiUrl, token, call, { ...body, lifecycleRules: [] });
    }
  };

  const { buckets } = await b2(apiUrl, token, "b2_list_buckets", { accountId, bucketName: BUCKET });
  let bucket = buckets[0];
  if (!bucket && bucketOnly) throw new Error(`There's no bucket called "${BUCKET}" yet. Run this without --bucket-only first.`);
  if (!bucket) {
    bucket = await withLifecycle("b2_create_bucket", {
      accountId,
      bucketName: BUCKET,
      bucketType: "allPrivate",
      corsRules: CORS_RULES,
      defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
    });
    console.log(`\n✓ Created the private bucket "${BUCKET}".`);
  } else {
    if (bucket.bucketType !== "allPrivate") {
      throw new Error(`The bucket "${BUCKET}" is public. Make it private in Backblaze first, then run this again.`);
    }
    if (bucket.fileLockConfiguration?.value?.isFileLockEnabled) {
      console.log(`\n! Object Lock is on for "${BUCKET}", so deleted projects wouldn't free space. It can only be turned off by Backblaze support.`);
    }
    bucket = await withLifecycle("b2_update_bucket", { accountId, bucketId: bucket.bucketId, corsRules: CORS_RULES });
    console.log(`\n✓ Found the bucket "${BUCKET}" and updated its settings.`);
  }
  const rules = bucket.lifecycleRules ?? [];
  if (rules.some((rule) => rule.daysFromHidingToDeleting != null || rule.daysFromUploadingToHiding != null)) {
    throw new Error("The bucket still has a rule that clears old versions. Tell Claude before using it.");
  }
  console.log(
    rules.length
      ? "✓ Keeps every version: a hidden or replaced file can always be brought back. Abandoned uploads are cleared after 7 days."
      : "✓ Keeps every version: a hidden or replaced file can always be brought back.",
  );
  console.log(`✓ Uploads allowed from ${ORIGINS.join(" and ")}.`);
  if (bucketOnly) {
    console.log("\nBucket settings updated; the app's and worker's keys are unchanged.\nAll done.\n");
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const makeKey = (keyName) =>
    b2(apiUrl, token, "b2_create_key", { accountId, keyName, bucketId: bucket.bucketId, capabilities: KEY_CAPABILITIES });
  const appKeyInfo = await makeKey(`loupe-app-${stamp}`);
  const workerKeyInfo = await makeKey(`loupe-worker-${stamp}`);
  console.log("✓ Made two keys for this bucket only, with no permission to permanently delete (app and worker).");

  const shared = { B2_ENDPOINT: s3ApiUrl, B2_REGION: region, B2_BUCKET: BUCKET };
  writeEnv(path.join(ROOT, "app/.env.local"), { ...shared, B2_KEY_ID: appKeyInfo.applicationKeyId, B2_APP_KEY: appKeyInfo.applicationKey });
  writeEnv(path.join(ROOT, "worker/.env"), { ...shared, B2_KEY_ID: workerKeyInfo.applicationKeyId, B2_APP_KEY: workerKeyInfo.applicationKey });
  console.log("✓ Saved them into app/.env.local and worker/.env (both are kept out of git).\n");
  console.log(`Bucket: ${BUCKET}   Region: ${region}\nAll done.\n`);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
});
