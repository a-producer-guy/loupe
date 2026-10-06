import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asScene, cleanName } from "../src/lib/upload/scene-drop";
import type { PickedGroup } from "../src/lib/upload/read-drop";

const file = (name: string) => new File(["x"], name);
const group = (name: string, paths: string[], unreadable: string[] = []): PickedGroup => ({
  name,
  files: paths.map((path) => ({ file: file(path.split("/").pop()!), path })),
  unreadable,
});
const shape = (groups: PickedGroup[]) => groups.map((g) => [g.name, g.files.map((f) => f.path), g.unreadable]);

describe("dropping a scene", () => {
  test("the shoot folder names the scene, and the folders inside it are the cards", () => {
    const dropped = [
      group("Scene 4 - The Offer", [
        "B001/CLIP/C0001.MP4",
        "A001/CLIP/C0001.MP4",
        "A001/CLIP/C0002.MP4",
        "SOUND/SC04_T01.WAV",
        "The Offer.fdx",
      ], ["A001/CLIP/C0003.MP4"]),
    ];
    const scene = asScene(dropped, "2026-10-06");
    assert.equal(scene.name, "Scene 4 - The Offer");
    assert.deepEqual(shape(scene.groups), [
      ["A001", ["CLIP/C0001.MP4", "CLIP/C0002.MP4"], ["CLIP/C0003.MP4"]],
      ["B001", ["CLIP/C0001.MP4"], []],
      ["SOUND", ["SC04_T01.WAV"], []],
      ["", ["The Offer.fdx"], []],
    ]);
  });

  test("card folders dropped straight in stay as they are, in a scene with a dated name", () => {
    const dropped = [group("A001", ["CLIP/C0001.MP4"]), group("B001", ["CLIP/C0001.MP4"])];
    const scene = asScene(dropped, "2026-10-06");
    assert.equal(scene.name, "Scene from Oct 6");
    assert.deepEqual(scene.groups, dropped);
  });

  test("one card dropped on its own isn't mistaken for a scene folder", () => {
    const dropped = [group("A001", ["C0001.MP4", "C0002.MP4"])];
    const scene = asScene(dropped, "2026-10-06");
    assert.equal(scene.name, "Scene from Oct 6");
    assert.deepEqual(scene.groups, dropped);
  });

  test("folder names are tidied, not rewritten", () => {
    assert.equal(cleanName("2026-10-05_Scene_04__The-Offer"), "2026-10-05 Scene 04 The-Offer");
    assert.equal(cleanName("  Night   Shift  "), "Night Shift");
  });
});
