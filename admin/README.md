# 脉冲管理后台

Vue 3 Composition API、TypeScript、Vite 8、Tailwind CSS，采用 Art Design Pro 的默认视觉体系与 Element Plus 组件。支持浅色、深色和小屏布局。

## 本地开发

要求 Node.js 22.12 或以上。

```powershell
cd D:\IM\admin
npm ci
npm run dev
```

默认仅监听 `127.0.0.1:18100`，`/api/v2` 代理到正式管理域名。开发代理会调整 Host / Origin，让上游继续执行 Cookie、专属入口和 CSRF 校验。开发服务器不应对公网开放。

连接本地隔离后端时：

```powershell
$env:PULSE_ADMIN_BACKEND = 'http://127.0.0.1:18123'
$env:PULSE_ADMIN_PORT = '18101'
npm run dev
```

## 构建与发布

```powershell
npm run typecheck
npm run build
```

将 `dist/` 的**内容**作为发布目录中的 `admin/`，包括 `index.html`、`entry.html`、`assets/`、图标和第三方声明。现有 Nginx 的 `root /opt/pulse/current/admin` 与 `/entry/` 映射可继续使用。不要将源码目录或 `node_modules/` 当成线上静态页面，也不要部署为 `admin/dist/`。

本次后台同时依赖 Go 的选择器、列表筛选、用户分发和会话分类补丁；正式发布应配套更新此仓库的 Go 程序，并先执行迁移 `061_admin_conversation_type.sql`。旧接口继续保留。回滚后端需要使用理解新迁移版本的兼容构建，不能直接运行只认识 schema 60 的旧二进制。

## 验证

```powershell
node --test ..\scripts\admin-login.test.cjs
python ..\scripts\check-go-client-coverage.py --check
```

真实浏览器回归使用本地隔离 Go 和 PostgreSQL。提供 fixture JSON 的路径，不能指向生产库：

```powershell
$env:PULSE_ADMIN_UI_URL = 'http://127.0.0.1:18102'
$env:PULSE_ADMIN_FIXTURE = 'D:/IM/.local/admin-redesign-20261114/fixtures.private.json'
npm test
```

测试包含真实建号、资料与头像、群组、敏感词、公告、图片题库及 CSV 导入、任务启停、验证码、分发、配置、线路、清理预览、旧作业批改、导出和只读权限。测试会修改指定的本地隔离数据；配置和测试代码均拒绝非本地目标。

布局回归同时检查固定侧栏/顶部栏、内容和菜单独立滚动、表格横向滚动、抽屉/弹窗边界、地图滚轮行为、移动菜单关闭，以及 17 页面在桌面和手机宽度下的浅色/深色布局。仅检查布局可运行 `npx playwright test admin-layout.spec.ts`。

原 JS 整页渲染和样式已退出源码入口，基线保留在 Git 历史。Go 兼容适配器 `src/go-api.js` 继续负责既有 UUID 映射、媒体授权、会话隔离及业务契约。
