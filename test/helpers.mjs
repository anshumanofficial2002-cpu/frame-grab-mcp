// Shared test helpers: generate fixtures with ffmpeg and talk to the built server over stdio.
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const TMP = path.join(here, ".tmp");
mkdirSync(TMP, { recursive: true });

export function hasFfmpeg() {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  return r.status === 0;
}

/** Create a fixture with ffmpeg (cached by name). */
export function fixture(name, args) {
  const out = path.join(TMP, name);
  if (existsSync(out)) return out;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture ${name} failed: ${r.stderr}`);
  return out;
}

export async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "dist", "index.js")],
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export function textOf(result) {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

/** Pull the JSON block a tool appends after its summary. */
export function jsonOf(result) {
  const t = textOf(result);
  const m = t.match(/```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error("no JSON block in result:\n" + t);
  return JSON.parse(m[1]);
}
