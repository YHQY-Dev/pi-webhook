import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { defaultConfig, EVENTS, saveConfig } from "../src/config.ts";
import type { WebhookEvent } from "../src/delivery.ts";

test("extension lifecycle: no low-level false completion, waiting, recovery, cancellation and commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-webhook-extension-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const received: WebhookEvent[] = [];
  const http = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { received.push(JSON.parse(body)); res.end(); });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); assert(address && typeof address !== "string");
  try {
    const config = defaultConfig(); config.webhooks[0].url = `http://127.0.0.1:${address.port}/`;
    config.webhooks[0].events = [...EVENTS];
    await saveConfig(join(dir, "webhook.json"), config);
    type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
    const handlers = new Map<string, Handler>();
    let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const pi = { on: (type: string, handler: Handler) => handlers.set(type, handler), registerCommand: (_: string, spec: { handler: typeof command }) => { command = spec.handler; } } as unknown as ExtensionAPI;
    const notices: string[] = [];
    const ctx = { cwd: "private-project", hasUI: true, sessionManager: { getSessionId: () => "session-A" }, ui: { notify: (text: string) => notices.push(text), editor: async () => { await handlers.get("ui_prompt_start")?.({ kind: "editor", reason: "ui_prompt" }, ctx); await handlers.get("ui_prompt_end")?.({}, ctx); return undefined; } } } as unknown as ExtensionContext;
    extension(pi);
    const fire = async (type: string, event: Record<string, unknown> = {}) => { await handlers.get(type)?.(event, ctx); };
    await fire("session_start");
    await fire("agent_start");
    await fire("agent_before_settle", { outcome: "error" }); // transient error followed by recovery
    assert.equal(handlers.has("agent_end"), false);
    await fire("agent_start");
    await fire("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
    await fire("ui_prompt_start", { kind: "input", reason: "ui_prompt" });
    await fire("ui_prompt_end"); await fire("ui_prompt_end");
    await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "secret reply" }] } });
    await fire("agent_before_settle", { outcome: "completed" });
    await fire("agent_settled", { aborted: false });
    await fire("agent_start"); await fire("agent_before_settle", { outcome: "error" }); await fire("agent_settled", { aborted: false });
    await fire("agent_start"); await fire("agent_settled", { aborted: true });
    await command?.("config", ctx); // Must not notify about its own settings editor.
    await command?.("events default completed,error,waiting", ctx);
    await command?.("events default typo", ctx);
    assert(notices.some(n => n.includes("操作失败")));
    await fire("session_shutdown");
    assert.deepEqual(received.map(e => e.type), ["session_started", "started", "waiting", "resumed", "completed", "started", "error", "started", "cancelled"]);
    assert(received.every(e => e.session.id === "session-A" && !e.session.cwd && !e.data.message));
    assert.equal(received[1].data.runId, received[4].data.runId);
    assert.notEqual(received[4].data.runId, received[6].data.runId);
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("summary is opt-in, bounded across text blocks, and updated on config reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-webhook-summary-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const received: WebhookEvent[] = [];
  const http = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { received.push(JSON.parse(body)); res.end(); });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); assert(address && typeof address !== "string");
  type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const pi = { on: (type: string, handler: Handler) => handlers.set(type, handler), registerCommand: (_: string, spec: { handler: typeof command }) => { command = spec.handler; } } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "summary" } } as unknown as ExtensionContext;
  const fire = async (type: string, event: Record<string, unknown> = {}) => { await handlers.get(type)?.(event, ctx); };
  const noRead = { role: "assistant", get content() { throw new Error("private content must not be traversed"); } };
  try {
    const config = defaultConfig(); config.webhooks[0].url = `http://127.0.0.1:${address.port}/`;
    config.webhooks[0].events = ["completed"];
    const path = join(dir, "webhook.json");
    await saveConfig(path, config);
    extension(pi); await fire("session_start");
    await fire("message_end", { message: noRead });
    config.webhooks[0].includeMessage = true;
    await saveConfig(path, config); await command?.("reload", ctx);
    await fire("agent_start");
    await fire("message_end", { message: { role: "assistant", content: [
      { type: "thinking", thinking: "never send reasoning" },
      { type: "text", text: "a".repeat(1500) },
      { type: "text", text: "b".repeat(1024*1024) },
      { type: "text", get text() { throw new Error("must stop after 2000 characters"); } },
    ] } });
    await fire("agent_settled", { aborted: false });
    config.webhooks[0].includeMessage = false;
    await saveConfig(path, config); await command?.("reload", ctx);
    await fire("agent_start"); await fire("message_end", { message: noRead }); await fire("agent_settled", { aborted: false });
    config.webhooks[0].includeMessage = true; config.webhooks[0].events = ["waiting"];
    await saveConfig(path, config); await command?.("reload", ctx);
    await fire("message_end", { message: noRead });
    config.webhooks[0].events = ["completed"]; config.webhooks[0].enabled = false;
    await saveConfig(path, config); await command?.("reload", ctx);
    await fire("message_end", { message: noRead });
    config.webhooks[0].enabled = true; config.enabled = false;
    await saveConfig(path, config); await command?.("reload", ctx);
    await fire("message_end", { message: noRead });
    await fire("session_shutdown");
    assert.equal(received.length, 2);
    assert.equal(received[0].data.message, "a".repeat(1500) + "\n" + "b".repeat(499));
    assert.equal(received[1].data.message, undefined);
  } finally {
    await fire("session_shutdown");
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
