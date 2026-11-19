# 已修复功能的 Go 后端整合

日期：2026-11-19，北京时间。以 GitHub `codex/go-rewrite` 分支的 `774369efcf00eba4ee44ca08a1f1cab437930a4d` 为基线，核对此前已推送的修复，并补齐下述服务端契约。

## 构建和部署入口

全部服务端实现位于同一 `server` 根模块，入口为 `server/main.go`，业务在 `server/internal/core`，由 `NewHandler` 注册实际 HTTP 路由。默认 `go.work` 只使用该模块，`server/Dockerfile` 会编译全部当前 `internal` 源码。无需另外安装前文的两个文件热修复包。

```sh
docker build -f server/Dockerfile -t pulse-im:go-20261119 server
```

部署时沿用现有生产环境配置、挂载及网络，先保留旧镜像，再按现有发布流程切换完整服务。此命令仅构建镜像。用户已明确暂不部署，本轮没有上传生产服务器、修改生产数据或重启服务。

本次没有增加数据库迁移，迁移目录仍到 `063_client_network_observations.sql`；它与此前只读核查的生产提交 `6618578f92788d7dff1c0cca425142453aa59224` 的迁移文件一致。

## 本轮补齐

### 服务端统一群权限

`groups.go` 与 `client_queries.go` 共用 `group_permissions.go`。`GET/PATCH /api/v2/groups/{id}` 直接返回 `can_manage`、`can_invite`、`is_owner`、`can_mention_all`、`allow_member_add_friend`、`members_visibility`、`search_scope`。

- 关闭 `block_member_friend_requests`：普通群员获得完整群成员目录，`members_visibility=all`、`search_scope=group`，支持名称、本人备注、账号及公开 ID 模糊搜索。
- 开启该开关：普通群员默认只浏览群主与管理员，`members_visibility=managers`、`search_scope=friends`；搜索限本群内自己的好友。
- 群主及管理员的管理能力继续独立判断；普通群员查看完整目录不获得管理、邀请或 @ 全体权限。频道不继承普通群聊的目录开放规则。
- 群详情及目录读取在各自一致的数据库快照内计算。加好友仍在 `profiles.go` 返回当前对象的 `can_add_friend`，并在 `social.go` 写入申请时重核当前成员、群开关、账号能力和双向拉黑；显示字段不能授权写操作。

### 群发候选的备注和搜索

`GET /api/v2/broadcast-targets?kind=friend|group&q=...&after=...&limit=...&snapshot=...` 新增可选 `q`，最多 100 个字符；每页 1～100 条。好友搜索覆盖本人备注、昵称、公开账号、公开 ID；群组搜索覆盖群名及公开 ID。通配符按字面量转义。

候选增加 `remark`、`display_name`、`public_id`；`name` 保留原昵称语义，`display_name` 优先本人备注。查询仅连接当前账号的备注，不包含其他人的备注。已有好友关系、双向拉黑、有效群成员、隐藏状态和候选快照限制继续生效，内部员工权限在每次请求时重新检查。浏览器适配器保留这些字段并转发搜索参数。

### 探索配置兼容

`GET /api/v2/client/config` 的 `announcement` 同时返回 Go 使用的 `body`，以及旧版原生客户端需要的数字 `id`、`revision` 和字符串 `content`。关闭公告时仍返回完整对象；`content` 与 `body` 相同，`revision` 对应 `announcement_version`。未改变数据库内管理员保存的公告设置。

这补齐了此前 iOS 探索入口因公告缺字段而整份配置解码失败的服务端兼容。导航仍来自实际 `navigation` 设置；网络失败或未配置入口不会被伪装成有效导航。

## 此前推送的功能核对

以下是实现位置及现有回归入口，并非声明本轮所有用例都完成了真实数据库或真机验收。具体运行边界见后文。

