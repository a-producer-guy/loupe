// Reads what the DIT dropped: whole card folders, keeping their structure.
// Uppy's own folder reader stops reading a folder at the first file it can't
// open and keeps going as if the folder were complete. For "safe to wipe" that
// isn't good enough, so this one notes every unreadable file or folder.

import { isHiddenName, isHiddenPath } from "@/lib/footage/names";

export type PickedFile = { file: File; path: string };

/** One top-level item: a card folder, or name "" for loose files. */
export type PickedGroup = { name: string; files: PickedFile[]; unreadable: string[] };

/**
 * Must be called during the drop event itself: the browser forgets the
 * dropped items as soon as the event handler returns.
 */
export function takeEntries(dataTransfer: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function readEntries(
  entries: FileSystemEntry[],
  onFound?: (count: number) => void,
): Promise<PickedGroup[]> {
  let found = 0;
  const loose: PickedGroup = { name: "", files: [], unreadable: [] };
  const groups: PickedGroup[] = [];

  const addFile = async (entry: FileSystemFileEntry, path: string, group: PickedGroup) => {
    try {
      group.files.push({ file: await fileOf(entry), path });
      onFound?.(++found);
    } catch {
      group.unreadable.push(path);
    }
  };

  const walk = async (dir: FileSystemDirectoryEntry, prefix: string, group: PickedGroup) => {
    let children: FileSystemEntry[];
    try {
      children = await listDirectory(dir);
    } catch {
      group.unreadable.push(prefix || ".");
      return;
    }
    for (const child of children) {
      // Hidden folders (.Spotlight-V100, .Trashes...) are often locked; skip them unread.
      if (isHiddenName(child.name)) continue;
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory) await walk(child as FileSystemDirectoryEntry, path, group);
      else if (child.isFile) await addFile(child as FileSystemFileEntry, path, group);
    }
  };

  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue;
    if (entry.isDirectory) {
      const group: PickedGroup = { name: entry.name, files: [], unreadable: [] };
      await walk(entry as FileSystemDirectoryEntry, "", group);
      groups.push(group);
    } else if (entry.isFile) {
      await addFile(entry as FileSystemFileEntry, entry.name, loose);
    }
  }
  if (loose.files.length || loose.unreadable.length) groups.push(loose);
  return groups;
}

function listDirectory(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries hands back one batch at a time; an empty batch means done.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Files from the "choose a folder" picker, for anyone who clicks instead of dragging. */
export function groupFileList(list: FileList | File[]): PickedGroup[] {
  const groups = new Map<string, PickedGroup>();
  for (const file of Array.from(list)) {
    const relative = file.webkitRelativePath || file.name;
    if (isHiddenPath(relative)) continue;
    const slash = relative.indexOf("/");
    const name = slash > 0 ? relative.slice(0, slash) : "";
    const group = groups.get(name) ?? { name, files: [], unreadable: [] };
    group.files.push({ file, path: slash > 0 ? relative.slice(slash + 1) : relative });
    groups.set(name, group);
  }
  return [...groups.values()];
}
