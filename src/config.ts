import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const EVENTS = ["started", "completed", "error", "waiting", "resumed", "cancelled", "tool_error", "session_started", "session_closed"] as const;
export type EventType = (typeof EVENTS)[number];
export interface Target {
  name: string;
  url: string;
  enabled: boolean;
  events: EventType[];
  headers: Record<string, string>;
  includeMessage: boolean;
  includeCwd: boolean;
}
export interface Config { enabled: boolean; timeoutMs: number; retries: number; webhooks: Target[] }
export function defaultConfig(): Config {
  return { enabled: true, timeoutMs: 3000, retries: 2, webhooks: [{ name: "default", url: "http://127.0.0.1:24527/", enabled: true, events: ["completed", "error", "waiting"], headers: {}, includeMessage: false, includeCwd: false }] };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown config key: ${key}`);
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("Expected boolean");
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Expected integer ${min}..${max}`);
  return value;
}
export function parseConfig(input: unknown): Config {
  const root = object(input);
  keys(root, ["enabled", "timeoutMs", "retries", "webhooks"]);
  if (!Array.isArray(root.webhooks) || root.webhooks.length > 16) throw new Error("webhooks must be an array with at most 16 targets");
  const names = new Set<string>();
  const webhooks = root.webhooks.map((item): Target => {
    const target = object(item);
    keys(target, ["name", "url", "enabled", "events", "headers", "includeMessage", "includeCwd"]);
    if (typeof target.name !== "string" || !/^[\w.-]{1,64}$/.test(target.name) || names.has(target.name)) throw new Error("Target names must be unique (letters, digits, _, ., -; max 64)");
    names.add(target.name);
    if (typeof target.url !== "string") throw new Error("Expected webhook URL");
    const url = new URL(target.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use an HTTP(S) URL without embedded credentials or fragment");
    if (!Array.isArray(target.events) || !target.events.every(e => typeof e === "string" && EVENTS.includes(e as EventType))) throw new Error("Invalid event list");
    const headers = object(target.headers ?? {});
    for (const [key, value] of Object.entries(headers)) {
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Invalid HTTP header");
      if (["host", "content-length", "content-type", "connection", "transfer-encoding"].includes(key.toLowerCase()) || key.toLowerCase().startsWith("x-pi-")) throw new Error("Reserved HTTP header");
    }
    return { name: target.name, url: url.href, enabled: bool(target.enabled, true), events: [...new Set(target.events)] as EventType[], headers: headers as Record<string, string>, includeMessage: bool(target.includeMessage, false), includeCwd: bool(target.includeCwd, false) };
  });
  return { enabled: bool(root.enabled, true), timeoutMs: integer(root.timeoutMs, 3000, 100, 30000), retries: integer(root.retries, 2, 0, 5), webhooks };
}
export async function loadConfig(path: string): Promise<Config> {
  try { return parseConfig(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig(); throw error; }
}
export async function saveConfig(path: string, config: Config): Promise<void> {
  const text = JSON.stringify(parseConfig(config), null, 2) + "\n";
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600, flag: "wx" }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const secret = process.env[name];
      if (secret === undefined) throw new Error("Missing webhook header environment variable");
      return secret;
    });
    if (/[\r\n]/.test(resolved)) throw new Error("Invalid resolved header");
    return [key, resolved];
  }));
}
