import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { Dispatcher, type WebhookEvent } from '../src/delivery.ts';
import { defaultConfig } from '../src/config.ts';
import extension from '../src/index.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const percentile = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.floor(values.length*p))] || 0;
const round = (n: number) => Math.round(n * 1000) / 1000;
const mib = (n: number) => round(n / 1024 / 1024);
function gc() { (globalThis as typeof globalThis & { gc?: () => void }).gc?.(); }
const results: unknown[] = [];
async function deliveryCase(name: string, { delayMs = 0, status = 200, burst = false, hang = false, offline = false, secondTarget = false, long = false } = {}) {
  const sent = new Map<string, number>();
  const latencies: number[] = [];
  let received = 0;
  let attempts = 0;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      attempts++;
      if (hang) return;
      const done = () => { if (!res.destroyed) { if (status === 200) { received++; latencies.push(performance.now() - (sent.get(String(req.headers['x-pi-event-id'])) || performance.now())); } res.writeHead(status).end(); } };
      if (delayMs) setTimeout(done, delayMs); else done();
    });
  };
  const http = createServer(handler);
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('listen failed');
  if (offline) await new Promise<void>(resolve => http.close(() => resolve()));
  const healthy = secondTarget ? createServer((req,res) => { req.resume(); req.on('end', () => { received++; latencies.push(performance.now() - (sent.get(String(req.headers['x-pi-event-id'])) || performance.now())); res.end(); }); }) : undefined;
  if (healthy) { healthy.listen(0, '127.0.0.1'); await once(healthy, 'listening'); }
  const config = defaultConfig(); config.webhooks[0].url = `http://127.0.0.1:${address.port}/`;
  config.timeoutMs = long ? 500 : (hang ? 200 : 3000); config.retries = long ? 0 : 2;
  if (healthy) { const addr = healthy.address(); if (!addr || typeof addr === 'string') throw new Error('listen failed'); config.webhooks.push({ ...config.webhooks[0], name: 'healthy', url: `http://127.0.0.1:${addr.port}/` }); }
  const dispatcher = new Dispatcher();
  const enqueue: number[] = [];
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  gc(); const memoryBefore = process.memoryUsage(); let heapPeak = memoryBefore.heapUsed; let rssPeak = memoryBefore.rss;
  const sampler = setInterval(() => { const m = process.memoryUsage(); heapPeak = Math.max(heapPeak,m.heapUsed); rssPeak = Math.max(rssPeak,m.rss); }, 10);
  const cpu = process.cpuUsage(); const start = performance.now();
  const offered = burst || long ? 1000 : 200;
  for (let i = 0; i < offered; i++) {
    const event: WebhookEvent = { schemaVersion: 1, id: `${name}-${i}`, type: 'completed', source: 'pi', timestamp: new Date().toISOString(), session: { id: `session-${i % 8}` }, data: { message: 'x'.repeat(2000) } };
    sent.set(event.id, performance.now());
    const begin = performance.now(); dispatcher.enqueue(event, config); enqueue.push((performance.now()-begin)*1000);
    if (!burst && !long && (i+1)%10===0) await sleep(50);
  }
  const enqueueEnd = performance.now();
  await dispatcher.close(long ? 65000 : (hang || offline || status !== 200 ? 1200 : 15000));
  const finish = performance.now(); const used = process.cpuUsage(cpu);
  clearInterval(sampler); loop.disable(); gc();
  results.push({ name, offered, targets: config.webhooks.length, received, httpAttempts: attempts, dropped: dispatcher.dropped, failed: dispatcher.failed, expired: 'expired' in dispatcher ? dispatcher.expired : 0, enqueueP50Us: round(percentile(enqueue,.5)), enqueueP99Us: round(percentile(enqueue,.99)), totalMs: round(finish-start), closeMs: round(finish-enqueueEnd), latencyP50Ms: round(percentile(latencies,.5)), latencyP95Ms: round(percentile(latencies,.95)), loopP99Ms: round(loop.percentile(99)/1e6), cpuMs: round((used.user+used.system)/1000), heapPeakDeltaMiB: mib(heapPeak-memoryBefore.heapUsed), heapAfterGcDeltaMiB: mib(process.memoryUsage().heapUsed-memoryBefore.heapUsed), rssPeakDeltaMiB: mib(rssPeak-memoryBefore.rss) });
  http.closeAllConnections(); if (!offline) await new Promise<void>(resolve => http.close(() => resolve()));
  if (healthy) { healthy.closeAllConnections(); await new Promise<void>(resolve => healthy.close(() => resolve())); }
}
async function messageCase(includeMessage: boolean) {
  const dir = await mkdtemp(join(tmpdir(),'pi-webhook-bench-'));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  const config = defaultConfig(); config.webhooks[0].includeMessage = includeMessage;
  await writeFile(join(dir,'webhook.json'),JSON.stringify(config));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name,handler), registerCommand: () => {} } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, sessionManager: { getSessionId: () => 'bench', getSessionName: () => undefined } } as unknown as ExtensionContext;
  try {
    extension(pi); await handlers.get('session_start')?.({},ctx);
    const content = Array.from({length:128},()=>({type:'text',text:'x'.repeat(8192)}));
    const event = {message:{role:'assistant',content}};
    for(let i=0;i<20;i++) handlers.get('message_end')?.(event,ctx);
    gc(); const before=process.memoryUsage().heapUsed; const samples:number[]=[]; const cpu=process.cpuUsage(); const start=performance.now();
    for(let i=0;i<500;i++){const t=performance.now();handlers.get('message_end')?.(event,ctx);samples.push((performance.now()-t)*1000);}
    const used=process.cpuUsage(cpu);
    results.push({name:includeMessage?'summary-enabled-1MiB':'summary-disabled-1MiB',messages:500,totalMs:round(performance.now()-start),p50Us:round(percentile(samples,.5)),p99Us:round(percentile(samples,.99)),cpuMs:round((used.user+used.system)/1000),heapDeltaMiB:mib(process.memoryUsage().heapUsed-before)});
    await handlers.get('session_shutdown')?.({},ctx);
  } finally { if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(dir,{recursive:true,force:true}); }
}
await messageCase(false); await messageCase(true);
await deliveryCase('healthy-200ps');
await deliveryCase('burst-1000',{burst:true});
await deliveryCase('slow-50ms',{delayMs:50});
await deliveryCase('offline',{offline:true});
await deliveryCase('http-503',{status:503});
await deliveryCase('timeout',{hang:true});
await deliveryCase('independent-targets',{hang:true,secondTarget:true});
if(process.argv.includes('--long')) await deliveryCase('outage-backlog',{hang:true,long:true});
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,at:new Date().toISOString(),long:process.argv.includes('--long'),results},null,2));
