import { test } from "node:test";
import assert from "node:assert/strict";
import { labelDecimals, evenTimes, parseMetadata, cutsToScenes, rate, cropFilter, escapeFilterValue, jpegQ, previewArgs, tsShort } from "../dist/lib/frames.js";

test("evenTimes spaces frames inside the range", () => {
  assert.deepEqual(evenTimes(10, 5), [1, 3, 5, 7, 9]);
  assert.deepEqual(evenTimes(10, 2, 4, 8), [5, 7]);
  assert.deepEqual(evenTimes(0, 3), [0]);
});

test("parseMetadata reads metadata=print blocks with offset", () => {
  const out = "frame:0    pts:38400   pts_time:3\nlavfi.scene_score=0.55\nframe:1    pts:76800   pts_time:6\nlavfi.scene_score=0.52\n";
  const m = parseMetadata(out, 10);
  assert.deepEqual(m.map((f) => f.t), [13, 16]);
  assert.equal(m[0].values.scene_score, 0.55);
});

test("cutsToScenes builds scenes and drops flash cuts", () => {
  const s = cutsToScenes([{ t: 3, score: 0.5 }, { t: 3.1, score: 0.6 }, { t: 6, score: 0.4 }], 0, 9, 0.4);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 3], [3, 6], [6, 9]]);
  assert.equal(s[0].cut_score, null);
});

test("frame scoring rejects black, white and flat frames", () => {
  assert.match(rate(1, { "signalstats.YAVG": 10, "signalstats.YLOW": 5, "signalstats.YHIGH": 20, blur: 3 }).rejected, /dark/);
  assert.match(rate(1, { "signalstats.YAVG": 245, "signalstats.YLOW": 240, "signalstats.YHIGH": 250, blur: 3 }).rejected, /bright/);
  assert.match(rate(1, { "signalstats.YAVG": 81, "signalstats.YLOW": 81, "signalstats.YHIGH": 81, blur: NaN }).rejected, /flat/);
  const sharp = rate(1, { "signalstats.YAVG": 120, "signalstats.YLOW": 20, "signalstats.YHIGH": 230, "signalstats.SATAVG": 60, blur: 2 });
  const soft = rate(2, { "signalstats.YAVG": 120, "signalstats.YLOW": 20, "signalstats.YHIGH": 230, "signalstats.SATAVG": 60, blur: 12 });
  assert.equal(sharp.rejected, null);
  assert.ok(sharp.score > soft.score);
});

test("filter helpers", () => {
  assert.equal(cropFilter(1280, 720), "scale=1280:720:force_original_aspect_ratio=increase:flags=lanczos,crop=1280:720:(iw-1280)*0.5:(ih-720)*0.5,setsar=1");
  assert.equal(escapeFilterValue("C:\\Fonts\\a.ttf"), "C\\:/Fonts/a.ttf");
  assert.equal(escapeFilterValue("00:01"), "00\\:01");
  assert.equal(jpegQ(100), "2");
  assert.equal(labelDecimals(5), 0);
  assert.equal(labelDecimals(0.75), 1);
  assert.equal(jpegQ(1), "31");
  assert.equal(tsShort(65), "01:05");
  assert.equal(tsShort(65.43, 1), "01:05.4");
  assert.equal(tsShort(3725.5, 2), "01:02:05.50");
  assert.ok(previewArgs("/a.mp4", "/b.gif", { start: 0, duration: 2, fps: 10, width: 320, colors: 64, loop: true }).join(" ").includes("palettegen=max_colors=64"));
  assert.throws(() => previewArgs("/a.mp4", "/b.avi", { start: 0, duration: 2, fps: 10, width: 320, colors: 64, loop: true }));
});
