import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { postStatus } from "./http.ts";
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
export async function deliver(target: Target, event: WebhookEvent, config: Pick<Config, "timeoutMs" | "retries">, signal: AbortSignal): Promise<DeliveryResult> {
  let attempts = 0;
  let status: number | undefined;
  let headers: Record<string, string>;
  try { headers = resolveHeaders(target.headers); } catch { return { target: target.name, ok: false, attempts }; }
  const body = JSON.stringify(payloadFor(event, target));
  while (!signal.aborted && attempts <= config.retries) {
    attempts++;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
    try {
      status = await postStatus(target.url, { ...headers, "Content-Type": "application/json", "X-Pi-Event-Id": event.id, "X-Pi-Event-Type": event.type }, body, AbortSignal.any([signal, timeout.signal]));
      if (status >= 200 && status < 300) return { target: target.name, ok: true, attempts, status };
      if (status !== 429 && status < 500) break;
    } catch { /* Never leak URL credentials, response bodies, or headers into logs. */ }
    finally { clearTimeout(timer); }
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
  private maxQueueAgeMs: number;
  dropped = 0;
  failed = 0;
  expired = 0;
  delivered = 0;
  constructor({ maxQueueAgeMs = 30000 }: { maxQueueAgeMs?: number } = {}) {
    if (!Number.isFinite(maxQueueAgeMs) || maxQueueAgeMs <= 0) throw new Error("Invalid queue age");
    this.maxQueueAgeMs = maxQueueAgeMs;
  }
  get pending(): number { return [...this.counts.values()].reduce((sum, count) => sum + count, 0); }
  get activeTargets(): number { return this.tails.size; }
  enqueue(event: WebhookEvent, config: Config): void {
    if (this.closed || !config.enabled) return;
    for (const target of config.webhooks) {
      if (!target.enabled || (event.type !== "test" && !target.events.includes(event.type))) continue;
      if (!this.counts.has(target.name) && this.counts.size >= 16) { this.dropped++; continue; }
      const count = this.counts.get(target.name) ?? 0;
      if (count >= 100) { this.dropped++; continue; }
      this.counts.set(target.name, count + 1);
      const queuedAt = performance.now();
      // Filter private fields before retaining the queued event. Do not retain all targets/configs.
      const payload = payloadFor(event, target);
      const deliveryConfig = { timeoutMs: config.timeoutMs, retries: config.retries };
      const next = (this.tails.get(target.name) ?? Promise.resolve()).then(async () => {
        if (this.controller.signal.aborted) { this.dropped++; return; }
        const remainingMs = this.maxQueueAgeMs - (performance.now() - queuedAt);
        if (remainingMs <= 0) { this.expired++; this.dropped++; return; }
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), Math.max(1, Math.ceil(remainingMs)));
        const signal = AbortSignal.any([this.controller.signal, deadline.signal]);
        try {
          if ((await deliver(target, payload, deliveryConfig, signal)).ok) this.delivered++;
          else this.failed++;
        } catch { this.failed++; }
        finally { clearTimeout(timer); }
      }).finally(() => {
        this.counts.set(target.name, (this.counts.get(target.name) ?? 1) - 1);
        if (this.tails.get(target.name) === next) { this.tails.delete(target.name); this.counts.delete(target.name); }
      });
      this.tails.set(target.name, next);
    }
  }
  async close(graceMs = 2000): Promise<void> {
    this.closed = true;
    const timer = setTimeout(() => this.controller.abort(), graceMs);
    try { await Promise.all(this.tails.values()); } finally { clearTimeout(timer); this.controller.abort(); }
  }
}
