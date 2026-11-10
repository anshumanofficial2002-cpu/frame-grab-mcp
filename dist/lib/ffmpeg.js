/**
 * Locating and running ffmpeg / ffprobe safely.
 *
 * - Binaries are resolved from FFMPEG_PATH / FFPROBE_PATH, then PATH, then the
 *   usual install folders. The last step matters on macOS: Claude Desktop and
 *   other GUI apps start MCP servers with a minimal PATH that often misses
 *   Homebrew's /opt/homebrew/bin.
 * - Everything runs through spawn() with an argument array. No shell is ever
 *   involved, so file names with spaces, quotes or `$()` are harmless.
 */
import { spawn } from "node:child_process";
import { access, constants, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export class SetupError extends Error {
    constructor(message) {
        super(message);
        this.name = "SetupError";
    }
}
const EXTRA_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
    "C:\\ffmpeg\\bin",
    "C:\\Program Files\\ffmpeg\\bin",
];
const resolved = new Map();
async function isExecutable(p) {
    try {
        await access(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const s = await stat(p);
        return s.isFile();
    }
    catch {
        return false;
    }
}
export function installHelp() {
    return [
        "ffmpeg/ffprobe were not found.",
        "Install them, then restart your MCP client:",
        "  macOS:   brew install ffmpeg",
        "  Ubuntu:  sudo apt install ffmpeg",
        "  Windows: winget install ffmpeg   (or choco install ffmpeg)",
        "Or point the server at existing binaries with the FFMPEG_PATH and FFPROBE_PATH environment variables.",
    ].join("\n");
}
export async function resolveBinary(name) {
    const cached = resolved.get(name);
    if (cached)
        return cached;
    const envVar = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
    const fromEnv = process.env[envVar];
    if (fromEnv) {
        if (await isExecutable(fromEnv)) {
            resolved.set(name, fromEnv);
            return fromEnv;
        }
        throw new SetupError(`${envVar} is set to "${fromEnv}" but that file is not executable.`);
    }
    const exts = process.platform === "win32" ? [".exe", ""] : [""];
    const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...EXTRA_DIRS];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext);
            if (await isExecutable(candidate)) {
                resolved.set(name, candidate);
                return candidate;
            }
        }
    }
    throw new SetupError(installHelp());
}
export async function run(name, args, opts = {}) {
    const bin = await resolveBinary(name);
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const max = opts.maxOutputBytes ?? 64 * 1024 * 1024;
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const out = [];
        const err = [];
        let outLen = 0;
        let errLen = 0;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (d) => {
            if (outLen < max) {
                out.push(d);
                outLen += d.length;
            }
        });
        child.stderr.on("data", (d) => {
            // keep the tail of stderr; ffmpeg prints the useful summary last
            err.push(d);
            errLen += d.length;
            while (errLen > max && err.length > 1)
                errLen -= err.shift().length;
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            const stdoutBuffer = Buffer.concat(out);
            resolve({
                code,
                stdout: opts.binaryStdout ? "" : stdoutBuffer.toString("utf8"),
                stdoutBuffer: opts.binaryStdout ? stdoutBuffer : undefined,
                stderr: Buffer.concat(err).toString("utf8"),
                timedOut,
            });
        });
    });
}
/** Run and throw a readable error on failure. */
export async function runOrThrow(name, args, opts = {}) {
    const res = await run(name, args, opts);
    if (res.timedOut)
        throw new Error(`${name} timed out after ${Math.round((opts.timeoutMs ?? 600000) / 1000)}s.`);
    if (res.code !== 0) {
        const tail = res.stderr.trim().split("\n").slice(-8).join("\n");
        throw new Error(`${name} exited with code ${res.code}.\n${tail}`);
    }
    return res;
}
export async function versionOf(name) {
    const res = await run(name, ["-hide_banner", "-version"], { timeoutMs: 15000 });
    return res.stdout.split("\n")[0]?.trim() ?? "unknown";
}
/** Expand ~ and make absolute. */
export function expandPath(p) {
    let out = p.trim();
    if (out === "~")
        out = os.homedir();
    else if (out.startsWith("~/") || out.startsWith("~\\"))
        out = path.join(os.homedir(), out.slice(2));
    return path.resolve(out);
}
export async function requireFile(p) {
    const abs = expandPath(p);
    let s;
    try {
        s = await stat(abs);
    }
    catch {
        throw new Error(`File not found: ${abs}`);
    }
    if (!s.isFile())
        throw new Error(`Not a file: ${abs}`);
    return abs;
}
export async function requireDir(p) {
    const abs = expandPath(p);
    let s;
    try {
        s = await stat(abs);
    }
    catch {
        throw new Error(`Folder not found: ${abs}`);
    }
    if (!s.isDirectory())
        throw new Error(`Not a folder: ${abs}`);
    return abs;
}
/** Validate an output path: parent folder is created, existing files need overwrite=true. */
export async function prepareOutput(p, overwrite = false, input) {
    const abs = expandPath(p);
    if (input && path.resolve(input) === abs) {
        throw new Error("Output path is the same as the input. Choose a different file name.");
    }
    try {
        await stat(abs);
        if (!overwrite)
            throw new Error(`Output already exists: ${abs}. Pass overwrite: true to replace it.`);
    }
    catch (e) {
        if (e instanceof Error && e.message.startsWith("Output already exists"))
            throw e;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    return abs;
}
/**
 * Parse a timestamp: 12, "12.5", "01:02", "00:01:02.250", "50%" (needs duration).
 */
export function parseTimestamp(value, duration) {
    if (typeof value === "number")
        return clampTime(value, duration);
    const v = value.trim();
    if (v.endsWith("%")) {
        const pct = Number(v.slice(0, -1));
        if (!Number.isFinite(pct))
            throw new Error(`Bad percentage timestamp: ${value}`);
        if (duration === undefined)
            throw new Error("Percentage timestamps need a known duration.");
        return clampTime((pct / 100) * duration, duration);
    }
    if (/^-?\d+(\.\d+)?s?$/.test(v))
        return clampTime(Number(v.replace(/s$/, "")), duration);
    const parts = v.replace(",", ".").split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((x) => x === "" || isNaN(Number(x)))) {
        throw new Error(`Bad timestamp "${value}". Use seconds (12.5), MM:SS, HH:MM:SS.mmm or a percentage (50%).`);
    }
    const nums = parts.map(Number);
    const secs = nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
    return clampTime(secs, duration);
}
function clampTime(t, duration) {
    if (!Number.isFinite(t) || t < 0)
        throw new Error(`Timestamp must be a positive number, got ${t}.`);
    if (duration !== undefined && t > duration)
        return Math.max(0, duration - 0.05);
    return t;
}
export function formatTimestamp(totalSeconds, withMs = true) {
    const sign = totalSeconds < 0 ? "-" : "";
    let s = Math.abs(totalSeconds);
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const whole = Math.floor(s);
    const ms = Math.round((s - whole) * 1000);
    const base = `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ms === 1000 ? whole + 1 : whole).padStart(2, "0")}`;
    return withMs ? `${base}.${String(ms === 1000 ? 0 : ms).padStart(3, "0")}` : base;
}
/** Quote an argument for display in a copy-pasteable shell command (POSIX style). */
export function shellQuote(arg) {
    if (/^[A-Za-z0-9_\-+=.,/:@%]+$/.test(arg))
        return arg;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
export function toCommand(name, args) {
    return [name, ...args].map(shellQuote).join(" ");
}
