// What a filmmaker drops on "New scene" is usually the whole folder from the shoot: one folder
// named after the scene, with the camera cards, the sound and the script inside. Loupe names the
// scene after that folder and treats the folders inside it as the cards, so the footage keeps the
// structure it was shot with. Dropping the card folders themselves works too.

import type { PickedGroup } from "./read-drop";

export type SceneDrop = { name: string; groups: PickedGroup[] };

/** The scene's name and its cards, from what was dropped. `today` names a scene with nothing better. */
export function asScene(groups: PickedGroup[], today: string): SceneDrop {
  const folders = groups.filter((g) => g.name !== "");
  const loose = groups.find((g) => g.name === "");
  const wrapper = folders.length === 1 && !loose?.files.length ? folders[0] : null;
  const hasSubfolders = wrapper ? wrapper.files.some((f) => f.path.includes("/")) || wrapper.unreadable.some((p) => p.includes("/")) : false;

  if (wrapper && hasSubfolders) {
    const cards = new Map<string, PickedGroup>();
    const card = (name: string) => {
      const group = cards.get(name) ?? { name, files: [], unreadable: [] };
      cards.set(name, group);
      return group;
    };
    for (const file of wrapper.files) {
      const slash = file.path.indexOf("/");
      if (slash > 0) card(file.path.slice(0, slash)).files.push({ file: file.file, path: file.path.slice(slash + 1) });
      else card("").files.push(file);
    }
    for (const path of wrapper.unreadable) {
      const slash = path.indexOf("/");
      if (slash > 0) card(path.slice(0, slash)).unreadable.push(path.slice(slash + 1));
      else card("").unreadable.push(path);
    }
    // Cards first in the order they sort; files loose in the scene folder (the script) last.
    const named = [...cards.values()].filter((g) => g.name !== "").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const rest = cards.get("");
    return { name: cleanName(wrapper.name) || fallbackName(today), groups: rest ? [...named, rest] : named };
  }

  // Card folders dropped straight in (or one card on its own): the scene gets a dated name to rename later.
  return { name: fallbackName(today), groups };
}

/** "2026-10-05_Scene_04__The-Offer" → "2026-10-05 Scene 04 The-Offer": readable, kept close to the folder. */
export function cleanName(folder: string): string {
  return folder.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function fallbackName(today: string): string {
  const date = new Date(`${today}T12:00:00Z`);
  const label = Number.isNaN(date.getTime()) ? today : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Scene from ${label}`;
}
