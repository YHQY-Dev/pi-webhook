import { setTimeout as delay } from "node:timers/promises";
import { resolveHeaders, type Config, type Target, type EventType } from "./config.ts";

export interface WebhookEvent {
  schemaVersion: 1;
  id: string;
  type: EventType | "test";
  timestamp: string;
  source: "pi";
  session: { id: string; name?: string; cwd?: string };
  data: Record<string, unknown>;
}
export function payloadFor(event: WebhookEvent, target: Target): WebhookEvent {
  const { cwd, ...session } = event.session;
  const { message, ...data } = event.data;
  return { ...event, session: { ...session, ...(target.includeCwd && cwd ? { cwd } : {}) }, data: { ...data, ...(target.includeMessage && typeof message === "string" ? { message: message.slice(0, 2000) } : {}) } };
}
export interface DeliveryResult { target: string; ok: boolean; attempts: number; status?: number }
export async function deliver(target: Target, event: WebhookEvent, config: Config, signal: AbortSignal): Promise<DeliveryResult> {
  let attempts = 0;
  let status: number | undefined;
  let headers: Record<string, string>;
  try { headers = resolveHeaders(target.headers); } catch { return { target: target.name, ok: false, attempts }; }
  const body = JSON.stringify(payloadFor(event, target));
  while (!signal.aborted && attempts <= config.retries) {
    attempts++;
    try {
      const response = await fetch(target.url, { method: "POST", redirect: "error", body, headers: { ...headers, "Content-Type": "application/json", "X-Pi-Event-Id": event.id, "X-Pi-Event-Type": event.type }, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) });
      status = response.status;
      await response.body?.cancel();
      if (response.ok) return { target: target.name, ok: true, attempts, status };
      if (status !== 429 && status < 500) break;
    } catch { /* Never leak URL credentials, response bodies, or headers into logs. */ }
    if (attempts <= config.retries && !signal.aborted) {
      try { await delay(Math.min(250 * 2 ** (attempts - 1), 4000), undefined, { signal }); } catch { break; }
    }
  }
  return { target: target.name, ok: false, attempts, status };
}
/** Ordered per target; bounded in-memory best effort, not a durable message broker. */
export class Dispatcher {
  private tails = new Map<string, Promise<void>>();
  private counts = new Map<string, number>();
  private controller = new AbortController();
  private closed = false;
  dropped = 0;
  failed = 0;
  enqueue(event: WebhookEvent, config: Config): void {
    if (this.closed || !config.enabled) return;
    for (const target of config.webhooks) {
      if (!target.enabled || (event.type !== "test" && !target.events.includes(event.type))) continue;
      const count = this.counts.get(target.name) ?? 0;
      if (count >= 100) { this.dropped++; continue; }
      this.counts.set(target.name, count + 1);
      const next = (this.tails.get(target.name) ?? Promise.resolve()).then(async () => {
        if (this.controller.signal.aborted) return;
        try { if (!(await deliver(target, event, config, this.controller.signal)).ok) this.failed++; }
        catch { this.failed++; }
      }).finally(() => { this.counts.set(target.name, (this.counts.get(target.name) ?? 1) - 1); });
      this.tails.set(target.name, next);
    }
  }
  async close(graceMs = 2000): Promise<void> {
    this.closed = true;
    const timer = setTimeout(() => this.controller.abort(), graceMs);
    try { await Promise.all(this.tails.values()); } finally { clearTimeout(timer); this.controller.abort(); }
  }
}
