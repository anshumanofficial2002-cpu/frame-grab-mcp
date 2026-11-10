#!/usr/bin/env node
/**
 * frame-grab-mcp — let an AI assistant see inside video files.
 * Frames come back as MCP image content, so vision-capable models can look at them directly.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  expandPath, installHelp, parseTimestamp, prepareOutput, requireFile, resolveBinary, run, runOrThrow, SetupError, toCommand, versionOf,
} from "./lib/ffmpeg.js";
import {
  contactSheet, cropFilter, cutsToScenes, detectCuts, evenTimes, findFont, grabFrame, labelDecimals, mapLimit, previewArgs, scaleFilter, scoreFrame, THUMB_PRESETS, ts, tsShort, videoInfo, writeFrame, type FrameScore,
} from "./lib/frames.js";
import { formatBytes, guard, markdownTable, ok } from "./lib/tool.js";

const VERSION = "1.0.0";
const presetIds = Object.keys(THUMB_PRESETS) as [string, ...string[]];

const server = new McpServer(
  { name: "frame-grab-mcp", version: VERSION },
  {
    instructions:
      "Tools that let you see inside local video files. grab_frame and sample_frames return frames as images you can look at; " +
      "contact_sheet returns one grid image of the whole clip (cheapest way to 'watch' a video); detect_scenes finds cuts; " +
      "make_thumbnail picks the sharpest, best-exposed frame (or a given time) and exports it at a platform's thumbnail size; " +
      "extract_frames saves stills to a folder; make_preview makes a GIF/MP4/WebP loop. Timestamps accept seconds, MM:SS, HH:MM:SS.mmm or a percentage like 50%.",
  },
);

const fileArg = z.string().describe("Absolute path to a local video file. ~ is expanded.");
const timeArg = z.union([z.number(), z.string()]);
const rangeArgs = {
  start: timeArg.optional().describe("Only look from this time on."),
  end: timeArg.optional().describe("Only look up to this time."),
};

function img(buf: Buffer, mime = "image/jpeg") {
  return { type: "image" as const, data: buf.toString("base64"), mimeType: mime };
}

function txt(text: string) {
  return { type: "text" as const, text };
}

async function resolveRange(file: string, a: { start?: number | string; end?: number | string }) {
  const info = await videoInfo(file);
  const start = a.start === undefined ? 0 : parseTimestamp(a.start, info.duration);
  const end = a.end === undefined ? info.duration : parseTimestamp(a.end, info.duration);
  if (info.duration && end <= start) throw new Error("end must be after start.");
  return { info, start, end };
}

/* ---------------------------------------------------------------- setup */

