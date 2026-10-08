import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { changesOf, whatChanged } from "../src/lib/footage/cut-types";

describe("versions, in plain words", () => {
  test("a cut's changes are listed one by one, each with its own key", () => {
    const changes = changesOf({ pace: "tighter", music: "soft piano", extras: { score: true, ambience: true }, picks: [{ line: "I can't.", take: "3" }] }, "BROOKE");
    assert.deepEqual(
      changes.map((c) => c.key),
      ["lead", "pace", "music", "extras.ambience", "pick:I can't."],
    );
    assert.equal(changes[0].label, "Whose scene: Brooke");
    assert.equal(changes[2].label, "Score: “soft piano”");
  });

  test("what one version changed from the one before", () => {
    const before = { direction: { pace: "tighter", extras: { score: true } }, leadRole: null };
    const after = { direction: { pace: "tighter", reactions: "more" }, leadRole: null };
    assert.equal(whatChanged(before, after), "More reactions · No score");
    assert.equal(whatChanged(before, before), null);
  });
});
