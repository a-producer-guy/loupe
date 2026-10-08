import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { costOf, rec709, upscaleFactor, withoutLinks } from "../src/assembly/topaz.js";
import { finalSize, pieceFilter } from "../src/assembly/final.js";

describe("finals and their 4K versions", () => {
  test("Topaz enlarges HD to fill 4K, and leaves 4K (or nearly) alone", () => {
    assert.equal(upscaleFactor(1920, 1080), 2);
    assert.equal(upscaleFactor(1280, 720), 3);
    assert.equal(upscaleFactor(3840, 2160), 1);
    assert.equal(upscaleFactor(3600, 2025), 1);
    assert.equal(upscaleFactor(1080, 1920), 2);
  });
  test("the price: 8 cents a second, twice above 30 frames a second", () => {
    assert.equal(costOf(111.57, 23.976), 8.93);
    assert.equal(costOf(60, 59.94), 9.6);
  });
  test("Rec. 709 labels only for Rec. 709 (or unlabelled HD) finals; links never shown", () => {
    assert.deepEqual(rec709({ index: 0, height: 1080 }), { full: false });
    assert.equal(rec709({ index: 0, height: 1080, color_transfer: "smpte2084" }), null);
    assert.equal(withoutLinks("can't read https://b2.example/x?sig=1 now"), "can't read (the final's link) now");
  });
  test("the final's size: the takes' own, no wider than UHD, even", () => {
    assert.deepEqual(finalSize([{ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]), { width: 1920, height: 1080 });
    assert.deepEqual(finalSize([{ width: 6144, height: 3240 }]), { width: 3840, height: 2024 });
    assert.deepEqual(finalSize([]), { width: 1920, height: 1080 });
  });
  test("each shot: to size, its look, then its move and the fades at the ends", () => {
    const f = pieceFilter({ width: 1920, height: 1080, frames: 48, luts: ["/tmp/w/lut-1.cube"], push: { piece: 0, scale: 1.08 }, handheld: false, piece: 0, fadeIn: true, fadeOut: false });
    assert.ok(f.startsWith("fps=24000/1001,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080"));
    assert.ok(f.includes("lut3d=file='/tmp/w/lut-1.cube'") && f.includes("1+0.0800*t/") && f.includes("fade=t=in:st=0:d=1"));
    assert.ok(!pieceFilter({ width: 1920, height: 1080, frames: 48, luts: ["/tmp/x;rm.cube"], push: undefined, handheld: false, piece: 1, fadeIn: false, fadeOut: false }).includes("lut3d"));
  });
});
