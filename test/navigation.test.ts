import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectNavigationHost, sessionNavigation } from "../src/navigation.ts";

test("web run records must match this PID; unmatched hosts attempt terminal navigation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-webhook-navigation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await detectNavigationHost(dir, 123), { kind: "terminal", pid: 123 });
  const runs = join(dir, "pi-web-run");
  await mkdir(runs);
  const write = (file: string, value: unknown) => writeFile(join(runs, file), JSON.stringify(value));
  await writeFile(join(runs, "1.json"), "{broken");
  await write("2.json", { nextPid: 999, url: "http://localhost:1111/" });
  await write("3.json", { nextPid: 123, url: "file:///tmp/invalid" });
  await write("4.json", { nextPid: 123, url: "http://user:password@localhost/" });
  assert.deepEqual(await detectNavigationHost(dir, 123), { kind: "terminal", pid: 123 });
  await write("5.json", { nextPid: 123, url: "http://127.0.0.1:30141/" });
  const host = await detectNavigationHost(dir, 123);
  assert.deepEqual(host, { kind: "web", baseUrl: "http://127.0.0.1:30141/" });
  const navigation = sessionNavigation(host, "id &中文");
  assert.equal(navigation.kind, "web");
  if (navigation.kind !== "web") return;
  assert.equal(new URL(navigation.url).searchParams.get("session"), "id &中文");
  assert.equal(new URL(navigation.url).origin, "http://127.0.0.1:30141");
});

test("session links retain path prefixes but clear stale query and fragment", () => {
  const result = sessionNavigation({ kind: "web", baseUrl: "https://example.com/pi/?cwd=old#stale" }, "session-new");
  assert.deepEqual(result, { kind: "web", url: "https://example.com/pi/?session=session-new" });
  assert.deepEqual(sessionNavigation({ kind: "terminal", pid: 23 }, "a"), { kind: "terminal", pid: 23 });
});
