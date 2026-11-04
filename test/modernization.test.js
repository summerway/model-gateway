import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { ModelInbox, editModels } from '../src/ops/model-inbox.js';
import { ModelGuard } from '../src/ops/jobs/model-guard.js';
import { UsageLog } from '../src/monitor/store.js';
import { collectCodex, validateCodexBatch, syncCodex } from '../src/monitor/codex-local.js';
import { createRequestHandler } from '../src/gateway/router.js';
import { validateConfig } from '../src/config.js';

const config = () => ({ jobs:{activate:{enabled:false},probe:{enabled:false}},gateway:{keys:[{key:'env:TEST_BUSINESS_KEY',app:'business'}]},providers:[{id:'p',type:'openai',baseUrl:'https://example.com/v1/chat/completions',apiKeyRef:'env:TEST_UPSTREAM_KEY',models:['m']}] });
const candidate = () => ({kind:'upgrade',providerId:'p',family:'gpt',old:'m',model:'n',info:{cost:{input:1,output:2}}});
function temp(t) { const dir=mkdtempSync(join(tmpdir(),'mgw-modern-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }
function inbox(t, extra={}) { const dir=temp(t), configPath=join(dir,'config.json'); writeFileSync(configPath,JSON.stringify(config())); return new ModelInbox({file:join(dir,'inbox.json'),configPath,...extra}); }

test('Inbox deduplicates, persists dismissals, and allows a later version',async t=>{
 const box=inbox(t,{now:()=>now});await box.reconcile([candidate()]);await box.reconcile([candidate()]);assert.equal(box.snapshot().pending,1);
 const id=box.items[0].id;await box.apply(box.preview(id,'dismiss').token);assert.equal(box.items[0].handledAt,new Date(now).toISOString());
 const restarted=new ModelInbox({file:box.file,configPath:box.configPath});await restarted.reconcile([candidate()]);assert.equal(restarted.snapshot().pending,0);assert.equal(restarted.items[0].handledAt,new Date(now).toISOString());
 await restarted.reconcile([{...candidate(),model:'n2'}]);assert.equal(restarted.snapshot().pending,1);assert.deepEqual(JSON.parse(readFileSync(box.configPath)).providers[0].models,['m']);
});
test('Inbox applies only selected provider and rejects stale previews',async t=>{
 const box=inbox(t,{onChange:()=>true});const cfg=config();cfg.providers.push({...cfg.providers[0],id:'other'});writeFileSync(box.configPath,JSON.stringify(cfg));
 await box.reconcile([candidate()]);const id=box.items[0].id;const stale=box.preview(id,'replace');writeFileSync(box.configPath,JSON.stringify({...cfg,note:'external edit'}));await assert.rejects(box.apply(stale.token),/配置已改变/);
 const preview=box.preview(id,'replace');await box.apply(preview.token);const out=JSON.parse(readFileSync(box.configPath));assert.deepEqual(out.providers.map(p=>p.models),[['n'],['m']]);assert.equal(box.items[0].status,'replaced');await assert.rejects(box.apply(preview.token),/预览已失效/);
});
test('Inbox reload failure rolls back config and records retryable failure',async t=>{
 const box=inbox(t,{onChange:()=>false,now:()=>now});await box.reconcile([candidate()]);const before=readFileSync(box.configPath,'utf8');
 await assert.rejects(box.apply(box.preview(box.items[0].id,'replace').token),/配置变更未完成/);assert.equal(readFileSync(box.configPath,'utf8'),before);assert.equal(box.items[0].status,'failed');assert.equal(box.items[0].failedAt,new Date(now).toISOString());
});
test('price changes after preview require reconfirmation using fresh metadata',async t=>{
 let input=1;const box=inbox(t,{metadataFor:()=>({cost:{input,output:2}})});await box.reconcile([candidate()]);const id=box.items[0].id,first=box.preview(id,'replace');input=2;await assert.rejects(box.apply(first.token),/价格或模型能力已更新/);assert.equal(box.preview(id,'replace').prices.model.input,2);
});
test('Inbox persistence failure cannot apply config or strand a processing item',async t=>{
 const box=inbox(t);await box.reconcile([candidate()]);const before=readFileSync(box.configPath,'utf8');const token=box.preview(box.items[0].id,'replace').token;box.save=()=>{throw new Error('disk full');};
 await assert.rejects(box.apply(token),/配置未修改/);assert.equal(readFileSync(box.configPath,'utf8'),before);assert.equal(box.items[0].status,'failed');
});
test('corrupt Inbox state disables management without overwriting the state file',async t=>{
 const dir=temp(t),file=join(dir,'inbox.json');writeFileSync(file,'corrupted');const box=new ModelInbox({file});assert.equal(box.loadError,true);assert.throws(()=>box.snapshot(),/状态无法读取/);await assert.rejects(box.reconcile([candidate()]),/状态无法读取/);assert.equal(readFileSync(file,'utf8'),'corrupted');
});
test('interrupted applied operation recovers from config hash and persists the result',async t=>{
 const box=inbox(t,{onChange:()=>true});await box.reconcile([candidate()]);await box.apply(box.preview(box.items[0].id,'replace').token);
 box.items[0].status='processing';box.save();const recovered=new ModelInbox({file:box.file,configPath:box.configPath});assert.equal(recovered.items[0].status,'replaced');assert.equal(JSON.parse(readFileSync(box.file)).items[0].status,'replaced');
});
test('Inbox add retains old model and retirement removal validates nonempty list',async t=>{
 const box=inbox(t);await box.reconcile([candidate()]);await box.apply(box.preview(box.items[0].id,'add').token);assert.deepEqual(JSON.parse(readFileSync(box.configPath)).providers[0].models,['m','n']);
 await box.reconcile([{...candidate(),kind:'retire',old:'m',model:'m'}]);await box.apply(box.preview(box.items.find(i=>i.kind==='retire').id,'remove').token);assert.deepEqual(JSON.parse(readFileSync(box.configPath)).providers[0].models,['n']);
 await box.reconcile([{...candidate(),kind:'retire',old:'n',model:'n'}]);assert.throws(()=>box.preview(box.items.find(i=>i.model==='n'&&i.kind==='retire').id,'remove'),/non-empty/);
});
test('YAML editing preserves comments and scopes structured models to one provider',()=>{
 const raw='jobs:\n  activate:\n    enabled: false\ngateway:\n  keys:\n    - env:TEST_GATEWAY_KEY\nproviders:\n  - id: p\n    type: openai\n    baseUrl: https://example.com/v1/chat/completions\n    apiKeyRef: env:TEST_UPSTREAM_KEY\n    models:\n      - id: m # retain this comment\n        modalities:\n          - text\n  - id: other\n    type: openai\n    baseUrl: https://example.com/v1/chat/completions\n    apiKeyRef: env:TEST_UPSTREAM_KEY\n    models:\n      - m\n';
 const next=editModels(raw,candidate(),'replace');assert.match(next,/- id: n # retain this comment/);assert.match(next,/modalities:\n          - text/);assert.match(next,/models:\n      - m/);
 const add=editModels(next,{...candidate(),old:'n',model:'x'},'add');assert.match(add,/- x/);
});
test('Inbox emails notify new items once and retain pending items on mail failure',async t=>{
 let calls=0;const box=inbox(t,{notifyCfg:{smtpUrl:'smtp://example.com'},publicUrl:'https://gateway.example.com',mail:async()=>{calls++;return {ok:true};}});
 await box.reconcile([candidate()]);await box.reconcile([candidate()]);assert.equal(calls,1);
 const fail=inbox(t,{notifyCfg:{smtpUrl:'smtp://example.com'},publicUrl:'https://gateway.example.com',mail:async()=>({ok:false})});await fail.reconcile([candidate()]);assert.equal(fail.snapshot().pending,1);assert.ok(fail.items[0].notifyAfter);
});
test('discovery persistence failure retains previous durable Inbox without mailing phantom items',async t=>{
 const box=inbox(t);await box.reconcile([candidate()]);const before=readFileSync(box.file,'utf8');box.save=()=>{throw new Error('disk full');};await assert.rejects(box.reconcile([{...candidate(),model:'next'}]),/disk full/);assert.equal(box.items.length,1);assert.equal(box.items[0].model,'n');assert.equal(readFileSync(box.file,'utf8'),before);
});
test('production guard with Inbox never auto-applies even with dryRun false',async t=>{
 const box=inbox(t);const p={id:'p',type:'codex',models:['gpt-6-sol']};writeFileSync(box.configPath,JSON.stringify({...config(),providers:[p]}));
 const guard=new ModelGuard({providers:[p],jobs:{dryRun:false},configPath:box.configPath,statePath:join(dirnameFile(box.file),'guard.json'),inbox:box});
 guard.discover=async()=>({gpt:{'gpt-7-sol':{tier:'sol',version:7,cost:{input:1,output:1}}},glm:{},deepseek:{}});
 const before=readFileSync(box.configPath,'utf8');await guard.runOnce();assert.equal(readFileSync(box.configPath,'utf8'),before);assert.equal(box.snapshot().pending,1);assert.equal(guard.snapshot().dryRun,true);
});
test('Inbox upgrade discovery evaluates each provider independently',async t=>{
 const box=inbox(t),providers=[{id:'lower',type:'codex',models:['gpt-6-sol']},{id:'latest',type:'codex',models:['gpt-7-sol']}];const guard=new ModelGuard({providers,configPath:box.configPath,statePath:join(dirnameFile(box.file),'guard-per-provider.json'),inbox:box});guard.discover=async()=>({gpt:{'gpt-7-sol':{tier:'sol',version:7,cost:{input:1,output:1}}},glm:{},deepseek:{}});await guard.runOnce();assert.deepEqual(box.items.map(i=>i.providerId),['lower']);
});
function dirnameFile(file){return file.slice(0,file.lastIndexOf('/'));}

const now=Date.parse('2026-10-28T08:00:00Z');
const event=(n,time='2026-10-28T07:00:00Z',last=n)=>({timestamp:time,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:n,cached_input_tokens:0},last_token_usage:{input_tokens:last,output_tokens:last,cached_input_tokens:0}}}});
function session(file,origin='Codex Desktop',rows=[event(10),event(10),event(15,'2026-10-28T07:01:00Z',5)]) { writeFileSync(file,[{type:'session_meta',payload:{originator:origin,model_provider:'openai'}},{type:'turn_context',payload:{model:'gpt-6-sol'}},...rows].map(JSON.stringify).join('\n')+'\n'); }
test('Codex counters use deltas, copied forks deduplicate after receiver restart',t=>{
 const dir=temp(t);session(join(dir,'a.jsonl'));session(join(dir,'b.jsonl'));const batch=collectCodex({sessionDir:dir,now});assert.equal(batch.events.length,4);
 const file=join(dir,'usage.jsonl');let log=new UsageLog({file,now:()=>now});log.importSubscription(validateCodexBatch({events:batch.events},now));assert.equal(log.size,2);
 log=new UsageLog({file,now:()=>now});assert.equal(log.importSubscription(validateCodexBatch({events:batch.events},now)),0);assert.equal(log.size,2);
 const out=log.query({from:new Date(now-86400000),to:new Date(now)});assert.equal(out.totals.tokens,30);assert.equal(out.totals.requests,0);assert.equal(out.totals.failed,0);assert.equal(out.totals.ok,0);
 assert.equal(collectCodex({sessionDir:dir,state:batch.state,now}).events.length,0);
});
test('independent sessions with identical counters stay distinct; fork prefixes retain ancestry',t=>{
 const dir=temp(t);const write=(name,id,parent,start,rows)=>writeFileSync(join(dir,name),[{type:'session_meta',payload:{id,forked_from_id:parent,timestamp:start,originator:'Codex Desktop',model_provider:'openai'}},{type:'turn_context',payload:{model:'gpt-6-sol'}},...rows].map(JSON.stringify).join('\n')+'\n');
 write('a.jsonl','root-a',null,'2026-10-28T06:00:00Z',[event(10)]);write('b.jsonl','root-b',null,'2026-10-28T06:00:00Z',[event(10)]);
 write('c.jsonl','fork','root-a','2026-10-28T07:01:00Z',[event(10),event(15,'2026-10-28T07:02:00Z',5)]);
 const batch=collectCodex({sessionDir:dir,now});const log=new UsageLog({now:()=>now});log.importSubscription(validateCodexBatch({events:batch.events},now));assert.equal(log.size,3);assert.equal(log.buf.reduce((sum,r)=>sum+r.usage.input,0),25);
});
test('Codex first inherited counter uses last usage, resets never produce negative deltas',t=>{
 const dir=temp(t);session(join(dir,'a.jsonl'),'codex_exec',[event(100,undefined,2),event(103,'2026-10-28T07:01:00Z',3),event(1,'2026-10-28T07:02:00Z',1)]);const {events}=collectCodex({sessionDir:dir,now});assert.equal(events.reduce((s,e)=>s+e.usage.input,0),6);assert.ok(events.every(e=>e.client==='cli'));
});
test('Codex partial tail is retried and bounded batches never advance past unacknowledged events',t=>{
 const dir=temp(t),file=join(dir,'a.jsonl');session(file);const text=readFileSync(file,'utf8');writeFileSync(file,text.trimEnd());const a=collectCodex({sessionDir:dir,now,limit:1});assert.equal(a.events.length,1);
 const b=collectCodex({sessionDir:dir,state:a.state,now});assert.equal(b.events.length,0);writeFileSync(file,text);assert.equal(collectCodex({sessionDir:dir,state:b.state,now}).events.length,1);
});
test('Codex sync failure preserves cursor; payload excludes session contents',async t=>{
 const dir=temp(t),stateFile=join(dir,'state.json');session(join(dir,'a.jsonl'));await assert.rejects(syncCodex({sessionDir:dir,stateFile,url:'https://example.com',key:'test-only',now,fetchFn:async()=>({ok:false,status:503})}),/503/);
 let body;await syncCodex({sessionDir:dir,stateFile,url:'https://example.com',key:'test-only',now,fetchFn:async(_u,o)=>{body=JSON.parse(o.body);return {ok:true,json:async()=>({accepted:body.events.length})};}});assert.equal(body.events.length,2);assert.deepEqual(Object.keys(body.events[0]).sort(),['client','id','model','ts','usage']);
});
test('historical import keeps newest records under shared capacity and retention',()=>{
 const log=new UsageLog({maxRecords:2,now:()=>now});log.record({ts:new Date(now).toISOString(),model:'m'});
 const row=(id,age)=>({eventId:id,kind:'subscription',ts:new Date(now-age*86400000).toISOString(),model:'n',client:'codex-local-app',ok:null});
 log.importSubscription([row('a',3),row('b',1),row('old',36)]);assert.equal(log.size,2);assert.ok(log.buf.some(r=>r.model==='m'));assert.ok(log.buf.some(r=>r.eventId==='b'));
});
test('new configuration is retained and collector credential requires env reference',()=>{
 const cfg=validateConfig({...config(),codexUsage:{enabled:true,apiKeyRef:'env:TEST_SYNC_KEY'},modelInbox:{publicUrl:'https://gateway.example.com'}});assert.equal(cfg.codexUsage.enabled,true);assert.equal(cfg.modelInbox.publicUrl,'https://gateway.example.com');assert.throws(()=>validateConfig({...config(),codexUsage:{enabled:true,apiKeyRef:'literal-secret'}}),/apiKeyRef/);
});
test('HTTP receiver isolates sync credentials; Inbox write requires origin and CSRF',async t=>{
 const box=inbox(t);await box.reconcile([candidate()]);const log=new UsageLog({now:()=>now});process.env.TEST_SYNC_KEY='sync-test-only';t.after(()=>delete process.env.TEST_SYNC_KEY);
 const cfg=validateConfig({...config(),codexUsage:{enabled:true,apiKeyRef:'env:TEST_SYNC_KEY'}});
 const server=http.createServer(createRequestHandler({config:cfg,catalog:{providers:cfg.providers},inboxStore:box,usageLog:log}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const headers={'content-type':'application/json',authorization:'Bearer incorrect'};assert.equal((await fetch(base+'/internal/usage/codex',{method:'POST',headers,body:'{"events":[]}'})).status,401);
 headers.authorization='Bearer sync-test-only';assert.equal((await fetch(base+'/internal/usage/codex',{method:'POST',headers,body:'{"events":[]}'})).status,200);
 const body=JSON.stringify({events:[{id:'a'.repeat(64),ts:new Date(now).toISOString(),model:'gpt-6-sol',client:'app',usage:{input:10,output:5,cacheRead:0,cacheWrite:0}}]});
 assert.equal((await (await fetch(base+'/internal/usage/codex',{method:'POST',headers,body})).json()).imported,1);
 assert.equal((await (await fetch(base+'/internal/usage/codex',{method:'POST',headers,body})).json()).imported,0);
 const stats=await (await fetch(base+'/internal/usage?range=30d')).json();assert.equal(stats.totals.requests,0);assert.equal(stats.totals.failed,0);assert.equal(stats.totals.tokens,15);assert.equal(stats.clients[0].client,'codex');assert.ok(stats.filters.clients.includes('codex')); // 4e45c42 起写入归一：codex-local-* → codex
 const app=await (await fetch(base+'/internal/usage?range=30d&client=codex')).json();assert.equal(app.totals.tokens,15);assert.equal(app.clients[0].client,'codex');
 const payload=JSON.stringify({id:box.items[0].id,action:'replace'});assert.equal((await fetch(base+'/internal/inbox/preview',{method:'POST',headers,body:payload})).status,403);
 Object.assign(headers,{origin:base,'x-inbox-csrf':box.csrf});assert.equal((await fetch(base+'/internal/inbox/preview',{method:'POST',headers,body:payload})).status,200);
 headers.origin='https://attacker.example';assert.equal((await fetch(base+'/internal/inbox/preview',{method:'POST',headers,body:payload})).status,403);
});
test('query cache reuses snapshots but invalidates for usage, pricing and catalog changes',async t=>{
 const cfg=validateConfig(config()),log=new UsageLog(),catalog={providers:cfg.providers},pricing={fetchedAt:'first',costOf:()=>0,costFor:()=>({}),typeFor:()=> 'chat'};
 let queries=0;const original=log.query.bind(log);log.query=q=>{queries++;return original(q);};
 const server=http.createServer(createRequestHandler({config:cfg,catalog,usageLog:log,pricing}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url=`http://127.0.0.1:${server.address().port}/internal/usage`;
 await (await fetch(url)).json();await (await fetch(url)).json();assert.equal(queries,1);
 log.record({ts:new Date(Date.now()-1000).toISOString(),model:'m'});const latest=await (await fetch(url)).json();assert.equal(queries,2);assert.equal(latest.totals.requests,1);
 pricing.fetchedAt='second';await (await fetch(url)).json();assert.equal(queries,3);
 catalog.providers=[...catalog.providers];await (await fetch(url)).json();assert.equal(queries,4);
});

test('usage response cache separates abort-only logs while preserving totals',async t=>{
 const cfg=validateConfig(config()),log=new UsageLog();
 const ts=new Date(Date.now()-1000).toISOString();
 log.record({ts,model:'m',client:'normal',ok:true});
 log.record({ts,model:'m',client:'aborted',ok:false,clientAbort:true});
 const server=http.createServer(createRequestHandler({config:cfg,catalog:{providers:cfg.providers},usageLog:log}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/internal/usage`;
 const all=await (await fetch(url)).json();
 const aborted=await (await fetch(url+'?status=abort')).json();
 const allAgain=await (await fetch(url)).json();
 assert.equal(all.logs.length,2);assert.equal(aborted.logs.length,1);
 assert.equal(aborted.logs[0].clientAbort,true);assert.deepEqual(aborted.totals,all.totals);
 assert.deepEqual(allAgain.logs,all.logs);
});

test('failed dismissal persistence restores pending state and does not leave a completion time',async t=>{
 const box=inbox(t,{now:()=>now});await box.reconcile([candidate()]);
 const token=box.preview(box.items[0].id,'dismiss').token;
 box.save=()=>{throw new Error('disk full');};
 await assert.rejects(box.apply(token),/待办保存失败/);
 assert.equal(box.items[0].status,'pending');assert.equal(Object.hasOwn(box.items[0],'handledAt'),false);
 const restored=new ModelInbox({file:box.file,configPath:box.configPath});
 assert.equal(restored.items[0].status,'pending');assert.equal(Object.hasOwn(restored.items[0],'handledAt'),false);
});

test('Inbox apply 生成备份并支持一键回滚', async t => {
  const box=inbox(t,{onChange:()=>true}); await box.reconcile([candidate()]); await box.apply(box.preview(box.items[0].id,'replace').token);
  const snap=box.snapshot();
  assert.ok(snap.rollback && snap.rollback.model==='n' && snap.rollback.canRollback===true, 'snapshot 暴露回滚点');
  const backups = readdirSync(join(box.file,'..')).filter(f=>/^config-backup-/.test(f));
  assert.equal(backups.length,1,'落地前写了一份备份');
  await box.rollback();
  const cfg=JSON.parse(readFileSync(box.configPath,'utf8'));
  assert.deepEqual(cfg.providers[0].models,['m'],'回滚恢复旧模型列表');
  assert.equal(box.snapshot().rollback,null,'回滚后无回滚点');
  const item=box.items.find(i=>i.model==='n');
  assert.ok(item.rolledBackAt,'条目标记已回滚');
});

test('Inbox 回滚在配置被外部修改后拒绝执行', async t => {
  const box=inbox(t,{onChange:()=>true}); await box.reconcile([candidate()]); await box.apply(box.preview(box.items[0].id,'replace').token);
  writeFileSync(box.configPath,JSON.stringify({...config(),note:'external'}));
  await assert.rejects(box.rollback(),/被其他方式修改|人工/);
});

test('model-guard catalogHas 用自身目录快照兜底校验', async t => {
  const dir=temp(t); const configPath=join(dir,'config.json');
  writeFileSync(configPath,JSON.stringify(config()));
  const box=new ModelInbox({file:join(dir,'inbox.json'),configPath,onChange:()=>true,
    validateModel: m => m==='n' || guard.catalogHas(m)});
  const guard=new ModelGuard({providers:config().providers,jobs:{},configPath,statePath:join(dir,'guard.json'),events:{record(){}},inbox:box});
  guard.universe={gpt:{n:{cost:{input:1,output:2}}}};
  await box.reconcile([candidate()]);
  await box.apply(box.preview(box.items[0].id,'replace').token); // validateModel 并集放行
  assert.deepEqual(JSON.parse(readFileSync(configPath,'utf8')).providers[0].models,['n']);
});

test('model-guard start 后立即恢复 state 快照供 catalogHas 兜底', async t => {
  const dir=temp(t); const configPath=join(dir,'config.json');
  writeFileSync(configPath,JSON.stringify(config()));
  const statePath=join(dir,'guard.json');
  writeFileSync(statePath,JSON.stringify({models:{gpt:{'m':{}}},updated:'2026-01-01T00:00:00Z'}));
  const guard=new ModelGuard({providers:config().providers,jobs:{},configPath,statePath,events:{record(){}},fetch:async()=>{throw new Error('上游不可达也不影响兜底')}});
  assert.equal(guard.catalogHas('m'),false,'start 前无快照');
  guard.start();
  await new Promise(r=>setTimeout(r,50));
  assert.equal(guard.catalogHas('m'),true,'start 后立即从 state 恢复');
  guard.timer?.unref?.(); clearInterval(guard.timer);
});
test('new-series candidate (no old) replaces the reference model — first non-monitor, console-parity', async t => {
  const box = inbox(t, { onChange: () => true });
  const cfg = config(); cfg.providers[0].models = [{ id: 'mon', monitor: true }, 'm'];
  writeFileSync(box.configPath, JSON.stringify(cfg));
  await box.reconcile([{ kind: 'upgrade', providerId: 'p', family: 'gpt', old: null, model: 'n', info: { cost: { input: 1, output: 2 } } }]);
  const item = box.items[0];
  assert.equal(item.old, null);
  const pv = box.preview(item.id, 'replace'); // 新系列替换参照（此前服务端 400 无效操作）
  assert.deepEqual(pv.before, ['mon', 'm']);
  assert.deepEqual(pv.after, ['mon', 'n'], '替换第一个非 monitor 模型（monitor 展示位不动）');
  await box.apply(pv.token);
  assert.deepEqual(JSON.parse(readFileSync(box.configPath)).providers[0].models, [{ id: 'mon', monitor: true }, 'n']);
});
test('new-series replace fails closed when the provider has no non-monitor reference', async t => {
  const box = inbox(t);
  const cfg = config(); cfg.providers[0].models = [{ id: 'mon', monitor: true }];
  writeFileSync(box.configPath, JSON.stringify(cfg));
  await box.reconcile([{ kind: 'upgrade', providerId: 'p', family: 'gpt', old: null, model: 'n', info: {} }]);
  assert.throws(() => box.preview(box.items[0].id, 'replace'), /没有可替换的参照模型/);
});
