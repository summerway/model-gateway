import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { buildDashboardData } from '../src/ops/dashboard-data.js';
import { EventLog } from '../src/events.js';

// MG24：旧独立页（usage/keys/inbox）与 common.js/common.css 已删除，
// 本文件只保留服务端（buildDashboardData / 静态资源服务）相关用例。

test('probe metadata exposes only safe diagnostics and preserves existing fields',()=>{
  const catalog={providers:[{id:'one',type:'glm',models:[]}]};
  const data=buildDashboardData({catalog,events:new EventLog(10),quotaStore:{probeIds:()=>['one'],snapshot:()=>({one:{ok:false,lastError:'upstream apiKey=PRIVATE_SENTINEL Bearer SECRET',lastErrorAt:'2026-10-27T00:00:00Z'}})}});
  assert.equal(data.providers[0].healthy,true);
  assert.equal(data.providers[0].healthBasis,'configuration');
  assert.equal(data.providers[0].probe.supported,true);
  assert.equal(data.providers[0].probe.ok,false);
  assert.doesNotMatch(JSON.stringify(data),/PRIVATE_SENTINEL|SECRET/);
  assert.match(data.providers[0].probe.lastError,/凭据不可用/);
});

test('shared assets are allowlisted and unrelated files cannot be served as dashboard assets',async(t)=>{
 const handler=createRequestHandler({config:{gateway:{keys:[]}},catalog:{providers:[]},events:new EventLog(10)});
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const [name,type] of [['topology.css','text/css'],['topology.js','text/javascript']]){const res=await fetch(base+'/dashboard/assets/'+name);assert.equal(res.status,200);assert.match(res.headers.get('content-type'),new RegExp(type));assert.equal(res.headers.get('x-content-type-options'),'nosniff');}
 for(const path of ['/dashboard/assets/index.html','/dashboard/assets/config.yaml','/dashboard/assets/..%2F..%2Fconfig.yaml']){const res=await fetch(base+path);assert.notEqual(res.status,200);}
 // MG24：旧共享资源 common.js / common.css 随旧独立页下线，不再可服务
 for(const name of ['common.css','common.js']){const res=await fetch(base+'/dashboard/assets/'+name);assert.equal(res.status,404,`${name} must be gone`);}
});
