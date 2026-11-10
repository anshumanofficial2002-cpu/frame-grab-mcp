/** Small helpers for building MCP tool results. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A readable summary first, then the machine-readable data as JSON. */
export function ok(summary: string, data?: unknown): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: summary }];
  if (data !== undefined) {
    content.push({ type: "text", text: "```json\n" + JSON.stringify(data, null, 2) + "\n```" });
  }
  return { content };
}

export function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Run a tool body and turn any thrown error into an MCP error result. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${Math.round(s)}s`;
  if (m > 0) return `${m}m ${s.toFixed(1)}s`;
  return `${s.toFixed(2)}s`;
}

export function markdownTable(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}
