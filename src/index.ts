import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig, loadConfig, saveConfig, parseConfig, EVENTS, type Config, type EventType } from "./config.ts";
import { Dispatcher, deliver, type WebhookEvent } from "./delivery.ts";

export default function webhookExtension(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "webhook.json");
  let config: Config = { ...defaultConfig(), enabled: false };
  let dispatcher = new Dispatcher();
  let outcome: "completed" | "aborted" | "error" = "completed";
  let message: string | undefined;
  let runId: string | undefined;
  let startedAt = 0;
  let configuring = false;
  let waiting = 0;
  const makeEvent = (type: EventType | "test", ctx: ExtensionContext, data: Record<string, unknown> = {}): WebhookEvent => ({
    schemaVersion: 1, id: randomUUID(), type, timestamp: new Date().toISOString(), source: "pi",
    session: { id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }, data: { ...(runId ? { runId } : {}), ...data },
  });
  const emit = (type: EventType, ctx: ExtensionContext, data: Record<string, unknown> = {}) => dispatcher.enqueue(makeEvent(type, ctx, data), config);
  async function reload(ctx: ExtensionContext) {
    try { config = await loadConfig(path); }
    catch {
      config = { ...defaultConfig(), enabled: false };
      if (ctx.hasUI) ctx.ui.notify(`Webhook 配置无效，已停止发送。请检查 ${path}`, "error");
    }
  }
  pi.on("session_start", async (_, ctx) => {
    dispatcher = new Dispatcher(); outcome = "completed"; message = undefined; runId = undefined; waiting = 0;
    await reload(ctx);
    emit("session_started", ctx);
  });
  pi.on("agent_start", (_, ctx) => {
    // Automatic retries/continuations may start another low-level loop before settlement.
    if (!runId) { runId = randomUUID(); startedAt = Date.now(); emit("started", ctx); }
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    message = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n").slice(0, 2000);
  });
  pi.on("agent_before_settle", event => { outcome = event.outcome; });
  pi.on("agent_settled", (event, ctx) => {
    const type = event.aborted || outcome === "aborted" ? "cancelled" : outcome === "error" ? "error" : "completed";
    emit(type, ctx, { durationMs: startedAt ? Date.now() - startedAt : 0, ...(message ? { message } : {}) });
    outcome = "completed"; message = undefined; runId = undefined; startedAt = 0; waiting = 0;
  });
  pi.on("ui_prompt_start", (event, ctx) => {
    if (configuring) return;
    waiting++;
    if (waiting === 1) emit("waiting", ctx, { reason: event.reason, kind: event.kind });
  });
  pi.on("ui_prompt_end", (_, ctx) => {
    if (configuring || waiting === 0) return;
    if (--waiting === 0) emit("resumed", ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.isError) emit("tool_error", ctx, { toolName: event.toolName, toolCallId: event.toolCallId });
  });
  pi.on("session_shutdown", async (_, ctx) => { emit("session_closed", ctx); await dispatcher.close(); });

  pi.registerCommand("webhook", {
    description: "Webhook 通知：status | config | reload | on | off | events <接收端> <事件,事件> | test [接收端]",
    handler: async (args, ctx) => {
      const [command = "status", name, selection] = args.trim().split(/\s+/);
      const notify = (text: string, error = false) => { if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info"); };
      try {
        if (command === "status") {
          notify(`${config.enabled ? "已启用" : "已禁用"} · ${path}\n${config.webhooks.map(t => `${t.name}: ${t.enabled ? t.events.join(", ") : "禁用"}`).join("\n")}\n发送失败 ${dispatcher.failed}，队列丢弃 ${dispatcher.dropped}`);
        } else if (command === "reload") {
          await reload(ctx);
          notify(config.enabled ? "Webhook 配置已加载" : "Webhook 当前已禁用");
        } else if (command === "test") {
          if (!config.enabled) throw new Error("disabled");
          const targets = config.webhooks.filter(t => t.enabled && (!name || t.name === name));
          if (!targets.length) throw new Error("no targets");
          const event = makeEvent("test", ctx);
          const results = await Promise.all(targets.map(t => deliver(t, event, config, AbortSignal.timeout(10000))));
          notify(results.map(r => `${r.target}: ${r.ok ? "成功" : "失败"}${r.status ? ` (HTTP ${r.status})` : ""}，尝试 ${r.attempts} 次`).join("\n"), results.some(r => !r.ok));
        } else {
          let next: Config = structuredClone(config);
          if (command === "on" || command === "off") next.enabled = command === "on";
          else if (command === "events") {
            const target = next.webhooks.find(t => t.name === name);
            if (!target || selection === undefined) throw new Error("invalid events command");
            target.events = selection === "none" ? [] : selection.split(",") as EventType[];
          } else if (command === "config") {
            if (!ctx.hasUI) return;
            configuring = true;
            try {
              const text = await ctx.ui.editor("Webhook 配置（请求头建议使用 ${ENV_NAME}）", JSON.stringify(config, null, 2));
              if (text === undefined) return;
              next = parseConfig(JSON.parse(text));
            } finally { configuring = false; }
          } else {
            notify(`用法：/webhook status|config|reload|on|off|test [接收端]|events <接收端> <逗号分隔事件或 none>\n事件：${EVENTS.join(", ")}`);
            return;
          }
          next = parseConfig(next);
          await saveConfig(path, next);
          config = next;
          notify("Webhook 配置已保存（其他会话需执行 /webhook reload）");
        }
      } catch { notify("操作失败：请检查配置、接收端名称、事件名称或网络连接；未保存无效配置。", true); }
    },
  });
}
