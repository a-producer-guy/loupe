// The footage cleanup's dates (Guy, Oct 9: "Loupe footage cleanup rules"): when a scene's camera files are warned
// about and taken away, and that nobody loses footage without a week's warning.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DAY, decide, removedEmail, warningEmail, type SceneFacts } from "../src/cleanup.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const day = (d: Date) => d.toISOString().slice(0, 10);
const scene = (s: Partial<SceneFacts>): SceneFacts => ({ unlockedAt: null, plan: "indie", lastActivity: ago(0), keepFootage: false, busy: false, warnedAt: null, warned3At: null, ...s });

describe("footage cleanup dates", () => {
  test("never exported: kept 14 days after the last activity, warned at 7 and 3 days before, then taken away", () => {
    assert.deepEqual(decide(scene({ lastActivity: ago(6) }), NOW), { until: new Date(ago(6).getTime() + 14 * DAY), action: null, clearWarnings: false });
    const first = decide(scene({ lastActivity: ago(7) }), NOW);
    assert.equal(first.action, "warn");
    assert.equal(day(first.until), "2026-11-08");
    assert.equal(decide(scene({ lastActivity: ago(10), warnedAt: ago(3) }), NOW).action, null);
    assert.equal(decide(scene({ lastActivity: ago(11), warnedAt: ago(4) }), NOW).action, "warn_3");
    assert.equal(decide(scene({ lastActivity: ago(14), warnedAt: ago(7), warned3At: ago(3) }), NOW).action, "remove");
  });

  test("exported: 30, 60 or 90 days by plan, from the export or anything after it", () => {
    assert.equal(decide(scene({ unlockedAt: ago(22), lastActivity: ago(22) }), NOW).action, null);
    assert.equal(decide(scene({ unlockedAt: ago(23), lastActivity: ago(23) }), NOW).action, "warn");
    assert.equal(decide(scene({ unlockedAt: ago(23), lastActivity: ago(23), plan: "pro" }), NOW).action, null);
    assert.equal(decide(scene({ unlockedAt: ago(53), lastActivity: ago(53), plan: "pro" }), NOW).action, "warn");
    assert.equal(decide(scene({ unlockedAt: ago(83), lastActivity: ago(83), plan: "studio" }), NOW).action, "warn");
    assert.equal(decide(scene({ unlockedAt: ago(83), lastActivity: ago(10), plan: "studio" }), NOW).action, null, "a new final restarts the clock");
  });

  test("a warning sent late moves the date: always 7 days after the first, 3 after the last", () => {
    const late = decide(scene({ lastActivity: ago(40) }), NOW);
    assert.equal(late.action, "warn");
    assert.equal(day(late.until), "2026-11-08");
    assert.equal(decide(scene({ lastActivity: ago(40), warnedAt: ago(5) }), NOW).action, "warn_3");
    assert.equal(decide(scene({ lastActivity: ago(40), warnedAt: ago(6), warned3At: ago(2) }), NOW).action, null, "3 days after the last warning, not before");
    assert.equal(decide(scene({ lastActivity: ago(40), warnedAt: ago(7), warned3At: ago(3) }), NOW).action, "remove");
  });

  test("activity after a warning starts a new round", () => {
    const back = decide(scene({ lastActivity: ago(1), warnedAt: ago(5) }), NOW);
    assert.deepEqual([back.action, back.clearWarnings], [null, true]);
  });

  test("Keep footage, or a scene busy uploading or cutting: never taken away", () => {
    assert.deepEqual(decide(scene({ lastActivity: ago(60), keepFootage: true, warnedAt: ago(7), warned3At: ago(3) }), NOW).action, null);
    assert.equal(decide(scene({ lastActivity: ago(60), keepFootage: true, warnedAt: ago(7) }), NOW).clearWarnings, true);
    assert.equal(decide(scene({ lastActivity: ago(60), busy: true, warnedAt: ago(7), warned3At: ago(3) }), NOW).action, null);
  });

  test("the emails name the scene and the date, and escape what people typed", () => {
    const w = warningEmail({ id: 1001, name: "Ruth <Take 2>" }, new Date("2026-11-08T00:00:00Z"), 7);
    assert.match(w.subject, /kept until November 8/);
    assert.match(w.html, /Ruth &lt;Take 2&gt;/);
    assert.match(w.html, /scenes\/1001\?keep=1/);
    assert.match(warningEmail({ id: 1, name: "S" }, NOW, 3).subject, /^3 days left/);
    assert.match(removedEmail({ id: 1, name: "S" }, NOW).html, /drop the same cards/);
  });
});
