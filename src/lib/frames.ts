/** Frame extraction, contact sheets, scene detection and thumbnail scoring on top of ffmpeg. */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatTimestamp, run, runOrThrow } from "./ffmpeg.js";

/* ---------------------------------------------------------------- probe */

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number | null;
}

export async function videoInfo(file: string): Promise<VideoInfo> {
  const res = await runOrThrow(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration", "-of", "json", file],
    { timeoutMs: 60000 },
  );
  let j: { streams?: Record<string, unknown>[]; format?: { duration?: string } };
  try {
    j = JSON.parse(res.stdout);
  } catch {
    throw new Error("ffprobe could not read this file.");
  }
  const s = j.streams?.[0] as Record<string, any> | undefined;
  if (!s) throw new Error(`No video stream in ${path.basename(file)}.`);
  let w = Number(s.width) || 0;
  let h = Number(s.height) || 0;
  const rot = Number((s.side_data_list ?? []).find((d: Record<string, unknown>) => d.rotation !== undefined)?.rotation ?? 0);
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  const rate = (r: unknown) => {
    if (typeof r !== "string") return null;
    const [a, b] = r.split("/").map(Number);
    return b ? a / b : null;
  };
  const dur = Number(j.format?.duration);
  return { duration: Number.isFinite(dur) ? dur : 0, width: w, height: h, fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate) };
}

export const ts = (t: number) => formatTimestamp(t);
/** Short label: "01:05", or "01:05.4" when precision is needed (e.g. tiles less than a second apart). */
export const tsShort = (t: number, decimals = 0) => {
  const full = formatTimestamp(t, decimals > 0);
  const trimmed = decimals > 0 ? full.slice(0, full.length - (3 - decimals)) : full;
  return trimmed.startsWith("00:") ? trimmed.slice(3) : trimmed;
};

/** Decimal places needed so labels spaced `step` seconds apart are all distinct. */
export const labelDecimals = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);

/* ---------------------------------------------------------------- single frames */

export type ImageFormat = "jpeg" | "png";

export function jpegQ(quality: number): string {
  // ffmpeg mjpeg -q:v: 2 (best) … 31 (worst)
  const q = Math.round(31 - (Math.min(100, Math.max(1, quality)) / 100) * 29);
  return String(Math.min(31, Math.max(2, q)));
}

export function scaleFilter(maxWidth?: number): string {
  return maxWidth ? `scale='min(${maxWidth},iw)':-2:flags=lanczos,setsar=1` : "setsar=1";
}

