import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultConfig } from '../src/config.ts';
import { Dispatcher, deliver, type WebhookEvent } from '../src/delivery.ts';

const event: WebhookEvent = { schemaVersion: 1, id: 'test', type: 'completed', timestamp: new Date().toISOString(), source: 'pi', session: { id: 'session' }, data: {} };
async function fixture(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const config = defaultConfig(); config.webhooks[0].url = `http://127.0.0.1:${address.port}/`; config.retries = 0;
  return { server, config };
}
test('idle queues release target entries, counters account for delivered events', async t => {
  const { config } = await fixture(t, (req,res) => { req.resume(); req.on('end', () => res.end()); });
  const dispatcher = new Dispatcher();
  for (let i=0;i<50;i++) {
    config.webhooks[0].name = `target-${i}`;
    dispatcher.enqueue({...event,id:String(i)}, structuredClone(config));
    while(dispatcher.pending) await sleep(1);
    assert.equal(dispatcher.activeTargets,0);
  }
  await dispatcher.close(); assert.equal(dispatcher.delivered,50); assert.equal(dispatcher.failed,0);
});
test('queue age caps active delivery, expires backlog, and recovery accepts fresh events', async t => {
  let recovered = false; const received: string[] = [];
  const { config } = await fixture(t, (req,res) => { req.resume(); req.on('end', () => { received.push(String(req.headers['x-pi-event-id'])); if (recovered) res.end(); }); });
  const dispatcher = new Dispatcher({maxQueueAgeMs:100});
  for(let i=0;i<10;i++) dispatcher.enqueue({...event,id:String(i)},config);
  while(dispatcher.pending) await sleep(5);
  assert.equal(dispatcher.failed,1); assert.equal(dispatcher.expired,9); assert.equal(dispatcher.dropped,9);
  assert.deepEqual(received,['0']);
  recovered = true; dispatcher.enqueue({...event,id:'fresh'},config); await dispatcher.close();
  assert.equal(dispatcher.delivered,1); assert.deepEqual(received,['0','fresh']);
});
test('shutdown accounts for discarded queued events and does not leave target state', async t => {
  const { config } = await fixture(t, (req) => req.resume());
  const dispatcher = new Dispatcher();
  for(let i=0;i<100;i++) dispatcher.enqueue({...event,id:String(i)},config);
  await dispatcher.close(30);
  assert.equal(dispatcher.pending,0); assert.equal(dispatcher.activeTargets,0);
  assert.equal(dispatcher.delivered+dispatcher.failed+dispatcher.dropped,100);
});
test('configuration churn cannot create more than 16 active target queues', async t => {
  const { config } = await fixture(t, (req) => req.resume());
  const dispatcher = new Dispatcher();
  for(let i=0;i<100;i++) { const next=structuredClone(config);next.webhooks[0].name=`target-${i}`;dispatcher.enqueue(event,next); }
  assert.equal(dispatcher.activeTargets,16); assert.equal(dispatcher.pending,16); assert.equal(dispatcher.dropped,84);
  await dispatcher.close(30); assert.equal(dispatcher.activeTargets,0);
});
test('native HTTP pools sockets, sends UTF-8 content length and bounds response consumption', async t => {
  const lengths: number[] = []; let connections = 0; let large = false;
  const {server,config} = await fixture(t, (req,res) => { let bytes=0;req.on('data',(chunk:Buffer)=>{bytes+=chunk.length});req.on('end',()=>{assert.equal(bytes,Number(req.headers['content-length']));lengths.push(bytes);if(large)res.end(Buffer.alloc(256*1024));else res.end('{}');}); });
  server.on('connection',()=>connections++);
  for(let i=0;i<20;i++) assert.equal((await deliver(config.webhooks[0],{...event,data:{message:'中文测试'}},config,new AbortController().signal)).ok,true);
  assert.ok(connections<=2); assert.equal(lengths.length,20);
  large=true;
  assert.equal((await deliver(config.webhooks[0],event,config,new AbortController().signal)).ok,true);
});
test('truncated and hanging response bodies cannot hang the queue', async t => {
  const {config} = await fixture(t,(req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Length':'100'});res.write('partial');res.destroy();});});
  config.timeoutMs=100;
  assert.equal((await deliver(config.webhooks[0],event,config,new AbortController().signal)).ok,false);
});
