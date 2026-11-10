# frame-grab-mcp

[![CI](https://github.com/anshumanofficial2002-cpu/frame-grab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anshumanofficial2002-cpu/frame-grab-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black)](https://modelcontextprotocol.io)

**Give your AI assistant eyes on your videos.**

`frame-grab-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that returns video frames as **images** — so Claude and other vision models can actually look at your footage. Grab a frame, sample a clip, see the whole video as one contact sheet, detect every cut, auto-pick the sharpest thumbnail and export it at the right size for YouTube, Reels, TikTok or LinkedIn, or make a GIF.

Runs locally with ffmpeg. Your footage never leaves your machine.

```
You:    Look at ~/Exports/reel_v4.mp4 and tell me where the pacing drags.
Claude: [contact sheet + scene detection] 31 cuts in 42s (avg 1.4s), but shots 18–20
        run 4.1s, 3.8s and 5.2s — that's the product demo section around 0:24–0:37.
        Everything else cuts every 1–1.5s, so that stretch will feel slow.
You:    Make a YouTube thumbnail from the sharpest frame.
Claude: Saved reel_v4_youtube_thumb.jpg (1280x720, 214 KB) from 00:00:08.4.
        Here are 4 runner-ups if you'd prefer a different shot.
```

---

## Tools

| Tool | Returns | What it does |
| --- | --- | --- |
| `grab_frame` | 🖼 image | Frame at a timestamp (`12.5`, `1:23`, `00:01:23.400`, `50%`). Optionally saves full-res JPG/PNG/WebP. |
| `sample_frames` | 🖼 images | 1–24 frames evenly spaced (or at exact times) across the clip or a range. |
| `contact_sheet` | 🖼 image | One grid of evenly spaced frames with timestamp labels and a title bar. The cheapest way to "watch" a video. |
| `detect_scenes` | table + 🖼 | Every cut with start/end/length, shots per minute, shortest/longest shot, a sheet of each scene's first frame, optional CSV. |
| `make_thumbnail` | 🖼 image(s) | Platform-sized thumbnail. Auto-pick rejects black/white/flat frames and ranks by sharpness, contrast, exposure and color, then shows runner-ups. Or pass `at`. |
| `extract_frames` | file list | Save stills to a folder: every N seconds, N evenly spaced, one per scene, or exact timestamps. |
| `make_preview` | file + 🖼 | Optimized looping GIF (custom palette), silent MP4 loop, or animated WebP from a section. |
| `check_setup` | text | Confirms ffmpeg/ffprobe, required filters, and the label font. |

### Thumbnail presets

| id | Size | Notes |
| --- | --- | --- |
| `youtube` | 1280x720 | Auto-compressed to stay under YouTube's 2 MB limit |
| `youtube_shorts` | 1080x1920 | |
| `instagram_reels_cover` | 1080x1920 | The profile grid shows the middle 3:4 — keep the subject there |
| `instagram_grid` | 1080x1440 | 3:4 profile grid tile |
| `instagram_feed` | 1080x1350 | 4:5 |
| `tiktok_cover` | 1080x1920 | |
| `square` | 1080x1080 | |
| `x` | 1600x900 | |
| `linkedin` | 1200x627 | |

Or pass custom `width` / `height`. Cropping uses `anchor_x` / `anchor_y` (0 = left/top, 1 = right/bottom) so you can keep a subject who isn't centered.

---

## Requirements

- **Node.js 20+**
- **ffmpeg + ffprobe**
  - macOS: `brew install ffmpeg` · Ubuntu: `sudo apt install ffmpeg` · Windows: `winget install ffmpeg`
- A **vision-capable** MCP client (Claude Desktop, Claude Code, Cursor…) to see the returned images.

Binaries are found via `FFMPEG_PATH` / `FFPROBE_PATH`, then `PATH`, then common folders like `/opt/homebrew/bin` (Claude Desktop on macOS uses a minimal `PATH`). Timestamp labels use a system font (Arial/Helvetica on macOS, DejaVu on Linux, Arial on Windows); set `FRAME_GRAB_FONT=/path/to/font.ttf` to choose your own. If your ffmpeg can't draw text, sheets are made without labels.

## Install

### Claude Desktop

**Settings → Developer → Edit Config**:

```json
{
  "mcpServers": {
    "frame-grab": {
      "command": "npx",
      "args": ["-y", "github:anshumanofficial2002-cpu/frame-grab-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add frame-grab -- npx -y github:anshumanofficial2002-cpu/frame-grab-mcp
```

### Cursor / Windsurf / VS Code / other clients

```json
{
  "frame-grab": {
    "command": "npx",
    "args": ["-y", "github:anshumanofficial2002-cpu/frame-grab-mcp"]
  }
}
```

### From source

```sh
git clone https://github.com/anshumanofficial2002-cpu/frame-grab-mcp.git
cd frame-grab-mcp && npm install && npm run build
# point your client at: node /absolute/path/to/frame-grab-mcp/dist/index.js
```

---

## Example prompts

- "What's on screen at 0:42 in `interview_cam_b.mov`? Is the lower third readable?"
- "Make a 5×4 contact sheet of `client_raw.mp4` and tell me which shots are usable b-roll."
- "Count the cuts in this reference reel and give me a shot list with timings."
- "Pick the best frame from `vlog_ep3.mp4` for a YouTube thumbnail — the subject is on the right, keep them in frame."
- "Make a Reels cover from 00:12.3."
- "Export one still per scene from `montage.mp4` into `~/Desktop/stills` as PNG."
- "Make a 3-second GIF of the logo reveal at 0:05 for X, under 5 MB."
- "Sample 12 frames from the first minute and check whether my white balance shifts between shots."

---

## Tool reference

Timestamps everywhere accept seconds (`12.5`), `MM:SS`, `HH:MM:SS.mmm`, or a percentage of the duration (`"75%"`). Range params `start` / `end` limit any analysis to part of the clip.

### `grab_frame`
`at` (`"50%"`), `max_width` (1024), `format` (`jpeg`|`png`), `save_path`, `overwrite`.

### `sample_frames`
`count` (8, max 24) **or** `times` (list), `start`, `end`, `max_width` (512).

### `contact_sheet`
`cols` (4), `rows` (4), `start`, `end`, `tile_width` (320), `labels` (true), `title` (true), `background` (`0x111111`), `font_file`, `save_path`, `overwrite`.

### `detect_scenes`
`threshold` (0.3; lower = more sensitive), `min_scene_seconds` (0.4; ignores flash frames), `start`, `end`, `include_sheet` (true, up to 30 scenes), `max_rows` (200), `csv_output_path`, `overwrite`.

### `make_thumbnail`

| Param | Default | Notes |
| --- | --- | --- |
| `preset` | `youtube` | See table above |
| `width` / `height` | — | Custom size |
| `at` | auto | Use this frame instead of auto-picking |
| `start` / `end` | whole clip | Where to look (auto mode skips the first/last 3% for titles and fades) |
| `candidates` | 24 | Frames evaluated |
| `show_candidates` | 4 | Runner-ups returned as images |
| `anchor_x` / `anchor_y` | 0.5 | Crop anchor |
| `output_path` | `<name>_<preset>_thumb.jpg` | `.jpg`, `.png`, `.webp` |
| `quality` | 92 | |
| `overwrite` | false | |

### `extract_frames`
`output_folder`, `mode` (`count` \| `interval` \| `scenes` \| `timestamps`), `count` (12), `interval_seconds`, `times`, `scene_threshold` (0.3), `start`, `end`, `format` (`jpg`|`png`|`webp`), `width`, `prefix`, `max_frames` (200), `overwrite`. Files are named `<prefix>_<HH-MM-SS-mmm>.<ext>`.

### `make_preview`
`start` (0), `duration` (4, max 60), `output_path` (`<name>_preview.gif`; `.gif`/`.mp4`/`.webp`), `fps` (12), `width` (480), `colors` (128), `loop` (true), `dry_run`, `overwrite`.

---

## How it works

- Frames are decoded with accurate input seeking (`-ss` before `-i`), auto-rotated, scaled with Lanczos, and piped straight back as JPEG/PNG — nothing touches disk unless you ask.
- **Scene detection:** ffmpeg's `select='gt(scene,T)'` on a 320 px proxy for speed.
- **Thumbnail scoring:** `signalstats` (brightness, contrast, saturation) and `blurdetect` (sharpness) on each candidate. Black, white, flat and detail-less frames are rejected.
- **Contact sheets:** one ffmpeg graph with a fast seek per tile, `tile` for the grid and `drawtext` for labels. The title is drawn from a temp text file, so odd file names are safe.
- **GIFs:** two-stage palette (`palettegen` + `paletteuse`) for small, clean files.

HDR footage is not tone-mapped, so frames from HDR clips (e.g. iPhone HDR video) can look washed out.

## Safety

- ffmpeg runs via `spawn` with argument arrays — no shell.
- Existing files are never overwritten unless `overwrite: true`, and outputs can't replace the source video.
- No network access, no telemetry.

## Development

```sh
npm install
npm run build
npm test          # unit tests + end-to-end tests on a generated clip with known cuts
npm run inspect   # MCP Inspector
```

`dist/` is committed so `npx github:…` works without a build; CI verifies it matches `src/`.

## Related servers

- [video-probe-mcp](https://github.com/anshumanofficial2002-cpu/video-probe-mcp) — inspect and conform video for each platform
- [caption-forge-mcp](https://github.com/anshumanofficial2002-cpu/caption-forge-mcp) — SRT/VTT/ASS conversion, timing, linting and reel-style captions
- [loudness-check-mcp](https://github.com/anshumanofficial2002-cpu/loudness-check-mcp) — LUFS, true peak, normalization, silence and clipping
- [frame-grab-mcp](https://github.com/anshumanofficial2002-cpu/frame-grab-mcp) — frames, contact sheets, scene cuts and thumbnails your AI can see
- [script-timer-mcp](https://github.com/anshumanofficial2002-cpu/script-timer-mcp) — time, trim and format scripts for short-form video

## License

[MIT](LICENSE) © 2026 Anshuman
