# Pulse IM Go 后端

2026-11-14：管理后台使用 Vue 3、TypeScript、Vite 8、Tailwind CSS 与 Art Design Pro 视觉体系重构，支持浅色/深色；页面、操作及 Go 契约补漏见 [后台重构对照](docs/ADMIN-REDESIGN-2026-11-14.md)。静态发布必须使用 `admin/dist/` 的构建结果，不能直接复制源码，见 [后台运行与发布](admin/README.md)。本轮重构尚未部署到正式服务器。

2026-11-14：公网端口进一步收敛为 TCP 22/80/443，IM 服务共用现有 Nginx 443，宝塔关闭公网并保留 SSH 隧道，见 [端口策略及现场验证](docs/NETWORK-INGRESS-2026-11-14.md)。

2026-11-14：审查修复已推送并正式更新 Go、Web 和管理后台；部署迁移、Fail2ban、Nginx、内部端口与文件完整性防护见 [本次上线与安全加固](docs/PRODUCTION-SECURITY-2026-11-14.md)。手机安装包本轮跳过，功能验收边界继续保留。

2026-11-14 再次审查及真实回归见 [后端与四端安全复查](docs/BACKEND-CLIENT-SECURITY-REVIEW-2026-11-14.md)：修复邀请管理记录的越权读取、角色版本未推进和四端消息作者展示。仍发现 iOS 待发持久化等缺口，不能判为全部 PHP 功能已完整验收。

2026-11-14 最新补漏见 [手机原图与批量发送](docs/MOBILE-MEDIA-GAPS-2026-11-14.md)：补齐 Android/iOS 原图接线、重试状态，并将选图上限调整到 300；HEIC 原图、Apple 真机及完整业务等价验收仍有缺口。此前修复定时禁言、隐藏会话恢复、@ 提醒、历史定位/搜索、PC 记录翻页和权限缓存等，见 [Go 后端与四端接口审查](docs/BACKEND-CLIENT-AUDIT-2026-11-13.md)。下文早期里程碑说明保留作历史记录，不代表当前全功能完成判定。

<!-- backend-completion-2026-11-11 -->
2026-11-11：按用户最新要求暂停客户端接入，优先补齐旧 PHP 全部保留功能。当前逐项来源与验证见 [后端补齐矩阵](docs/BACKEND-COMPLETION-MATRIX.md) 和 [扩展 API](docs/API-V2-EXTENSIONS.md)。本文后续历史记录不代表新增模块的最终验收状态。

单机模块化单体：Go + PostgreSQL + Redis。保留现有 PC、移动端、Web 前端代码，后续集中改接新协议。容量目标为总计 4 核、8—16 GiB 下至少 10000 在线连接，尚未完成容量验收。

当前完成第一条真实消息链路：密码登录 → 好友关系/私聊 → 持久幂等发送 → WebSocket 通知 → 断线分页补齐 → 已读/送达同步。新增了临时聊天与隐私/例外、邀请历史选择、关系与群权限写接口、个人历史删除/清空、设备会话管理、Redis 限流与故障回归。完整的 166 项需求尚未全部实现。

- [当前后端补齐与验收边界](docs/BACKEND-COMPLETION.md)
- [单机容量压测报告](docs/BACKEND-LOAD-2026-11-11.md)
- [旧 MySQL 迁移验收状态](docs/LEGACY-MIGRATION.md)
- [旧 PHP 全功能对照与审查结论](docs/BACKEND-PARITY-REVIEW.md)
- [Android 接口接入与本地验证](docs/ANDROID-API-V2.md)
- [iOS 接口接入与验证边界](docs/IOS-API-V2.md)
- [Android / iOS 联合审查](docs/MOBILE-REVIEW-2026-11-11.md)
- [全部功能与需求](docs/REQUIREMENTS.md)
- [单机架构与组件决策](docs/ARCHITECTURE.md)
- [底座缺陷与修复审查](docs/CORE-REVIEW.md)
- [API 与旧前端接入顺序](docs/API-V2.md)
- [本地运行与验证](docs/RUNBOOK.md)
- [实现状态与下一步](docs/IMPLEMENTATION.md)
- [权限与业务不变量](docs/PERMISSIONS.md)

默认程序位于 server/main.go，业务内核在 server/internal/core。默认模块只引用消息内核所需依赖，历史参考模块不参与构建或路由注册。

运行前显式执行数据库迁移；配置从环境变量读取，服务不会自动加载 .env。命令及隔离验证入口见运行说明。

Android 优先接入已开始，保留原样式并增加必要操作入口。当前核心文字聊天与关系/群权限链路可联调，尚未替代全部旧功能，详见 Android 接入说明。