/** Grab one frame and return it as an encoded image buffer. */
export async function grabFrame(
  file: string,
  t: number,
  o: { maxWidth?: number; format?: ImageFormat; quality?: number; vf?: string } = {},
): Promise<Buffer> {
  const format = o.format ?? "jpeg";
  const attempt = async (time: number) => {
    const vf = o.vf ?? scaleFilter(o.maxWidth);
    const args = ["-hide_banner", "-loglevel", "error", "-ss", time.toFixed(3), "-i", file, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-vf", vf, "-f", "image2pipe"];
    if (format === "png") args.push("-c:v", "png", "-pix_fmt", "rgb24");
    else args.push("-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", jpegQ(o.quality ?? 85));
    args.push("-");
    const res = await runOrThrow("ffmpeg", args, { timeoutMs: 120000, binaryStdout: true });
    return res.stdoutBuffer ?? Buffer.alloc(0);
  };
  let buf = await attempt(t);
  // Seeking to the very end can land past the last frame; step back once.
  if (buf.length === 0 && t > 0) buf = await attempt(Math.max(0, t - 1));
  if (buf.length === 0) throw new Error(`Could not decode a frame at ${ts(t)}.`);
  return buf;
}

/** Write one frame straight to a file (full quality, any size). */
export async function writeFrame(file: string, t: number, out: string, vf: string, quality = 92): Promise<void> {
  const ext = path.extname(out).toLowerCase();
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-vf", vf];
  if (ext === ".png") args.push("-c:v", "png", "-pix_fmt", "rgb24");
  else if (ext === ".webp") args.push("-c:v", "libwebp", "-quality", String(quality));
  else args.push("-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", jpegQ(quality));
  args.push("-update", "1", out);
  await runOrThrow("ffmpeg", args, { timeoutMs: 120000 });
  if (!existsSync(out)) throw new Error(`ffmpeg did not write ${out}`);
}

/** Evenly spaced timestamps, avoiding the exact first and last frame (often black). */
export function evenTimes(duration: number, count: number, start = 0, end?: number): number[] {
  const s = Math.max(0, start);
  const e = Math.min(end ?? duration, duration || Infinity);
  const span = Math.max(0, e - s);
  if (count <= 0) return [];
  if (span === 0) return [s];
  const step = span / count;
  return Array.from({ length: count }, (_, i) => +(s + step * (i + 0.5)).toFixed(3));
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/* ---------------------------------------------------------------- fonts / drawtext */

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
];

export function findFont(explicit?: string): string | null {
  const env = process.env.FRAME_GRAB_FONT;
  for (const p of [explicit, env, ...FONT_CANDIDATES]) if (p && existsSync(p)) return p;
  return null;
}

/** Escape a value for use inside a single-quoted filtergraph option. */
export function escapeFilterValue(v: string): string {
  return v.replace(/\\/g, "/").replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

function fontOpt(font: string | null): string {
  return font ? `fontfile='${escapeFilterValue(font)}':` : "";
}

/* ---------------------------------------------------------------- contact sheet */

export interface SheetOptions {
  cols: number;
  tileWidth: number;
  labels: boolean;
  title: string | null;
  background: string;
  font: string | null;
  quality: number;
}

export async function contactSheet(file: string, times: number[], o: SheetOptions): Promise<{ image: Buffer; labelled: boolean }> {
  const rows = Math.ceil(times.length / o.cols);
  const minStep = times.slice(1).reduce((m, t, i) => Math.min(m, t - times[i]), Infinity);
  const dec = labelDecimals(minStep);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "frame-grab-"));
  try {
    const build = async (withText: boolean) => {
      const args = ["-hide_banner", "-loglevel", "error"];
      for (const t of times) args.push("-ss", t.toFixed(3), "-i", file);
      const fs = Math.max(12, Math.round(o.tileWidth / 15));
      const parts = times.map((t, i) => {
        const label = withText && o.labels ? `,drawtext=${fontOpt(o.font)}text='${escapeFilterValue(tsShort(t, dec))}':fontsize=${fs}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${Math.round(fs / 3)}:x=8:y=h-th-8` : "";
        return `[${i}:v:0]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${o.tileWidth}:-2:flags=lanczos,setsar=1,format=yuv420p${label}[f${i}]`;
      });
      let chain = `${times.map((_, i) => `[f${i}]`).join("")}concat=n=${times.length}:v=1:a=0,tile=${o.cols}x${rows}:padding=6:margin=6:color=${o.background}`;
      if (withText && o.title) {
        const titleFile = path.join(tmp, "title.txt");
        await writeFile(titleFile, o.title, "utf8");
        const hh = Math.max(36, Math.round(fs * 2.2));
        chain += `,pad=iw:ih+${hh}:0:${hh}:color=${o.background},drawtext=${fontOpt(o.font)}textfile='${escapeFilterValue(titleFile)}':expansion=none:fontsize=${Math.round(fs * 1.15)}:fontcolor=white:x=12:y=(${hh}-th)/2`;
      }
      args.push("-filter_complex", `${parts.join(";")};${chain}[out]`, "-map", "[out]", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", jpegQ(o.quality), "-");
      const res = await run("ffmpeg", args, { timeoutMs: 5 * 60 * 1000, binaryStdout: true });
      return res;
    };
    let res = await build(true);
    let labelled = o.labels || Boolean(o.title);
    if ((res.code !== 0 || !res.stdoutBuffer?.length) && /drawtext|font|Fontconfig/i.test(res.stderr)) {
      res = await build(false);
      labelled = false;
    }
    if (res.code !== 0 || !res.stdoutBuffer?.length) throw new Error(`Contact sheet failed: ${res.stderr.trim().split("\n").slice(-4).join("\n")}`);
    return { image: res.stdoutBuffer, labelled };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- metadata parsing */

export interface FrameMeta {
  t: number;
  values: Record<string, number>;
}

/** Parse `metadata=print` output: "frame:N pts:X pts_time:T" followed by key=value lines. */
export function parseMetadata(out: string, offset = 0): FrameMeta[] {
  const frames: FrameMeta[] = [];
  let cur: FrameMeta | null = null;
  for (const line of out.split("\n")) {
    const f = line.match(/^frame:\d+\s+pts:\S+\s+pts_time:([-\d.]+)/);
    if (f) {
      cur = { t: +(Number(f[1]) + offset).toFixed(3), values: {} };
      frames.push(cur);
      continue;
    }
    const kv = line.match(/^lavfi\.([\w.]+)=(.*)$/);
    if (kv && cur) cur.values[kv[1]] = Number(kv[2]);
  }
  return frames;
}

/* ---------------------------------------------------------------- scenes */

export interface Scene {
  index: number;
  start: number;
  end: number;
  duration: number;
  cut_score: number | null;
}

export async function detectCuts(file: string, threshold: number, o: { start?: number; duration?: number; analyzeWidth?: number } = {}) {
  const args = ["-hide_banner", "-nostats", "-loglevel", "error"];
  if (o.start) args.push("-ss", String(o.start));
  args.push("-i", file);
  if (o.duration) args.push("-t", String(o.duration));
  args.push("-map", "0:v:0", "-vf", `scale=${o.analyzeWidth ?? 320}:-2,select='gt(scene\\,${threshold})',metadata=print:file=-`, "-an", "-f", "null", "-");
  const res = await runOrThrow("ffmpeg", args, { timeoutMs: 60 * 60 * 1000 });
  return parseMetadata(res.stdout, o.start ?? 0).map((f) => ({ t: f.t, score: f.values["scene_score"] ?? null }));
}

export function cutsToScenes(cuts: { t: number; score: number | null }[], start: number, end: number, minScene: number): Scene[] {
  const kept: { t: number; score: number | null }[] = [];
  let last = start;
  for (const c of cuts) {
    if (c.t - last >= minScene && end - c.t >= Math.min(minScene, 0.2)) {
      kept.push(c);
      last = c.t;
    }
  }
  const bounds = [{ t: start, score: null as number | null }, ...kept];
  return bounds.map((b, i) => {
    const e = i + 1 < bounds.length ? bounds[i + 1].t : end;
    return { index: i + 1, start: +b.t.toFixed(3), end: +e.toFixed(3), duration: +(e - b.t).toFixed(3), cut_score: b.score === null ? null : +b.score.toFixed(3) };
  });
}

/* ---------------------------------------------------------------- frame quality */

export interface FrameScore {
  t: number;
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number | null;
  score: number;
  rejected: string | null;
}

export async function scoreFrame(file: string, t: number): Promise<FrameScore> {
  const res = await run(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=480:-2,signalstats,blurdetect,metadata=print:file=-", "-an", "-f", "null", "-"],
    { timeoutMs: 120000 },
  );
  const m = parseMetadata(res.stdout)[0]?.values ?? {};
  return rate(t, m);
}

export function rate(t: number, m: Record<string, number>): FrameScore {
  const yavg = m["signalstats.YAVG"] ?? 0;
  const ylow = m["signalstats.YLOW"] ?? 0;
  const yhigh = m["signalstats.YHIGH"] ?? 0;
  const sat = m["signalstats.SATAVG"] ?? 0;
  const blurRaw = m["blur"];
  const blur = Number.isFinite(blurRaw) ? blurRaw : null;
  const contrast = Math.max(0, yhigh - ylow) / 255;
  let rejected: string | null = null;
  if (yavg < 28) rejected = "too dark (black frame or fade)";
  else if (yavg > 232) rejected = "too bright (white flash)";
  else if (contrast < 0.08) rejected = "flat, no detail";
  else if (blur === null) rejected = "no measurable detail";
  // blurdetect: higher = blurrier. Typical sharp footage ~2–6, soft ~8+.
  const sharp = blur === null ? 0 : 1 / (1 + blur / 4);
  const exposure = 1 - Math.abs(yavg - 125) / 125;
  const score = rejected ? -1 : +(sharp * 3 + contrast * 2 + exposure * 1.5 + Math.min(1, sat / 90) * 0.75).toFixed(3);
  return { t, brightness: Math.round(yavg), contrast: +contrast.toFixed(2), saturation: Math.round(sat), blur: blur === null ? null : +blur.toFixed(2), score, rejected };
}

/* ---------------------------------------------------------------- thumbnails */

export interface ThumbPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  max_bytes?: number;
  note?: string;
}

export const THUMB_PRESETS: Record<string, ThumbPreset> = {
  youtube: { id: "youtube", name: "YouTube thumbnail", width: 1280, height: 720, max_bytes: 2 * 1024 * 1024, note: "YouTube accepts JPG/PNG up to 2 MB." },
  youtube_shorts: { id: "youtube_shorts", name: "YouTube Shorts frame", width: 1080, height: 1920 },
  instagram_reels_cover: { id: "instagram_reels_cover", name: "Instagram Reels cover", width: 1080, height: 1920, note: "The profile grid shows the middle 3:4 (1080x1440); keep the subject and text there." },
  instagram_grid: { id: "instagram_grid", name: "Instagram profile grid (3:4)", width: 1080, height: 1440 },
  instagram_feed: { id: "instagram_feed", name: "Instagram feed (4:5)", width: 1080, height: 1350 },
  tiktok_cover: { id: "tiktok_cover", name: "TikTok cover", width: 1080, height: 1920 },
  square: { id: "square", name: "Square", width: 1080, height: 1080 },
  x: { id: "x", name: "X / Twitter card", width: 1600, height: 900 },
  linkedin: { id: "linkedin", name: "LinkedIn link/video thumbnail", width: 1200, height: 627 },
};

export function cropFilter(w: number, h: number, anchorX = 0.5, anchorY = 0.5): string {
  const ax = Math.min(1, Math.max(0, anchorX));
  const ay = Math.min(1, Math.max(0, anchorY));
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}:(iw-${w})*${ax}:(ih-${h})*${ay},setsar=1`;
}

/* ---------------------------------------------------------------- previews */

export function previewArgs(file: string, out: string, o: { start: number; duration: number; fps: number; width: number; colors: number; loop: boolean }): string[] {
  const ext = path.extname(out).toLowerCase();
  const input = ["-hide_banner", "-loglevel", "error", "-y", "-ss", o.start.toFixed(3), "-t", o.duration.toFixed(3), "-i", file, "-an"];
  const base = [...input, "-map", "0:v:0"];
  if (ext === ".gif") {
    return [
      ...input,
      "-filter_complex",
      `[0:v:0]fps=${o.fps},scale=${o.width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${o.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      "-loop", o.loop ? "0" : "-1",
      out,
    ];
  }
  if (ext === ".mp4") {
    return [...base, "-vf", `fps=${o.fps},scale=${o.width}:-2:flags=lanczos,setsar=1`, "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out];
  }
  if (ext === ".webp") {
    return [...base, "-vf", `fps=${o.fps},scale=${o.width}:-2:flags=lanczos`, "-c:v", "libwebp", "-quality", "75", "-loop", o.loop ? "0" : "1", out];
  }
  throw new Error("Preview output must end in .gif, .mp4 or .webp.");
}