server.registerTool(
  "check_setup",
  {
    title: "Check ffmpeg setup",
    description: "Confirm ffmpeg/ffprobe are installed, that scene and blur detection filters exist, and which font is used for timestamp labels.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () =>
    guard(async () => {
      try {
        const [ffmpeg, ffprobe] = await Promise.all([resolveBinary("ffmpeg"), resolveBinary("ffprobe")]);
        const v = await versionOf("ffmpeg");
        const filters = (await run("ffmpeg", ["-hide_banner", "-filters"], { timeoutMs: 15000 })).stdout;
        const need = ["select", "tile", "blurdetect", "signalstats", "palettegen", "drawtext"];
        const missing = need.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
        const font = findFont();
        const lines = [
          `ffmpeg: ${ffmpeg}\n  ${v}`,
          `ffprobe: ${ffprobe}`,
          missing.length ? `Missing filters: ${missing.join(", ")}${missing.includes("drawtext") ? " (contact sheets will have no timestamp labels)" : ""}` : "All filters present.",
          `Label font: ${font ?? "fontconfig default (set FRAME_GRAB_FONT to a .ttf to choose one)"}`,
          "Ready.",
        ];
        return ok(lines.join("\n"), { ffmpeg, ffprobe, version: v, missing_filters: missing, font });
      } catch (e) {
        if (e instanceof SetupError) return ok(e.message, { ready: false });
        throw e;
      }
    }),
);

/* ---------------------------------------------------------------- grab_frame */

server.registerTool(
  "grab_frame",
  {
    title: "Grab a frame",
    description:
      "Return the frame at a timestamp as an image you can look at (e.g. 'what's on screen at 1:23?', 'is the logo legible here?'). " +
      "Optionally also save it at full resolution as JPG, PNG or WebP.",
    inputSchema: {
      path: fileArg,
      at: timeArg.default("50%").describe('Time: seconds, "MM:SS", "HH:MM:SS.mmm" or "50%".'),
      max_width: z.number().int().min(64).max(3840).default(1024).describe("Width of the returned preview image."),
      format: z.enum(["jpeg", "png"]).default("jpeg"),
      save_path: z.string().optional().describe("Also save the frame at full resolution here (.jpg, .png or .webp)."),
      overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const file = await requireFile(a.path);
      const info = await videoInfo(file);
      const t = parseTimestamp(a.at, info.duration || undefined);
      const buf = await grabFrame(file, t, { maxWidth: a.max_width, format: a.format });
      let saved = "";
      if (a.save_path) {
        const out = await prepareOutput(a.save_path, a.overwrite, file);
        await writeFrame(file, t, out, "setsar=1", 95);
        saved = `\nSaved full-resolution frame (${info.width}x${info.height}) to ${out}`;
      }
      return {
        content: [txt(`${path.basename(file)} @ ${ts(t)} (of ${ts(info.duration)}, ${info.width}x${info.height})${saved}`), img(buf, a.format === "png" ? "image/png" : "image/jpeg")],
      } satisfies CallToolResult;
    }),
);

/* ---------------------------------------------------------------- sample_frames */

server.registerTool(
  "sample_frames",
  {
    title: "Sample frames across a clip",
    description:
      "Return several frames as separate images — evenly spaced across the clip (or a range), or at the exact times you list. " +
      "Use it to review pacing, check continuity, read on-screen text, or describe what happens in a video. For a single overview image, contact_sheet is cheaper.",
    inputSchema: {
      path: fileArg,
      count: z.number().int().min(1).max(24).default(8).describe("Evenly spaced frames to return (ignored if times is given)."),
      times: z.array(timeArg).max(24).optional().describe("Exact timestamps to grab instead of evenly spaced ones."),
      ...rangeArgs,
      max_width: z.number().int().min(64).max(1920).default(512),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    guard(async () => {
      const file = await requireFile(a.path);
      const { info, start, end } = await resolveRange(file, a);
      const times = a.times?.length ? a.times.map((t) => parseTimestamp(t, info.duration || undefined)) : evenTimes(info.duration, a.count, start, end);
      const bufs = await mapLimit(times, 4, (t) => grabFrame(file, t, { maxWidth: a.max_width, quality: 80 }));
      const content: CallToolResult["content"] = [txt(`${times.length} frame(s) from ${path.basename(file)} (${ts(info.duration)}, ${info.width}x${info.height}${info.fps ? `, ${info.fps.toFixed(2)} fps` : ""}).`)];
      bufs.forEach((b, i) => {
        content.push(txt(`Frame ${i + 1} @ ${ts(times[i])}`));
        content.push(img(b));
      });
      return { content };
    }),
);

/* ---------------------------------------------------------------- contact_sheet */

server.registerTool(
  "contact_sheet",
  {
    title: "Contact sheet",
    description:
      "One grid image of evenly spaced frames with timestamp labels and a title bar — the quickest way to see a whole video at a glance " +
      "(review an edit, log b-roll, find a moment, describe a clip). Optionally saved as a JPG.",
    inputSchema: {
      path: fileArg,
      cols: z.number().int().min(1).max(10).default(4),
      rows: z.number().int().min(1).max(10).default(4),
      ...rangeArgs,
      tile_width: z.number().int().min(80).max(960).default(320).describe("Width of each thumbnail in pixels."),
      labels: z.boolean().default(true).describe("Draw the timestamp on each tile."),
      title: z.boolean().default(true).describe("Add a title bar with file name, duration and resolution."),
      background: z.string().default("0x111111").describe("Background color (ffmpeg color name or 0xRRGGBB)."),
      font_file: z.string().optional().describe("Font for labels (.ttf/.otf). Defaults to a system font."),
      save_path: z.string().optional().describe("Also save the sheet as a JPG."),
      overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const file = await requireFile(a.path);
      const { info, start, end } = await resolveRange(file, a);
      const count = a.cols * a.rows;
      const times = evenTimes(info.duration, count, start, end);
      const title = a.title ? `${path.basename(file)}  ·  ${tsShort(info.duration)}  ·  ${info.width}x${info.height}${info.fps ? `  ·  ${info.fps.toFixed(2).replace(/\.00$/, "")} fps` : ""}` : null;
      const font = findFont(a.font_file ? expandPath(a.font_file) : undefined);
      const { image, labelled } = await contactSheet(file, times, { cols: a.cols, tileWidth: a.tile_width, labels: a.labels, title, background: a.background, font, quality: 82 });
      let saved = "";
      if (a.save_path) {
        const out = await prepareOutput(a.save_path, a.overwrite, file);
        await writeFile(out, image);
        saved = `\nSaved to ${out}`;
      }
      const note = (a.labels || a.title) && !labelled ? "\n(Labels skipped: this ffmpeg build can't draw text. Install a build with drawtext/freetype, or pass font_file.)" : "";
      const dec = labelDecimals(times.length > 1 ? times[1] - times[0] : 1);
      const legend = times.map((t, i) => `${i + 1}: ${tsShort(t, dec)}`).join("  ");
      return { content: [txt(`Contact sheet of ${path.basename(file)}: ${a.cols}×${a.rows}, ${tsShort(start, dec)}–${tsShort(end, dec)}.\nTiles (left→right, top→bottom): ${legend}${saved}${note}`), img(image)] };
    }),
);

/* ---------------------------------------------------------------- detect_scenes */

server.registerTool(
  "detect_scenes",
  {
    title: "Detect scene cuts",
    description:
      "Find hard cuts and big visual changes, and list every scene with start, end and length — for logging an edit, counting cuts (pacing), " +
      "pulling a shot list from a reference video, or splitting a montage. Optionally returns a contact sheet of the first frame of each scene and writes CSV.",
    inputSchema: {
      path: fileArg,
      threshold: z.number().min(0.05).max(0.9).default(0.3).describe("Scene-change sensitivity: lower finds more cuts (0.2 catches soft cuts, 0.4 only hard ones)."),
      min_scene_seconds: z.number().min(0).max(60).default(0.4).describe("Ignore cuts closer together than this (flash frames, strobes)."),
      ...rangeArgs,
      include_sheet: z.boolean().default(true).describe("Return a contact sheet of each scene's first frame (up to 30)."),
      max_rows: z.number().int().min(1).max(5000).default(200),
      csv_output_path: z.string().optional(),
      overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const file = await requireFile(a.path);
      const { info, start, end } = await resolveRange(file, a);
      const cuts = await detectCuts(file, a.threshold, { start: start || undefined, duration: a.end !== undefined ? end - start : undefined });
      const scenes = cutsToScenes(cuts, start, end, a.min_scene_seconds);
      const span = end - start;
      const avg = scenes.length ? span / scenes.length : 0;
      const shortest = scenes.reduce((m, s) => Math.min(m, s.duration), Infinity);
      const longest = scenes.reduce((m, s) => Math.max(m, s.duration), 0);

      let csvNote = "";
      if (a.csv_output_path) {
        const out = await prepareOutput(a.csv_output_path, a.overwrite);
        await writeFile(out, ["scene,start_s,end_s,duration_s,start_tc,cut_score", ...scenes.map((s) => [s.index, s.start, s.end, s.duration, ts(s.start), s.cut_score ?? ""].join(","))].join("\n") + "\n");
        csvNote = `\nCSV saved to ${out}`;
      }
      const head =
        `${scenes.length} scene(s), ${Math.max(0, scenes.length - 1)} cut(s) in ${tsShort(span)} — average shot ${avg.toFixed(2)}s ` +
        `(${(scenes.length / Math.max(span, 0.001) * 60).toFixed(1)} shots/min), shortest ${shortest === Infinity ? "—" : shortest.toFixed(2) + "s"}, longest ${longest.toFixed(2)}s.`;
      const table = markdownTable(["#", "start", "end", "length", "cut score"], scenes.slice(0, a.max_rows).map((s) => [s.index, ts(s.start), ts(s.end), `${s.duration.toFixed(2)}s`, s.cut_score ?? "—"]));
      const content: CallToolResult["content"] = [txt(`${head}\n\n${table}${scenes.length > a.max_rows ? `\n(${scenes.length - a.max_rows} more)` : ""}${csvNote}`)];
      if (a.include_sheet && scenes.length > 1) {
        const firsts = scenes.slice(0, 30).map((s) => Math.min(s.start + 0.04, s.end - 0.01));
        const cols = Math.min(6, Math.ceil(Math.sqrt(firsts.length)));
        const { image } = await contactSheet(file, firsts, { cols, tileWidth: 240, labels: true, title: null, background: "0x111111", font: findFont(), quality: 80 });
        content.push(txt(`First frame of scenes 1–${firsts.length}:`), img(image));
      }
      content.push(txt("```json\n" + JSON.stringify({ duration: info.duration, scenes: scenes.slice(0, a.max_rows) }, null, 2) + "\n```"));
      return { content };
    }),
);

/* ---------------------------------------------------------------- make_thumbnail */

server.registerTool(
  "make_thumbnail",
  {
    title: "Make a thumbnail",
    description:
      "Export a thumbnail sized for a platform (YouTube 1280x720, Reels/TikTok/Shorts cover 1080x1920, Instagram grid 3:4, feed 4:5, square, X, LinkedIn). " +
      "Give `at` to use a specific frame, or leave it out and the tool samples the video, rejects black/white/flat frames, and picks the sharpest, " +
      "best-exposed one — returning the top candidates so you can choose a different one. Crops to the aspect ratio with an adjustable anchor.",
    inputSchema: {
      path: fileArg,
      preset: z.enum(presetIds).default("youtube").describe(`Size preset: ${presetIds.join(", ")}`),
      width: z.number().int().min(16).max(7680).optional().describe("Custom width (overrides preset)."),
      height: z.number().int().min(16).max(7680).optional().describe("Custom height (overrides preset)."),
      at: timeArg.optional().describe("Use the frame at this time instead of auto-picking."),
      ...rangeArgs,
      candidates: z.number().int().min(4).max(60).default(24).describe("Frames to evaluate when auto-picking."),
      show_candidates: z.number().int().min(0).max(8).default(4).describe("Return this many runner-up frames as small images."),
      anchor_x: z.number().min(0).max(1).default(0.5).describe("Horizontal crop anchor: 0 keeps the left edge, 1 the right."),
      anchor_y: z.number().min(0).max(1).default(0.5).describe("Vertical crop anchor: 0 keeps the top, 1 the bottom."),
      output_path: z.string().optional().describe("Defaults to <name>_<preset>_thumb.jpg next to the video. .jpg, .png or .webp."),
      quality: z.number().int().min(40).max(100).default(92),
      overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const file = await requireFile(a.path);
      const { info, start, end } = await resolveRange(file, a);
      const preset = THUMB_PRESETS[a.preset];
      const W = a.width ?? preset.width;
      const H = a.height ?? preset.height;
      const label = a.width || a.height ? `${W}x${H}` : preset.id;
      const out = expandPath(a.output_path ?? path.join(path.dirname(file), `${path.parse(file).name}_${label}_thumb.jpg`));

      let chosen: number;
      let ranked: FrameScore[] = [];
      if (a.at !== undefined) {
        chosen = parseTimestamp(a.at, info.duration || undefined);
      } else {
        // skip the first/last 3% (titles, fades) when the range is the whole clip
        const pad = a.start === undefined && a.end === undefined ? (end - start) * 0.03 : 0;
        const times = evenTimes(info.duration, a.candidates, start + pad, end - pad);
        const scores = await mapLimit(times, 4, (t) => scoreFrame(file, t));
        ranked = [...scores].sort((x, y) => y.score - x.score);
        const best = ranked.find((s) => !s.rejected) ?? ranked[0];
        if (!best) throw new Error("Could not evaluate any frames.");
        chosen = best.t;
      }

      await prepareOutput(out, a.overwrite, file);
      const vf = cropFilter(W, H, a.anchor_x, a.anchor_y);
      let q = a.quality;
      await writeFrame(file, chosen, out, vf, q);
      let size = (await stat(out)).size;
      const ext = path.extname(out).toLowerCase();
      while (preset.max_bytes && !a.width && size > preset.max_bytes && ext !== ".png" && q > 50) {
        q -= 8;
        await writeFrame(file, chosen, out, vf, q);
        size = (await stat(out)).size;
      }

      const lines = [`Thumbnail for ${preset.name}${a.width || a.height ? ` (custom ${W}x${H})` : ` (${W}x${H})`} from ${ts(chosen)} → ${out} (${formatBytes(size)}${q !== a.quality ? `, quality lowered to ${q} to fit` : ""}).`];
      if (preset.note) lines.push(preset.note);
      if (preset.max_bytes && size > preset.max_bytes) lines.push(`⚠️ Larger than ${formatBytes(preset.max_bytes)} — save as .jpg with lower quality.`);
      if (ranked.length) {
        const rejected = ranked.filter((r) => r.rejected).length;
        lines.push(
          `Auto-picked from ${ranked.length} candidates (${rejected} rejected as black/white/flat). Scores weigh sharpness, contrast, exposure and color.`,
          markdownTable(["rank", "time", "score", "sharpness (blur, lower = sharper)", "brightness", "contrast", "note"], ranked.slice(0, Math.max(5, a.show_candidates)).map((r, i) => [i + 1, ts(r.t), r.score, r.blur ?? "—", r.brightness, r.contrast, r.rejected ?? ""])),
        );
      }
      const content: CallToolResult["content"] = [txt(lines.join("\n"))];
      const finalBuf = await readFile(out);
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      content.push(finalBuf.length < 3.5 * 1024 * 1024 ? img(finalBuf, mime) : img(await grabFrame(file, chosen, { vf: `${vf},scale=640:-2` })));
      const alts = ranked.filter((r) => !r.rejected && r.t !== chosen).slice(0, a.show_candidates);
      if (alts.length) {
        const bufs = await mapLimit(alts, 4, (r) => grabFrame(file, r.t, { vf: `${cropFilter(W, H, a.anchor_x, a.anchor_y)},scale='min(360,iw)':-2`, quality: 75 }));
        content.push(txt(`Runner-up candidates (call again with at: "<time>" to use one):`));
        bufs.forEach((b, i) => content.push(txt(`#${i + 2} @ ${ts(alts[i].t)} (score ${alts[i].score})`), img(b)));
      }
      return { content };
    }),
);

/* ---------------------------------------------------------------- extract_frames */

server.registerTool(
  "extract_frames",
  {
    title: "Extract frames to a folder",
    description:
      "Save stills to a folder: every N seconds, N evenly spaced frames, one per detected scene, or at exact timestamps. Files are named with their timecode. " +
      "Good for b-roll stills, storyboards, social carousels or feeding frames to other tools.",
    inputSchema: {
      path: fileArg,
      output_folder: z.string().describe("Folder to write into (created if missing)."),
      mode: z.enum(["interval", "count", "scenes", "timestamps"]).default("count"),
      interval_seconds: z.number().min(0.04).max(3600).optional().describe("mode=interval: seconds between frames."),
      count: z.number().int().min(1).max(500).default(12).describe("mode=count: how many evenly spaced frames."),
      times: z.array(timeArg).max(500).optional().describe("mode=timestamps: exact times."),
      scene_threshold: z.number().min(0.05).max(0.9).default(0.3).describe("mode=scenes: sensitivity."),
      ...rangeArgs,
      format: z.enum(["jpg", "png", "webp"]).default("jpg"),
      width: z.number().int().min(16).max(7680).optional().describe("Resize to this width (keeps aspect). Default: full resolution."),
      prefix: z.string().regex(/^[\w.-]*$/).optional().describe("File name prefix; defaults to the video's name."),
      max_frames: z.number().int().min(1).max(500).default(200),
      overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const file = await requireFile(a.path);
      const { info, start, end } = await resolveRange(file, a);
      let times: number[];
      if (a.mode === "timestamps") {
        if (!a.times?.length) throw new Error("mode=timestamps needs times.");
        times = a.times.map((t) => parseTimestamp(t, info.duration || undefined));
      } else if (a.mode === "interval") {
        if (!a.interval_seconds) throw new Error("mode=interval needs interval_seconds.");
        times = [];
        for (let t = start; t < end && times.length < a.max_frames + 1; t += a.interval_seconds) times.push(+t.toFixed(3));
      } else if (a.mode === "scenes") {
        const cuts = await detectCuts(file, a.scene_threshold, { start: start || undefined, duration: a.end !== undefined ? end - start : undefined });
        times = cutsToScenes(cuts, start, end, 0.4).map((s) => +Math.min(s.start + 0.04, s.end - 0.01).toFixed(3));
      } else {
        times = evenTimes(info.duration, a.count, start, end);
      }
      const truncated = times.length > a.max_frames;
      times = times.slice(0, a.max_frames);
      const prefix = a.prefix ?? path.parse(file).name.replace(/[^\w.-]+/g, "_");
      const dir = expandPath(a.output_folder);
      const vf = scaleFilter(a.width);
      const written = await mapLimit(times, 4, async (t) => {
        const name = `${prefix}_${ts(t).replace(/[:.]/g, "-")}.${a.format}`;
        const out = await prepareOutput(path.join(dir, name), a.overwrite, file);
        await writeFrame(file, t, out, a.width ? `scale=${a.width}:-2:flags=lanczos,setsar=1` : vf, 92);
        return out;
      });
      const list = written.slice(0, 30).map((p, i) => `- ${ts(times[i])} → ${path.basename(p)}`).join("\n");
      return ok(
        `Saved ${written.length} frame(s) to ${dir}${truncated ? ` (stopped at max_frames=${a.max_frames})` : ""}.\n${list}${written.length > 30 ? `\n…and ${written.length - 30} more` : ""}`,
        { folder: dir, files: written.map((p, i) => ({ time: times[i], path: p })) },
      );
    }),
);

/* ---------------------------------------------------------------- make_preview */

server.registerTool(
  "make_preview",
  {
    title: "Make a GIF / looping preview",
    description:
      "Turn a section of a video into a looping preview: an optimized GIF (custom palette, small file), a silent MP4 loop, or animated WebP. " +
      "For X/Slack/Notion/GitHub READMEs, client previews, or reaction clips. Returns the first frame so you can confirm the section.",
    inputSchema: {
      path: fileArg,
      start: timeArg.default(0).describe("Where the preview starts."),
      duration: z.number().min(0.2).max(60).default(4).describe("Length in seconds."),
      output_path: z.string().optional().describe("Defaults to <name>_preview.gif next to the video. Extension picks the format: .gif, .mp4, .webp."),
      fps: z.number().min(1).max(60).default(12),
      width: z.number().int().min(64).max(1920).default(480),
      colors: z.number().int().min(8).max(256).default(128).describe("GIF palette size; fewer = smaller file."),
      loop: z.boolean().default(true),
      dry_run: z.boolean().default(false),
      overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const file = await requireFile(a.path);
      const info = await videoInfo(file);
      const s = parseTimestamp(a.start, info.duration || undefined);
      const d = info.duration ? Math.min(a.duration, Math.max(0.2, info.duration - s)) : a.duration;
      const out = expandPath(a.output_path ?? path.join(path.dirname(file), `${path.parse(file).name}_preview.gif`));
      const args = previewArgs(file, out, { start: s, duration: d, fps: a.fps, width: a.width, colors: a.colors, loop: a.loop });
      const cmd = toCommand("ffmpeg", args);
      if (a.dry_run) return ok(`Command:\n\`\`\`sh\n${cmd}\n\`\`\``, { command: cmd });
      await prepareOutput(out, a.overwrite, file);
      await runOrThrow("ffmpeg", args, { timeoutMs: 10 * 60 * 1000 });
      const size = (await stat(out)).size;
      const warn = path.extname(out).toLowerCase() === ".gif" && size > 15 * 1024 * 1024 ? "\n⚠️ Over 15 MB — many sites reject GIFs that large. Lower width, fps, colors or duration, or use .mp4." : "";
      const first = await grabFrame(file, s, { maxWidth: a.width, quality: 80 });
      return {
        content: [txt(`Preview ${ts(s)}–${ts(s + d)} (${d.toFixed(1)}s, ${a.fps} fps, ${a.width}px wide) → ${out} (${formatBytes(size)})${warn}\nFirst frame:`), img(first)],
      };
    }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  resolveBinary("ffmpeg").catch(() => console.error(`[frame-grab-mcp] ${installHelp()}`));
  console.error(`[frame-grab-mcp] v${VERSION} ready on stdio`);
}

main().catch((e) => {
  console.error("[frame-grab-mcp] fatal:", e);
  process.exit(1);
});
