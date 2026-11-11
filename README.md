# Pulse IM Go 后端

单机模块化单体：Go + PostgreSQL + Redis。保留现有 PC、移动端、Web 前端代码，后续集中改接新协议。容量目标为总计 4 核、8—16 GiB 下至少 10000 在线连接，尚未完成容量验收。

当前完成第一条真实消息链路：密码登录 → 好友关系/私聊 → 持久幂等发送 → WebSocket 通知 → 断线分页补齐 → 已读/送达同步。新增了临时聊天与隐私/例外、邀请历史选择、关系与群权限写接口、个人历史删除/清空、设备会话管理、Redis 限流与故障回归。完整的 166 项需求尚未全部实现。

- [旧 PHP 全功能对照与审查结论](docs/BACKEND-PARITY-REVIEW.md)
- [Android 接口接入与本地验证](docs/ANDROID-API-V2.md)
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
