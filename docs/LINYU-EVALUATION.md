> 2026-11-09 后续决策：此前客户端复用建议已作废，全部保留现有 Pulse 前端。Redis 已纳入并接入；当前架构与修复状态以 ARCHITECTURE.md、CORE-REVIEW.md、IMPLEMENTATION.md 为准。本文件保留早期评估过程供内部查证。

# 林语二次开发评估与路线选择

结论：建议以林语为基础进行有边界的二次开发。可以减少基础账号、好友/群管理和桌面界面的搭建工作；面向 Pulse 全量需求与低配置万人在线，改造规模属于中度二开，消息可靠性与定制业务仍需认真设计。

评估时间 2026-11-09，服务端固定 eeb37a58a51e0e2139b329a962709db120f63883，客户端固定 1febe9f5de6d1348e435cbc1a75b837d346b5708。代码通过 GitHub API/codeload 获取，不把 README 的性能描述当作测量结果。服务端和客户端仓库均声明 Apache-2.0；派生服务端已保留 LICENSE，后续分发继续保留上游版权、许可及变更说明。

## 能省下的工作

| 范围 | 复用方式 | 仍要处理 |
| --- | --- | --- |
| Go 服务框架 | 复用 Gin、多模块目录、GORM 和普通业务组织 | 调整启动配置、连接池、鉴权、错误码、观测与部署 |
| 账号、通讯录、群 | 复用模型、表单/接口流程与通用 CRUD | Pulse 的内部身份、正式员工、邀请/禁言/隐私等规则 |
| 桌面客户端 | Vue 3 + Tauri 2 的聊天界面、多窗口、主题、缓存等可作为基础 | 新消息协议、品牌与 Pulse 业务入口；逐项验证 |
| 消息内容与上传 | 内容结构、类型解析与上传交互可参考 | 持久幂等、事务、断线补齐、权限化媒体访问 |
| 特殊业务 | 与 IM 模块集成 | 任务/题库/工资、分发、独立运营后台和 Telegram 能力需要新增 |

166 项逐条映射见 LINYU-MAPPING.md。没有给“覆盖 80%”等估计，因为功能条目粒度不同，同名功能的权限和一致性语义也并不等价。

## 单体是否可行

可行的源码依据：根 mian.go 在一个进程中初始化并启动 gateway；gateway 直接注册模块路由。common 提供 LocalEventBus 和 OtterCache，因此 RocketMQ/Redis 不是单机运行的必要依赖。README 罗列的所有外围组件不需要全部部署。

现有 relational switch 仅支持 MySQL、SQLite，没有 PostgreSQL。验证版已补 PostgreSQL，并实际创建六类核心模型及测试账号/消息的读写。换库有真实适配成本，尤其是时间与 SQL 语义，不能理解成只改驱动名称。

## 当前核心必须改的地方

| 发现 | 固定源码依据 | 对我们目标的影响 |
| --- | --- | --- |
| 群消息逐成员查询/更新会话 | basic-service/pkg/service/chat_service.go: SaveOrUpdateGroupIncUnreadNum、SaveOrUpdateIncUnreadNum | 群越大写放大越明显，读取后自增再保存还需处理并发覆盖 |
| 发送重试没有持久请求去重 | basic-service/pkg/param/message.go；model/message.go 的 ClientMsgId 为 gorm:"-"；SendMessage 每次生成新 ID | HTTP 重试可能产生新消息，不能靠 WebSocket ACK 解决 |
| 会话修改、消息创建、事件发布不处于一个可靠提交单元 | message_service.go: SendMessageToSession；local_event_bus.go: Publish | 入库失败或进程退出时有状态/投递缺口；本地总线每 handler 启动 goroutine 且忽略错误 |
| 增量历史无固定上界、无分页上限 | message_dao.go: ListMessagesBySessionIDSinceMsgID 使用 id > 条件后按 created_at 排序 | 雪花 ID 不代表事务提交顺序，迟提交消息可能落在已推进游标之前 |
| 转发入口绕开普通发送的目标权限入口 | message_service.go: ForwardMessage 直接调用 SendMessageToSession | 需统一授权；目前仅源码确认调用路径，未对线上服务探测 |
| 私有媒体访问与需求不同 | basic-service/pkg/api/storage.go 的公开 LocalStorageHandler 路由 | 不能直接满足撤回/退群/清空后的附件权限要求 |
| WebSocket 连接与 ACK 有问题 | client.go、client_manager.go、handlers.go | 三项已通过本地回归复现并修复，另补 ACK 设备绑定和真实连接测试 |
| 登录版本只存通用缓存 | auth/login_service.go；gateway/middleware/auth.go | 单机缓存重启/淘汰会影响会话，生产需要持久登录会话与明确撤销语义 |

以上前三类与同步、权限问题仍是后续消息内核改造重点；本轮没有声称它们已经全部修好。

## 移动端的实际边界

固定客户端 README 明确本仓库聚焦桌面：Windows 是主要验证平台，macOS/Linux 可构建，移动端/Web 仍列为规划。不能把 Tauri 支持移动平台等同于林语已经交付完整 Android/iOS/Web 产品。

最快且风险较低的衔接方式：后端先基于林语改造；桌面端后续可改用林语界面；现有 Pulse Android/iOS 界面和业务流程可先保留，改接新接口。若最终要 uni-app，则是额外客户端工程，不能计入“直接复用已完成”。

## 验证版已完成什么

独立派生目录已经建立，并实现 PostgreSQL 适配、默认精简构建、WebSocket 生命周期修复。Windows Go 构建和 Linux/amd64 交叉构建通过，8 项针对性测试通过，其中包括真实 WebSocket 重连/超大帧测试与真实 PostgreSQL 集成测试。

引入修复前，3 项 WebSocket 回归分别失败：旧 socket 清理删除新 socket、两个接收人的重试记录只剩 1 条、满队列阻塞发送。新增 PostgreSQL 的第一轮读写还复现了 8 小时时移。修正后复测通过，日志和测试源码保存在 evidence/。

这只是复用可行性的实证，尚未完成全量业务、迁移、全端联调、Linux race 检查或万人负载验收；不能直接替换线上 PHP 服务。生产数据未迁移，本轮服务器访问为只读资源核实。

## 接下来怎样实施

1. 保持林语通用模块和桌面接口中可用的部分，不为统一命名重写所有 CRUD。消息/同步采用单独版本的新契约，定制业务使用独立模块。
2. 先完成持久会话、统一授权、发送幂等、会话序号、transactional outbox、已读水位与受控 WS；形成两账号收发、断线恢复、重试去重的验收闭环。
3. 补群/频道权限、媒体、内部人员九项权限，再实现任务/工资、后台与 Telegram。
4. 迁移演练及各端改接完成后，将应用与数据库一起限制到 4 核、8/16 GiB，验证 1 万在线及独立的消息吞吐/群广播指标。

详细设计、资源预算、负载矩阵和切换方案见 ARCHITECTURE.md；当前工作状态见 IMPLEMENTATION.md。
