import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// What the paid AI calls answered, kept between versions of a scene (Guy, Oct 9: cutting is free for customers, so
// it has to be cheap for Loupe). A note changes the cut, not the takes: how each take is performed, what each take
// shows and each take's voice isolated stay the same, so they're asked for once per scene and reused, as long as
// what was sent is exactly the same (the name is a fingerprint of it).

/** Files kept beside the scene (in its "Loupe work" folder), by name. */
export type WorkCache = {
  get(name: string, file: string): Promise<boolean>;
  put(name: string, file: string, contentType: string): Promise<void>;
};

/** A short fingerprint of everything that was sent. */
export function fingerprint(...parts: (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 32);
}

/** A file kept under `name`, fetched into `file`; false when there isn't one (or it can't be read: then it's asked again). */
export async function fetchKept(cache: WorkCache | undefined, name: string, file: string): Promise<boolean> {
  if (!cache) return false;
  return cache.get(name, file).catch(() => false);
}

/** Keeps a file; never fails the cut (the next version just asks again). */
export async function keep(cache: WorkCache | undefined, name: string, file: string, contentType: string): Promise<void> {
  await cache?.put(name, file, contentType).catch(() => {});
}

/** An answer kept as JSON: reused if there is one, otherwise asked for and kept when `worth` says it's a real answer. */
export async function remembered<T>(cache: WorkCache | undefined, dir: string, name: string, ask: () => Promise<T>, worth: (value: T) => boolean): Promise<T> {
  const file = path.join(dir, `kept-${name}`);
  if (await fetchKept(cache, name, file)) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
      // Unreadable: asked again below.
    }
  }
  const value = await ask();
  if (cache && worth(value)) {
    await writeFile(file, JSON.stringify(value));
    await keep(cache, name, file, "application/json");
  }
  return value;
}
