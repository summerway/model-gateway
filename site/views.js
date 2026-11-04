// site/views.js — MG22：产品页「一个看板，八个视图」导览。
// 零依赖 IIFE：挂载 #views-mount，左侧 01–08 编号列表切换，右侧模拟控制台窗口。
// 所有统计数字均来自 window.MGDemo（site/data.js）的聚合接口；文案集中在本文件顶部 TXT。
// 视图 08 日志为演示行：由当日 served 记录确定性派生（时间/延迟为演示口径，单次 token 量来自真实聚合）。
(function () {
  'use strict';
  const mount = document.getElementById('views-mount');
  const MG = window.MGDemo;
  if (!mount || !MG) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ───────── 文案（zh / en） ───────── */
  const TXT = {
    zh: {
      nav: ['概览', '用量', '网关', '日志'],
      list: [
        { t: '概览', d: '额度还剩多少，今天顺不顺' },
        { t: '趋势', d: '每天用了多少、花了多少' },
        { t: '渠道', d: '每家服务商的用量与成功率' },
        { t: '来源', d: '哪个工具在用、用了多少' },
        { t: '模型', d: '每个模型的用量和成本' },
        { t: '设备', d: '网关、NAS、Mac 各用多少' },
        { t: '调用链', d: '谁先上、谁接力，新模型先问你' },
        { t: '日志', d: '每一次请求的来龙去脉' },
      ],
      usageTabs: ['总览', '趋势', '渠道', '来源', '模型', '设备'],
      gwTabs: ['渠道与模型', '模型建议'],
      brand: 'model-gateway',
      logs: {
        win: '近 24 小时', today: (n, p) => `今日 ${n} 次请求 · 成功率 ${p}`,
        time: '时间', src: '来源', mdl: '模型', chan: '渠道', tok: 'Tokens', lat: '延迟', st: '状态',
        ok: '成功', fb: '失败 · 已接力', abort: '客户端中断',
        ms: (n) => `${n} ms`, s: (n) => `${(n / 1000).toFixed(1)} s`,
        keep: '明细保留 90 天，日聚合长期保留',
      },
      quota: {
        title: '订阅额度', h5: '5 小时额度', week: '本周额度',
        st: { normal: '正常', low: '即将用尽', reset: '待重置' },
        plans: { 'glm-primary': 'GLM Coding Plan', 'glm-backup': 'GLM Coding Plan 备用', codex: 'ChatGPT Pro', claude: 'Claude Pro' },
      },
      today: { title: '今日网关', reqs: '请求', rate: '成功率', fb: '接力切换', tok: '今日 Tokens', cost: '今日成本', lowRate: '低于 95%' },
      tr: {
        r7: '7天', r30: '30天', r90: '90天', r1y: '1年', total: '总量', mix: '构成',
        kinds: [['input', '输入'], ['output', '输出'], ['cacheWrite', '缓存创建'], ['cacheRead', '缓存命中']],
        sum: '合计', other: '其他', cost: '成本（美元）', bySrc: '按来源堆叠',
      },
      ch: {
        p1: '今天', p7: '近 7 天', p30: '近 30 天', all: '全部渠道',
        tokL: '累计处理 Tokens', costL: '总成本', reqs: '总请求数', abort: '客户端中断',
        rate: '成功率', hit: '缓存命中率', trend: '使用趋势', na: '未提供', cost: '成本',
      },
      src: {
        all: '全部', agent: 'Agent', app: '应用',
        src: '来源', model: '模型', type: '类型', tok: 'Tokens', cost: '成本', reqs: '请求', share: '占比',
        served: '经网关', observed: '订阅直连', mix: 'Tokens 构成', d30: '近 30 天',
        models: '用到的模型', srcs: '使用它的来源', na: '未提供',
      },
      dev: { meta: (a, n) => `近 30 天 Tokens · 最近数据 ${a.m != null ? a.m + ' 分钟前' : a.d != null ? a.d + ' 天前' : '—'} · 近 7 天 ${n} 条记录` },
      rt: {
        cat: '模型与调用链', mods: '输入能力', chain: '调用链', mod: { text: '文本', image: '图像', pdf: 'PDF' },
        in: (n) => `接入 ${n} 个模型`, clear: '取消筛选',
        sugg: '模型建议', up: '升级', when: '2 小时前',
        cur: '现有', cand: '发现', modsRow: '输入能力',
        pin: '输入价格（每百万）', pout: '输出价格（每百万）', ctx: '上下文',
        add: '添加并保留旧版', repl: '替换旧版', drop: '放弃', undo: '撤回',
        added: (m) => `已添加 ${m}，旧版保留`, replaced: (m) => `已替换为 ${m}，旧版已移除`, dropped: '已放弃这条建议',
        even: '持平',
      },
    },
    en: {
      nav: ['Overview', 'Usage', 'Gateway', 'Logs'],
      list: [
        { t: 'Overview', d: 'Quota left, and how today went' },
        { t: 'Trends', d: 'Daily tokens and spend' },
        { t: 'Channels', d: 'Usage and success per provider' },
        { t: 'Sources', d: 'Which tools use it, how much' },
        { t: 'Models', d: 'Usage and cost per model' },
        { t: 'Devices', d: 'Gateway, NAS and Mac usage' },
        { t: 'Routing', d: 'Who goes first, who takes over' },
        { t: 'Logs', d: 'Every request, latency and outcome' },
      ],
      usageTabs: ['Summary', 'Trends', 'Channels', 'Sources', 'Models', 'Devices'],
      gwTabs: ['Catalog', 'Suggestions'],
      brand: 'model-gateway',
      logs: {
        win: 'Last 24 hours', today: (n, p) => `${n} requests today · ${p} success`,
        time: 'Time', src: 'Source', mdl: 'Model', chan: 'Channel', tok: 'Tokens', lat: 'Latency', st: 'Status',
        ok: 'OK', fb: 'Failed · fallback took over', abort: 'Client abort',
        ms: (n) => `${n} ms`, s: (n) => `${(n / 1000).toFixed(1)} s`,
        keep: 'Details kept for 90 days; daily aggregates kept forever',
      },
      quota: {
        title: 'Subscription quotas', h5: '5-hour quota', week: 'Weekly quota',
        st: { normal: 'Normal', low: 'Almost gone', reset: 'Awaiting reset' },
        plans: { 'glm-primary': 'GLM Coding Plan', 'glm-backup': 'GLM Coding Plan backup', codex: 'ChatGPT Pro', claude: 'Claude Pro' },
      },
      today: { title: 'Today via gateway', reqs: 'Requests', rate: 'Success rate', fb: 'Fallbacks', tok: 'Tokens today', cost: 'Cost today', lowRate: 'Below 95%' },
      tr: {
        r7: '7d', r30: '30d', r90: '90d', r1y: '1y', total: 'Total', mix: 'Mix',
        kinds: [['input', 'Input'], ['output', 'Output'], ['cacheWrite', 'Cache write'], ['cacheRead', 'Cache read']],
        sum: 'Total', other: 'Other', cost: 'Cost (USD)', bySrc: 'Stacked by source',
      },
      ch: {
        p1: 'Today', p7: 'Last 7 days', p30: 'Last 30 days', all: 'All channels',
        tokL: 'Tokens processed', costL: 'Total cost', reqs: 'Requests', abort: 'Client aborts',
        rate: 'Success rate', hit: 'Cache hit', trend: 'Usage trend', na: 'Not provided', cost: 'Cost',
      },
      src: {
        all: 'All', agent: 'Agents', app: 'Apps',
        src: 'Source', model: 'Model', type: 'Type', tok: 'Tokens', cost: 'Cost', reqs: 'Requests', share: 'Share',
        served: 'Via gateway', observed: 'Direct', mix: 'Token mix', d30: 'Last 30 days',
        models: 'Models used', srcs: 'Sources using it', na: 'Not provided',
      },
      dev: { meta: (a, n) => `30-day tokens · Last data ${a.m != null ? a.m + ' min ago' : a.d != null ? a.d + ' days ago' : '—'} · ${n} records in 7 days` },
      rt: {
        cat: 'Models & routing chains', mods: 'Inputs', chain: 'Chain', mod: { text: 'Text', image: 'Image', pdf: 'PDF' },
        in: (n) => `${n} models`, clear: 'Clear filter',
        sugg: 'Model suggestions', up: 'Upgrade', when: '2h ago',
        cur: 'Current', cand: 'Found', modsRow: 'Inputs',
        pin: 'Input price (per M)', pout: 'Output price (per M)', ctx: 'Context',
        add: 'Add, keep old', repl: 'Replace old', drop: 'Dismiss', undo: 'Undo',
        added: (m) => `Added ${m}, old kept`, replaced: (m) => `Replaced with ${m}, old removed`, dropped: 'Suggestion dismissed',
        even: 'Same',
      },
    },
  };
  const T = () => TXT[MG.lang === 'en' ? 'en' : 'zh'];

  /* ───────── 图标（与 site/index.html 同源，原样拼接） ───────── */
  const PICON = {"zhipu": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB2ZXJzaW9uPSIxLjEiIHg9IjBweCIgeT0iMHB4IiBzdHlsZT0iZW5hYmxlLWJhY2tncm91bmQ6bmV3IDAgMCAzMCAzMDsiIHhtbDpzcGFjZT0icHJlc2VydmUiIHZpZXdCb3g9IjEuMTcgMS4xNyAyNy42NiAyNy42NSI+CjxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+Cgkuc3Qwe29wYWNpdHk6MC4zO2ZpbGw6I0UyRTRFNzt9Cgkuc3Qxe29wYWNpdHk6MC44O2ZpbGw6I0UyRTRFNztzdHJva2U6I0ZGRkZGRjtzdHJva2Utd2lkdGg6NTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3Qye2ZpbGw6dXJsKCNTVkdJRF8xXyk7fQoJLnN0M3tmaWxsOm5vbmU7c3Ryb2tlOiNFMEU0RTk7c3Ryb2tlLXdpZHRoOjAuMjU7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0NHtmaWxsOm5vbmU7fQoJLnN0NXtmaWxsOiM5REExQTU7fQoJLnN0NntmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOm5vbmU7fQoJLnN0N3tmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOiNERkUyRTc7fQoJLnN0OHtmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOiNDREQ0REE7fQoJLnN0OXtmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOiNCM0JDQzc7fQoJLnN0MTB7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDojOURBQUI3O30KCS5zdDExe2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6Izg2OThBODt9Cgkuc3QxMntmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOnVybCgjU1ZHSURfMl8pO30KCS5zdDEze2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF8zXyk7fQoJLnN0MTR7ZmlsbDojMUY2M0VDO30KCS5zdDE1e2ZpbGw6IzJEMkQyRDt9Cgkuc3QxNntmaWxsOm5vbmU7c3Ryb2tlOiNFMEU0RTk7c3Ryb2tlLXdpZHRoOjAuNTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxN3tmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOnVybCgjU1ZHSURfNF8pO30KCS5zdDE4e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF81Xyk7fQoJLnN0MTl7ZmlsbDpub25lO3N0cm9rZTojNjc3MzgwO3N0cm9rZS13aWR0aDowLjU7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MjB7ZmlsbDpub25lO3N0cm9rZTp1cmwoI1NWR0lEXzZfKTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QyMXtmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOnVybCgjU1ZHSURfN18pO30KCS5zdDIye2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF84Xyk7fQoJLnN0MjN7ZmlsbDojRkZGRkZGO30KCS5zdDI0e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6IzJEMkQyRDt9Cgkuc3QyNXtjbGlwLXBhdGg6dXJsKCNTVkdJRF8xMF8pO30KCS5zdDI2e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzEyXyk7fQoJLnN0Mjd7ZmlsbDp1cmwoI1NWR0lEXzEzXyk7fQoJLnN0Mjh7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDp1cmwoI1NWR0lEXzE0Xyk7fQoJLnN0Mjl7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDp1cmwoI1NWR0lEXzE1Xyk7fQoJLnN0MzB7Y2xpcC1wYXRoOnVybCgjU1ZHSURfMTdfKTt9Cgkuc3QzMXtjbGlwLXBhdGg6dXJsKCNTVkdJRF8xOV8pO30KCS5zdDMye2ZpbGw6dXJsKCNTVkdJRF8yMF8pO30KCS5zdDMze2ZpbGw6bm9uZTtzdHJva2U6dXJsKCNTVkdJRF8yMV8pO3N0cm9rZS13aWR0aDoyO3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDM0e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF8yMl8pO30KCS5zdDM1e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF8yM18pO30KCS5zdDM2e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzI1Xyk7fQoJLnN0Mzd7Y2xpcC1wYXRoOnVybCgjU1ZHSURfMjdfKTt9Cgkuc3QzOHtmaWxsOnVybCgjU1ZHSURfMjhfKTt9Cgkuc3QzOXtjbGlwLXBhdGg6dXJsKCNTVkdJRF8zMF8pO30KCS5zdDQwe2NsaXAtcGF0aDp1cmwoI1NWR0lEXzMyXyk7fQoJLnN0NDF7ZmlsbDp1cmwoI1NWR0lEXzMzXyk7fQoJLnN0NDJ7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDojMTI2RUY2O30KCS5zdDQze2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6I0ZGRkZGRjt9Cgkuc3Q0NHtjbGlwLXBhdGg6dXJsKCNTVkdJRF8zNV8pO30KCS5zdDQ1e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzM3Xyk7fQoJLnN0NDZ7ZmlsbDp1cmwoI1NWR0lEXzM4Xyk7fQoJLnN0NDd7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDojOURBMUE1O30KCS5zdDQ4e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF8zOV8pO30KCS5zdDQ5e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80MF8pO30KCS5zdDUwe2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80MV8pO30KCS5zdDUxe2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80Ml8pO30KCS5zdDUye2ZpbGw6bm9uZTtzdHJva2U6dXJsKCNTVkdJRF80M18pO3N0cm9rZS13aWR0aDoyO3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDUze2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6bm9uZTtzdHJva2U6I0UwRTRFOTtzdHJva2Utd2lkdGg6MC41O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDU0e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80NF8pO30KCS5zdDU1e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80NV8pO30KCS5zdDU2e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80Nl8pO30KCS5zdDU3e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80N18pO30KCS5zdDU4e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80OF8pO30KCS5zdDU5e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF80OV8pO30KCS5zdDYwe2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF81MF8pO30KCS5zdDYxe2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF81MV8pO30KCS5zdDYye2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF81Ml8pO30KCS5zdDYze2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF81M18pO30KCS5zdDY0e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzU1Xyk7fQoJLnN0NjV7Y2xpcC1wYXRoOnVybCgjU1ZHSURfNTdfKTt9Cgkuc3Q2NntmaWxsOnVybCgjU1ZHSURfNThfKTt9Cgkuc3Q2N3tjbGlwLXBhdGg6dXJsKCNTVkdJRF82MF8pO30KCS5zdDY4e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzYyXyk7fQoJLnN0Njl7ZmlsbDp1cmwoI1NWR0lEXzYzXyk7fQoJLnN0NzB7ZmlsbDpub25lO3N0cm9rZTp1cmwoI1NWR0lEXzY0Xyk7c3Ryb2tlLXdpZHRoOjI7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0NzF7Y2xpcC1wYXRoOnVybCgjU1ZHSURfNjZfKTt9Cgkuc3Q3MntjbGlwLXBhdGg6dXJsKCNTVkdJRF82OF8pO30KCS5zdDcze2ZpbGw6dXJsKCNTVkdJRF82OV8pO30KCS5zdDc0e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzcxXyk7fQoJLnN0NzV7Y2xpcC1wYXRoOnVybCgjU1ZHSURfNzNfKTt9Cgkuc3Q3NntmaWxsOnVybCgjU1ZHSURfNzRfKTt9Cgkuc3Q3N3tjbGlwLXBhdGg6dXJsKCNTVkdJRF83Nl8pO30KCS5zdDc4e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzc4Xyk7fQoJLnN0Nzl7ZmlsbDp1cmwoI1NWR0lEXzc5Xyk7fQoJLnN0ODB7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDp1cmwoI1NWR0lEXzgwXyk7fQoJLnN0ODF7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDp1cmwoI1NWR0lEXzgxXyk7fQoJLnN0ODJ7Y2xpcC1wYXRoOnVybCgjU1ZHSURfODNfKTt9Cgkuc3Q4M3tjbGlwLXBhdGg6dXJsKCNTVkdJRF84NV8pO30KCS5zdDg0e2ZpbGw6dXJsKCNTVkdJRF84Nl8pO30KCS5zdDg1e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF84N18pO30KCS5zdDg2e2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6dXJsKCNTVkdJRF84OF8pO30KCS5zdDg3e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzkwXyk7fQoJLnN0ODh7Y2xpcC1wYXRoOnVybCgjU1ZHSURfOTJfKTt9Cgkuc3Q4OXtmaWxsOnVybCgjU1ZHSURfOTNfKTt9Cgkuc3Q5MHtmaWxsOm5vbmU7c3Ryb2tlOnVybCgjU1ZHSURfOTRfKTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3Q5MXtmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOnVybCgjU1ZHSURfOTVfKTt9Cgkuc3Q5MntmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtmaWxsOnVybCgjU1ZHSURfOTZfKTt9Cgkuc3Q5M3tjbGlwLXBhdGg6dXJsKCNTVkdJRF85OF8pO30KCS5zdDk0e2NsaXAtcGF0aDp1cmwoI1NWR0lEXzEwMF8pO30KCS5zdDk1e2ZpbGw6dXJsKCNTVkdJRF8xMDFfKTt9Cgkuc3Q5NntjbGlwLXBhdGg6dXJsKCNTVkdJRF8xMDNfKTt9Cgkuc3Q5N3tjbGlwLXBhdGg6dXJsKCNTVkdJRF8xMDVfKTt9Cgkuc3Q5OHtmaWxsOnVybCgjU1ZHSURfMTA2Xyk7fQoJLnN0OTl7Y2xpcC1wYXRoOnVybCgjU1ZHSURfMTA4Xyk7fQoJLnN0MTAwe2NsaXAtcGF0aDp1cmwoI1NWR0lEXzExMF8pO30KCS5zdDEwMXtmaWxsOnVybCgjU1ZHSURfMTExXyk7fQoJLnN0MTAye2ZpbGw6I0ZGRkZGRjtzdHJva2U6I0IzQkNDNztzdHJva2Utd2lkdGg6MC4yNzU7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MTAze2NsaXAtcGF0aDp1cmwoI1NWR0lEXzExM18pO30KCS5zdDEwNHtmaWxsOiNGREQxMzg7fQoJLnN0MTA1e2ZpbGw6I0ZDQTYyRjt9Cgkuc3QxMDZ7ZmlsbDojRkI3OTI3O30KCS5zdDEwN3tmaWxsOiNGNDRCMjI7fQoJLnN0MTA4e2ZpbGw6I0Q4MTkxNTt9Cgkuc3QxMDl7ZmlsbDojMkQyRDJEO3N0cm9rZTojRkZGRkZGO3N0cm9rZS13aWR0aDowLjMzNTQ7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MTEwe2ZpbGw6bm9uZTtzdHJva2U6IzY1NzI3RjtzdHJva2Utd2lkdGg6MjtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxMTF7ZmlsbDpub25lO3N0cm9rZTojNjU3MjdGO3N0cm9rZS13aWR0aDowLjc1O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDExMntmaWxsOnVybCgjU1ZHSURfMTE0Xyk7fQoJLnN0MTEze2ZpbGw6I0QwNkM1MDt9Cgkuc3QxMTR7ZmlsbDojMkQyRDJEO3N0cm9rZTojQjNCQ0M3O3N0cm9rZS13aWR0aDowLjI3NTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxMTV7b3BhY2l0eTowLjI7fQoJLnN0MTE2e2ZpbGw6bm9uZTtzdHJva2U6IzY3NzM4MDtzdHJva2Utd2lkdGg6MC4zNTY0O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDExN3tmaWxsOm5vbmU7c3Ryb2tlOiM2NzczODA7c3Ryb2tlLXdpZHRoOjAuMzU2NDtzdHJva2UtbWl0ZXJsaW1pdDoxMDtzdHJva2UtZGFzaGFycmF5OjEuMDIxMiwxLjAyMTI7fQoJLnN0MTE4e2ZpbGw6bm9uZTtzdHJva2U6IzY3NzM4MDtzdHJva2Utd2lkdGg6MC4zNTY0O3N0cm9rZS1taXRlcmxpbWl0OjEwO3N0cm9rZS1kYXNoYXJyYXk6MS4wMjA1LDEuMDIwNTt9Cgkuc3QxMTl7b3BhY2l0eTowLjI7ZmlsbDpub25lO30KCS5zdDEyMHtmaWxsOm5vbmU7c3Ryb2tlOiM2NzczODA7c3Ryb2tlLXdpZHRoOjAuMzY4OTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxMjF7ZmlsbDpub25lO3N0cm9rZTojNjc3MzgwO3N0cm9rZS13aWR0aDowLjM2ODk7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLWRhc2hhcnJheToxLjA1MDksMS4wNTA5O30KCS5zdDEyMntvcGFjaXR5OjAuMztmaWxsOiMxRjYzRUM7fQoJLnN0MTIze2ZpbGw6IzJEMkQyRDtzdHJva2U6I0ZGRkZGRjtzdHJva2Utd2lkdGg6MC4zMTYyO3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDEyNHtmaWxsOiNGRkZGRkY7c3Ryb2tlOiNCM0JDQzc7c3Ryb2tlLXdpZHRoOjAuMzE2MjtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxMjV7Y2xpcC1wYXRoOnVybCgjU1ZHSURfMTE4Xyk7fQoJLnN0MTI2e2ZpbGw6dXJsKCNTVkdJRF8xMTlfKTt9Cgkuc3QxMjd7ZmlsbDpub25lO3N0cm9rZTojREZFMkU3O3N0cm9rZS13aWR0aDowLjc1O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDEyOHtmaWxsOiM5REExQTU7c3Ryb2tlOiNGRkZGRkY7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MTI5e2ZpbGw6dXJsKCNTVkdJRF8xMjBfKTt9Cgkuc3QxMzB7ZmlsbDpub25lO3N0cm9rZTojNjc3MzgwO3N0cm9rZS13aWR0aDowLjc1O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDEzMXtvcGFjaXR5OjAuNDt9Cgkuc3QxMzJ7Y2xpcC1wYXRoOnVybCgjU1ZHSURfMTIyXyk7fQoJLnN0MTMze2NsaXAtcGF0aDp1cmwoI1NWR0lEXzEyNF8pO30KCS5zdDEzNHtmaWxsOnVybCgjU1ZHSURfMTI1Xyk7fQoJLnN0MTM1e2ZpbGw6bm9uZTtzdHJva2U6IzgzOTJBMztzdHJva2Utd2lkdGg6MC4zNTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxMzZ7ZmlsbDpub25lO3N0cm9rZTojODM5MkEzO3N0cm9rZS13aWR0aDowLjM1O3N0cm9rZS1taXRlcmxpbWl0OjEwO3N0cm9rZS1kYXNoYXJyYXk6MC45OTUxLDAuOTk1MTt9Cgkuc3QxMzd7ZmlsbDpub25lO3N0cm9rZTojODM5MkEzO3N0cm9rZS13aWR0aDowLjM1O3N0cm9rZS1taXRlcmxpbWl0OjEwO3N0cm9rZS1kYXNoYXJyYXk6MS4wMDQsMS4wMDQ7fQoJLnN0MTM4e2ZpbGw6bm9uZTtzdHJva2U6dXJsKCNTVkdJRF8xMjZfKTtzdHJva2Utd2lkdGg6MS41O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDEzOXtmaWxsOnVybCgjU1ZHSURfMTI3Xyk7fQoJLnN0MTQwe2ZpbGw6bm9uZTtzdHJva2U6I0RERTBFNDtzdHJva2Utd2lkdGg6MC4zNTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNDF7ZmlsbDojMkQyRDJEO3N0cm9rZTojQTlCM0JFO3N0cm9rZS13aWR0aDowLjI3NTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNDJ7ZmlsbC1ydWxlOmV2ZW5vZGQ7Y2xpcC1ydWxlOmV2ZW5vZGQ7ZmlsbDojMTI2RUY0O30KCS5zdDE0M3tmaWxsOiNGRkZGRkY7c3Ryb2tlOiNCMUJBQzQ7c3Ryb2tlLXdpZHRoOjAuMjc1O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDE0NHtmaWxsOiNDRTZDNTA7fQoJLnN0MTQ1e2ZpbGw6IzVCNUI1Qjt9Cgkuc3QxNDZ7ZmlsbDojODM5MkEzO30KCS5zdDE0N3tmaWxsOm5vbmU7c3Ryb2tlOnVybCgjU1ZHSURfMTI4Xyk7c3Ryb2tlLXdpZHRoOjEuNTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNDh7ZmlsbDp1cmwoI1NWR0lEXzEyOV8pO30KCS5zdDE0OXtmaWxsOm5vbmU7c3Ryb2tlOiNCNUJEQzQ7c3Ryb2tlLXdpZHRoOjAuNztzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNTB7b3BhY2l0eTowLjY7ZmlsbDpub25lO3N0cm9rZTojNzg4MzhFO3N0cm9rZS13aWR0aDowLjM1O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDE1MXtvcGFjaXR5OjAuMjtmaWxsOm5vbmU7c3Ryb2tlOiM4MzkyQTM7c3Ryb2tlLXdpZHRoOjAuMzU7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLWRhc2hhcnJheToxLDE7fQoJLnN0MTUye2ZpbGw6bm9uZTtzdHJva2U6I0RERTBFNDtzdHJva2Utd2lkdGg6MC43NTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNTN7ZmlsbDpub25lO3N0cm9rZTojODM5MkEzO3N0cm9rZS13aWR0aDowLjU7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MTU0e29wYWNpdHk6MC4yO2ZpbGw6bm9uZTtzdHJva2U6IzY3NzM4MDtzdHJva2Utd2lkdGg6MC4zNTY0O3N0cm9rZS1taXRlcmxpbWl0OjEwO3N0cm9rZS1kYXNoYXJyYXk6MS4wMTgyLDEuMDE4Mjt9Cgkuc3QxNTV7ZmlsbDpub25lO3N0cm9rZTojRERFMEU0O3N0cm9rZS13aWR0aDowLjc2NTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNTZ7ZmlsbDp1cmwoI1NWR0lEXzEzMF8pO30KCS5zdDE1N3tmaWxsOnVybCgjU1ZHSURfMTMxXyk7fQoJLnN0MTU4e2ZpbGw6I0IxQkFDNDt9Cgkuc3QxNTl7ZmlsbDojQ0JEMUQ4O30KCS5zdDE2MHtmaWxsOiMwQjFCMkI7fQoJLnN0MTYxe2ZpbGw6IzkxRDExOTt9Cgkuc3QxNjJ7b3BhY2l0eTowLjc7fQoJLnN0MTYze2ZpbGw6I0ZGRkZGRjtzdHJva2U6IzAwMDAwMDtzdHJva2Utd2lkdGg6MC40NDE4O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDE2NHtmaWxsOm5vbmU7c3Ryb2tlOiM5MzlDQUE7c3Ryb2tlLXdpZHRoOjAuMjIwOTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNjV7ZmlsbDpub25lO3N0cm9rZTojRkZGRkZGO3N0cm9rZS13aWR0aDozLjA5MjQ7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MTY2e2ZpbGw6dXJsKCNTVkdJRF8xMzJfKTt9Cgkuc3QxNjd7ZmlsbDpub25lO3N0cm9rZTp1cmwoI1NWR0lEXzEzM18pO3N0cm9rZS13aWR0aDoxLjcxNDtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxNjh7ZmlsbDp1cmwoI1NWR0lEXzEzNF8pO30KCS5zdDE2OXtmaWxsOnVybCgjU1ZHSURfMTM1Xyk7fQoJLnN0MTcwe2ZpbGw6dXJsKCNTVkdJRF8xMzZfKTt9Cgkuc3QxNzF7ZmlsbDp1cmwoI1NWR0lEXzEzN18pO30KCS5zdDE3MntmaWxsOnVybCgjU1ZHSURfMTM4Xyk7fQoJLnN0MTcze2ZpbGw6dXJsKCNTVkdJRF8xMzlfKTt9Cgkuc3QxNzR7ZmlsbDp1cmwoI1NWR0lEXzE0MF8pO30KCS5zdDE3NXtmaWxsOnVybCgjU1ZHSURfMTQxXyk7fQoJLnN0MTc2e2ZpbGw6dXJsKCNTVkdJRF8xNDJfKTt9Cgkuc3QxNzd7ZmlsbDp1cmwoI1NWR0lEXzE0M18pO30KCS5zdDE3OHtmaWxsOnVybCgjU1ZHSURfMTQ0Xyk7fQoJLnN0MTc5e2ZpbGw6bm9uZTtzdHJva2U6IzFGNjNFQztzdHJva2Utd2lkdGg6NDtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxODB7ZmlsbDpub25lO3N0cm9rZTojMEIxQjJCO3N0cm9rZS13aWR0aDo0O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDE4MXtmaWxsOm5vbmU7c3Ryb2tlOiM2NzczODA7c3Ryb2tlLXdpZHRoOjAuMzk4OTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxODJ7ZmlsbDpub25lO3N0cm9rZTojNjc3MzgwO3N0cm9rZS13aWR0aDowLjM5ODk7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLWRhc2hhcnJheToxLjE0LDEuMTQ7fQoJLnN0MTgze2ZpbGw6IzI1N0FGMTt9Cgkuc3QxODR7b3BhY2l0eTowLjM7ZmlsbDojRkZGRkZGO30KCS5zdDE4NXtmaWxsOm5vbmU7c3Ryb2tlOiM5OEE1QjI7c3Ryb2tlLXdpZHRoOjQ7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MTg2e2ZpbGw6bm9uZTtzdHJva2U6IzY1NzI3RjtzdHJva2Utd2lkdGg6MC4zOTg5O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDE4N3tmaWxsOm5vbmU7c3Ryb2tlOiM2NTcyN0Y7c3Ryb2tlLXdpZHRoOjAuMzk4OTtzdHJva2UtbWl0ZXJsaW1pdDoxMDtzdHJva2UtZGFzaGFycmF5OjEuMTQsMS4xNDt9Cgkuc3QxODh7ZmlsbDpub25lO3N0cm9rZTojRERERkU0O3N0cm9rZS13aWR0aDowLjc1O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KCS5zdDE4OXtmaWxsOiM5QTlFQTI7fQoJLnN0MTkwe2ZpbGwtcnVsZTpldmVub2RkO2NsaXAtcnVsZTpldmVub2RkO2ZpbGw6IzMyNjdBQzt9Cgkuc3QxOTF7ZmlsbDojRkZGRkZGO3N0cm9rZTojQUZCOEMzO3N0cm9rZS13aWR0aDowLjI3NTtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3QxOTJ7ZmlsbDojQzU2OTRFO30KCS5zdDE5M3tmaWxsOiM4MTkyQTI7fQoJLnN0MTk0e2ZpbGw6IzJEMkQyRDtzdHJva2U6I0ZGRkZGRjtzdHJva2Utd2lkdGg6MC42MzE3O3N0cm9rZS1taXRlcmxpbWl0OjEwO30KPC9zdHlsZT4KPGcgaWQ9IuWbvuWxgl8yIj4KPC9nPgo8ZyBpZD0i5Zu+5bGCXzEiPgoJPHBhdGggY2xhc3M9InN0MTk0IiBkPSJNMjQuNTEsMjguNTFINS40OWMtMi4yMSwwLTQtMS43OS00LTRWNS40OWMwLTIuMjEsMS43OS00LDQtNGgxOS4wM2MyLjIxLDAsNCwxLjc5LDQsNHYxOS4wMyAgIEMyOC41MSwyNi43MiwyNi43MiwyOC41MSwyNC41MSwyOC41MXoiLz4KCTxnPgoJCTxnPgoJCQk8Zz4KCQkJCTxnPgoJCQkJCTxwYXRoIGNsYXNzPSJzdDIzIiBkPSJNMTUuNDcsNy4xbC0xLjMsMS44NWMtMC4yLDAuMjktMC41NCwwLjQ3LTAuOSwwLjQ3aC03LjFWNy4wOUM2LjE2LDcuMSwxNS40Nyw3LjEsMTUuNDcsNy4xeiIvPgoJCQkJCTxwb2x5Z29uIGNsYXNzPSJzdDIzIiBwb2ludHM9IjI0LjMsNy4xIDEzLjE0LDIyLjkxIDUuNywyMi45MSAxNi44Niw3LjEgICAgICAiLz4KCQkJCQk8cGF0aCBjbGFzcz0ic3QyMyIgZD0iTTE0LjUzLDIyLjkxbDEuMzEtMS44NmMwLjItMC4yOSwwLjU0LTAuNDcsMC45LTAuNDdoNy4wOXYyLjMzSDE0LjUzeiIvPgoJCQkJPC9nPgoJCQk8L2c+CgkJPC9nPgoJPC9nPgo8L2c+Cjwvc3ZnPg==", "openai": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MDAiIGhlaWdodD0iODAwIiB2aWV3Qm94PSIwIDAgMjQgMjQiPjxwYXRoIGQ9Ik0yMi4yODIgOS44MjFhNiA2IDAgMCAwLS41MTYtNC45MSA2LjA1IDYuMDUgMCAwIDAtNi41MS0yLjlBNi4wNjUgNi4wNjUgMCAwIDAgNC45ODEgNC4xOGE2IDYgMCAwIDAtMy45OTggMi45IDYuMDUgNi4wNSAwIDAgMCAuNzQzIDcuMDk3IDUuOTggNS45OCAwIDAgMCAuNTEgNC45MTEgNi4wNSA2LjA1IDAgMCAwIDYuNTE1IDIuOUE2IDYgMCAwIDAgMTMuMjYgMjRhNi4wNiA2LjA2IDAgMCAwIDUuNzcyLTQuMjA2IDYgNiAwIDAgMCAzLjk5Ny0yLjkgNi4wNiA2LjA2IDAgMCAwLS43NDctNy4wNzNNMTMuMjYgMjIuNDNhNC40OCA0LjQ4IDAgMCAxLTIuODc2LTEuMDRsLjE0MS0uMDgxIDQuNzc5LTIuNzU4YS44LjggMCAwIDAgLjM5Mi0uNjgxdi02LjczN2wyLjAyIDEuMTY4YS4wNy4wNyAwIDAgMSAuMDM4LjA1MnY1LjU4M2E0LjUwNCA0LjUwNCAwIDAgMS00LjQ5NCA0LjQ5NE0zLjYgMTguMzA0YTQuNDcgNC40NyAwIDAgMS0uNTM1LTMuMDE0bC4xNDIuMDg1IDQuNzgzIDIuNzU5YS43Ny43NyAwIDAgMCAuNzggMGw1Ljg0My0zLjM2OXYyLjMzMmEuMDguMDggMCAwIDEtLjAzMy4wNjJMOS43NCAxOS45NWE0LjUgNC41IDAgMCAxLTYuMTQtMS42NDZNMi4zNCA3Ljg5NmE0LjUgNC41IDAgMCAxIDIuMzY2LTEuOTczVjExLjZhLjc3Ljc3IDAgMCAwIC4zODguNjc3bDUuODE1IDMuMzU0LTIuMDIgMS4xNjhhLjA4LjA4IDAgMCAxLS4wNzEgMGwtNC44My0yLjc4NkE0LjUwNCA0LjUwNCAwIDAgMSAyLjM0IDcuODcyem0xNi41OTcgMy44NTUtNS44MzMtMy4zODdMMTUuMTE5IDcuMmEuMDguMDggMCAwIDEgLjA3MSAwbDQuODMgMi43OTFhNC40OTQgNC40OTQgMCAwIDEtLjY3NiA4LjEwNXYtNS42NzhhLjc5Ljc5IDAgMCAwLS40MDctLjY2N20yLjAxLTMuMDIzLS4xNDEtLjA4NS00Ljc3NC0yLjc4MmEuNzguNzggMCAwIDAtLjc4NSAwTDkuNDA5IDkuMjNWNi44OTdhLjA3LjA3IDAgMCAxIC4wMjgtLjA2MWw0LjgzLTIuNzg3YTQuNSA0LjUgMCAwIDEgNi42OCA0LjY2em0tMTIuNjQgNC4xMzUtMi4wMi0xLjE2NGEuMDguMDggMCAwIDEtLjAzOC0uMDU3VjYuMDc1YTQuNSA0LjUgMCAwIDEgNy4zNzUtMy40NTNsLS4xNDIuMDhMOC43MDQgNS40NmEuOC44IDAgMCAwLS4zOTMuNjgxem0xLjA5Ny0yLjM2NSAyLjYwMi0xLjUgMi42MDcgMS41djIuOTk5bC0yLjU5NyAxLjUtMi42MDctMS41WiIvPjwvc3ZnPg==", "deepseek": "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iTGF5ZXJfMiIgZGF0YS1uYW1lPSJMYXllciAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzNzcuMSAyNzcuODYiPgogIDxkZWZzPgogICAgPHN0eWxlPgogICAgICAuY2xzLTEgewogICAgICAgIGZpbGw6ICM0ZDZiZmU7CiAgICAgICAgc3Ryb2tlLXdpZHRoOiAwcHg7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJMYXllcl8xLTIiIGRhdGEtbmFtZT0iTGF5ZXIgMSI+CiAgICA8cGF0aCBpZD0icGF0aCIgY2xhc3M9ImNscy0xIiBkPSJNMzczLjE1LDIzLjMyYy00LTEuOTUtNS43MiwxLjc3LTguMDYsMy42Ni0uNzkuNjItMS40NywxLjQzLTIuMTQsMi4xNC01Ljg1LDYuMjYtMTIuNjcsMTAuMzYtMjEuNTcsOS44Ni0xMy4wNC0uNzEtMjQuMTYsMy4zOC0zMy45OSwxMy4zNy0yLjA5LTEyLjMxLTkuMDQtMTkuNjYtMTkuNi0yNC4zOC01LjU0LTIuNDUtMTEuMTMtNC45LTE0Ljk5LTEwLjIzLTIuNzEtMy43OC0zLjQ0LTgtNC44MS0xMi4xNi0uODUtMi41MS0xLjcyLTUuMDktNC42LTUuNTItMy4xMy0uNS00LjM2LDIuMTQtNS41OCw0LjM0LTQuOTMsOC45OS02LjgyLDE4LjkyLTYuNjUsMjguOTcuNDMsMjIuNTgsOS45Nyw0MC41NiwyOC44OSw1My4zNywyLjE2LDEuNDYsMi43MSwyLjk1LDIuMDMsNS4wOS0xLjI5LDQuNC0yLjgyLDguNjgtNC4xOSwxMy4wOS0uODUsMi44Mi0yLjE0LDMuNDQtNS4xNSwyLjItMTAuMzktNC4zNC0xOS4zNy0xMC43Ni0yNy4yOS0xOC41NS0xMy40Ni0xMy4wMi0yNS42My0yNy40MS00MC44MS0zOC42Ny0zLjU3LTIuNjQtNy4xMi01LjA5LTEwLjgxLTcuNDEtMTUuNDktMTUuMDcsMi4wMy0yNy40NSw2LjA4LTI4LjksNC4yNS0xLjUyLDEuNDctNi43OS0xMi4yMy02LjczLTEzLjY5LjA2LTI2LjI0LDQuNjUtNDIuMjEsMTAuNzYtMi4zNC45My00Ljc5LDEuNjEtNy4zMiwyLjE0LTE0LjUtMi43My0yOS41NS0zLjM1LTQ1LjI5LTEuNTgtMjkuNjIsMy4zMi01My4yOCwxNy4zNC03MC42OCw0MS4yOEMxLjI5LDg4LjItMy42MywxMjAuODgsMi4zOSwxNTVjNi4zMywzNS45MSwyNC42NCw2NS42OCw1Mi44LDg4Ljk0LDI5LjE4LDI0LjEsNjIuOCwzNS45MSwxMDEuMTUsMzMuNjUsMjMuMjktMS4zMyw0OS4yMy00LjQ2LDc4LjQ4LTI5LjI0LDcuMzgsMy42NiwxNS4xMiw1LjEyLDI3Ljk3LDYuMjMsOS44OS45MywxOS40MS0uNSwyNi43OS0yLjAyLDExLjU1LTIuNDUsMTAuNzUtMTMuMTUsNi41OC0xNS4xMy0zMy44Ny0xNS43OC0yNi40NC05LjM2LTMzLjItMTQuNTQsMTcuMjEtMjAuNDEsNDMuMTUtNDEuNTksNTMuMy0xMTAuMTkuNzktNS40Ni4xMS04Ljg3LDAtMTMuMy0uMDYtMi42Ny41NC0zLjcyLDMuNjEtNC4wMyw4LjQ4LS45NiwxNi43Mi0zLjI5LDI0LjI4LTcuNDcsMjEuOTQtMTIsMzAuNzgtMzEuNjksMzIuODctNTUuMzMuMzEtMy42LS4wNi03LjM1LTMuODYtOS4yNFpNMTgxLjk2LDIzNS45N2MtMzIuODMtMjUuODMtNDguNzQtMzQuMzMtNTUuMzEtMzMuOTYtNi4xNC4zNC01LjA0LDcuMzgtMy42OSwxMS45NywxLjQxLDQuNTMsMy4yNiw3LjY2LDUuODUsMTEuNjMsMS43OCwyLjY0LDMuMDEsNi41Ny0xLjc4LDkuNDktMTAuNTcsNi41OC0yOC45NS0yLjItMjkuODItMi42NC0yMS4zOC0xMi41OS0zOS4yNi0yOS4yNC01MS44Ny01Mi4wMS0xMi4xNi0yMS45Mi0xOS4yMy00NS40My0yMC4zOS03MC41Mi0uMzEtNi4wOCwxLjQ3LTguMjIsNy40OS05LjMsNy45Mi0xLjQ2LDE2LjExLTEuNzcsMjQuMDMtLjYyLDMzLjQ5LDQuOSw2Mi4wMSwxOS45MSw4NS45LDQzLjYzLDEzLjY1LDEzLjU1LDIzLjk3LDI5LjcxLDM0LjYxLDQ1LjQ5LDExLjMsMTYuNzgsMjMuNDgsMzIuNzUsMzguOTcsNDUuODQsNS40Niw0LjU5LDkuODMsOC4wOSwxNCwxMC42Ny0xMi41OSwxLjQtMzMuNjIsMS43MS00Ny45OS05LjY4Wk0xOTcuNjksMTM0LjY1YzAtMi43LDIuMTUtNC44NCw0Ljg3LTQuODQuNiwwLDEuMTYuMTIsMS42Ni4zMS42Ny4yNSwxLjI5LjYyLDEuNzcsMS4xOC44Ny44NCwxLjM2LDIuMDgsMS4zNiwzLjM1LDAsMi43LTIuMTUsNC44NC00Ljg1LDQuODRzLTQuODEtMi4xNC00LjgxLTQuODRaTTI0Ni41NSwxNTkuNzdjLTMuMTMsMS4yNy02LjI2LDIuMzktOS4yNywyLjUxLTQuNjcuMjItOS43Ny0xLjY4LTEyLjU1LTQtNC4zLTMuNi03LjM2LTUuNjEtOC42Ny0xMS45NC0uNTQtMi43LS4yMy02Ljg1LjI1LTkuMjQsMS4xMi01LjE1LS4xMi04LjQ0LTMuNzQtMTEuNDQtMi45Ni0yLjQ1LTYuNy0zLjEtMTAuODItMy4xLTEuNTQsMC0yLjk1LS42OC00LTEuMjQtMS43Mi0uODctMy4xMy0zLjAxLTEuNzgtNS42NC40My0uODQsMi41My0yLjkyLDMuMDItMy4yOSw1LjU4LTMuMTksMTIuMDMtMi4xNCwxOCwuMjUsNS41NCwyLjI2LDkuNzEsNi40MiwxNS43MiwxMi4yOCw2LjE2LDcuMSw3LjI2LDkuMDksMTAuNzYsMTQuMzksMi43Niw0LjE5LDUuMjksOC40Nyw3LjAxLDEzLjM3LDEuMDQsMy4wNC0uMzEsNS41NS0zLjk0LDcuMVoiLz4KICA8L2c+Cjwvc3ZnPg==", "claude": "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Crect%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%225%22%20fill%3D%22%23D97757%22%2F%3E%3Cpath%20d%3D%22M12%205.5v13M5.5%2012h13M7.4%207.4l9.2%209.2M16.6%207.4l-9.2%209.2%22%20stroke%3D%22%23FCFCFB%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E", "bailian": "data:image/png;base64,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"};
  const AGENT_ICON = {"claudecode": "<svg class=\"agent-ico\" viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z\" fill=\"#D97757\" fill-rule=\"nonzero\"></path></svg>", "codex": "<svg class=\"agent-ico\" viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z\"></path></svg>", "openclaw": "<svg class=\"agent-ico\" viewBox=\"0 0 120 120\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z\" fill=\"#ef4444\"/><path d=\"M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z\" fill=\"#ef4444\"/><path d=\"M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z\" fill=\"#ef4444\"/><path d=\"M45 15 Q35 5 30 8\" stroke=\"#ff4d4d\" stroke-width=\"3\" stroke-linecap=\"round\"/><path d=\"M75 15 Q85 5 90 8\" stroke=\"#ff4d4d\" stroke-width=\"3\" stroke-linecap=\"round\"/><circle cx=\"45\" cy=\"35\" r=\"6\" fill=\"#050810\"/><circle cx=\"75\" cy=\"35\" r=\"6\" fill=\"#050810\"/><circle cx=\"46\" cy=\"34\" r=\"2.5\" fill=\"#00e5cc\"/><circle cx=\"76\" cy=\"34\" r=\"2.5\" fill=\"#00e5cc\"/></svg>", "pi": "<svg class=\"agent-ico\" viewBox=\"0 0 800 800\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path fill=\"#F09082\" d=\"M165.29 165.29H517.36V400H400V282.65H165.29Z\"/><path fill=\"#4D9ABF\" d=\"M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z\"/><path fill=\"#F1BE58\" d=\"M517.36 400H634.72V634.72H517.36Z\"/></svg>"};
  const provIcon = (p) => {
    const hay = `${p?.id ?? ''} ${p?.name ?? ''} ${p?.badge ?? ''}`.toLowerCase();
    if (p?.type === 'glm') return { src: PICON.zhipu, cls: '' };
    if (p?.type === 'codex') return { src: PICON.openai, cls: 'invert-d' };
    if (p?.type === 'claude') return { src: PICON.claude, cls: '' };
    if (p?.type === 'dashscope') return { src: PICON.bailian, cls: '' };
    if (p?.type === 'openai') return hay.includes('deepseek') ? { src: PICON.deepseek, cls: '' } : { src: PICON.openai, cls: 'invert-d' };
    return { src: PICON.openai, cls: 'invert-d' };
  };
  const provLogo = (p, sm = false) => { const i = provIcon(p); return `<img class="prov-logo ${i.cls}${sm ? ' sm' : ''}" src="${i.src}" alt="" width="${sm ? 22 : 28}" height="${sm ? 22 : 28}">`; };
  const agentIcon = (kind) => AGENT_ICON[kind] ?? '';
  // 模型 id 展示时把尾部的 major-minor 版本号换成点（claude-opus-5-5 → claude-opus-5.5）
  const modelLabel = (id) => String(id ?? '').replace(/-(\d+)-(\d+)$/, '-$1.$2');

  /* ───────── 演示用展示常量（非统计数字：拓扑/能力/建议元数据） ───────── */
  const PROVIDERS = [
    { id: 'glm-primary', type: 'glm' },
    { id: 'glm-backup', type: 'glm' },
    { id: 'deepseek', type: 'openai' },
    { id: 'codex', type: 'codex' },
    { id: 'claude', type: 'claude' },
    { id: 'dashscope', type: 'dashscope' },
  ];
  const QUOTA_TYPE = { 'glm-primary': 'glm', 'glm-backup': 'glm', codex: 'codex', claude: 'claude' };
  // 调用链：数组元素为渠道 id，或 { p: 渠道, m: 改写后模型 }；mods 为输入能力
  const MODEL_META = {
    'glm-5.3': { chain: ['glm-primary', 'glm-backup'], mods: ['text', 'image', 'pdf'] },
    'glm-5.3-flash': { chain: ['glm-primary', 'glm-backup', { p: 'deepseek', m: 'deepseek-flash' }], mods: ['text', 'image', 'pdf'] },
    'deepseek-flash': { chain: ['deepseek'], mods: ['text'] },
    'deepseek-v4-pro': { chain: ['deepseek'], mods: ['text', 'pdf'] },
    'gpt-6-sol': { chain: ['codex'], mods: ['text', 'image', 'pdf'] },
    'gpt-6-luna': { chain: ['codex'], mods: ['text', 'image'] },
    'claude-opus-5-5': { chain: ['claude'], mods: ['text', 'image', 'pdf'] },
    'claude-sonnet-5-5': { chain: ['claude'], mods: ['text', 'image', 'pdf'] },
    'claude-haiku-5-5': { chain: ['claude'], mods: ['text', 'image', 'pdf'] },
    'text-embedding-v4': { chain: ['dashscope'], mods: ['text'] },
  };
  // 模型建议：现有 glm-5.3 价格与 data.js PRICES 同口径；候选为演示值
  const SUGG = {
    current: 'glm-5.3', candidate: 'glm-5.4',
    cur: { input: 0.60, output: 2.20, ctx: 128, mods: ['text', 'image', 'pdf'] },
    cand: { input: 0.50, output: 1.80, ctx: 200, mods: ['text', 'image', 'pdf'] },
  };

  /* ───────── 状态（仅内存） ───────── */
  const S = { view: 0, sub7: 'catalog', range: 30, tview: 'total', hidden: new Set(), chanPeriod: 30, chanSel: '', srcGroup: '', open: new Set(), sugg: null, prov: '' };
  const VIEWS = [
    { nav: 0 },
    { nav: 1 },
    { nav: 1 },
    { nav: 1 },
    { nav: 1 },
    { nav: 1 },
    { nav: 2 },
    { nav: 3 },
  ];
  const rowCache = new Map();
  const rollPrev = new Map();
  const CTX = []; // 每次渲染后需要绑定/绘制的宿主 { id, fn }
  let firstRender = true;
  let lastView = 0;
  let pendingScroll = false;

  /* ───────── 小工具 ───────── */
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const fmtTok = (n) => MG.fmt.tokens(n);
  const fmtUsd = (n) => MG.fmt.usd(n);
  const fmtPct = (n) => (n * 100).toFixed(n >= 0.1 || n === 0 ? 0 : 1) + '%';
  const nm = (dim, key) => { const e = MG.names[dim] && MG.names[dim][key]; if (!e) return key; return (MG.lang === 'en' ? e.en : e.zh) ?? key; };
  const shortDay = (s) => { const [y, m, d] = s.split('-').map(Number); return `${y}/${m}/${d}`; };
  function untilStr(min) {
    const m = Math.max(0, Math.round(min));
    if (MG.lang === 'en') {
      if (m < 60) return `Resets in ${m} min`;
      const h = Math.floor(m / 60);
      if (h < 48) return `Resets in ${h}h ${m % 60}m`;
      return `Resets in ${Math.floor(h / 24)}d ${h % 24}h`;
    }
    if (m < 60) return `${m} 分钟后重置`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} 小时 ${m % 60} 分后重置`;
    return `${Math.floor(h / 24)} 天 ${h % 24} 小时后重置`;
  }
  // 全期用量一次性分配分类色（c1..c10 / c-other），与线上控制台同法
  function rankColors(rows) {
    const order = [...rows].sort((a, b) => b.tokens - a.tokens).map((r) => r.key);
    return new Map(order.map((k, i) => [k, i < 10 ? `var(--c${i + 1})` : 'var(--c-other)']));
  }
  const K_COLOR = { input: 'var(--tok-in)', output: 'var(--tok-out)', cacheWrite: 'var(--tok-cc)', cacheRead: 'var(--tok-cr)' };

  /* ───────── 数字滚动（与控制台同法：data-from → data-to 缓动） ───────── */
  const ROLL_FMT = { int: fmtInt, tok: fmtTok, usd: fmtUsd, pct: fmtPct };
  function rollAttr(key, to, fmtName, from0 = false) {
    const from = from0 ? 0 : (rollPrev.has(key) ? rollPrev.get(key) : to);
    rollPrev.set(key, to);
    return from !== to && Number.isFinite(to) ? ` data-roll="${key}" data-from="${from}" data-to="${to}" data-fmt="${fmtName}"` : '';
  }
  const roll = (key, to, fmtName, fmtFn, from0 = false) => (to == null ? '' : `<span${rollAttr(key, to, fmtName, from0)}>${fmtFn(to)}</span>`);
  function animateRolls(scope) {
    if (reduced) return;
    for (const el of scope.querySelectorAll('[data-roll]')) {
      const to = Number(el.dataset.to), from = Number(el.dataset.from);
      const fmt = ROLL_FMT[el.dataset.fmt] ?? fmtInt;
      const t0 = performance.now(), dur = 800;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
  }
  const meterIO = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { meterIO.unobserve(en.target); en.target.style.transform = `scaleX(${en.target.dataset.target})`; }
  }, { threshold: 0.4 }) : null;
  function animateMeters(scope) {
    if (meterIO) meterIO.disconnect();
    for (const el of scope.querySelectorAll('.mgv-meter-fill')) {
      if (reduced || !meterIO) el.style.transform = `scaleX(${el.dataset.target})`;
      else meterIO.observe(el);
    }
  }

  /* ───────── 图表工具（手写 SVG） ───────── */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function smoothPath(pts) { // Catmull-Rom → bezier
    if (pts.length < 2) return '';
    if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`;
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }
  function frameSVG(iw, h, days, opts) {
    const { max, padL = 52, padR = 10, padT = 10, padB = 24, fmtY = fmtTok } = opts;
    const inner = iw - padL - padR;
    const x = (i) => (days.length < 2 ? padL + inner / 2 : padL + (i * inner) / (days.length - 1));
    const y = (v) => padT + (1 - v / max) * (h - padT - padB);
    const base = h - padB;
    let grid = '';
    for (let g = 1; g <= 4; g++) {
      const gy = padT + (g * (h - padT - padB)) / 4;
      grid += `<line class="mgv-gl" x1="${padL}" x2="${iw - padR}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}"></line><text class="mgv-ax" x="${padL - 6}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end">${fmtY((max * (4 - g)) / 4)}</text>`;
    }
    grid += `<line class="mgv-bl" x1="${padL}" x2="${iw - padR}" y1="${base}" y2="${base}"></line><text class="mgv-ax" x="${padL - 6}" y="${base + 3.5}" text-anchor="end">${fmtY(0)}</text>`;
    const step = Math.max(1, Math.ceil((days.length - 1) / Math.max(1, Math.floor(inner / 64))));
    let ticks = '';
    for (let i = 0; i < days.length; i += step) ticks += `<text class="mgv-ax" x="${x(i).toFixed(1)}" y="${h - padB + 16}" text-anchor="middle">${shortDay(days[i].date)}</text>`;
    return { x, y, base, padL, padR, padT, padB, grid, ticks };
  }
  // 迷你趋势线（viewBox 缩放，无需量宽）：面积 + 端点
  function sparkSVG(values, color) {
    if (!values.length) return '';
    const w = 240, h = 44, max = Math.max(1, ...values);
    const pts = values.map((v, i) => [values.length < 2 ? w / 2 : (i * w) / (values.length - 1), h - 4 - (v / max) * (h - 10)]);
    const line = smoothPath(pts);
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" style="display:block;width:100%;height:40px"><path d="${line}L${w},${h}L0,${h}Z" style="fill:${color}" opacity=".12"></path><path d="${line}" fill="none" style="stroke:${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"></path><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" style="fill:${color}"></circle></svg>`;
  }
  // 构成分段条 + 图例
  function mixBarHTML(segs) {
    const total = segs.reduce((a, [, v]) => a + v, 0) || 1;
    const spans = segs.filter(([, v]) => v > 0).map(([, v, c]) => `<span style="width:${((v / total) * 100).toFixed(2)}%;background:${c}"></span>`).join('');
    const legend = segs.map(([l, v, c]) => `<span style="display:inline-flex;align-items:center;gap:5px"><i style="background:${c}"></i>${l} ${fmtPct(v / total)}</span>`).join('');
    return `<div class="mgv-mix">${spans}</div><div class="mgv-legend" style="margin:8px 0 0">${legend}</div>`;
  }

  /* ───────── 悬浮提示（单例，fixed） ───────── */
  let tipEl = null;
  function showTip(html, cx, cy) {
    tipEl.innerHTML = html;
    tipEl.classList.add('on');
    const r = tipEl.getBoundingClientRect();
    let L = cx + 14, Tp = cy + 14;
    if (L + r.width > innerWidth - 8) L = cx - r.width - 14;
    if (L < 8) L = 8;
    if (Tp + r.height > innerHeight - 8) Tp = cy - r.height - 14;
    if (Tp < 8) Tp = 8;
    tipEl.style.left = `${L}px`;
    tipEl.style.top = `${Tp}px`;
  }
  const hideTip = () => tipEl.classList.remove('on');
  function bindHover(el, rule, pick) {
    el.onmousemove = (e) => {
      const r = el.getBoundingClientRect();
      const frac = (e.clientX - r.left - rule.padL) / Math.max(1, r.width - rule.padL - rule.padR);
      const i = Math.max(0, Math.min(rule.n - 1, Math.round(frac * (rule.n - 1))));
      rule.line.setAttribute('x1', rule.x(i));
      rule.line.setAttribute('x2', rule.x(i));
      rule.line.setAttribute('opacity', '1');
      showTip(pick(i), e.clientX, e.clientY);
    };
    el.onmouseleave = () => { rule.line.setAttribute('opacity', '0'); hideTip(); };
  }

  /* ───────── 视图 01：概览 ───────── */
  function vOverview(t) {
    const lv = (p) => (p >= 90 ? 'crit' : p >= 60 ? 'warn' : '');
    const cards = MG.quota().map((c) => {
      // 状态 chip 规则同看板 quotaCard：worst = max(5h%, 周%)，≥100 待重置 / ≥90 即将用尽 / 否则正常
      const worst = Math.max(c.used5h, c.usedWeek);
      const st = worst >= 100 ? ['crit', t.quota.st.reset] : worst >= 90 ? ['warn', t.quota.st.low] : ['good', t.quota.st.normal];
      const meter = (label, used, reset) => `
        <div class="mgv-meter">
          <div class="mgv-meter-row"><span>${label}</span><span class="pct num">${used}%</span></div>
          <div class="mgv-meter-track"><div class="mgv-meter-fill ${lv(used)}" data-target="${(used / 100).toFixed(4)}"></div></div>
          <div class="mgv-meter-foot"><span>${untilStr(reset)}</span></div>
        </div>`;
      return `<article class="mgv-card mgv-quota">
        <div class="mgv-q-head">${provLogo({ id: c.id, type: QUOTA_TYPE[c.id] })}
          <div><div class="mgv-q-name">${esc(c.name)}</div><div class="mgv-q-plan">${esc(t.quota.plans[c.id] ?? '')}</div></div>
          <span class="mgv-chip ${st[0]}">${st[1]}</span></div>
        <div class="mgv-q-body">${meter(t.quota.h5, c.used5h, c.resetIn5h)}${meter(t.quota.week, c.usedWeek, c.resetInWeek)}</div>
      </article>`;
    }).join('');
    const td = MG.today();
    const tile = (k, v) => `<div class="mgv-tile"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const rate = td.successRate == null ? t.ch.na : `${fmtPct(td.successRate)}${td.successRate < 0.95 ? ` <span class="mgv-chip warn">${t.today.lowRate}</span>` : ''}`;
    const tiles = `<div class="mgv-tiles">
      ${tile(t.today.reqs, roll('ov-req', td.requests, 'int', fmtInt, firstRender))}
      ${tile(t.today.rate, rate)}
      ${tile(t.today.fb, roll('ov-fb', td.fallbacks, 'int', fmtInt, firstRender))}
      ${tile(t.today.tok, roll('ov-tok', td.tokens, 'tok', fmtTok, firstRender))}
      ${tile(t.today.cost, roll('ov-cost', td.costUsd, 'usd', fmtUsd, firstRender))}
    </div>`;
    return `<section class="mgv-card"><div class="mgv-card-h"><h2>${t.quota.title}</h2></div><div class="mgv-qgrid">${cards}</div></section>
      <section class="mgv-card"><div class="mgv-card-h"><h2>${t.today.title}</h2></div>${tiles}</section>`;
  }

  /* ───────── 视图 02：趋势 ───────── */
  function vTrends(t) {
    const ranges = [[7, t.tr.r7], [30, t.tr.r30], [90, t.tr.r90], [365, t.tr.r1y]];
    const head = `<div class="mgv-card-h"><h2>${t.list[1].t}</h2><div class="mgv-controls">
      <div class="mgv-seg" role="group">${ranges.map(([v, l]) => `<button type="button" data-seg="range" data-val="${v}" aria-pressed="${v === S.range}">${l}</button>`).join('')}</div>
      <div class="mgv-seg" role="group">${[['total', t.tr.total], ['mix', t.tr.mix]].map(([v, l]) => `<button type="button" data-seg="tview" data-val="${v}" aria-pressed="${v === S.tview}">${l}</button>`).join('')}</div>
    </div></div>`;
    const q = MG.query({ days: S.range });
    const days = MG.byDay(q);
    let body = '';
    if (S.tview === 'total') {
      const tot = MG.totals(q);
      const legend = `<div class="mgv-legend">${t.tr.kinds.map(([k, l]) => `<button type="button" data-hide="${k}" aria-pressed="${!S.hidden.has(k)}"><i style="background:${K_COLOR[k]}"></i>${l}<b>${S.hidden.has(k) ? '' : fmtTok(tot[k])}</b></button>`).join('')}</div>`;
      body = `${legend}<div class="mgv-chart" id="mgv-tr-main"></div>
        <div class="mgv-chart-sub">${t.tr.cost}</div><div class="mgv-chart" id="mgv-tr-cost"></div>`;
      CTX.push({ id: 'mgv-tr-main', fn: (el) => drawTrendTotal(el, days, t) });
      CTX.push({ id: 'mgv-tr-cost', fn: (el) => drawTrendCost(el, days, t) });
    } else {
      const rows = MG.groupBy(q, 'source');
      const colors = rankColors(rows);
      const top = rows.slice(0, 7);
      const other = rows.slice(7);
      const legend = `<div class="mgv-legend">${top.map((r) => `<button type="button" data-hide="mix:${r.key}" aria-pressed="${!S.hidden.has('mix:' + r.key)}"><i style="background:${colors.get(r.key)}"></i>${esc(r.name)}<b>${S.hidden.has('mix:' + r.key) ? '' : fmtTok(r.tokens)}</b></button>`).join('')}${other.length ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 6px"><i style="background:var(--c-other)"></i>${t.tr.other}</span>` : ''}</div>`;
      body = `${legend}<div class="mgv-chart-sub">${t.tr.bySrc}</div><div class="mgv-chart" id="mgv-tr-mix"></div>`;
      CTX.push({ id: 'mgv-tr-mix', fn: (el) => drawTrendMix(el, MG.byDay(q, 'source'), top, other, colors, t) });
    }
    return `<section class="mgv-card">${head}${body}</section>`;
  }
  function drawTrendTotal(el, days, t) {
    const iw = Math.max(280, Math.floor(el.clientWidth) || 640);
    const h = 240;
    const vis = t.tr.kinds.filter(([k]) => !S.hidden.has(k));
    const kindTot = (k) => days.reduce((a, d) => a + d[k], 0);
    let max = 0;
    for (const d of days) for (const [k] of vis) max = Math.max(max, d[k]);
    const f = frameSVG(iw, h, days, { max: niceMax(max) });
    let out = f.grid;
    const order = [...vis].sort((a, b) => kindTot(b[0]) - kindTot(a[0])); // 大者先画
    for (const [k] of order) {
      const pts = days.map((d, i) => [f.x(i), f.y(d[k])]);
      const gid = `mgv-g-${k}`;
      const line = smoothPath(pts);
      out += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${K_COLOR[k]}" stop-opacity=".45"></stop><stop offset="1" style="stop-color:${K_COLOR[k]}" stop-opacity=".04"></stop></linearGradient></defs>`;
      out += `<path d="${line}L${f.x(days.length - 1).toFixed(1)},${f.base}L${f.x(0).toFixed(1)},${f.base}Z" fill="url(#${gid})" stroke="none"></path>`;
      out += `<path d="${line}" fill="none" style="stroke:${K_COLOR[k]}" stroke-width="1.8"></path>`;
    }
    out += f.ticks;
    out += `<line class="mgv-rule" x1="0" x2="0" y1="${f.padT}" y2="${h - f.padB}" opacity="0"></line>`;
    el.innerHTML = `<svg width="${iw}" height="${h}" viewBox="0 0 ${iw} ${h}">${out}</svg>`;
    const line = el.querySelector('.mgv-rule');
    bindHover(el, { x: f.x, padL: f.padL, padR: f.padR, n: days.length, line }, (i) => {
      const d = days[i];
      const rows = vis.map(([k, l]) => `<div class="tr"><span>${l}</span><span class="num">${fmtTok(d[k])}</span></div>`).join('');
      const sum = vis.reduce((a, [k]) => a + d[k], 0);
      return `<div class="tt">${shortDay(d.date)}</div>${rows}<div class="tr"><span>${t.tr.sum}</span><span class="num">${fmtTok(sum)}</span></div><div class="tr"><span>${t.tr.cost}</span><span class="num">${fmtUsd(d.costUsd)}</span></div>`;
    });
  }
  function drawTrendCost(el, days, t) {
    const iw = Math.max(280, Math.floor(el.clientWidth) || 640);
    const h = 130;
    const max = niceMax(Math.max(...days.map((d) => d.costUsd)));
    const f = frameSVG(iw, h, days, { max, fmtY: fmtUsd });
    const pts = days.map((d, i) => [f.x(i), f.y(d.costUsd)]);
    const line = smoothPath(pts);
    let out = f.grid;
    out += `<path d="${line}L${f.x(days.length - 1).toFixed(1)},${f.base}L${f.x(0).toFixed(1)},${f.base}Z" style="fill:var(--c7)" fill-opacity=".10" stroke="none"></path>`;
    out += `<path d="${line}" fill="none" style="stroke:var(--c7)" stroke-width="1.8"></path>`;
    out += f.ticks;
    out += `<line class="mgv-rule" x1="0" x2="0" y1="${f.padT}" y2="${h - f.padB}" opacity="0"></line>`;
    el.innerHTML = `<svg width="${iw}" height="${h}" viewBox="0 0 ${iw} ${h}">${out}</svg>`;
    bindHover(el, { x: f.x, padL: f.padL, padR: f.padR, n: days.length, line: el.querySelector('.mgv-rule') }, (i) => {
      const d = days[i];
      return `<div class="tt">${shortDay(d.date)}</div><div class="tr"><span>${t.tr.cost}</span><span class="num">${fmtUsd(d.costUsd)}</span></div>`;
    });
  }
  function drawTrendMix(el, days, top, other, colors, t) {
    const iw = Math.max(280, Math.floor(el.clientWidth) || 640);
    const h = 240;
    const padL = 52, padR = 10, padT = 10, padB = 24;
    const inner = iw - padL - padR;
    const stepW = inner / days.length;
    const bw = Math.max(2, Math.min(22, stepW * 0.7));
    const visTop = top.filter((r) => !S.hidden.has('mix:' + r.key));
    const otherKeys = other.map((r) => r.key);
    let max = 0;
    for (const d of days) {
      let sum = 0;
      for (const r of visTop) sum += d.series[r.key] ?? 0;
      for (const k of otherKeys) sum += d.series[k] ?? 0;
      max = Math.max(max, sum);
    }
    const f = frameSVG(iw, h, days, { max: niceMax(max), padL, padR, padT, padB });
    let out = f.grid;
    const segsOf = (d) => [
      ...visTop.map((r) => [r.name, d.series[r.key] ?? 0, colors.get(r.key)]),
      ...otherKeys.map((k) => [nm('source', k), d.series[k] ?? 0, 'var(--c-other)']),
    ];
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const cx = padL + stepW * (i + 0.5);
      let acc = 0;
      for (const [, v, c] of segsOf(d)) {
        if (v <= 0) continue;
        const y1 = f.y(acc + v), y2 = f.y(acc);
        out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y2 - y1).toFixed(1)}" style="fill:${c}"></rect>`;
        acc += v;
      }
    }
    out += f.ticks;
    el.innerHTML = `<svg width="${iw}" height="${h}" viewBox="0 0 ${iw} ${h}">${out}</svg>`;
    const dayAt = (mx) => Math.max(0, Math.min(days.length - 1, Math.floor((mx - padL) / stepW)));
    el.onmousemove = (e) => {
      const r = el.getBoundingClientRect();
      const i = dayAt(e.clientX - r.left);
      const d = days[i];
      const segs = segsOf(d).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const sum = segs.reduce((a, [, v]) => a + v, 0);
      showTip(`<div class="tt">${shortDay(d.date)}</div>${segs.map(([l, v, c]) => `<div class="tr"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:5px"></i>${l}</span><span class="num">${fmtTok(v)}</span></div>`).join('')}<div class="tr"><span>${t.tr.sum}</span><span class="num">${fmtTok(sum)}</span></div>`, e.clientX, e.clientY);
    };
    el.onmouseleave = hideTip;
  }

  /* ───────── 视图 03：渠道 ───────── */
  function vChannels(t) {
    const periods = [[1, t.ch.p1], [7, t.ch.p7], [30, t.ch.p30]];
    const q = MG.query({ days: S.chanPeriod, channel: S.chanSel || undefined });
    const tot = MG.totals(q);
    const days = MG.byDay(q);
    const head = `<div class="mgv-card-h"><h2>${t.list[2].t}</h2><div class="mgv-controls">
      <div class="mgv-seg" role="group">${periods.map(([v, l]) => `<button type="button" data-seg="chanPeriod" data-val="${v}" aria-pressed="${v === S.chanPeriod}">${l}</button>`).join('')}</div>
      <select data-sel="chan" aria-label="${t.ch.all}"><option value="">${t.ch.all}</option>${Object.keys(MG.names.channel).map((c) => `<option value="${c}"${S.chanSel === c ? ' selected' : ''}>${esc(nm('channel', c))}</option>`).join('')}</select>
    </div></div>`;
    const na = t.ch.na;
    const mini = (label, val, cls = '') => `<div class="mgv-umini ${cls}"><div class="mgv-ulabel">${label}</div><div class="mgv-umid">${val}</div></div>`;
    const hero = `<div class="mgv-uhero">
      <div class="mgv-uprimary"><div class="mgv-ulabel">${t.ch.tokL}</div><div class="mgv-uxl">${fmtTok(tot.tokens)}</div><div class="mgv-usub num">≈ ${fmtInt(tot.tokens)}</div></div>
      <div class="mgv-uprimary cost"><div class="mgv-ulabel">${t.ch.costL}</div><div class="mgv-uxl">${fmtUsd(tot.costUsd)}</div></div>
      <div class="mgv-uminigrid">
        ${mini(t.ch.reqs, tot.requests == null ? na : fmtInt(tot.requests))}
        ${mini(t.ch.abort, tot.requests == null ? na : fmtInt(tot.abort))}
        ${mini(t.ch.rate, tot.successRate == null ? na : fmtPct(tot.successRate), tot.successRate != null && tot.successRate < 0.97 ? 'warn' : '')}
        ${mini(t.ch.hit, fmtPct(tot.cacheHitRate))}
      </div>
    </div>
    <div class="mgv-umix">${mixBarHTML(t.tr.kinds.map(([k, l]) => [l, tot[k], K_COLOR[k]]))}</div>`;
    // 图例照抄看板 uLegendHtml：色块 + 名称 + 合计值，末项成本；每一项可点击切换显隐
    const U_ORDER = ['output', 'input', 'cacheWrite', 'cacheRead'];
    const kindLabel = (k) => (t.tr.kinds.find(([x]) => x === k) || ['', k])[1];
    const legend = `<div class="mgv-legend">${U_ORDER.map((k) => `<button type="button" data-hide="ch:${k}" aria-pressed="${!S.hidden.has('ch:' + k)}"><i style="background:${K_COLOR[k]}"></i>${kindLabel(k)} <b>${fmtTok(tot[k])}</b></button>`).join('')}<button type="button" data-hide="ch:cost" aria-pressed="${!S.hidden.has('ch:cost')}"><i style="background:var(--tok-cost)"></i>${t.ch.cost} <b>$${tot.costUsd.toFixed(2)}</b></button></div>`;
    CTX.push({ id: 'mgv-ch-trend', fn: (el) => drawStackArea(el, days, t) });
    return `<section class="mgv-card">${head}${hero}</section>
      <section class="mgv-card"><div class="mgv-card-h"><h3>${t.ch.trend}</h3></div>${legend}<div class="mgv-chart" id="mgv-ch-trend"></div></section>`;
  }
  function drawStackArea(el, days, t) {
    const iw = Math.max(280, Math.floor(el.clientWidth) || 640);
    const h = 250;
    const padL = 52, padT = 12, padB = 24;
    const all = [['output', 'var(--tok-out)'], ['input', 'var(--tok-in)'], ['cacheWrite', 'var(--tok-cc)'], ['cacheRead', 'var(--tok-cr)']]; // 自下而上
    const stack = all.filter(([k]) => !S.hidden.has('ch:' + k)); // 图例可切换显隐
    const costMax = niceMax(Math.max(...days.map((d) => d.costUsd), 0.001));
    const labelW = [...fmtUsd(costMax)].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 10.5 : 6.5), 0);
    const padR = 12 + labelW;
    let maxTot = 0;
    for (let i = 0; i < days.length; i++) {
      let acc = 0;
      for (const [k] of stack) acc += days[i][k];
      maxTot = Math.max(maxTot, acc);
    }
    const f = frameSVG(iw, h, days, { max: niceMax(maxTot), padL, padR, padT, padB });
    const yR = (v) => padT + (1 - v / costMax) * (h - padT - padB);
    let out = f.grid;
    // 右轴成本刻度：每条网格线一个 $ 标签（同看板 drawUTrend）
    for (let g = 0; g <= 4; g++) {
      const gy = padT + ((4 - g) * (h - padT - padB)) / 4;
      out += `<text class="mgv-ax" x="${iw - padR + 8}" y="${(gy + 3.5).toFixed(1)}">${fmtUsd((costMax * g) / 4)}</text>`;
    }
    if (days.length < 2) {
      // 单桶：一根堆叠柱 + 成本点
      const inner = iw - padL - padR;
      const bw = Math.min(56, inner * 0.6);
      const cx = padL + inner / 2;
      const d = days[0];
      let acc = 0;
      for (const [k, c] of stack) {
        const v = d[k];
        if (v <= 0) continue;
        out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${f.y(acc + v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, f.y(acc) - f.y(acc + v)).toFixed(1)}" style="fill:${c}"></rect>`;
        acc += v;
      }
      if (!S.hidden.has('ch:cost')) out += `<circle cx="${cx.toFixed(1)}" cy="${yR(d.costUsd).toFixed(1)}" r="3.5" style="fill:var(--tok-cost)"></circle>`;
    } else {
      // 堆叠面积照抄看板 drawUTrend：每层上沿 acc+v，下沿沿同一组 x 点反向走回上一层上沿再闭合；折线，不平滑
      let acc = days.map(() => 0), vacc = days.map(() => f.base);
      const layerPath = (vals) => {
        const top = vals.map((v, i) => acc[i] + v);
        const yTop = top.map((v, i) => (vals[i] > 0 ? Math.max(f.padT, Math.min(f.y(v), vacc[i] - 3)) : vacc[i]));
        const m = yTop.length;
        const d = yTop.map((y, i) => `${i ? 'L' : 'M'}${f.x(i).toFixed(1)},${y.toFixed(1)}`).join('') +
          yTop.map((_, ri) => { const i = m - 1 - ri; return `L${f.x(i).toFixed(1)},${vacc[i].toFixed(1)}`; }).join('') + 'Z';
        acc = top; vacc = yTop;
        return d;
      };
      for (const [k, c] of stack) {
        if (!days.some((x) => x[k] > 0)) continue; // 全零系列不画（零厚度不改变堆叠状态）
        const d = layerPath(days.map((x) => x[k]));
        const gid = `mgv-ug-${k}`;
        out += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${c}" stop-opacity=".5"></stop><stop offset="1" style="stop-color:${c}" stop-opacity=".2"></stop></linearGradient></defs>`;
        out += `<path d="${d}" fill="url(#${gid})"></path><path d="${d}" fill="none" style="stroke:${c}" stroke-width="1.6"></path>`;
      }
      if (!S.hidden.has('ch:cost')) {
        const costPath = days.map((d, i) => `${i ? 'L' : 'M'}${f.x(i).toFixed(1)},${yR(d.costUsd).toFixed(1)}`).join('');
        out += `<path d="${costPath}" fill="none" style="stroke:var(--tok-cost)" stroke-width="1.8" stroke-dasharray="6 4" stroke-linejoin="round"></path>`;
      }
    }
    out += f.ticks;
    out += `<line class="mgv-rule" x1="0" x2="0" y1="${padT}" y2="${h - padB}" opacity="0"></line>`;
    el.innerHTML = `<svg width="${iw}" height="${h}" viewBox="0 0 ${iw} ${h}">${out}</svg>`;
    bindHover(el, { x: f.x, padL, padR, n: days.length, line: el.querySelector('.mgv-rule') }, (i) => {
      const d = days[i];
      const rows = all.map(([k, c]) => `<div class="tr"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:5px"></i>${(t.tr.kinds.find(([x]) => x === k) || ['', k])[1]}</span><span class="num">${fmtTok(d[k])}</span></div>`).join('');
      return `<div class="tt">${shortDay(d.date)}</div>${rows}<div class="tr"><span>${t.tr.sum}</span><span class="num">${fmtTok(d.tokens)}</span></div><div class="tr"><span>${t.ch.costL}</span><span class="num">${fmtUsd(d.costUsd)}</span></div>`;
    });
  }

  /* ───────── 视图 04/05：来源 / 模型（同一张可展开表格） ───────── */
  function dimTable(t, dim, rows, colors, recsOf) {
    const labels = t.src;
    const kindsOf = (key) => { const s = new Set(); for (const r of recsOf(key)) s.add(r.kind); return [...s]; };
    const maxTok = rows[0]?.tokens || 1;
    const trs = rows.map((r) => {
      const e = (MG.names[dim] || {})[r.key] ?? {};
      const ico = e.icon ? agentIcon(e.icon) : `<span class="mgv-dot" style="background:${colors.get(r.key)}"></span>`;
      const chips = kindsOf(r.key).map((k) => `<span class="mgv-chip ghost">${k === 'served' ? labels.served : labels.observed}</span>`).join(' ');
      const nameCls = dim === 'model' ? 't mono' : 't';
      const open = S.open.has(dim + ':' + r.key);
      return `<tr class="mgv-row${open ? ' mgv-open' : ''}" id="r-${dim}-${esc(r.key)}" data-key="${esc(r.key)}" tabindex="0" aria-expanded="${open}">
        <td><div class="mgv-name"><svg class="mgv-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>${ico}<span class="${nameCls}">${esc(modelLabel(r.name))}</span></div></td>
        <td>${chips}</td>
        <td class="r num">${fmtTok(r.tokens)}</td>
        <td class="r num">${fmtUsd(r.costUsd)}</td>
        <td class="r num">${r.requests == null ? labels.na : fmtInt(r.requests)}</td>
        <td><div class="mgv-share"><div class="mgv-share-track"><div class="mgv-share-fill" style="width:${((r.tokens / maxTok) * 100).toFixed(1)}%;background:${colors.get(r.key)}"></div></div><span class="p num">${fmtPct(r.share)}</span></div></td>
      </tr>`;
    }).join('');
    return `<div class="mgv-tblwrap"><table class="tbl" data-dim="${dim}"><thead><tr>
      <th>${dim === 'source' ? labels.src : labels.model}</th><th>${labels.type}</th>
      <th class="r">${labels.tok}</th><th class="r">${labels.cost}</th><th class="r">${labels.reqs}</th><th>${labels.share}</th>
    </tr></thead><tbody>${trs}</tbody></table></div>`;
  }
  function dimDetail(t, dim, key, color) {
    const recs = MG.query({ days: 30, [dim]: key });
    const tot = MG.totals(recs);
    const days = MG.byDay(recs);
    const other = dim === 'source' ? 'model' : 'source';
    const pairs = MG.groupBy(recs, other);
    const pairColors = rankColors(pairs);
    const left = `<div class="mgv-dcol"><h4>${t.src.mix}</h4>${mixBarHTML(t.tr.kinds.map(([k, l]) => [l, tot[k], K_COLOR[k]]))}<h4>${t.src.d30}</h4>${sparkSVG(days.map((d) => d.tokens), color)}</div>`;
    const right = `<div class="mgv-dcol"><h4>${dim === 'source' ? t.src.models : t.src.srcs}</h4><div class="mgv-pairs">${pairs.slice(0, 6).map((p) => `<div class="mgv-pair"><span class="mgv-dot" style="background:${pairColors.get(p.key)}"></span><span class="t">${esc(other === 'model' ? modelLabel(p.name) : p.name)}</span><span class="num">${fmtTok(p.tokens)} · ${fmtPct(p.share)}</span></div>`).join('')}</div></div>`;
    return `<tr class="mgv-detail"><td colspan="6"><div class="mgv-dgrid">${left}${right}</div></td></tr>`;
  }
  function vSources(t) {
    const q = MG.query({ days: 30 });
    const rows = MG.groupBy(q, 'source').filter((r) => {
      const kind = (MG.names.source[r.key] || {}).kind ?? '';
      return !S.srcGroup || kind === S.srcGroup;
    });
    const colors = rankColors(MG.groupBy(q, 'source'));
    const head = `<div class="mgv-card-h"><h2>${t.list[3].t}</h2><div class="mgv-seg" role="group">${[['', t.src.all], ['agent', t.src.agent], ['app', t.src.app]].map(([v, l]) => `<button type="button" data-seg="srcGroup" data-val="${v}" aria-pressed="${v === S.srcGroup}">${l}</button>`).join('')}</div></div>`;
    return `<section class="mgv-card">${head}${dimTable(t, 'source', rows, colors, (key) => q.filter((r) => r.source === key))}</section>`;
  }
  function vModels(t) {
    const q = MG.query({ days: 30 });
    const rows = MG.groupBy(q, 'model');
    const colors = rankColors(rows);
    return `<section class="mgv-card"><div class="mgv-card-h"><h2>${t.list[4].t}</h2></div>${dimTable(t, 'model', rows, colors, (key) => q.filter((r) => r.model === key))}</section>`;
  }

  /* ───────── 视图 06：设备 ───────── */
  function vDevices(t) {
    const q30 = MG.query({ days: 30 });
    const q7 = MG.query({ days: 7 });
    const colors = rankColors(MG.groupBy(q30, 'device'));
    const cards = Object.keys(MG.names.device).map((d) => {
      const recs = q30.filter((r) => r.device === d);
      const tot = MG.totals(recs);
      const days = MG.byDay(recs);
      const reqs = tot.requests ?? 0;
      const n7 = q7.filter((r) => r.device === d).length;
      // 演示用「最近数据」：近 7 天有记录按分钟给，否则按最后一条记录的日期算天数，与记录数一致
      const last = recs.reduce((a, r) => (r.date > a ? r.date : a), '');
      const ago = n7 ? { m: 4 + (reqs * 7) % 46 } : { d: last ? Math.round((Date.now() - new Date(last + 'T12:00:00')) / 864e5) : null };
      const via = recs.some((r) => r.kind === 'served'); // 设备上有经网关流量则视为网关侧
      // 结构照抄看板 viewUsageDevices：card-h 标题 + chip，数字，单行说明，再是迷你图
      return `<article class="mgv-card mgv-dev">
        <div class="mgv-card-h"><h2>${esc(nm('device', d))}</h2><span class="mgv-chip ${via ? 'info' : 'ghost'}">${via ? t.src.served : t.src.observed}</span></div>
        <div class="mgv-dev-big num">${fmtTok(tot.tokens)}</div>
        <div class="mgv-dev-meta">${t.dev.meta(ago, n7)}</div>
        <div class="mgv-dev-spark">${sparkSVG(days.map((x) => x.tokens), colors.get(d) ?? 'var(--c-other)')}</div>
      </article>`;
    }).join('');
    return `<div class="mgv-devs">${cards}</div>`;
  }

  /* ───────── 视图 07：调用链 + 模型建议 ───────── */
  function vRouting(t) {
    const hopCid = (e) => (typeof e === 'string' ? e : e.p);
    const models = Object.keys(MODEL_META);
    const servedLike = new Set(MG.query({ days: 365 }).filter((r) => r.kind !== 'observed').map((r) => r.model));
    // 点选渠道后只显示该渠道上的模型
    const rows = models
      .filter((m) => !S.prov || MODEL_META[m].chain.some((e) => hopCid(e) === S.prov))
      .sort((a, b) => (Number(servedLike.has(b)) - Number(servedLike.has(a))) || (a < b ? -1 : 1));
    const count = (cid) => models.filter((m) => MODEL_META[m].chain.some((e) => hopCid(e) === cid)).length;
    const strip = `<div class="mgv-provstrip">${PROVIDERS.map((p) => `
      <button type="button" class="mgv-prov" data-prov="${p.id}" aria-pressed="${S.prov === p.id}">${provLogo(p)}
        <span class="t"><span class="n1">${esc(nm('channel', p.id))}</span><span class="s">${t.rt.in(count(p.id))}</span></span>
      </button>`).join('')}</div>`;
    const hop = (e, i) => {
      const cid = hopCid(e);
      const m = typeof e === 'object' ? e.m : null;
      const hot = !!S.prov && cid === S.prov;
      return `${i ? '<span class="arr">→</span>' : ''}<span class="hop${i ? '' : ' first'}${hot ? ' hot' : ''}">${esc(nm('channel', cid))}${m ? ' · ' + esc(modelLabel(m)) : ''}</span>`;
    };
    const table = `<div class="mgv-tblwrap"><table class="tbl"><thead><tr><th>${t.src.model}</th><th>${t.rt.mods}</th><th>${t.rt.chain}</th></tr></thead><tbody>
      ${rows.map((m) => {
        const meta = MODEL_META[m];
        const hl = !!S.prov && meta.chain.some((e) => hopCid(e) === S.prov);
        return `<tr class="${hl ? 'hl' : ''}"><td><div class="mgv-name"><span class="t mono">${esc(modelLabel(m))}</span>${servedLike.has(m) ? '' : `<span class="mgv-chip ghost">${t.src.observed}</span>`}</div></td>
          <td>${meta.mods.map((x) => `<span class="mgv-chip ghost">${t.rt.mod[x]}</span>`).join(' ')}</td>
          <td><div class="mgv-chain">${meta.chain.map((e, i) => hop(e, i)).join('')}</div></td></tr>`;
      }).join('')}
    </tbody></table></div>`;
    const sg = SUGG;
    const cur = modelLabel(sg.current), cand = modelLabel(sg.candidate);
    const price = (v) => '$' + v.toFixed(2);
    const delta = (a, b) => {
      if (a === b) return `<span class="num">${t.rt.even}</span>`;
      const p = ((b - a) / a) * 100;
      return `<span class="${b > a ? 'mgv-delta-up' : 'mgv-delta-down'} num">${p > 0 ? '+' : ''}${p.toFixed(0)}%</span>`;
    };
    const modsTxt = (arr) => arr.map((x) => t.rt.mod[x]).join(MG.lang === 'en' ? ', ' : '、');
    const cmp = `<div class="mgv-tblwrap"><table class="tbl mgv-cmp"><thead><tr><th></th><th>${t.rt.cur} ${esc(cur)}</th><th>${t.rt.cand} ${esc(cand)}</th></tr></thead><tbody>
      <tr><td>${t.rt.modsRow}</td><td>${modsTxt(sg.cur.mods)}</td><td>${modsTxt(sg.cand.mods)} ${delta(0, 0)}</td></tr>
      <tr><td>${t.rt.pin}</td><td class="num">${price(sg.cur.input)}</td><td class="num">${price(sg.cand.input)} ${delta(sg.cur.input, sg.cand.input)}</td></tr>
      <tr><td>${t.rt.pout}</td><td class="num">${price(sg.cur.output)}</td><td class="num">${price(sg.cand.output)} ${delta(sg.cur.output, sg.cand.output)}</td></tr>
      <tr><td>${t.rt.ctx}</td><td class="num">${sg.cur.ctx}K</td><td class="num">${sg.cand.ctx}K</td></tr>
    </tbody></table></div>`;
    const foot = S.sugg == null
      ? `<div class="mgv-actions"><button type="button" class="mgv-btn primary" data-sugg="add">${t.rt.add}</button><button type="button" class="mgv-btn" data-sugg="replace">${t.rt.repl}</button><button type="button" class="mgv-btn" data-sugg="dismiss">${t.rt.drop}</button></div>`
      : `<div class="mgv-result"><span>${S.sugg === 'add' ? t.rt.added(cand) : S.sugg === 'replace' ? t.rt.replaced(cand) : t.rt.dropped}</span><button type="button" class="mgv-btn" data-sugg-undo="1">${t.rt.undo}</button></div>`;
    const suggCard = `<section class="mgv-card" id="mgv-sugg-block"><div class="mgv-sugg">
      <div class="mgv-suggh">${provLogo(PROVIDERS[0])}<h3>${t.rt.sugg}</h3><span class="mgv-chip info">${t.rt.up}</span><span class="when">${t.rt.when}</span></div>
      ${cmp}${foot}</div></section>`;
    return `${strip}
      <section class="mgv-card"><div class="mgv-card-h"><h3>${t.rt.cat}</h3>${S.prov ? `<button type="button" class="mgv-btn" data-prov-clear="1">${t.rt.clear}</button>` : ''}</div>${table}</section>
      ${suggCard}`;
  }
  /* ───────── 视图 08：日志（演示行由当日 served 记录确定性派生） ───────── */
  function vLogs(t) {
    const lg = t.logs;
    const td = MG.today();
    const recs = MG.query({ days: 1 }).filter((r) => r.kind === 'served');
    const rows = [];
    recs.forEach((r, ri) => {
      const per = Math.round((r.input + r.output + r.cacheRead + r.cacheWrite) / Math.max(1, r.requests));
      const n = 1 + (ri % 3 === 0 ? 1 : 0); // 每条组合派生 1–2 行
      for (let k = 0; k < n && rows.length < 14; k++) {
        const idx = rows.length;
        const hh = 23 - ((idx * 7) % 15), mm = (idx * 17 + ri * 5) % 60, ss = (idx * 31) % 60;
        // 状态：按记录自身的失败/中断数确定性标注少量异常行，其余成功
        let st = 'ok';
        if (k === 0 && r.fail > 0 && ri % 4 === 1) st = 'fb';
        else if (k === 1 && r.abort > 0 && ri % 3 === 2) st = 'abort';
        rows.push({
          time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
          r, per, st,
          lat: Math.round(r.latencyMs * (0.7 + (idx % 5) * 0.18)),
        });
      }
    });
    rows.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    const stChip = { ok: `<span class="mgv-chip good">${lg.ok}</span>`, fb: `<span class="mgv-chip warn">${lg.fb}</span>`, abort: `<span class="mgv-chip crit">${lg.abort}</span>` };
    const trs = rows.map((w) => {
      const e = MG.names.source[w.r.source] || {};
      return `<tr>
        <td class="num mono">${w.time}</td>
        <td><div class="mgv-name">${agentIcon(e.icon) || '<span class="mgv-dot"></span>'}<span class="t">${esc(nm('source', w.r.source))}</span></div></td>
        <td><span class="mono">${esc(modelLabel(w.r.model))}</span></td>
        <td>${esc(nm('channel', w.r.channel))}</td>
        <td class="r num">${fmtTok(w.per)}</td>
        <td class="r num">${w.lat < 1000 ? lg.ms(w.lat) : lg.s(w.lat)}</td>
        <td>${stChip[w.st]}</td>
      </tr>`;
    }).join('');
    const rate = td.successRate == null ? '—' : fmtPct(td.successRate);
    return `<section class="mgv-card"><div class="mgv-card-h"><h2>${t.list[7].t}</h2>
      <div class="mgv-controls"><span class="mgv-chip ghost">${lg.win}</span><span class="mgv-meta">${lg.today(fmtInt(td.requests ?? 0), rate)}</span></div></div>
      <div class="mgv-tblwrap"><table class="tbl"><thead><tr>
        <th>${lg.time}</th><th>${lg.src}</th><th>${lg.mdl}</th><th>${lg.chan}</th><th class="r">${lg.tok}</th><th class="r">${lg.lat}</th><th>${lg.st}</th>
      </tr></thead><tbody>${trs}</tbody></table></div>
      <div style="margin-top:12px"><span class="mgv-meta">${lg.keep}</span></div>
    </section>`;
  }
  const RENDERERS = [vOverview, vTrends, vChannels, vSources, vModels, vDevices, vRouting, vLogs];

  /* ───────── 骨架：列表 + 窗口 ───────── */
  function listHTML(t) {
    return `<ol class="mgv-list">${t.list.map((it, i) => `<li class="mgv-item"><button type="button" data-view="${i}" aria-pressed="${S.view === i}"><span class="mgv-num">${String(i + 1).padStart(2, '0')}</span><span class="mgv-title">${it.t}</span><span class="mgv-desc">${it.d}</span></button></li>`).join('')}</ol>`;
  }
  function winHTML(t, body, fade) {
    const nav = VIEWS[S.view].nav;
    const navBtn = (i, target) => `<button type="button" data-nav="${i}" ${nav === i ? 'aria-current="true"' : ''}>${t.nav[i]}</button>`;
    let tabs = '';
    if (nav === 1) {
      tabs = `<div class="mgv-tabs">${t.usageTabs.map((l, i) => i === 0
        ? `<button type="button" class="mgv-tab" data-tab="activity">${l}</button>`
        : `<button type="button" class="mgv-tab" data-tab="u${i}" ${S.view === i ? 'aria-current="true"' : ''}>${l}</button>`).join('')}</div>`;
    } else if (nav === 2) {
      tabs = `<div class="mgv-tabs">${t.gwTabs.map((l, i) => `<button type="button" class="mgv-tab" data-tab="g${i}" ${S.view === 6 && (S.sub7 === 'catalog') === (i === 0) ? 'aria-current="true"' : ''}>${l}</button>`).join('')}</div>`;
    }
    return `<div class="mgv-win">
      <div class="mgv-bar"><span class="mgv-brand"><img src="assets/icon.png" alt="">${t.brand}</span><nav class="mgv-nav">${navBtn(0)}${navBtn(1)}${navBtn(2)}${navBtn(3)}</nav></div>
      ${tabs}<div class="mgv-body"><div class="mgv-view${fade ? ' mgv-fade' : ''}">${body}</div></div>
    </div>`;
  }

  /* ───────── 渲染与装配 ───────── */
  let inner = null;
  function mountPills() {
    for (const box of inner.querySelectorAll('.mgv-tabs, .mgv-seg')) {
      const active = box.querySelector('[aria-current="true"], [aria-pressed="true"]');
      let pill = box.querySelector('.mgv-pill');
      if (!active) { if (pill) pill.remove(); continue; }
      if (!pill) { pill = document.createElement('span'); pill.className = 'mgv-pill'; box.prepend(pill); }
      pill.style.transform = `translateX(${active.offsetLeft}px)`;
      pill.style.width = `${active.offsetWidth}px`;
    }
  }
  function render() {
    rowCache.clear();
    CTX.length = 0;
    const t = T();
    const fade = !firstRender && S.view !== lastView;
    lastView = S.view;
    const body = RENDERERS[S.view](t);
    inner.innerHTML = listHTML(t) + winHTML(t, body, fade);
    for (const { id, fn } of CTX) { const el = document.getElementById(id); if (el) fn(el); }
    mountPills();
    animateRolls(inner);
    animateMeters(inner);
    if (pendingScroll) {
      pendingScroll = false;
      const block = document.getElementById('mgv-sugg-block');
      if (block) block.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
    }
    firstRender = false;
  }

  /* ───────── 交互（事件委托） ───────── */
  function toggleDetail(tr) {
    const dim = tr.closest('table').dataset.dim;
    if (!dim) return;
    const key = tr.dataset.key;
    const ck = dim + ':' + key;
    const id = 'd-' + dim + '-' + key;
    const existing = document.getElementById(id);
    if (existing) {
      existing.remove();
      S.open.delete(ck);
      tr.classList.remove('mgv-open');
      tr.setAttribute('aria-expanded', 'false');
      return;
    }
    let html = rowCache.get(ck);
    if (html == null) {
      const colors = rankColors(MG.groupBy(MG.query({ days: 30 }), dim));
      html = dimDetail(T(), dim, key, colors.get(key) ?? 'var(--c-other)');
      rowCache.set(ck, html);
    }
    tr.insertAdjacentHTML('afterend', html);
    S.open.add(ck);
    tr.classList.add('mgv-open');
    tr.setAttribute('aria-expanded', 'true');
  }
  function bindEvents() {
    inner.addEventListener('click', (e) => {
      const el = e.target.closest('button, tr.mgv-row');
      if (!el || !inner.contains(el) || el.tagName === 'TR') {
        const tr = e.target.closest('tr.mgv-row');
        if (tr) toggleDetail(tr);
        return;
      }
      if (el.disabled) return;
      const ds = el.dataset;
      if (ds.view != null) { S.view = +ds.view; render(); }
      else if (ds.nav != null) { S.view = [0, 1, 6, 7][+ds.nav]; render(); }
      else if (ds.tab === 'activity') { document.getElementById('activity')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }); }
      else if (ds.tab && ds.tab[0] === 'u') { S.view = +ds.tab.slice(1); render(); }
      else if (ds.tab === 'g0') { S.view = 6; S.sub7 = 'catalog'; render(); }
      else if (ds.tab === 'g1') { S.view = 6; S.sub7 = 'sugg'; pendingScroll = true; render(); }
      else if (ds.seg) {
        if (ds.seg === 'range') S.range = +ds.val;
        else if (ds.seg === 'tview') S.tview = ds.val;
        else if (ds.seg === 'chanPeriod') S.chanPeriod = +ds.val;
        else if (ds.seg === 'srcGroup') S.srcGroup = ds.val;
        render();
      }
      else if (ds.hide) { const k = ds.hide; if (S.hidden.has(k)) S.hidden.delete(k); else S.hidden.add(k); render(); }
      else if (ds.prov != null) { S.prov = S.prov === ds.prov ? '' : ds.prov; render(); }
      else if (ds.provClear != null) { S.prov = ''; render(); }
      else if (ds.sugg) { S.sugg = ds.sugg; render(); }
      else if (ds.suggUndo != null) { S.sugg = null; render(); }
    });
    inner.addEventListener('keydown', (e) => {
      const tr = e.target.closest && e.target.closest('tr.mgv-row');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleDetail(tr); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const btn = e.target.closest && e.target.closest('.mgv-item > button');
        if (!btn) return;
        e.preventDefault();
        const next = Math.max(0, Math.min(VIEWS.length - 1, S.view + (e.key === 'ArrowDown' ? 1 : -1)));
        if (next !== S.view) render();
        const target = inner.querySelector(`.mgv-item > button[data-view="${S.view}"]`);
        if (target) target.focus();
      }
    });
    inner.addEventListener('change', (e) => {
      const sel = e.target.closest('select');
      if (sel && sel.dataset.sel === 'chan') { S.chanSel = sel.value; render(); }
    });
    let rzT = 0;
    window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(render, 150); });
  }

  /* ───────── 启动 ───────── */
  mount.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'mgv';
  inner = document.createElement('div');
  inner.className = 'mgv-inner';
  tipEl = document.createElement('div');
  tipEl.className = 'mgv-tip';
  tipEl.setAttribute('role', 'tooltip');
  root.appendChild(inner);
  root.appendChild(tipEl);
  mount.appendChild(root);
  bindEvents();
  render();
  MG.onLang(render); // 语言切换：重渲染（保留当前视图状态）
  // 供 Activity 占比卡「全部来源 / 全部模型」跳转：n 为导览编号 1–8
  window.MGViews = { show(n) { S.view = Math.max(0, Math.min(VIEWS.length - 1, n - 1)); render(); document.getElementById('views')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
})();
