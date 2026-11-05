# 产品页（site/）部署

`site/` 是产品展示页（README 的公开落地页），托管在 **Cloudflare Workers 静态资源**（新版 Pages）上，自定义域名 `model-gateway.maplesnow.cn`。配置见仓库根的 `wrangler.jsonc`。

## 发布流程

```bash
npm run site:verify   # 冒烟检查（Chrome CDP，无 Chrome 时 SKIP）
npx wrangler@4 deploy # 发布到 Cloudflare Workers；无需本地安装 wrangler
```

改动 `site/` 后按上面两步发布；不要本地安装 wrangler 为依赖，直接 `npx wrangler@4`。

## 配套脚本

- `npm run site:sync`：把 `src/dashboard/topology.js` 及其样式/图标同步进 `site/vendor/`、`site/assets/`（改了看板 topology 相关文件后运行）。
- `npm run site:check`：校验 `site/` 内生成文件与源码同步（CI 门禁，不同步会失败）。
- `npm run site:verify`：零依赖冒烟检查，桌面/手机宽度 × 明暗主题，断言无横向滚动、无 console 错误。
