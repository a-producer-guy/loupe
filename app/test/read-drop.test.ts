import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFileList, readEntries } from "../src/lib/upload/read-drop";

// Stand-ins for the browser's dropped-folder objects (FileSystemEntry).
type Entry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (ok: (file: File) => void, fail: (error: Error) => void) => void;
  createReader?: () => { readEntries: (ok: (batch: Entry[]) => void, fail: (error: Error) => void) => void };
};

const file = (name: string, size = 10, unreadable = false): Entry => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (ok, fail) => (unreadable ? fail(new Error("NotReadableError")) : ok(new File([new Uint8Array(size)], name))),
});

const folder = (name: string, children: Entry[], unreadable = false): Entry => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    // Browsers hand directory contents over in batches; mimic two of them.
    const batches = [children.slice(0, 2), children.slice(2)].filter((b) => b.length > 0);
    let next = 0;
    return { readEntries: (ok, fail) => (unreadable ? fail(new Error("denied")) : ok(batches[next++] ?? [])) };
  },
});

test("a dropped card keeps its folders, skips hidden files and reports anything unreadable", async () => {
  const card = folder("A001", [
    file(".DS_Store"),
    folder(".Spotlight-V100", [], true), // hidden and locked: skipped without complaint
    folder("PRIVATE", [
      folder("M4ROOT", [
        folder("CLIP", [file("C0001.MP4", 100), file("C0002.MP4", 100, true), file("._C0001.MP4")]),
        folder("THMBNL", [], true),
      ]),
    ]),
    file("MEDIAPRO.XML", 5),
  ]);
  const found: number[] = [];
  const groups = await readEntries([card, file("notes.txt", 3)] as never, (n) => found.push(n));

  assert.deepEqual(
    groups.map((g) => [g.name, g.files.map((f) => f.path), g.unreadable]),
    [
      ["A001", ["PRIVATE/M4ROOT/CLIP/C0001.MP4", "MEDIAPRO.XML"], ["PRIVATE/M4ROOT/CLIP/C0002.MP4", "PRIVATE/M4ROOT/THMBNL"]],
      ["", ["notes.txt"], []],
    ],
  );
  assert.deepEqual(found, [1, 2, 3]);
});

test("a card that can't be opened at all is reported, not treated as empty", async () => {
  const [group] = await readEntries([folder("Untitled", [], true)] as never);
  assert.deepEqual(group.unreadable, ["."]);
});

test("files from the folder picker are grouped by their top folder", () => {
  const picked = (relative: string) => {
    const f = new File([new Uint8Array(4)], relative.split("/").pop()!);
    Object.defineProperty(f, "webkitRelativePath", { value: relative });
    return f;
  };
  const groups = groupFileList([
    picked("A001/CLIP/C0001.MP4"),
    picked("A001/.DS_Store"),
    picked("A002/C0001.MP4"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.files.map((f) => f.path)]),
    [
      ["A001", ["CLIP/C0001.MP4"]],
      ["A002", ["C0001.MP4"]],
    ],
  );
});
