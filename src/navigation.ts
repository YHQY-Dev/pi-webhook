import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SessionNavigation = { kind: "web"; url: string } | { kind: "terminal"; pid: number };
export type NavigationHost = { kind: "web"; baseUrl: string } | { kind: "terminal"; pid: number };

/** Match this server process, not merely the presence of another running web instance. */
export async function detectNavigationHost(agentDir: string, pid = process.pid): Promise<NavigationHost> {
  const fallback: NavigationHost = { kind: "terminal", pid };
  const dir = join(agentDir, "pi-web-run");
  try {
    const files = await readdir(dir);
    for (const file of files.filter(name => /^\d+\.json$/.test(name)).slice(0, 64)) {
      try {
        const text = await readFile(join(dir, file), "utf8");
        if (text.length > 8192) continue;
        const record = JSON.parse(text);
        if (record.nextPid !== pid || typeof record.url !== "string") continue;
        const url = new URL(record.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
        url.search = ""; url.hash = "";
        return { kind: "web", baseUrl: url.href };
      } catch { /* Ignore stale, incomplete or malformed records. */ }
    }
  } catch { /* A CLI installation normally has no run directory. */ }
  return fallback;
}

export function sessionNavigation(host: NavigationHost, sessionId: string): SessionNavigation {
  if (host.kind === "terminal") return { ...host };
  const url = new URL(host.baseUrl);
  url.search = ""; url.hash = "";
  url.searchParams.set("session", sessionId);
  return { kind: "web", url: url.href };
}
