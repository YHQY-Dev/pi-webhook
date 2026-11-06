import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Status-only POST. Drain small bodies for keep-alive; never retain response content. */
export function postStatus(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported protocol");
    if (parsed.username || parsed.password) throw new Error("URL credentials forbidden");
    const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(parsed, {
      method: "POST", signal,
      // Node >= 22 global agents pool keep-alive sockets without a custom background worker.
      headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
    }, (res) => {
      const status = res.statusCode ?? 0;
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 64 * 1024) { resolve(status); res.destroy(); }
      });
      res.on("end", () => resolve(status));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
