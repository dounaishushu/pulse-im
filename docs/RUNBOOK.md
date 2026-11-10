# 运行与验证

工作目录：server。配置环境变量示例在 server/.env.example；程序不会自动读取 .env，凭据通过实际运行环境注入。

## 开发运行

1. 准备独立 PostgreSQL 数据库及 Redis。设置 PULSE_POSTGRES_DSN、PULSE_REDIS_URL；显式声明 PULSE_ALLOWED_ORIGINS。
2. go build -o pulse-im.exe .
3. 首次执行 pulse-im.exe migrate。此操作会在所指定数据库创建 pulse schema 和 public.pulse_schema_migrations；现有业务库不要直接作为开发库。
4. 通过 PULSE_USER_PASSWORD 环境变量设置新测试密码，执行 pulse-im.exe create-user ACCOUNT，再清除此环境变量。此入口不等于完成公众注册。
5. pulse-im.exe serve 默认只监听 127.0.0.1:8080。检查 /healthz、/readyz。
6. 私聊支持满足隐私的临时聊天；好友申请、受理和内部人员免申请接口仍用于建立联系人关系。邀请成员须显式给出 allow_history。

生产启动也显式迁移；二进制正常启动只检查迁移版本/校验和，不自动改表。迁移文件一旦对真实环境发布，后续更改新增版本，不重写已执行迁移。

PULSE_TRUSTED_PROXY_CIDRS 默认为空；只有实际代理地址位于配置网段时才使用 X-Real-IP，代理应覆盖该头。对外访问通过 HTTPS/WSS；数据库/Redis 不直接公开。HTTP 日志不记录票据或 token，反代访问日志也应省略实时 URL query。

## 当前验证环境

Go 1.27.3 windows/amd64；隔离 PostgreSQL 17.9，数据库 pulse_core_test；本机已有 Redis 5.0.14.1 的独立测试进程。这个 Redis 仅验证兼容的 Lua/TTL/限流行为，不作为生产版本推荐，部署前另行选定和验证受支持版本。

独立测试环境变量：

    PULSE_CORE_TEST_DSN=postgres://pulse_test@127.0.0.1:15439/pulse_core_test?sslmode=disable
    PULSE_CORE_TEST_REDIS_URL=redis://127.0.0.1:16381/0

脚本：

    powershell -File scripts/verify-core.ps1 -GoBinary <go.exe> -Race

当前环境运行 PowerShell 7 时也可直接调用脚本。-Race 需可用 C 编译器，本机通过将 C:\Program Files\LLVM\bin 加入子进程 PATH 并设置 CC=clang 验证；不改系统 PATH。

测试每个 fixture 清空 localhost/pulse_core_test 的 pulse 表并创建假账号，严格拒绝其他数据库名和非本机 host。Redis 仅清理随机测试命名空间，不执行 FLUSHDB。隔离数据库文件在 D:\IM\.local\postgres，Redis 测试配置在 D:\IM\.local\redis-core；测试输出、Windows/Linux 二进制位于 .local/core-verification。脚本拒绝缺少配置和跳过具名测试。

之前模型与旧 WS 的独立验证脚本 scripts/verify.ps1 仍保留，使用 server/go.legacy.work 和旧隔离库 pulse_linyu_eval。它验证的是历史改造，不代表默认程序的当前状态。

## 容器模板

server/Dockerfile 只复制当前入口与 internal，运行镜像不含 AI/云盘/插件/会议 SDK 或旧入口。server/docker-compose.yml 提供 PostgreSQL、Redis、app 三服务候选模板，不包含旧前端工程。

须设置 PULSE_POSTGRES_IMAGE/PULSE_REDIS_IMAGE 为已验证标签或 digest，提供数据库/Redis 密码及使用容器主机名的连接串。数据库卷路径按 PostgreSQL 17 镜像布局设计；换主版本必须核实布局与迁移兼容。先启动依赖，再通过一次性 app 容器执行 migrate，最后启动 app。

本轮没有 Docker 运行环境验证，不把模板生成称为部署成功。Compose 各服务限额相加只是预算初值；4 核验收还要给整栈父级 cgroup 设置总限额并包括代理/监控。

## 恢复与排障

Redis 失败：新登录/写入/票据返回 503，已登录用户可有限读补齐与退出。恢复 Redis 后在线状态重建、用户重新申请 WS 票据，消息不从 Redis 恢复。

程序意外退出：登录、消息、事件均在 PostgreSQL；过期 outbox 租约可重新领，通知可以重复。客户端重连收到 ready 后按协议补齐。消息成功持久化并不代表所有客户端已经送达。

数据库失败：请求返回 503，不返回假成功；重试沿用 request_id。监控应关注提交延迟、outbox 最旧年龄/积压、队列拒绝、SQL 超时、连接/Redis 错误。当前仅有基础健康检查与结构化日志，完整指标端点待补齐。

## 审查验证证据

verify-core.ps1 现在默认在 .local/core-verification/<UTC运行编号>/ 写入日志、源码清单、两种二进制和 verification.json，也支持 -OutputDirectory 指定新的空目录；拒绝覆盖已有非空证据目录。普通与 race 用例必须一致且无具名跳过，验证期间源码必须保持不变。

2026-11-10 审查新增 004 回执排除区间表。执行 migrate 更新隔离开发库；这不是旧 MySQL 业务数据迁移。完整审查记录在 docs/BACKEND-PARITY-REVIEW.md。


005_contact_privacy_history.sql 添加临时聊天/邀请隐私与例外名单、历史选择和成员版本。显式 migrate 会把之前邀请关闭的账号转为 nobody；正常服务启动不会自行改表。001—004 校验和保持不变，未进行旧 MySQL 数据迁移。
