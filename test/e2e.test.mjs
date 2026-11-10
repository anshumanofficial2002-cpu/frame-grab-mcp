import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { connect, fixture, hasFfmpeg, textOf, TMP } from "./helpers.mjs";

const skip = !hasFfmpeg() && "ffmpeg not installed";
let client, cuts;

const images = (res) => res.content.filter((c) => c.type === "image");
const jsonIn = (res) => JSON.parse(textOf(res).match(/```json\n([\s\S]*?)\n```/)[1]);

before(async () => {
  if (skip) return;
  // 3 scenes: test pattern (0-3s), solid red (3-6s), SMPTE bars (6-9s), plus 1s black at the start
  cuts = fixture("cuts.mp4", [
    "-f", "lavfi", "-i", "color=c=black:size=640x360:rate=25:duration=1",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=3",
    "-f", "lavfi", "-i", "color=c=red:size=640x360:rate=25:duration=3",
    "-f", "lavfi", "-i", "smptebars=size=640x360:rate=25:duration=3",
    "-filter_complex", "[0][1][2][3]concat=n=4:v=1:a=0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  ]);
  client = await connect();
});
after(async () => client?.close());

test("lists tools", { skip }, async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_setup", "contact_sheet", "detect_scenes", "extract_frames", "grab_frame", "make_preview", "make_thumbnail", "sample_frames"]);
});

test("check_setup", { skip }, async () => {
  assert.match(textOf(await client.callTool({ name: "check_setup", arguments: {} })), /Ready\./);
});

test("grab_frame returns a JPEG image and saves full-res", { skip }, async () => {
  const out = path.join(TMP, "frame.png");
  rmSync(out, { force: true });
  const res = await client.callTool({ name: "grab_frame", arguments: { path: cuts, at: "00:05", max_width: 320, save_path: out } });
  assert.ok(!res.isError, textOf(res));
  const [im] = images(res);
  assert.equal(im.mimeType, "image/jpeg");
  assert.equal(Buffer.from(im.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
  assert.ok(existsSync(out));
  const pct = await client.callTool({ name: "grab_frame", arguments: { path: cuts, at: "100%" } });
  assert.ok(!pct.isError, "end of file still returns a frame");
});

test("sample_frames returns N images", { skip }, async () => {
  const res = await client.callTool({ name: "sample_frames", arguments: { path: cuts, count: 5 } });
  assert.equal(images(res).length, 5);
});

test("contact_sheet returns one image", { skip }, async () => {
  const res = await client.callTool({ name: "contact_sheet", arguments: { path: cuts, cols: 3, rows: 2 } });
  assert.ok(!res.isError, textOf(res));
  assert.equal(images(res).length, 1);
  assert.match(textOf(res), /Tiles/);
});

test("detect_scenes finds the three cuts", { skip }, async () => {
  const res = await client.callTool({ name: "detect_scenes", arguments: { path: cuts } });
  assert.ok(!res.isError, textOf(res));
  const { scenes } = jsonIn(res);
  assert.equal(scenes.length, 4, JSON.stringify(scenes));
  for (const [i, t] of [[1, 1], [2, 4], [3, 7]]) assert.ok(Math.abs(scenes[i].start - t) < 0.1, `scene ${i} at ${scenes[i].start}`);
  assert.equal(images(res).length, 1);
});

test("make_thumbnail auto-picks a detailed frame, not black or flat red", { skip }, async () => {
  const out = path.join(TMP, "thumb.jpg");
  rmSync(out, { force: true });
  const res = await client.callTool({ name: "make_thumbnail", arguments: { path: cuts, preset: "youtube", candidates: 20, output_path: out } });
  assert.ok(!res.isError, textOf(res));
  const t = Number(textOf(res).match(/from 00:00:(\d+\.\d+)/)[1]);
  assert.ok((t > 1 && t < 4) || t > 7, `picked ${t}`);
  assert.ok(images(res).length >= 2);
  const again = await client.callTool({ name: "make_thumbnail", arguments: { path: cuts, at: 2, preset: "instagram_reels_cover", output_path: path.join(TMP, "cover.jpg"), overwrite: true } });
  assert.ok(!again.isError, textOf(again));
});

test("extract_frames and make_preview write files", { skip }, async () => {
  const dir = path.join(TMP, "stills");
  rmSync(dir, { recursive: true, force: true });
  const ex = await client.callTool({ name: "extract_frames", arguments: { path: cuts, output_folder: dir, mode: "scenes" } });
  assert.ok(!ex.isError, textOf(ex));
  assert.equal(readdirSync(dir).length, 4);
  const gif = path.join(TMP, "p.gif");
  rmSync(gif, { force: true });
  const pv = await client.callTool({ name: "make_preview", arguments: { path: cuts, start: 1, duration: 2, width: 240, fps: 8, output_path: gif } });
  assert.ok(!pv.isError, textOf(pv));
  assert.ok(existsSync(gif));
});
