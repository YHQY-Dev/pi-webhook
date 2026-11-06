import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, parseConfig, loadConfig, saveConfig, resolveHeaders } from "../src/config.ts";
import { Dispatcher, deliver, payloadFor, type WebhookEvent } from "../src/delivery.ts";

const event: WebhookEvent = { schemaVersion: 1, id: "unique-id", type: "completed", timestamp: new Date().toISOString(), source: "pi", session: { id: "session-1", cwd: "private/path" }, data: { message: "private response", durationMs: 123 } };
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  assert(address && typeof address !== "string");
  return { server: instance, url: `http://127.0.0.1:${address.port}/` };
}
function close(instance: Server) { instance.closeAllConnections(); return new Promise<void>((resolve, reject) => instance.close(e => e ? reject(e) : resolve())); }

test("default endpoint, strict config validation, and private-by-default payload", () => {
  const config = defaultConfig();
  assert.equal(config.webhooks[0].url, "http://127.0.0.1:24527/");
  assert.deepEqual(parseConfig(config), config);
  assert.equal(payloadFor(event, config.webhooks[0]).session.cwd, undefined);
  assert.equal(payloadFor(event, config.webhooks[0]).data.message, undefined);
  assert.equal(payloadFor(event, { ...config.webhooks[0], includeCwd: true, includeMessage: true }).data.message, "private response");
  for (const input of [{ ...config, timeoutMs: 0 }, { ...config, typo: true }, { ...config, webhooks: [config.webhooks[0], config.webhooks[0]] }, { ...config, webhooks: [{ ...config.webhooks[0], events: ["typo"] }] }, { ...config, webhooks: [{ ...config.webhooks[0], url: "file:///tmp/test" }] }, { ...config, webhooks: [{ ...config.webhooks[0], headers: { "Content-Type": "bad" } }] }]) assert.throws(() => parseConfig(input));
});
test("config persistence, missing file defaults and malformed file rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-webhook-"));
  try {
    const path = join(dir, "config.json");
    assert.deepEqual(await loadConfig(path), defaultConfig());
    await saveConfig(path, defaultConfig());
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), defaultConfig());
    await writeFile(path, "{");
    await assert.rejects(loadConfig(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("environment headers and newline injection protection", () => {
  process.env.PI_WEBHOOK_TEST_TOKEN = "secret";
  assert.deepEqual(resolveHeaders({ Authorization: "Bearer ${PI_WEBHOOK_TEST_TOKEN}" }), { Authorization: "Bearer secret" });
  delete process.env.PI_WEBHOOK_TEST_TOKEN;
  assert.throws(() => resolveHeaders({ Authorization: "${PI_WEBHOOK_TEST_TOKEN}" }));
  process.env.PI_WEBHOOK_TEST_TOKEN = "bad\r\nheader";
  assert.throws(() => resolveHeaders({ Authorization: "${PI_WEBHOOK_TEST_TOKEN}" }));
  delete process.env.PI_WEBHOOK_TEST_TOKEN;
});
test("HTTP retry preserves event ID and privacy; nonretryable errors stop immediately", async () => {
  let calls = 0;
  const received: unknown[] = [];
  const http = await server((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { calls++; received.push(JSON.parse(body)); assert.equal(req.headers["x-pi-event-id"], event.id); res.writeHead(calls === 1 ? 503 : 200).end(); });
  });
  try {
    const config = defaultConfig(); config.webhooks[0].url = http.url;
    const result = await deliver(config.webhooks[0], event, config, new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(result.attempts, 2);
    assert.deepEqual(received[0], received[1]);
    assert.equal(JSON.stringify(received).includes("private"), false);
  } finally { await close(http.server); }
  let attempts = 0;
  const denied = await server((_, res) => { attempts++; res.writeHead(401).end(); });
  try {
    const config = defaultConfig(); config.webhooks[0].url = denied.url;
    assert.equal((await deliver(config.webhooks[0], event, config, new AbortController().signal)).ok, false);
    assert.equal(attempts, 1);
  } finally { await close(denied.server); }
});
test("redirects are not followed and shutdown aborts slow deliveries", async () => {
  let reached = 0;
  const destination = await server((_, res) => { reached++; res.end(); });
  const redirect = await server((_, res) => res.writeHead(302, { Location: destination.url }).end());
  const hanging = await server(() => {});
  try {
    const config = defaultConfig(); config.retries = 0; config.webhooks[0].url = redirect.url;
    assert.equal((await deliver(config.webhooks[0], event, config, new AbortController().signal)).ok, false);
    assert.equal(reached, 0);
    config.webhooks[0].url = hanging.url;
    const dispatcher = new Dispatcher(); dispatcher.enqueue(event, config);
    const started = Date.now(); await dispatcher.close(50);
    assert(Date.now() - started < 1000);
  } finally { await Promise.all([close(destination.server), close(redirect.server), close(hanging.server)]); }
});
test("per-request timeout and independent target subscriptions", async () => {
  const hanging = await server(() => {});
  const received: WebhookEvent[] = [];
  const http = await server((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { received.push(JSON.parse(body)); res.end(); });
  });
  try {
    const config = defaultConfig(); config.timeoutMs = 100; config.retries = 0;
    config.webhooks[0].url = hanging.url;
    const result = await deliver(config.webhooks[0], event, config, new AbortController().signal);
    assert.equal(result.ok, false); assert.equal(result.attempts, 1);
    config.webhooks.push({ ...config.webhooks[0], name: "errors", url: http.url, events: ["error"], includeMessage: true });
    const dispatcher = new Dispatcher();
    dispatcher.enqueue(event, config);
    dispatcher.enqueue({ ...event, type: "error" }, config);
    await dispatcher.close();
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "error");
    assert.equal(received[0].data.message, "private response");
    assert.equal(dispatcher.failed, 2);
  } finally { await Promise.all([close(hanging.server), close(http.server)]); }
});
test("subscription filters, ordering and bounded queues", async () => {
  const received: string[] = [];
  const http = await server((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { received.push(JSON.parse(body).id); res.end(); });
  });
  try {
    const config = defaultConfig(); config.webhooks[0].url = http.url;
    const dispatcher = new Dispatcher();
    dispatcher.enqueue({ ...event, type: "started" }, config);
    for (let i = 0; i < 102; i++) dispatcher.enqueue({ ...event, id: String(i) }, config);
    assert.equal(dispatcher.dropped, 2);
    await dispatcher.close(10000);
    assert.deepEqual(received, Array.from({ length: 100 }, (_, i) => String(i)));
  } finally { await close(http.server); }
});