| 用户此前反馈 | Go 主服务实现 | 回归入口 |
| --- | --- | --- |
| 群成员显示、互加好友开关、普通群员模糊搜索 | `groups.go`、`group_permissions.go`、`client_queries.go`、`profiles.go`、`social.go` | `group_friend_policy_test.go`、`member_directory_test.go` |
| 管理员实际人数、群成员完整分页 | `GroupDetails` 的实际计数、`ClientMemberPage` 的 UUID 分页，不限制为五名管理员 | `member_directory_test.go`、既有 PC 管理员页面检查 |
| 普通群员输入 @、管理者 @ 全体 | `client_completion.go` 搜索授权、`message_content.go` 接收者和 @ 全体校验；普通成员候选账号隐藏由客户端显示规则完成 | `server_feedback_test.go`、`features_complete_test.go` |
| 群成员禁言、定时到期、全员禁言 | `groups.go`、`client_queries.go` 的永久/定时禁言和当前发送权限 | `migration_gaps_test.go`、`social_groups_test.go` |
| 好友备注、强加好友后的备注资格、切换会话和群聊显示备注 | `social.go` 统一好友关系、`profiles.go` 本人备注和版本检查、客户端好友目录返回备注 | `review_test.go`、`completion_review_test.go`、`client_queries_test.go` |
| 群发按备注搜索、分页、后台发送和重试 | `broadcast_targets.go`、`delivery_jobs.go`、普通消息的持久幂等发送接口 | `broadcast_targets_test.go`、`delivery_jobs_test.go` |
| 置顶会话、邀请过滤已在群的人、邀请列表按新旧消息排列 | `organization.go` 的本人偏好、`GroupSearchCursor` 的候选过滤、`group_invite_activity.go` 的实际可见私聊消息时间；客户端收齐分页后排序 | `group_invite_activity_test.go`、`social_groups_test.go` |
| 看完仍显示未读和 @ | `conversations.go` 已读水位、`receipt_one.go` 稀疏已读、`client_queries.go` 未读/@摘要及状态版本 | `migration_gaps_test.go`、`legacy_receipts_test.go`、`chat_latency_test.go` |
| 普通用户禁止自行删除/清空历史 | `personal.go` 在执行前重新检查账号和会话权限 | `history_delete_policy_test.go` |
| 会话切换、回前台和重连时增量补齐 | `client_open.go`、`sync.go`、`personal.go`、`client_http.go` 的打开、双游标和批量会话摘要 | `client_open_grants_test.go`、`conversation_updates_test.go`、`core_test.go` |
| 群聊头像、作者名字、历史/搜索/引用显示作者 | `types.go` 的最小作者展示信息及消息查询，保留资料和媒体访问权限 | `message_sender_test.go`、`performance_media_test.go` |
| 图片、视频、语音上传及媒体授权恢复 | `media_wait.go`、`media_processing.go`、`media_grants.go`、`media_cache.go`，发送使用持久请求号 | `media_wait_test.go`、`accounts_media_test.go`、`client_open_grants_test.go` |
| 在线时间、在线标识、登录设备、IP 和归属地 | `profiles.go`、`client_presence.go`、内部员工授权资料、登录记录及 IP 定位缓存；外部定位需要实际部署配置 | `client_presence_test.go`、`login_client_version_test.go`、`staff_profile_location_test.go` |
| 启动检查超时、探索配置、版本更新 | `configuration.go`、`client_config_compat.go`、`client_update_media.go`；后台版本检查和重试策略由客户端执行 | `client_config_compat_test.go`、`features_complete_test.go` |

## 客户端代码继续保留

消息滚动跟随和上翻定位、输入框自动增高/焦点恢复、头像布局与图片重试、已发送图片的本地即时预览、隐藏发送队列文字提示、安卓附件缓存目录恢复，以及应用分身的本地资源管理，都运行在客户端进程。此前修复的 PC、Android、iOS 源码已在同一仓库中保留；这些行为需要对应客户端代码，不能通过更新 Go 服务器替换已安装应用里的界面和本地文件处理。

Go 后端保留上述行为依赖的权限、水位、作者、备注、媒体及增量接口。已有客户端字段保持兼容；新增的群权限和群发字段可由新客户端直接使用。

## 本轮实际验证

- Go 全量测试命令已运行：61 项通过，0 失败，171 项因缺少独立本地 PostgreSQL/Redis 配置而跳过。不能将跳过的集成用例计为通过。
- `go vet ./...` 与 Linux amd64 构建通过；未在 Linux 主机启动本轮产物。
- 精确生产 SQL 在隔离 PGlite PostgreSQL 中通过 59 项检查：成员目录 18 项、好友权限 19 项、群发候选 22 项。这不是 Go HTTP/Redis 集成测试。
- 客户端单元检查 207 项通过；PC 群发备注页面 11 项、群成员与好友页面 18 项通过，页面使用隔离的 HTTP 假数据。
- 本轮没有重打移动端安装包，没有新增 Xcode 或手机真机验收。

精简证据见 [go-feature-integration-2026-11-19.json](evidence/go-feature-integration-2026-11-19.json)。构建和发布均应使用完整当前 `server` 源码，生产部署仍待单独执行。
