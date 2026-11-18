# 用户 Web

Vue 3 + Vite + TypeScript，采用 Composition API 和原生 Vue 组件。

在完整仓库中使用 Node.js 22.12 或更高版本：

```powershell
npm ci --prefix web-vue
npm run dev --prefix web-vue
npm run build --prefix web-vue
node scripts/audit-web-migration.cjs --strict
```

本机代理目标可在忽略提交的 `.env.local` 中设置 `PULSE_WEB_BACKEND`；生产构建使用当前域名下的 `/api/v2`，不要内嵌 token。输出目录为 `dist/`，需发布全部文件和动态 chunk。

[逐文件迁移和部署记录](../docs/WEB-VUE-MIGRATION-2026-11-18.md)说明了功能范围、复用服务、旧功能边界、源码比对、验证方式和上线细节。
