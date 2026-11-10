# 林语派生验证版改动

上游提交：eeb37a58a51e0e2139b329a962709db120f63883。原始源码与压缩包独立保留，派生目录为 server/，原 LICENSE 完整保留。修改的源文件增加变更声明。此版本用于验证复用路线。

- 新增 PostgreSQL/GORM 连接适配，设置有限连接池与连接检查超时。开发迁移必须显式开启，默认不运行 PostgreSQL AutoMigrate；生产版本仍需正式 SQL 迁移。
- 为旧 LocalTime 的 timestamp 列配置 Asia/Shanghai 解码，解决真实读写复现的八小时时移；最终新消息表采用 timestamptz。
- 默认构建排除 AI、应用中心、云盘、实时通话入口以及向量、RocketMQ、S3/OSS SDK。扩展可用 linyu_extended 构建标签；SQLite 需 linyu_legacy_db 标签。扩展组合未经本轮验收。
- WebSocket 发送队列有界、非阻塞，加入帧大小限制和读写 deadline；慢连接关闭。写循环退出按连接对象清理，保护同设备新连接。
- 重试键包含接收用户、设备和事件，ACK 绑定当前 socket 身份；连接列表广播时复制受锁保护的快照，心跳使用原子读写。
- 保留上游业务主体，未把这些基础改动等同于消息内核重写完成。持久 outbox、发送幂等、顺序补齐、所有权限和业务模块仍见 IMPLEMENTATION.md。

缓存的在线成员更新暂随管理锁排序，适用于本地缓存验证配置；远程 Redis 缓存延迟、连接数硬上限与全局重试内存预算仍待后续改造。现有历史同步不是最终可靠同步方案，慢连接关闭后的无遗漏恢复尚未完成验收。

部分文件仅因 gofmt 统一格式而变化。完整改动清单见 evidence/fork-files.json，补丁见 evidence/linyu-candidate.patch。

- `linyu-basic-service/pkg/model/pulse_postgres_test.go` — added
- `linyu-common/go.mod` — modified
- `linyu-common/go.sum` — modified
- `linyu-common/pkg/config/config.go` — modified
- `linyu-common/pkg/config/db_config.go` — modified
- `linyu-common/pkg/db/dialect_expr.go` — modified
- `linyu-common/pkg/db/rdb/postgres.go` — added
- `linyu-common/pkg/db/rdb/rdb.go` — modified
- `linyu-common/pkg/db/rdb/sqlite.go` — modified
- `linyu-common/pkg/db/rdb/sqlite_disabled.go` — added
- `linyu-common/pkg/db/vector/backends_disabled.go` — added
- `linyu-common/pkg/db/vector/chromem.go` — modified
- `linyu-common/pkg/db/vector/vector.go` — modified
- `linyu-common/pkg/db/vector/weaviate.go` — modified
- `linyu-common/pkg/event/eventbus/rocket_disabled.go` — added
- `linyu-common/pkg/event/eventbus/rocket_event_bus.go` — modified
- `linyu-common/pkg/storage/backends_disabled.go` — added
- `linyu-common/pkg/storage/oss_storage.go` — modified
- `linyu-common/pkg/storage/s3_storage.go` — modified
- `linyu-gateway/pkg/gateway/gateway.go` — modified
- `linyu-gateway/pkg/gateway/modules_core.go` — added
- `linyu-gateway/pkg/gateway/modules_extended.go` — added
- `linyu-im/internal/ws/client.go` — modified
- `linyu-im/internal/ws/client_manager.go` — modified
- `linyu-im/internal/ws/handlers.go` — modified
- `linyu-im/internal/ws/pulse_regression_test.go` — added
- `linyu-im/internal/ws/pulse_socket_test.go` — added
- `linyu-im/internal/ws/rotue.go` — modified

## 2026-11-09 消息内核阶段

- 默认根模块改为 pulse.im/server；旧入口移至 server/legacy-entry，独立 go.legacy.work 仅供历史验证。默认构建不注册旧路由。
- 新增 internal/core：版本化 PostgreSQL schema、持久身份、Redis 短期数据、统一发送授权、事务消息/事件/outbox、快照同步、单调回执、文字编辑撤回和有界 WebSocket。
- 密码助手沿用既有 Argon2id 编码/算法，增加资源与格式边界。普通业务源码保留作后续按需移植参考；本轮没有整体启用其 API。
- 默认运行名、模块名、README 和部署模板使用 Pulse IM。源码许可和内部来源记录保留。
- 具体修复、未完成项及验证见 CORE-REVIEW.md、IMPLEMENTATION.md；旧证据文件保留且不覆盖成新结果。
