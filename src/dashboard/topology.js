/* Configuration topology and local demonstration. Never performs network requests. */
/* 节点渲染是纯 SVG（rect + <image>/嵌套 svg + <text>）：WebKit 对 <foreignObject> 内
   HTML 的缩放绘制有长期 bug（img 会画到错误位置），iOS 上图标错乱的根因即在此。 */
(function(root) {
'use strict';
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const asset = k => `/dashboard/assets/topology/${k}.png`;
// 用户可见文案统一收拢（产品页英文版经 helpers.labels 覆盖，看板走默认中文）。
// 浅合并：device/modes 各自再合一层，其余键整条替换；不传时输出与默认逐字一致。
const DEFAULT_LABELS = {
  title: '链路拓扑',
  modeGroup: '流量演示模式',
  modes: {
    multi: ['多源并发', '随机并发流量，模拟真实的多来源访问节奏'],
    serial: ['单源串行', '单一来源依次演示，逐条走完整链路'],
  },
  demo: '模拟演示',
  play: '播放模拟演示',
  pause: '暂停模拟演示',
  svgLabel: '来源、网关、渠道与模型连接结构',
  chainTip: 'fallback 链：同色胶囊与虚线弧为同一链',
  device: { mac: 'Mac', nas: 'NAS', unknown: '位置未知' },
  apps: '应用',
  gateway: '网关',
  collector: label => `流量采集器（${label}）`,
  chainOf: id => `fallback 链 ${id}`,
  chainMember: names => `（${names.join('、')}成员）`,
  fallback: (from, provider, rewrite) => `${from} 失败转投 → ${provider}${rewrite != null ? `（改写为 ${rewrite}）` : ''}`,
};
const mergeLabels = override => !override ? DEFAULT_LABELS : {
  ...DEFAULT_LABELS, ...override,
  device: { ...DEFAULT_LABELS.device, ...override.device },
  modes: { ...DEFAULT_LABELS.modes, ...override.modes },
};
// 当前生效文案：html() 每次渲染刷新，layout/mount 与 build（经参数）共用。
let L = DEFAULT_LABELS;
function build(data, labelOverride) {
 const copy = mergeLabels(labelOverride);
 const cfg=data.topology??{}, nodes=[],edges=[],routes=[];
 const add=n=>{if(!nodes.some(x=>x.id===n.id))nodes.push(n);return n.id;};
 const edge=(a,b,type='call')=>{const id=JSON.stringify([a,b,type]);if(!edges.some(x=>x.id===id))edges.push({id,a,b,type});return id;};
 const agents=new Map((data.agents??[]).map(a=>[a.app,a]));
 const sources=new Map();
 const source=(app,device)=>{const a=agents.get(app);device=device??({local:'mac',cloud:'nas'}[a?.location]??'unknown');const id=JSON.stringify(['source',app,device]);add({id,type:'source',app,device,label:a?.iconKind==='pi'?'Pi':a?.iconKind==='claudecode'?'Claude Code':a?.iconKind==='codex'?'Codex':a?.iconKind==='openclaw'?'OpenClaw':app,icon:a?.iconKind??(/claude/.test(app)?'claudecode':/codex/.test(app)?'codex':null)});sources.set(app,id);return id;};
 add({id:'gateway',type:'gateway',label:'Model Gateway',image:'gateway'});
 const grouped=new Map();
 for(const g of cfg.appGroups??[]) for(const app of g.apps)grouped.set(app,g);
 const incoming=[];
 for(const k of data.keys??[]) {
  let id;
  const directSource=(cfg.directConnections??[]).find(c=>c.app===k.app);
  if(agents.has(k.app)||directSource)id=source(k.app,agents.has(k.app)?undefined:directSource.device);
  else {
   // 未归类的 key 不上拓扑：「其他应用」分组已移除。
   const g=grouped.get(k.app);
   if(!g)continue;
   id=JSON.stringify(['group',g.id]);add({id,type:'group',label:g.label,image:['knowledge','automation','business'].includes(g.icon)?g.icon:'business',members:[]});nodes.find(n=>n.id===id).members.push(k.app);
  }
  if(!incoming.includes(id))incoming.push(id);
 }
 for(const id of incoming)edge(id,'gateway');
 for(const p of data.providers??[]) {
  const pid=add({id:'provider:'+p.id,type:'provider',label:p.name??p.displayName??p.id,provider:p});
  // monitor 位默认不经网关（claude 直连订阅）；routable 标记的 monitor 位
  // （dashscope /v1/embeddings）流量确实走网关，同样连线并纳入演示路由。
  const viaGateway=!p.monitor||p.routable===true;
  if(viaGateway)edge('gateway',pid);
  for(const m of p.models??[]){const model=typeof m==='string'?m:m.id;const mid=add({id:JSON.stringify(['model',p.id,model]),type:'model',label:model,providerId:p.id});edge(pid,mid);if(viaGateway)for(const s of incoming)routes.push({nodes:[s,'gateway',pid,mid],edges:[edge(s,'gateway'),edge('gateway',pid),edge(pid,mid)]});}
 }
 // Fallback chains（dashboard 聚合的逐模型 chain）：模型胶囊之间的失败转投虚线弧。
 // 纯配置示意——模拟粒子永远不经过这些边，只有 hover/选中时高亮。
 for(const p of data.providers??[]) {
  for(const m of p.models??[]) {
   const entry=typeof m==='string'?{id:m}:m;
   const chain=Array.isArray(entry.chain)?entry.chain:[];
   for(let i=0;i+1<chain.length;i++){
    const aId=JSON.stringify(['model',chain[i].providerId,chain[i].model]);
    const bId=JSON.stringify(['model',chain[i+1].providerId,chain[i+1].model]);
    const a=nodes.find(n=>n.id===aId),b=nodes.find(n=>n.id===bId);
    if(!a||!b)continue;
    const target=chain[i+1];
    // edge() 先拿 id 再 find：不能在 find 回调里调 edge()（会边遍历边追加，
    // find 的长度快照看不到新元素）。
    const fbId=edge(aId,bId,'fallback');
    const fb=edges.find(x=>x.id===fbId);
    // 首个链胜出（同一弧可能同时属于多条链）；后续链只记成员关系，不改色
    fb.group ??= entry.id;
    fb.label=copy.fallback(entry.id, target.provider??target.providerId, target.model!==entry.id?target.model:null);
    (a.fallbackOf??=[]).includes(entry.id)||a.fallbackOf.push(entry.id);
    (b.fallbackOf??=[]).includes(entry.id)||b.fallbackOf.push(entry.id);
   }
  }
 }
 for(const c of cfg.directConnections??[]) {
  const sid=source(c.app,c.device),alias=c.providerId==='codex-local'?'codex':c.providerId;
  const pid='provider:'+alias;
  if(!nodes.some(n=>n.id===pid))add({id:pid,type:'provider',label:alias==='claude'?'Claude':alias==='codex'?'Codex':alias,provider:{id:alias,monitor:true,models:[]}});
  const direct=edge(sid,pid);
  let tail=[],tailNodes=[];
  if(c.collectorId){const cdef=(cfg.collectors??[]).find(x=>x.id===c.collectorId);if(cdef){const cid=add({id:'collector:'+cdef.id,type:'collector',label:cdef.label,image:'collector'});tail=[edge(sid,cid,'collect'),edge(cid,'gateway','collect')];tailNodes=[cid,'gateway'];}}
  const models=nodes.filter(n=>n.type==='model'&&n.providerId===alias);
  for (const m of models.length ? models : [null]) {
    const invocation = { nodes: [sid, pid, ...(m ? [m.id] : [])], edges: [direct, ...(m ? [edge(pid, m.id)] : [])] };
    const branches = [invocation];
    if (tail.length) branches.push({ nodes: [sid, ...tailNodes], edges: tail });
    routes.push({ nodes: [...invocation.nodes, ...tailNodes], edges: [...invocation.edges, ...tail], branches });
  }
 }
 return {nodes,edges,routes};
}

let selected = null;
let paused = false;
let scrollLeft = 0;
// 流量演示模式：multi=多源并发随机（默认），serial=单源串行（逐个来源演示完整链路）。
const MODES = ['multi', 'serial'];
let mode = (() => { try { return localStorage.getItem('tp-mode') === 'serial' ? 'serial' : 'multi'; } catch { return 'multi'; } })();
const CHAIN_COLORS = ['#7c5cd6', '#2e9e83', '#d97b2f', '#c94f6d', '#3d68a5'];
// color-mix/rgba 颜色计算工具（胶囊填充等内联绘制）
const hexRgb = h => {
  let s = String(h ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = [...s].map(c => c + c).join('');
  const n = /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : NaN;
  return Number.isNaN(n) ? [134, 189, 250] : [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const rgbaCss = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const mixRgb = (a, b, t) => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
// Simulation clock and the running scene survive remounts: selecting a node or
// clearing selection rerenders the card, and the demonstration must keep playing
// through that rebuild instead of restarting from zero.
let anim = { elapsed: 0, scene: null };
let cleanup = () => {};
// cleanup 只执行一次：render() 先 stop()（旧 DOM 还在树上，滚动位置此时保存才有效），
// 再 innerHTML 替换、mount 首行二次清理 —— 若不自清零，旧闭包会在脱离文档的节点上重读
// scrollLeft（恒 0），把已保存的横滚位置覆盖掉（移动端选节点/自动刷新后跳回最左）。
const runCleanup = () => { const fn = cleanup; cleanup = () => {}; fn(); };
function playbackIcon() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">${paused ? '<path d="M5 3.3a.5.5 0 0 1 .76-.43l7 4.2a.5.5 0 0 1 0 .86l-7 4.2A.5.5 0 0 1 5 11.7Z"/>' : '<rect x="4" y="3" width="3" height="10" rx=".7"/><rect x="9" y="3" width="3" height="10" rx=".7"/>'}</svg>`;
}


/** Measure one continuous branch, including travel inside its node ports.
 * Direct invocation and collection are measured separately and share emission times.
 * Movement durations are always length / speed; there is no per-edge easing. */
function measureJourney(edges) {
  const segments = [];
  let previous = null;
  for (const edge of edges) {
    if (previous) {
      if (previous.b !== edge.a) {
        throw new Error('Parallel topology branches must be measured separately');
      } else {
        const length = Math.hypot(edge.start.x - previous.end.x, edge.start.y - previous.end.y);
        if (length > 0) segments.push({ kind: 'inside', length });
      }
    }
    segments.push({ ...edge, kind: 'edge' });
    previous = edge;
  }
  return segments;
}

/** Pure absolute-time sampler: frame overshoot is preserved across all nodes. */
function sampleJourney(segments, speed, elapsedMs) {
  let remaining = Math.max(0, elapsedMs);
  let traveled = 0;
  const arrivals = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const duration = segment.length / speed * 1000;
    if (remaining < duration) {
      const distance = remaining / 1000 * speed;
      return { done: false, segment, index, distance, traveled: traveled + distance, arrivals };
    }
    remaining -= duration;
    traveled += segment.length ?? 0;
    if (segment.kind === 'edge') arrivals.push(segment.b);
  }
  return { done: true, traveled, arrivals };
}

function makeParticles(random = Math.random) {
  // One ordered application stream shares a transit rate. Jitter belongs to the
  // emission intervals and the next scene, never independent speeds that overtake.
  const speed = 155 + random() * 55;
  let delayMs = 0;
  return [0, 1, 2].map(index => {
    if (index) delayMs += 170 + random() * 120;
    return { speed, delayMs, radius: 3.8 - index * 0.45, opacity: 1 - index * 0.16, reached: new Set() };
  });
}

function measureScene(route, measuredEdges) {
  return (route.branches ?? [route]).map(branch => measureJourney(branch.edges.map(id => measuredEdges.get(id))));
}

/* ── 纯 SVG 文本工具：无 DOM 依赖（html() 会在 node:test 的 VM 里执行），
      按字符类别估算宽度截断，替代 foreignObject 里的 CSS ellipsis。 ── */
const charWidth = c => /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(c) ? 1
  : /[iljt.,:;'|!()\[\]{}-]/.test(c) ? 0.32
  : /[fpr]/.test(c) ? 0.44
  : /[mwMW@]/.test(c) ? 0.92
  : /[A-Z]/.test(c) ? 0.68
  : /\s/.test(c) ? 0.3 : 0.55;
function fitText(text, maxPx, fontSize) {
  if (!text) return '';
  let total = 0;
  for (const c of text) total += charWidth(c);
  if (total * fontSize <= maxPx) return text;
  let acc = 0.8; // 省略号预留
  for (let i = 0; i < text.length; i++) {
    acc += charWidth(text[i]);
    if (acc * fontSize > maxPx) return text.slice(0, Math.max(0, i)) + '…';
  }
  return text;
}

/** 把内联 <svg> 图标标记嵌进拓扑坐标系（去掉 HTML 上下文的 class/固定尺寸）。 */
function nestSvg(markup, x, y, w, h) {
  return String(markup).replace(/<svg\b[^>]*/i, m => m
    .replace(/\sclass="[^"]*"/i, '')
    .replace(/\s(?:width|height)="[^"]*"/gi, '')
    .replace(/^<svg/i, `<svg class="tp-nested" x="${x}" y="${y}" width="${w}" height="${h}"`));
}
const imgGlyph = (href, x, y, s, cls = '', filter = '') =>
  `<image${cls ? ` class="${cls}"` : ''}${filter ? ` filter="${filter}"` : ''} href="${esc(href)}" x="${x}" y="${y}" width="${s}" height="${s}" preserveAspectRatio="xMidYMid meet"/>`;

function layout(graph) {
  const positions = new Map();
  const regions = [];
  const devices = [...new Set(graph.nodes.filter(n => n.type === 'source').map(n => n.device))]
    .sort((a, b) => (a === 'mac' ? 0 : a === 'nas' ? 1 : 2) - (b === 'mac' ? 0 : b === 'nas' ? 1 : 2));
  const deviceLabel = device => (L.device[device] ?? device);

  // Source column (Mac / NAS / 应用) is measured first so the whole stack can be
  // vertically centered against the full canvas — the provider column is usually
  // taller and a top-aligned source column reads unbalanced.
  const column = [];
  const collect = (label, members, device) => {
    if (members.length) column.push({ label, device, members, h: 42 + members.length * 58 });
  };
  for (const device of devices) {
    collect(deviceLabel(device),
      graph.nodes.filter(n => n.type === 'source' && n.device === device), device);
  }
  collect(L.apps, graph.nodes.filter(n => n.type === 'group'), 'apps');
  const gap = 18;
  const leftTotal = column.reduce((sum, r) => sum + r.h, 0) + Math.max(0, column.length - 1) * gap;

  let providerY = 52;
  for (const provider of graph.nodes.filter(n => n.type === 'provider')) {
    positions.set(provider.id, { x: 804, y: providerY, w: 284, h: 38 });
    const models = graph.nodes.filter(n => n.type === 'model' && n.providerId === provider.provider.id);
    // Full catalogue: every model renders as its own pill stacked under its
    // provider — no hidden "more" popover.
    models.forEach((m, index) => positions.set(m.id, { x: 850, y: providerY + 46 + index * 35, w: 234, h: 29 }));
    providerY += 46 + models.length * 35 + (models.length ? 43 : 40);
  }
  const height = Math.max(390, leftTotal + 40, providerY + 16);
  let y = Math.max(28, Math.round((height - leftTotal) / 2));
  for (const block of column) {
    regions.push({ label: block.label, device: block.device, x: 20, y, w: 280, h: block.h });
    block.members.forEach((node, index) => positions.set(node.id, { x: 36, y: y + 34 + index * 58, w: 248, h: 48 }));
    y += block.h + gap;
  }
  const gatewayY = Math.max(110, height / 2 - 44);
  positions.set('gateway', { x: 488, y: gatewayY, w: 88, h: 88 });
  let collectorY = gatewayY + 154;
  for (const collector of graph.nodes.filter(n => n.type === 'collector')) {
    positions.set(collector.id, { x: 508, y: collectorY, w: 48, h: 48 });
    collectorY += 76;
  }
  const serviceBottom = Math.max(gatewayY + 88, ...graph.nodes.filter(n => n.type === 'collector').map(n => {
    const p = positions.get(n.id);
    return p.y + p.h;
  }));
  regions.push({ label: 'Model Gateway', device: 'service', x: 424, y: gatewayY - 48, w: 216, h: serviceBottom - gatewayY + 72 });
  return { positions, regions, height: Math.max(height, collectorY + 12), width: 1160 };
}

function html(data, helpers = {}) {
  L = mergeLabels(helpers.labels);
  const graph = build(data, L);
  if (selected && !graph.nodes.some(n => n.id === selected)) selected = null;
  // 每条 fallback 链一个专属色：弧线、胶囊描边、胶囊内小圆点、头部图例芯片同源着色，
  // 多链共享的胶囊用圆点叠加标示（智谱 1/2 同时在两条链上）。
  const chainGroups = [...new Set(graph.edges.filter(e => e.type === 'fallback').map(e => e.group))].sort();
  const chainColor = g => CHAIN_COLORS[Math.max(0, chainGroups.indexOf(g)) % CHAIN_COLORS.length];
  // 来源/渠道专属色：同一安全色板轮转（来源偏移两位降低与渠道撞色）。
  // 来源色=呼吸外框+粒子三球+沿途不变色；渠道色=icon 到达光晕。
  // 分组卡（知识/业务）也是发射方，同样参与来源色轮转。
  const provNodes = graph.nodes.filter(n => n.type === 'provider');
  const emitNodes = graph.nodes.filter(n => n.type === 'source' || n.type === 'group');
  // 渠道到达光只有两色：绿 = 状态正常可访问；红 = 异常转投（rejected 演示，
  // CSS 里 --halo 覆盖）。不再使用专属色轮转。
  const GLOW_OK = '#2e9e83';
  const glowOf = new Map([
    ...provNodes.map(n => [n.id, GLOW_OK]),
    ...emitNodes.map((n, i) => [n.id, CHAIN_COLORS[(i + 2) % CHAIN_COLORS.length]]),
  ]);
  const { positions, regions, height, width } = layout(graph);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const routes = selected ? graph.routes.filter(r => r.nodes.includes(selected)) : graph.routes;
  const lit = new Set(routes.flatMap(r => r.nodes));
  const litEdges = new Set(routes.flatMap(r => r.edges));
  const opacity = id => selected && !lit.has(id) ? 0.25 : 1;
  const point = (id, side) => {
    const p = positions.get(id);
    const node = byId.get(id);
    if (!p) return null;
    if (node.type === 'gateway') return { x: p.x + (side === 'out' ? 77 : 11), y: p.y + 50 };
    if (node.type === 'collector') return { x: p.x + p.w * (side === 'out' ? .84 : .08), y: p.y + p.h * .52 };
    if (node.type === 'provider') return { x: p.x + (side === 'out' ? 34 : 2), y: p.y + 19 };
    return { x: p.x + (side === 'out' ? p.w : 0), y: p.y + p.h / 2 };
  };
  let directLane = 0;
  // 选中模型时点亮其所属 fallback 链（其余弧线随场景一起压暗）。
  const fallbackLit = new Set();
  if (selected) {
    for (const g of byId.get(selected)?.fallbackOf ?? []) {
      for (const e of graph.edges) if (e.type === 'fallback' && e.group === g) fallbackLit.add(e.id);
    }
  }
  const paths = graph.edges.map(edge => {
    const a = point(edge.a, 'out');
    const b = point(edge.b, 'in');
    if (!a || !b) return '';
    let d;
    if (edge.type === 'fallback') {
      // 失败转投弧：从胶囊右缘绕到右侧留白，再折回目标胶囊右缘。
      const f = point(edge.b, 'out');
      d = `M${a.x},${a.y} C${a.x + 46},${a.y} ${f.x + 46},${f.y} ${f.x},${f.y}`;
      const color = chainColor(edge.group);
      return `<path data-edge="${esc(edge.id)}" class="tp-edge tp-fallback" style="--tp-chain:${color}" d="${d}" marker-end="url(#tp-fb-arrow-${chainGroups.indexOf(edge.group)})" opacity="${selected && !fallbackLit.has(edge.id) ? 0.12 : 1}"><title>${esc(edge.label)}</title></path>`;
    }
    const internal = byId.get(edge.b).type === 'model';
    if (internal) {
      const p = positions.get(edge.a);
      d = `M${p.x + 19},${p.y + p.h} C${p.x + 19},${b.y} ${b.x - 12},${b.y} ${b.x},${b.y}`;
    } else if (byId.get(edge.a).type === 'source' && byId.get(edge.b).type === 'provider') {
      const top = 12 + directLane++ * 12;
      d = `M${a.x},${a.y} C${a.x + 90},${top} ${b.x - 150},${top} ${b.x},${b.y}`;
    } else if (edge.type === 'collect' && edge.b === 'gateway') {
      const c = positions.get(edge.a), g = positions.get('gateway');
      d = `M${c.x + c.w * .545},${c.y + c.h * .28} C${c.x + c.w * .545},${c.y - 24} ${g.x + g.w / 2},${g.y + 90} ${g.x + g.w / 2},${g.y + 51}`;
    } else {
      d = `M${a.x},${a.y} C${a.x + 80},${a.y} ${b.x - 80},${b.y} ${b.x},${b.y}`;
    }
    return `<path data-edge="${esc(edge.id)}" class="tp-edge${edge.type === 'collect' ? ' tp-collect' : ''}${internal ? ' tp-internal' : ''}" d="${d}" opacity="${selected && !litEdges.has(edge.id) ? 0.12 : 1}"/>`;
  }).join('');

  // Line icons for the source regions; color follows each region's label tint.
  const regionIcons = {
    mac: '<rect x="2.2" y="2.8" width="11.6" height="8" rx="1.2"/><path d="M1 13.2h14"/>',
    nas: '<rect x="2.2" y="2" width="11.6" height="5.2" rx="1.1"/><rect x="2.2" y="8.8" width="11.6" height="5.2" rx="1.1"/><circle cx="4.6" cy="4.6" r=".6" fill="currentColor" stroke="none"/><circle cx="4.6" cy="11.4" r=".6" fill="currentColor" stroke="none"/>',
    apps: '<rect x="2" y="2" width="5" height="5" rx="1.1"/><rect x="9" y="2" width="5" height="5" rx="1.1"/><rect x="2" y="9" width="5" height="5" rx="1.1"/><rect x="9" y="9" width="5" height="5" rx="1.1"/>',
  };
  const backgrounds = regions.map(r => {
    const icon = regionIcons[r.device];
    return `<g class="tp-region tp-region-${esc(r.device)}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="15" fill="url(#tp-region-fill)" stroke="var(--hair)"/>${icon ? `<svg class="tp-region-icon" x="${r.x + 14}" y="${r.y + 11}" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icon}</svg>` : ''}<text x="${r.x + (icon ? 32 : 16)}" y="${r.y + 22}" class="tp-section">${esc(r.label)}</text></g>`;
  }).join('');
  let glowN = 0;
  const glowDefs = [];
  const boxes = graph.nodes.filter(n => positions.has(n.id)).map(node => {
    const p = positions.get(node.id);
    const isCard = ['source', 'group'].includes(node.type);
    const isModel = node.type === 'model';
    // 链成员胶囊按链着色；同时属于多条链的用叠层小圆点标示（顺序与图例一致）。
    const chains = isModel && node.fallbackOf?.length ? [...new Set(node.fallbackOf)].sort((a, b) => chainGroups.indexOf(a) - chainGroups.indexOf(b)) : [];
    const glowC = glowOf.get(node.id);
    const styleVars = `${chains.length ? `--tp-chain:${chainColor(chains[0])};` : ''}${glowC ? `--glow-c:${glowC};` : ''}`;
    const frameStyle = styleVars ? ` style="${styleVars}"` : '';
    const dots = chains.length ? `<g class="tp-chain-dots">${chains.map((c, i) => `<circle cx="${p.x + p.w - 8 - (chains.length - 1 - i) * 8}" cy="${p.y + p.h / 2}" r="2.4" fill="${chainColor(c)}"/>`).join('')}</g>` : '';
    const title = node.members ? `${node.label}：${node.members.join('、')}` : node.label;
    // The middle glyphs are nameless by design; hover identifies them:
    // 网关 vs 流量采集器.
    const hover = node.type === 'gateway' ? L.gateway : node.type === 'collector' ? L.collector(node.label) : title + (chains.length ? L.chainMember(chains.map(c => L.chainOf(helpers.model?.(c) ?? c))) : '');
    const label = isModel ? helpers.model?.(node.label) ?? node.label : node.label;
    const rx = isModel ? 8 : isCard ? 10 : node.type === 'provider' ? 9 : 12;
    // 发光滤镜：SVG 原生 feDropShadow，逐帧由 JS 改 flood-color/opacity。
    // 不能用 CSS filter（drop-shadow/invert/blur）：WebKit 不支持对 SVG 元素套
    // CSS filter，iOS Chrome/Safari 上会全部无效（桌面 Chromium 正常，极易漏测）。
    let myGlow = 0;
    if (!isCard && (isModel || ['gateway', 'collector', 'provider'].includes(node.type))) {
      myGlow = ++glowN;
      glowDefs.push(`<filter id="tp-glow-${myGlow}" x="-60%" y="-160%" width="220%" height="420%"><feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="#86bdfa" flood-opacity="0"/><feDropShadow dx="0" dy="0" stdDeviation="3.5" flood-color="#86bdfa" flood-opacity="0"/></filter>`);
    }
    // 来源外框呼吸光晕（见 .tp-halo）：仅来源/分组卡创建，icon 不跟着亮；
    // 模糊用 SVG 原生 feGaussianBlur（同理不能用 CSS blur）。
    const halo = ['source', 'group'].includes(node.type) ? `<rect class="tp-halo" filter="url(#tp-blur)" x="${p.x - 1}" y="${p.y - 1}" width="${p.w + 2}" height="${p.h + 2}" rx="${rx + 1}"/>` : '';
    const shape = isCard || isModel ? `<rect class="${isModel ? 'tp-pill-shape' : 'tp-source-shape'}${chains.length ? ' tp-pill-chain' : ''}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${rx}"/>` : '';
    // 图标：渠道 logo / Agent 内联 svg / 分组插画，纯 SVG 元素（见文件头注释）；
    // .tp-glyph 包一层用于 drop-shadow 柔光。
    let glyph = '';
    if (node.type === 'gateway') glyph = imgGlyph(asset('gateway'), p.x, p.y, Math.min(p.w, p.h));
    else if (node.type === 'collector') glyph = imgGlyph(asset('collector'), p.x, p.y, Math.min(p.w, p.h));
    else if (node.type === 'provider') {
      const g = helpers.provider?.(node.provider);
      if (g) {
        const href = typeof g === 'string' ? g : g.href;
        // 暗色反色：保留 invert-d 类，由 CSS 主题门控引用 url(#tp-invert)
        // （CSS invert 函数对 SVG image 在 WebKit 无效，见 topology.css 注释）
        const s = 32;
        glyph = imgGlyph(href, p.x + 3, p.y + (p.h - s) / 2, s, `tp-glyph-img${typeof g === 'object' && g.invert ? ' invert-d' : ''}`);
      }
    } else if (isCard) {
      const s = 28, gx = p.x + 12, gy = p.y + (p.h - s) / 2;
      if (node.image) glyph = imgGlyph(asset(node.image), gx, gy, s);
      else if (node.icon) glyph = helpers.agent?.(node.icon) ? nestSvg(helpers.agent(node.icon), gx, gy, s, s) : '';
      else glyph = imgGlyph(asset('business'), gx, gy, s);
    }
    glyph = glyph ? `<g class="tp-glyph"${myGlow ? ` filter="url(#tp-glow-${myGlow})"` : ''}>${glyph}</g>` : '';
    // 文本：宽屏/纵向布局各自的字形几何 + 估算截断。
    let text = '';
    const midY = p.y + p.h / 2;
    if (isModel) {
      const shown = fitText(label, p.w - 20 - (chains.length ? 24 : 0), 11.5);
      text = `<text class="tp-label"${myGlow ? ` filter="url(#tp-glow-${myGlow})"` : ''} x="${p.x + 10}" y="${midY}" dominant-baseline="central">${esc(shown)}</text>`;
    } else if (isCard) {
      const shown = fitText(label, p.w - 64, 13);
      text = `<text class="tp-label" x="${p.x + 52}" y="${midY}" dominant-baseline="central">${esc(shown)}</text>`;
    } else if (node.type === 'provider') {
      const shown = fitText(label, p.w - 54, 13);
      text = `<text class="tp-label tp-label-strong" x="${p.x + 50}" y="${midY}" dominant-baseline="central">${esc(shown)}</text>`;
    }
    return `<g data-tp-frame="${esc(node.id)}" data-tp-node="${esc(node.id)}"${myGlow ? ` data-tp-gf="tp-glow-${myGlow}"` : ''} role="button" tabindex="0" class="tp-node-frame tp-${node.type}${chains.length ? ' tp-model-chain' : ''}${selected === node.id ? ' tp-selected' : ''}"${frameStyle} aria-pressed="${selected === node.id}" aria-label="${esc(hover)}" opacity="${opacity(node.id)}"><title>${esc(hover)}</title>${halo}${shape}${glyph}${text}${dots}<rect class="tp-focus" x="${p.x - 2.5}" y="${p.y - 2.5}" width="${p.w + 5}" height="${p.h + 5}" rx="${rx + 2.5}"/></g>`;
  }).join('');
  const chainLegend = chainGroups.length ? `<span class="tp-chains">${chainGroups.map((g, i) => `<span class="tp-chain-chip" style="--tp-chain:${CHAIN_COLORS[i % CHAIN_COLORS.length]}" title="${esc(L.chainTip)}"><i></i>${esc(helpers.model?.(g) ?? g)}</span>`).join('')}</span>` : '';
  return `<section class="card tp-card" aria-label="${esc(L.title)}"><div class="card-h"><h2>${esc(L.title)}</h2><div class="tp-controls">${chainLegend}<span class="tp-mode" role="group" aria-label="${esc(L.modeGroup)}">${MODES.map(v => { const [label, tip] = L.modes[v]; return `<button type="button" data-tp-mode="${v}" aria-pressed="${mode === v}" title="${esc(tip)}">${esc(label)}</button>`; }).join('')}</span><span class="tp-demo">${esc(L.demo)}</span><button data-tp-play aria-pressed="${!paused}" aria-label="${esc(paused ? L.play : L.pause)}" title="${esc(paused ? L.play : L.pause)}">${playbackIcon()}</button></div></div><div class="tp-scroll"><svg viewBox="0 0 ${width} ${height}" class="tp-svg" aria-label="${esc(L.svgLabel)}"><defs><linearGradient id="tp-region-fill" x1="0" y1="0" x2="1" y2="1"><stop stop-color="var(--accent-wash)" stop-opacity=".58"/><stop offset="1" stop-color="var(--surface)" stop-opacity=".22"/></linearGradient><filter id="tp-invert"><feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0"/></filter><filter id="tp-blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter>${glowDefs.join('')}${chainGroups.map((g, i) => `<marker id="tp-fb-arrow-${i}" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0 .8 7 4 0 7.2z" fill="${CHAIN_COLORS[i % CHAIN_COLORS.length]}"/></marker>`).join('')}</defs>${backgrounds}${paths}${boxes}</svg></div></section>`;
}

function mount(data, rerender) {
  runCleanup();
  const card = document.querySelector('.tp-card');
  if (!card) return;
  const graph = build(data, L);
  const edgeById = new Map(graph.edges.map(e => [e.id, e]));
  const svg = card.querySelector('.tp-svg');
  const scroll = card.querySelector('.tp-scroll');
  scroll.scrollLeft = scrollLeft;
  const frames = new Map([...card.querySelectorAll('[data-tp-frame]')].map(n => [n.dataset.tpFrame, n]));
  const paths = new Map([...svg.querySelectorAll('[data-edge]')].map(path => [path.dataset.edge, path]));
  const measured = new Map([...paths].map(([id, path]) => {
    const length = path.getTotalLength();
    return [id, { ...edgeById.get(id), length, start: path.getPointAtLength(0), end: path.getPointAtLength(length), path }];
  }));
  const eligible = graph.routes.filter(r => (!selected || r.nodes.includes(selected)) && r.edges.every(id => measured.has(id)));
  // Alternate sources and direct/gateway paths so a large model catalogue cannot
  // bury the subscription/collection scene at the end of a long loop.
  const groups = new Map();
  for (const route of eligible) {
    const key = `${route.nodes[0]}:${route.nodes[1] === 'gateway' ? 'gateway' : 'direct'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route);
  }
  const gatewayScenes = [...groups.values()].filter(list => list[0].nodes[1] === 'gateway');
  const directScenes = [...groups.values()].filter(list => list[0].nodes[1] !== 'gateway');
  const scenes = [];
  for (let i = 0; i < Math.max(gatewayScenes.length, directScenes.length); i++) {
    if (gatewayScenes[i]) scenes.push(gatewayScenes[i]);
    if (directScenes[i]) scenes.push(directScenes[i]);
  }
  // 额度满 fallback 演示：粒子抵达被拒渠道闪红，随后沿虚线弧转投备用模型
  // （末位绿色光晕）。纯演示，不影响真实路由。
  const incomingSource = graph.edges.find(e => e.type === 'call' && e.b === 'gateway')?.a;
  const chainGroups = new Map();
  for (const e of graph.edges) {
    if (e.type !== 'fallback') continue;
    if (!chainGroups.has(e.group)) chainGroups.set(e.group, []);
    chainGroups.get(e.group).push(e);
  }
  for (const arcs of chainGroups.values()) {
    const first = arcs[0];
    const pid = 'provider:' + JSON.parse(first.a)[1];
    const call = (a, b) => graph.edges.find(e => e.a === a && e.b === b && e.type === 'call')?.id;
    const demo = {
      nodes: [incomingSource, 'gateway', pid, first.a, ...arcs.map(e => e.b)],
      edges: [call(incomingSource, 'gateway'), call('gateway', pid), call(pid, first.a), ...arcs.map(e => e.id)],
      rejected: [pid, first.a, ...arcs.slice(0, -1).map(e => e.b)],
    };
    if (demo.edges.every(id => id && measured.has(id)) && (!selected || demo.nodes.includes(selected))) scenes.push([demo]);
  }
  // ── 多流调度：随机发射、并发上限、同源不叠加、fallback 演示低频穿插 ──
  // 一条流 = 一次来源→模型旅程（makeParticles 三球编队共享速度）。旧的
  // 单场景串行改洗牌队列：顺序随机但每个来源都会轮到，同屏最多 MAX_STREAMS 条。
  const MAX_STREAMS = 3;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const fallbackScenes = scenes.filter(list => list[0].rejected);
  const plainScenes = scenes.filter(list => !list[0].rejected);
  let streams = [];          // 在途流：{route, journeys, particles, circles, startAt, breathLevel}
  let queue = [];            // 洗牌后的普通场景队列（元素是 scenes 的候选组）
  let lastEmitAt = -1e9, nextEmitIn = 0, serialIndex = 0;
  let fallbackDue = 3 + Math.floor(Math.random() * 3);
  let visible = false, frame = 0, last = null;
  let elapsed = anim.elapsed;
  const glows = new Map();
  const breathing = new Set();
  // 旧内核（微信 X5 / 老 iOS）不支持 color-mix：到达光/呼吸改由 JS 内联绘制
  const shuffle = list => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  // 粒子三球用来源专属色，沿途（含 fallback 转投段）不变色。
  const tintStream = (circles, route) => {
    const color = frames.get(route.nodes[0])?.style.getPropertyValue('--glow-c').trim();
    if (color) for (const c of circles) c.style.fill = color;
  };
  // 发光绘制统一走 SVG 原生滤镜 + 内联样式：WebKit 不支持对 SVG 元素套 CSS
  // filter（drop-shadow/invert/blur 全部无效，iOS Chrome/Safari 全中），CSS
  // filter/color-mix 不得作为发光路径；JS 逐帧改 feDropShadow 的 flood-*。
  const glowFilters = new Map();
  for (const [id, node] of frames) {
    const fid = node.dataset.tpGf;
    if (!fid) continue;
    const drops = [...svg.querySelectorAll(`#${fid} feDropShadow`)];
    if (drops.length) glowFilters.set(id, drops);
  }
  let cachedAccent = null;
  const paintGlow = (node, id, level, red) => {
    if (!node) return;
    const drops = glowFilters.get(id);
    if (drops) {
      const color = red ? '#e5484d' : node.style.getPropertyValue('--glow-c').trim() || '#86bdfa';
      drops[0].setAttribute('flood-color', color);
      drops[0].setAttribute('flood-opacity', (level * 0.75).toFixed(3));
      if (drops[1]) {
        drops[1].setAttribute('flood-color', color);
        drops[1].setAttribute('flood-opacity', (level * 0.6).toFixed(3));
      }
    }
    // 来源/分组：外框呼吸（stroke 色走内联，红闪时覆写为红）
    const halo = node.querySelector('.tp-halo');
    if (halo) {
      halo.style.opacity = level.toFixed(3);
      if (red && level > 0.004) halo.style.stroke = '#e5484d';
      else halo.style.removeProperty('stroke');
    }
    // 模型胶囊：到达时点亮填充，趣近 0 时还给 CSS 基线
    const pill = node.querySelector('.tp-pill-shape');
    if (pill) {
      if (level <= 0.004) pill.style.removeProperty('fill');
      else {
        const chain = node.style.getPropertyValue('--tp-chain').trim();
        if (chain) pill.style.fill = rgbaCss(hexRgb(chain), 0.12 + level * 0.3);
        else {
          if (!cachedAccent) {
            const cs = getComputedStyle(svg);
            cachedAccent = [hexRgb(cs.getPropertyValue('--accent')), hexRgb(cs.getPropertyValue('--accent-wash'))];
          }
          pill.style.fill = rgbaCss(mixRgb(cachedAccent[1], cachedAccent[0], 0.38 * level), 1);
        }
      }
    }
  };
  const makeCircles = (branchCount, particleCount) => {
    const circles = [];
    for (let branch = 0; branch < branchCount; branch++) {
      for (let i = 0; i < particleCount; i++) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('class', `tp-particle${branch ? ' tp-sample-particle' : ''}`);
        circle.setAttribute('visibility', 'hidden');
        svg.appendChild(circle);
        circles.push(circle);
      }
    }
    return circles;
  };
  const pulse = id => {
    const glow = glows.get(id) ?? { level: 0, holdUntil: 0 };
    glow.holdUntil = elapsed + 360;
    glows.set(id, glow);
  };
  // 拒绝光晕：额度满演示里被跳过的渠道/模型胶囊闪红，与普通蓝色到达光晕互斥。
  const errGlows = new Map();
  const pulseErr = id => {
    const glow = errGlows.get(id) ?? { level: 0, holdUntil: 0 };
    glow.holdUntil = elapsed + 500;
    errGlows.set(id, glow);
  };
  const hideParticles = () => { for (const s of streams) for (const c of s.circles) c.setAttribute('visibility', 'hidden'); };
  const emitStream = (forced, serial) => {
    let candidates;
    if (serial) {
      // 单源串行：沿用场景轮换（gateway/direct 交替，fallback 演示居末），逐个上演。
      if (!scenes.length) return;
      candidates = scenes[serialIndex++ % scenes.length];
    } else if (forced || (fallbackScenes.length && streams.length === 0 && fallbackDue <= 0)) {
      if (!fallbackScenes.length) return;
      // fallbackScenes 是场景组的数组：先抽一组，再由下方 route 抽组内路由。
      // 旧代码直接把整组数组当 route 用，measureScene 对 undefined.edges 取
      // map 时抛错杀死 rAF —— 调用链流量因此彻底消失，直到下一次数据刷新重挂载。
      candidates = fallbackScenes[Math.floor(Math.random() * fallbackScenes.length)];
      fallbackDue = 4 + Math.floor(Math.random() * 4);
    } else {
      fallbackDue--;
      if (!plainScenes.length) return;
      if (!queue.length) queue = shuffle([...plainScenes]);
      candidates = queue.pop();
      // 同源不并发：在途流已占用该来源时顺延到队列下一位，避免双呼吸叠加。
      if (streams.some(s => s.route.nodes[0] === candidates[0].nodes[0]) && queue.length) candidates = queue.pop();
    }
    const route = candidates[Math.floor(Math.random() * candidates.length)];
    const journeys = measureScene(route, measured);
    const particles = makeParticles();
    const circles = makeCircles(journeys.length, particles.length);
    tintStream(circles, route);
    streams.push({ route, journeys, particles, circles, startAt: elapsed + 350, breathLevel: 0 });
  };
  // 呼吸灯交还：流结束（或暂停/失焦）时把当前亮度放回衰减包络，平滑熄灭。
  const endBreath = stream => {
    if (!stream.breathLevel) return;
    glows.set(stream.route.nodes[0], { level: stream.breathLevel, holdUntil: 0 });
    stream.breathLevel = 0;
  };
  const dropStream = stream => {
    endBreath(stream);
    for (const c of stream.circles) c.remove();
    streams = streams.filter(s => s !== stream);
  };
  const sceneKey = r => `${r.nodes.join('>')}:${r.edges.length}`;
  if (Array.isArray(anim.streams)) {
    for (const saved of anim.streams) {
      const route = scenes.flat().find(r => sceneKey(r) === saved.key);
      if (!route) continue;
      const journeys = measureScene(route, measured);
      const circles = makeCircles(journeys.length, saved.particles.length);
      tintStream(circles, route);
      streams.push({ route, journeys, particles: saved.particles, circles, startAt: saved.startAt, breathLevel: 0 });
    }
  }
  lastEmitAt = elapsed;

  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    last = null;
    if (!visible) hideParticles();
  });
  observer.observe(card);
  const visibility = () => { last = null; if (document.hidden) hideParticles(); };
  document.addEventListener('visibilitychange', visibility);
  const run = time => {
    frame = requestAnimationFrame(run);
    if (!visible || document.hidden || paused || !scenes.length) {
      last = null;
      hideParticles();
      for (const stream of streams) endBreath(stream);
      // 暂停/离屏时光晕透渐熄灭而非冻结在半亮（否则残留外框色）。
      const fade = map => {
        for (const [id, glow] of map) {
          glow.holdUntil = 0;
          glow.level *= 0.86;
          const node = frames.get(id);
          if (glow.level < 0.004) {
            node?.style.removeProperty('--tp-glow');
            node?.style.removeProperty('--halo');
            paintGlow(node, id, 0, map === errGlows);
            map.delete(id);
          } else {
            node?.style.setProperty('--tp-glow', glow.level.toFixed(4));
            paintGlow(node, id, glow.level, map === errGlows);
          }
        }
      };
      fade(glows);
      fade(errGlows);
      return;
    }
    const delta = last === null ? 0 : time - last;
    elapsed += delta;
    last = time;
    // 发射调度：multi=空闲快补/随机叠加/并发封顶，fallback 到期后降到 1 自然排空独占上演；
    // serial=上一版的单源串行，一条流走完歇 700ms 再轮到下一个场景。
    if (mode === 'serial') {
      if (!streams.length && elapsed - lastEmitAt >= 700) {
        emitStream(false, true);
        lastEmitAt = elapsed;
      }
    } else {
      const dueFallback = fallbackScenes.length && fallbackDue <= 0;
      const cap = dueFallback ? 1 : MAX_STREAMS;
      if (dueFallback && streams.length === 0) {
        emitStream(true);
        lastEmitAt = elapsed;
        nextEmitIn = 400 + Math.random() * 600;
      } else if (streams.length < cap && elapsed - lastEmitAt >= nextEmitIn) {
        emitStream();
        lastEmitAt = elapsed;
        nextEmitIn = streams.length > 1 ? 1000 + Math.random() * 1800 : 400 + Math.random() * 600;
      }
    }
    breathing.clear();
    for (const stream of [...streams]) {
      let complete = elapsed >= stream.startAt;
      for (let i = 0; i < stream.particles.length; i++) {
        const particle = stream.particles[i];
        const age = elapsed - stream.startAt - particle.delayMs;
        if (age < 0) { complete = false; continue; }
        if (!particle.started) { pulse(stream.route.nodes[0]); particle.started = true; }
        for (let branch = 0; branch < stream.journeys.length; branch++) {
          const circle = stream.circles[branch * stream.particles.length + i];
          const sample = sampleJourney(stream.journeys[branch], particle.speed, age);
          for (const arrival of sample.arrivals) {
            if (!particle.reached.has(arrival)) {
              (stream.route.rejected?.includes(arrival) ? pulseErr : pulse)(arrival);
              particle.reached.add(arrival);
            }
          }
          if (!sample.done) complete = false;
          if (sample.done || sample.segment.kind !== 'edge') {
            circle.setAttribute('visibility', 'hidden');
            continue;
          }
          const point = sample.segment.path.getPointAtLength(sample.distance);
          circle.setAttribute('cx', point.x);
          circle.setAttribute('cy', point.y);
          circle.setAttribute('r', particle.radius * (branch ? 0.8 : 1));
          circle.setAttribute('opacity', particle.opacity);
          circle.setAttribute('visibility', 'visible');
          // Inspection values describe the demonstration, never real request telemetry.
          circle.dataset.speed = particle.speed.toFixed(3);
          circle.dataset.distance = sample.traveled.toFixed(3);
          circle.dataset.emission = particle.delayMs.toFixed(3);
        }
      }
      if (complete) dropStream(stream);
      else {
        // 来源呼吸灯：流在途期间来源 icon 按正弦缓慢起伏（0.25–0.80，周期 1950ms）。
        const src = stream.route.nodes[0];
        stream.breathLevel = 0.25 + 0.55 * (0.5 - 0.5 * Math.cos((elapsed - stream.startAt) / 1950 * Math.PI * 2));
        breathing.add(src);
        const srcNode = frames.get(src);
        srcNode?.style.setProperty('--tp-glow', stream.breathLevel.toFixed(4));
        paintGlow(srcNode, src, stream.breathLevel, false);
      }
    }
    for (const [id, glow] of glows) {
      if (breathing.has(id)) continue;
      const target = elapsed < glow.holdUntil ? 1 : 0;
      // Exponential attack/release is frame-rate independent. New arrivals only
      // extend the hold, preserving the current brightness rather than restarting.
      glow.level += (target - glow.level) * (1 - Math.exp(-delta / (target ? 85 : 260)));
      const node = frames.get(id);
      node?.style.setProperty('--tp-glow', glow.level.toFixed(4));
      paintGlow(node, id, glow.level, false);
      if (!target && glow.level < 0.002) {
        node?.style.removeProperty('--tp-glow');
        paintGlow(node, id, 0, false);
        glows.delete(id);
      }
    }
    for (const [id, glow] of errGlows) {
      if (breathing.has(id)) continue;
      const target = elapsed < glow.holdUntil ? 1 : 0;
      glow.level += (target - glow.level) * (1 - Math.exp(-delta / (target ? 70 : 300)));
      const node = frames.get(id);
      if (node) {
        node.style.setProperty('--halo', '#e5484d');
        node.style.setProperty('--tp-glow', glow.level.toFixed(4));
        paintGlow(node, id, glow.level, true);
      }
      if (!target && glow.level < 0.002) {
        node?.style.removeProperty('--tp-glow');
        node?.style.removeProperty('--halo');
        paintGlow(node, id, 0, true);
        errGlows.delete(id);
      }
    }
  };
  frame = requestAnimationFrame(run);

  const toggleSelect = id => {
    selected = selected === id ? null : id;
    rerender();
    [...document.querySelectorAll('[data-tp-node]')].find(n => n.dataset.tpNode === id)?.focus();
  };
  let arcTimer = 0;
  const setMode = m => {
    if ((m !== 'multi' && m !== 'serial') || m === mode) return;
    mode = m;
    // 切到单源串行立即清场：多源在途流全部退场，不再等待自然排空。
    if (m === 'serial') for (const s of [...streams]) dropStream(s);
    try { localStorage.setItem('tp-mode', m); } catch { /* VM/隐私模式无 localStorage */ }
    for (const b of card.querySelectorAll('[data-tp-mode]')) {
      const on = b.dataset.tpMode === mode;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('on', on);
    }
  };
  const click = event => {
    const modeBtn = event.target.closest('[data-tp-mode]');
    if (modeBtn) { setMode(modeBtn.dataset.tpMode); return; }
    const play = event.target.closest('[data-tp-play]');
    const node = event.target.closest('[data-tp-node]');
    if (play) {
      paused = !paused;
      play.innerHTML = playbackIcon();
      play.setAttribute('aria-label', paused ? L.play : L.pause);
      play.title = paused ? L.play : L.pause;
      play.setAttribute('aria-pressed', String(!paused));
      if (paused) hideParticles();
    } else if (node) {
      toggleSelect(node.dataset.tpNode);
    } else {
      // 触屏点按转投弧：短暂点亮流动虚线（桌面用 hover，触屏没有 hover）。
      const arc = event.target.closest('.tp-fallback');
      if (arc) {
        arc.classList.add('tp-arc-lit');
        clearTimeout(arcTimer);
        arcTimer = setTimeout(() => arc.classList.remove('tp-arc-lit'), 2400);
        return;
      }
      if (selected && (event.target === svg || event.target.closest('.tp-region'))) {
        // Blank clicks only clear an active selection; with nothing selected they
        // must be no-ops so the simulation is never disturbed.
        selected = null;
        rerender();
      }
    }
  };
  // 键盘可达性：节点从 <button> 换成 role=button 的 <g> 后自行处理 Enter/Space。
  const keydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const node = event.target.closest?.('[data-tp-node]');
    if (!node) return;
    event.preventDefault();
    toggleSelect(node.dataset.tpNode);
  };
  card.addEventListener('click', click);
  card.addEventListener('keydown', keydown);
  cleanup = () => {
    scrollLeft = scroll.scrollLeft;
    clearTimeout(arcTimer);
    anim = { elapsed, streams: streams.map(s => ({ key: sceneKey(s.route), startAt: s.startAt, particles: s.particles })) };
    cancelAnimationFrame(frame);
    observer.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    card.removeEventListener('click', click);
    card.removeEventListener('keydown', keydown);
  };
}
root.MGTopology = { build, html, mount, measureJourney, sampleJourney, makeParticles, measureScene, stop: runCleanup };
})(globalThis);
