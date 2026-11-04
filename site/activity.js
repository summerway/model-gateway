// site/activity.js — 产品页 Activity 区（MG23，返工 v2）。
// 零依赖 IIFE，结构与字段严格照看板「用量 · 总览」（src/dashboard/console.html
// viewUsageSummary + drawHeat）：顶部行右侧口径 seg、5 个数字格（.tiles）、
// Activity 卡（年度热力图）、来源/模型占比两卡（.grid-2，各 top 6，右上链接
// 跳视图导览 04/05）。数据全部来自 window.MGDemo（site/data.js，MG21）——
// 数字格取 MGDemo.activity(kind)，占比取 groupBy(query({days:365, kind}))，
// 不另行硬编码统计数字。热力色阶 --h0..h5、分位分档 0.2/0.45/0.7/0.9、
// 格子尺寸按容器宽反推（cell = clamp(10, floor((W-26-3*(cols-1))/cols), 20)）
// 均与 console 的 drawHeat 一致；占比行布局 130px|bar|60px|46px、tooltip
// 三行结构、800ms ease-out 计数动画亦同源。
(function (root) {
  'use strict';

  const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ── 文案：zh 为源语言，en 简短直译 ── */
  const TXT = {
    zh: {
      segLabel: '口径',
      kinds: { all: '全部', served: '经网关', observed: '订阅直连' },
      tile: { tokens: 'Token 总量', cost: '总成本', active: '活跃天数', peak: '单日峰值', model: '常用模型' },
      day: '天',
      title: 'Activity',
      meta: '近一年 · 悬停看当天',
      bySource: '来源占比',
      byModel: '模型占比',
      allSources: '全部来源 ›',
      allModels: '全部模型 ›',
      weekdays: ['一', '', '三', '', '五', '', '日'],
      month: (m) => m + 1 + '月',
      heatLabel: '近一年每日用量热力图',
      tokens: 'Tokens',
      cost: '成本',
    },
    en: {
      segLabel: 'Scope',
      kinds: { all: 'All', served: 'Via gateway', observed: 'Direct' },
      tile: { tokens: 'Total tokens', cost: 'Total cost', active: 'Active days', peak: 'Peak day', model: 'Top model' },
      day: 'days',
      title: 'Activity',
      meta: 'Last 12 months · hover a day',
      bySource: 'By source',
      byModel: 'By model',
      allSources: 'All sources ›',
      allModels: 'All models ›',
      weekdays: ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'],
      month: (m) => MON_EN[m],
      heatLabel: 'Daily usage heatmap, last 12 months',
      tokens: 'Tokens',
      cost: 'Cost',
    },
  };

  /* ── 热力图几何（同 drawHeat）：gap 3、顶部 18 留月份标签、左侧 26 留行标签 ── */
  const GAP = 3, TOP = 18, LABEL_W = 26, CELL_MIN = 10, CELL_MAX = 20;

  /* 末月标签宽度按 .ax 的 11px 字号用 canvas 估测（SVG 宽为其留余量，不被截断），
     渲染后 getComputedTextLength 实测兜底 */
  let axCtx = null;
  const textW = (s) => {
    if (!axCtx) axCtx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(document.body);
    axCtx.font = `${cs.fontWeight} 11px ${cs.fontFamily}`;
    return Math.ceil(axCtx.measureText(s).width);
  };

  const mount = document.getElementById('activity-mount');
  const D = root.MGDemo;
  if (!mount || !D) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = { kind: 'all', played: false };

  /* ── 工具 ── */
  const TT = () => TXT[D.lang === 'en' ? 'en' : 'zh'];
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = (s) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd); };
  const shortDay = (s) => { const d = parseDay(s); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; }; // 同 console：带年份避免跨年歧义
  const fmtTok = (n) => D.fmt.tokens(n);
  const fmtUsd = (n) => D.fmt.usd(n);
  const fmtPct = (n) => (n * 100).toFixed(n >= 0.1 || n === 0 ? 0 : 1) + '%';
  const modelName = (key) => {
    if (!key) return '—';
    const e = D.names.model[key];
    return e ? ((D.lang === 'en' ? e.en : e.zh) ?? key) : key;
  };

  let mga = null, tipEl = null, heatSvg = null, cells = [];

  /* ── 顶部行：口径 seg（真按钮，aria-pressed），右对齐（同看板 tabs 行右侧的 kindSeg） ── */
  function segHtml() {
    const L = TT();
    const opts = [['all', L.kinds.all], ['served', L.kinds.served], ['observed', L.kinds.observed]];
    return `<div class="mga-seg" role="group" aria-label="${esc(L.segLabel)}">${opts.map(([v, l]) =>
      `<button type="button" data-kind="${v}" aria-pressed="${String(v === state.kind)}">${esc(l)}</button>`).join('')}</div>`;
  }

  /* ── 5 个数字格（同 viewUsageSummary）；Token 总量/总成本首次进入视口播 800ms 计数动画 ── */
  function tilesHtml(a) {
    const L = TT();
    const live = !state.played && !reduced;
    const num = (v, fmt) => {
      const attr = live && Number.isFinite(v) ? ` data-count data-fmt="${fmt === fmtUsd ? 'usd' : 'tok'}" data-to="${v}"` : '';
      return `<span${attr}>${esc(fmt(v))}</span>`;
    };
    const peak = a.peak && a.peak.tokens > 0 ? a.peak : null;
    return `<div class="tiles mga-tiles">`
      + `<div class="tile"><div class="k">${esc(L.tile.tokens)}</div><div class="v num">${num(a.totalTokens, fmtTok)}</div></div>`
      + `<div class="tile"><div class="k">${esc(L.tile.cost)}</div><div class="v num">${num(a.totalCost, fmtUsd)}</div></div>`
      + `<div class="tile"><div class="k">${esc(L.tile.active)}</div><div class="v num">${a.activeDays} ${esc(L.day)}</div></div>`
      + `<div class="tile"><div class="k">${esc(L.tile.peak)}</div><div class="v num">${peak ? esc(fmtTok(peak.tokens)) : '—'}${peak ? ` <span class="tile-sub num">${esc(shortDay(peak.date))}</span>` : ''}</div></div>`
      + `<div class="tile"><div class="k">${esc(L.tile.model)}</div><div class="v num mono">${esc(modelName(a.topModel))}</div></div>`
      + `</div>`;
  }

  /* ── 热力图数据（与几何无关）：今天往前 364 天回退到最近的周一；非零日按 20/45/70/90 分位数分档 h1–h5 ── */
  function heatData(perDay) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tKey = dayKey(today);
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const list = [];
    let col = 0;
    for (const d = new Date(start); dayKey(d) <= tKey; d.setDate(d.getDate() + 1)) {
      const row = (d.getDay() + 6) % 7;
      const v = perDay.get(dayKey(d));
      list.push({ key: dayKey(d), col, row, tokens: v?.tokens ?? 0, cost: v?.costUsd ?? 0, m: d.getMonth(), dom: d.getDate() });
      if (row === 6) col++;
    }
    const vals = list.map((c) => c.tokens).filter((v) => v > 0).sort((x, y) => x - y);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
    const cuts = [q(0.2), q(0.45), q(0.7), q(0.9)];
    const lvl = (v) => (!v ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : v <= cuts[3] ? 4 : 5);
    const months = []; // 月份标签：每月第一周（row 0 且日期 ≤ 7）的列位
    let lastM = -1;
    for (const c of list) {
      c.lvl = lvl(c.tokens);
      if (c.row === 0 && c.m !== lastM && c.dom <= 7) { lastM = c.m; months.push({ col: c.col, m: c.m }); }
    }
    return { list, cols: col + 1, months };
  }

  /* ── 热力图 SVG（同 drawHeat）：格子按容器宽反推铺满卡片；SVG 宽在网格宽之外
     为末月标签补足余量，保证标签完整不被截断 ── */
  function heatSvgHtml(cw, hd, anim) {
    const L = TT();
    let cell = Math.floor((cw - LABEL_W - GAP * (hd.cols - 1)) / hd.cols);
    cell = Math.max(CELL_MIN, Math.min(cell, CELL_MAX));
    const rx = Math.max(2, cell / 5).toFixed(1);
    const step = cell + GAP;
    let w = LABEL_W + hd.cols * step;
    const last = hd.months[hd.months.length - 1];
    if (last) w = Math.max(w, Math.ceil(LABEL_W + last.col * step + textW(L.month(last.m))) + 4);
    const h = TOP + 7 * step;
    let svg = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(L.heatLabel)}">`;
    L.weekdays.forEach((l, r) => { if (l) svg += `<text class="ax" x="0" y="${(TOP + r * step + cell * 0.8).toFixed(1)}">${esc(l)}</text>`; });
    hd.months.forEach((mm, i) => {
      svg += `<text class="ax${i === hd.months.length - 1 ? ' mlast' : ''}" x="${LABEL_W + mm.col * step}" y="11">${esc(L.month(mm.m))}</text>`;
    });
    hd.list.forEach((c, i) => {
      const costTxt = c.tokens > 0 ? fmtUsd(c.cost) : '—';
      const label = `${c.key} · ${fmtTok(c.tokens)} Tokens · ${costTxt}`;
      const style = anim === 'none' || reduced ? 'animation:none' : `animation-delay:${((c.col / Math.max(1, hd.cols - 1)) * 0.2).toFixed(3)}s`;
      svg += `<rect class="cell h${c.lvl}" x="${LABEL_W + c.col * step}" y="${TOP + c.row * step}" width="${cell}" height="${cell}" rx="${rx}" tabindex="${i === 0 ? 0 : -1}" data-i="${i}" aria-label="${esc(label)}" style="${style}"><title>${esc(label)}</title></rect>`;
    });
    return svg + '</svg>';
  }

  /* ── 挂载热力图：量容器宽 → 生成 SVG → 末月标签实测兜底 → 绑交互 → 滚到最右 → 盯容器尺寸 ── */
  function mountHeat(anim, data) {
    const sc = mga.querySelector('.mga-heat');
    if (!sc) return;
    const a = data ?? D.activity(state.kind);
    const perDay = new Map(a.days.map((d) => [d.date, d]));
    const hd = heatData(perDay);
    cells = hd.list;
    sc.innerHTML = heatSvgHtml(sc.clientWidth, hd, anim);
    heatSvg = sc.firstElementChild;
    const ml = heatSvg.querySelector('text.mlast');
    if (ml) { // canvas 估测偏小时以实测宽度加宽 SVG，保证末月标签完整
      const need = Math.ceil(Number(ml.getAttribute('x')) + ml.getComputedTextLength()) + 4;
      const cur = Number(heatSvg.getAttribute('width'));
      if (need > cur) {
        const vh = Number(heatSvg.getAttribute('viewBox').split(' ')[3]);
        heatSvg.setAttribute('width', need);
        heatSvg.setAttribute('viewBox', `0 0 ${need} ${vh}`);
      }
    }
    bindHeat();
    sc.scrollLeft = sc.scrollWidth; // 初始滚到最右（今天）
    watchHeatSize(sc);
  }

  /* ── 容器尺寸变化：ResizeObserver + rAF 节流，只重画热力图（入场动画不重播） ── */
  let heatRO = null, heatW = -1, heatRaf = 0;
  function watchHeatSize(sc) {
    heatW = sc.clientWidth;
    if (heatRO) heatRO.disconnect();
    if (typeof ResizeObserver !== 'function') return;
    heatRO = new ResizeObserver((entries) => {
      const w = Math.round(entries[entries.length - 1].contentRect.width);
      if (w === heatW) return;
      heatW = w;
      cancelAnimationFrame(heatRaf);
      heatRaf = requestAnimationFrame(() => mountHeat(reduced || state.played ? 'none' : 'idle'));
    });
    heatRO.observe(sc);
  }

  /* ── 占比两卡（同 viewUsageSummary）：top 6，条按第一名归一，颜色取 MGDemo.palette（按名次）；
     card-h 右侧链接切到视图导览 04/05（MGViews 存在时），否则回退锚点滚到 #views ── */
  function sharesHtml(anim) {
    const L = TT();
    const q = D.query({ days: 365, kind: state.kind });
    const block = (dim, title, more, view) => {
      const rows = D.groupBy(q, dim).slice(0, 6);
      const max = rows.length ? rows[0].tokens : 1;
      const list = rows.map((r, i) => `<div class="sharerow" title="${esc(r.name)}">`
        + `<span class="sr-name">${esc(r.name)}</span>`
        + `<div class="share-track"><div class="share-fill" style="width:${((r.tokens / max) * 100).toFixed(2)}%;background:${D.palette[i % D.palette.length]}${anim === 'none' ? ';animation:none' : ''}"></div></div>`
        + `<span class="num">${esc(fmtTok(r.tokens))}</span>`
        + `<span class="p num">${esc(fmtPct(r.share))}</span></div>`).join('');
      return `<section class="card"><div class="card-h"><h2>${esc(title)}</h2><a class="meta" href="#views" data-view="${view}">${esc(more)}</a></div><div class="mini-list">${list}</div></section>`;
    };
    return `<div class="grid-2 mga-shares">${block('source', L.bySource, L.allSources, 4)}${block('model', L.byModel, L.allModels, 5)}</div>`;
  }

  /* ── 渲染：anim ∈ 'idle'（等进视口再入场）| 'play'（立即入场）| 'none'（不做入场动画） ── */
  function render(anim) {
    const L = TT();
    const a = D.activity(state.kind);
    mount.innerHTML = `<div class="mga${anim === 'idle' ? ' mga-idle' : ''}">`
      + `<div class="mga-top">${segHtml()}</div>`
      + tilesHtml(a)
      + `<section class="card"><div class="card-h"><h2>${esc(L.title)}</h2><span class="meta">${esc(L.meta)}</span></div><div class="mga-heat"></div></section>`
      + sharesHtml(anim)
      + `<div class="tip" role="tooltip"></div>`
      + `</div>`;
    mga = mount.firstElementChild;
    tipEl = mga.querySelector('.tip');
    mountHeat(anim, a); // 量实际容器宽后生成热力图 SVG 并滚到最右
  }

  /* ── 计数动画：800ms ease-out cubic，格式随当前语言 ── */
  function playCounts() {
    if (!mga) return;
    for (const el of mga.querySelectorAll('[data-count]')) {
      const to = Number(el.dataset.to);
      const fmt = el.dataset.fmt === 'usd' ? fmtUsd : fmtTok;
      if (!Number.isFinite(to)) continue;
      const t0 = performance.now(), dur = 800;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        el.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  /* ── tooltip：日期 / Tokens / 成本 三行 ── */
  function tipContent(c) {
    const L = TT();
    return `<div class="tt">${esc(c.key)}</div>`
      + `<div class="tr"><span>${esc(L.tokens)}</span><b class="num">${esc(fmtTok(c.tokens))}</b></div>`
      + `<div class="tr"><span>${esc(L.cost)}</span><b class="num">${esc(c.tokens > 0 ? fmtUsd(c.cost) : '—')}</b></div>`;
  }
  function showTip(html, ax, ay, center = false) {
    tipEl.innerHTML = html;
    tipEl.classList.add('on');
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let x = center ? ax - tw / 2 : ax;
    if (x + tw > mga.clientWidth - 4) x = ax - tw - 28; // 靠右时翻到指针左侧
    x = Math.max(4, Math.min(x, mga.clientWidth - tw - 4));
    let y = ay;
    if (y + th > mga.clientHeight - 4) y = ay - th - 28; // 靠下时翻到上方
    y = Math.max(4, Math.min(y, mga.clientHeight - th - 4));
    tipEl.style.left = Math.round(x) + 'px';
    tipEl.style.top = Math.round(y) + 'px';
  }
  function hideTip() { tipEl.classList.remove('on'); }
  const cellOf = (rect) => cells[Number(rect.dataset.i)];
  function tipFromPointer(e, rect) {
    const mr = mga.getBoundingClientRect();
    showTip(tipContent(cellOf(rect)), e.clientX - mr.left + 14, e.clientY - mr.top + 14);
  }
  function tipFromRect(rect) {
    const mr = mga.getBoundingClientRect(), rr = rect.getBoundingClientRect();
    showTip(tipContent(cellOf(rect)), rr.left - mr.left + rr.width / 2, rr.bottom - mr.top + 6, true);
  }

  /* ── 热力图交互：悬停/聚焦描边 + 浮层；方向键在格子间移动焦点（roving tabindex） ── */
  function bindHeat() {
    heatSvg.addEventListener('pointermove', (e) => {
      const r = e.target.closest('rect.cell');
      if (r) tipFromPointer(e, r); else hideTip();
    });
    heatSvg.addEventListener('pointerdown', (e) => {
      const r = e.target.closest('rect.cell');
      if (r) tipFromPointer(e, r);
    });
    heatSvg.addEventListener('pointerleave', hideTip);
    heatSvg.addEventListener('focusin', (e) => {
      const r = e.target.closest('rect.cell');
      if (r) tipFromRect(r);
    });
    heatSvg.addEventListener('focusout', hideTip);
    heatSvg.addEventListener('keydown', (e) => {
      const r = e.target.closest('rect.cell');
      if (!r) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = heatSvg.querySelector(`rect.cell[data-i="${Number(r.dataset.i) + step}"]`);
      if (!next) return;
      r.setAttribute('tabindex', '-1');
      next.setAttribute('tabindex', '0');
      next.focus();
      tipFromRect(next);
    });
  }

  /* ── 首次进入视口：数字计数动画 + 热力图入场（mga-idle 暂停态解除） ── */
  function firstSeen() {
    state.played = true;
    if (mga) mga.classList.remove('mga-idle');
    if (!reduced) playCounts();
  }
  const hasIO = typeof IntersectionObserver === 'function';
  let io = null;
  if (hasIO) {
    io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) { io.disconnect(); firstSeen(); }
    }, { threshold: 0.15 });
  }
  const nextAnim = () => (reduced ? 'none' : state.played || !hasIO ? 'play' : 'idle');

  render(hasIO && !reduced ? 'idle' : nextAnim());
  if (io) io.observe(mount); else firstSeen();

  /* 点击：占比卡右上链接（MGViews 存在时切视图，否则走 href="#views" 锚点）；
     口径 seg 切换后对应 kind 重新计算并重绘 */
  mount.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-view]');
    if (link) {
      const views = root.MGViews;
      if (views && typeof views.show === 'function') { e.preventDefault(); views.show(Number(link.dataset.view)); }
      return;
    }
    const b = e.target.closest('.mga-seg button');
    if (!b || b.dataset.kind === state.kind) return;
    state.kind = b.dataset.kind;
    render(nextAnim());
  });

  /* 语言切换：重绘全部文案、月份与数字格式；计数动画与热力图入场不重播 */
  D.onLang(() => render('none'));
})(globalThis);
