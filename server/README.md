# Pulse IM 服务端

默认入口为 main.go；内部模块在 internal/core。Go 工作区仅包含当前根模块，构建输出统一命名 pulse-im。

配置、数据库初始化和验证步骤见 ../docs/RUNBOOK.md，HTTP/WebSocket 协议见 ../docs/API-V2.md。

历史源码及来源记录用于内部审查；go.legacy.work 是独立的旧版验证工作区，不属于默认构建或部署。
