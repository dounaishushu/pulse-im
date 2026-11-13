# API v2 后端补齐接口（2026-11-11）

当前工作区的新增契约。旧客户端保持原界面，但需要在后端验收后继续适配。所有整数水位、版本及大整数金额以各 DTO 的 JSON 标签为准；消息及会话标识为 UUID。未知请求字段会拒绝，错误格式为 `error.code`，429/503 带 `Retry-After`。

## 账号和联系人

- `GET /auth/captcha` 返回 120 秒、IP 绑定的一次性图片验证码；失败尝试也消费验证码。
- `POST /auth/register` 支持 account/nickname/password/captcha_id/captcha_code；头像通过 avatar_filename + avatar_base64 提交，服务端重编码。受并发、同 IP 配额与注册策略控制。
- `POST /auth/login` 在原字段上增加 second_factor、platform、device_name。platform 为 pc/web/android/ios；移动绑定只作用于移动端。
- `GET/PUT /me/security`：查看状态、enable/change/disable/recovery。二步密码单独哈希，8 个一次性恢复码只在生成时返回。
- `GET/PATCH /me/profile`、`PUT /me/avatar`、`GET /profiles/{id}`、`GET /profiles/{id}/common-groups`。
- `GET /public-users/{public}` 按大小写敏感的公开 ID 查询；联系人详情继续受关系/群上下文与隐私限制。
- `GET /contacts`、`PUT /friends/{id}/metadata`：备注及分组，使用 contact_version 并发控制。
- `/me/privacy` 增加 phone、last_seen 及例外；受保护隐私项沿用内部人员权限。

## 媒体与消息

1. `POST /media/uploads`：request_id/kind/filename/bytes（字符串）/sha256/original，返回 id。支持 image/video/audio/file/avatar/question，后台专用素材走后台媒体入口。
2. `PUT /media/{id}/bytes`：原始二进制流，按声明长度和 SHA-256 校验，202 表示进入处理队列。
3. `GET /media/{id}`：pending/receiving/queued/processing/ready/failed/cancelled；失败含 error_code。
4. `DELETE /media/{id}` 取消未完成上传；`POST /media/{id}/retry` 重试可恢复处理失败。
5. 仅 ready 可用于消息。`GET /media/{id}/content` 和 `/preview` 重新校验访问权，支持 Range；不得使用公开静态目录绕过授权。

消息发送新增 kind/media_id/card_user_id/reply_to_id/mentions/mention_all；引用只保留来源 ID，读取来源仍校验可见性。名片资料由服务端读取。编辑仍只允许本人文字，固定 expected_version。撤回、清空、删除或退群会使对应附件引用授权失效；附件若还有其他有效引用或上传者所有权，可继续访问。

JPEG/PNG/WebP 普通图按最长边 2560、预览 640 处理，处理后去除 EXIF，JPEG 方向被应用。原图按用户选择保留校验后的原始字节；GIF 保留动画且检查帧数/累计像素，头像始终标准化。图片 10 MiB、视频 100 MiB、音频 10 MiB、文件 50 MiB；图片 2400 万像素、单边 12000 上限。图片处理最多 2 个 worker，共享 512 MiB 解码预算；最多 8 路上传，待处理全局 4 GiB / 单账号 512 MiB / 1000 项，存储至少预留 1 GiB。音视频由受超时和输出/探测预算限制的 ffprobe 读取真实容器；语音最长 5 分钟。

- `GET /conversations/{id}/search` 与 `GET /messages/search`：关键词、类型、发送者、时间及会话过滤。
- `GET /conversations/{id}/messages/{message}`：定点读取，可结合 history 的 before/floor/after 定位上下文。
- `GET /conversations/{id}/pins`，`PUT/DELETE /conversations/{id}/pins/{message}`，每会话最多 20 条。
- `GET /conversations/{id}/mentions`：本人未读提及。
- 名片 `/contact` 与 `/contact-request` 子路径校验真实消息和源群规则。
- `POST /forward-batches`、`POST /broadcasts`，`GET/DELETE /send-batches/{id}` 和 `/retry`：持久队列、逐项结果、固定请求号、当前权限重查。

## 会话、群与通知

- `POST /conversations/saved`：本人的唯一收藏会话。
- `GET/POST /conversation-folders`，`PUT /conversation-folders/{id}`；`PATCH /conversations/{id}/preferences` 设置置顶、免打扰、归档、隐藏和文件夹。
- `POST /channels` 创建频道；已有群成员/角色/加入/退出接口同时支持频道，其普通成员不能发言。
- `POST /groups/join-by-number`、`GET /groups/{id}/search-members`、`GET /groups/{id}/invite-candidates`、`PUT /groups/{id}/avatar`。
- 邀请历史默认 false；重复邀请不改变现有成员历史范围，重入递增 membership_version，并保留个人清空/删除。
- `GET /notifications`、`PUT /notifications/read`；`GET/PUT /me/notifications`。
- `PUT/DELETE /me/push-device` 登记当前会话的 APNs/FCM 设备。配置缺失、无效设备、平台失败分别返回/记录，不把登记成功等同真实到达。

## 独立后台

所有后台路由前缀 `/admin`。登录需要 account/password/entry_token；返回 HttpOnly、SameSite=Strict 的独立 Cookie 及 CSRF token，后续必须发送 X-Admin-Entry，写请求额外发送 X-CSRF-Token。远程要求 HTTPS，只有本机开发允许 HTTP。会话 8 小时，最多 5 个；角色、权限、密码与停用变更撤销旧会话。审计员只读，超级管理员/操作员按模块控制；不能停用/降级自己或最后一个超级管理员。

- `/accounts`、`/accounts/{id}`、`/accounts/{id}/entry`：账号、角色、模块权限及入口轮换。入口属于访问凭据，保存在私有后台表，不出现在账号列表；不得写入日志或公开配置。
- `/users`、`/users/batch`、`/users/{id}`、`/users/{id}/avatar`、`/logout`、`/history`、`/devices`：查询、开户、权限、密码重置、冻结/恢复/标记删除、强制退出、个人历史和设备查看。没有查看用户原密码接口。
- `/groups`、`/groups/{id}`：群/频道创建、资料、人数、规则、转让、停用与标记删除。
- `/messages`、`DELETE /messages/{id}`；`/sensitive-words` 及 `/delete`：消息查询/审核撤回、最长词优先替换，仅过滤正文。
- `/config/{key}`：registration、mobile_binding、announcement、releases、navigation、routes、display、maintenance。公告、设备、维护分别按对应模块授权，其他配置按 config；所有保存使用 expected_version。
- `/stats`、`/regions`、`/unusual-logins`、`/ip-locations/refresh`、`/login-events`、`/audit`、`/diagnostics`、`/health`。

## 任务、分发与维护

- 用户 `/tasks`、`/tasks/{id}/start`、`/task-records`、`/task-records/{id}`、`PUT .../answers`、`PUT .../submit`。
- 后台 `/tasks`、`/tasks/{id}`、`/tasks/{id}/code`、`/task-codes`、`/questions`、`/questions/delete`、`/questions/import`、`/questions/template`、`/exports/questions`、`/exports/wages`、`/task-records`、`/task-records/{id}/review`。
- 每日题目固定快照，2—1000 偶数、正误均分；开始时固定员工类型和单价；客户端不获取标准答案；工资按整数千分位计算。已有作业的任务不能直接删除。
- 题库 CSV（UTF-8/GB18030）、XLS、XLSX；支持编号更新、URL 和受归属检查的站内媒体、内嵌图片。最多 10000 行，XLSX 解压总量 80 MiB / 20000 项，最多 32 列；导入/导出同时仅 1 个任务。导出 CSV/XLSX。外部图片 URL 不由服务端抓取。
- 后台 `/dispatch-plans`、`/dispatch-plans/{id}`、`/disable`、`/delete`、`/dispatch-runs` 及详情：一次性或标准五字段 Cron（北京时间），最多 100 目标、100 步，逐项延迟、重试、固定幂等请求号；图文步骤在同一数据库事务发送两条消息。
- 后台 `/maintenance/idle`、`/idle-delete`、`/runs`：先预览、执行时重核版本和活动；内部员工/群管理者/未完成作业受保护。自动注销按本人 0/30/90/180/365 天策略。维护只清过期凭据、诊断、已读通知及指定 runtime/cache、runtime/logs；不清空聊天表或 Redis 实例。
- Telegram webhook `/integrations/telegram/webhook`；后台 `/telegram/grants`、`/telegram/chats`。`/pin`、`/codes`、`/create_admin`、`/entry` 均有授权，登录资料私聊；不实现已取消的 IP 白名单功能。

所有路径相对于 `/api/v2`。推送、Telegram、IP 定位及媒体探测需部署配置；最终真实平台、Linux 实机与旧数据库迁移验收单独记录。

## 后续补充

- `POST /groups` 可选 `avatar_id`，必须是创建者已处理完成且有归属权的图片。`GET /conversations/{id}/shared-media?kind=all|image|video|file&before_seq=...` 只返回本人仍可见的媒体消息；退出、清空、个人删除或撤回会使结果消失。
- `GET /client/update?platform=pc|web|android|ios&version=x.y.z` 返回当前版本与服务端发布策略的比较结果。
- 浏览器预览可先 `POST /media/{id}/grants` 获取两分钟票据，再通过返回的 content_path 或 preview_path 读取。票据与会话、媒体 ID 绑定；实际读取会重新检查会话状态和消息可见范围。
- 后台 `GET/PUT /admin/security/ip-rules` 管理有有效期的 CIDR 规则，仅超级管理员可写。PUT 还需 `X-Ops-Time`（Unix 秒）、`X-Ops-Nonce`（16—64 字符）及 `X-Ops-Signature`（HMAC-SHA256 十六进制）。签名原文为方法、路径、时间、nonce、请求体 SHA-256 十六进制，按该顺序以换行分隔。密钥通过 `PULSE_ADMIN_OPS_SECRET` 注入，至少 32 字符。时间窗为前后两分钟，nonce 入库防重放。
- 后台远程访问要求 HTTPS。可信反向代理必须配置 `PULSE_TRUSTED_PROXY_CIDRS` 并覆盖 `X-Real-IP`；启用白名单后，来自本机代理但缺失可信真实 IP 的请求被拒绝。直接本机访问也需把本机地址列入规则并传递真实 IP。
- `create-admin` CLI 只允许首次引导，后续通过已授权后台创建。独立入口只保存摘要，创建或轮换时返回一次。Telegram `/entry` 轮换并私聊新入口，旧入口及旧后台会话立即失效。
- 公开注册账号默认不能建群，后台授权后可建群。

- 迁移兼容：读取资料和公开 ID 路由优先返回旧 16 位 public_id（若存在），并兼容原 PHP bcrypt 密码哈希；正式导入和记录对账尚未完成，详见 [旧库迁移](LEGACY-MIGRATION.md)。

## 2026-11-13 客户端收尾补充

- `POST /conversations/{id}/reply-contexts` 接受至多 100 个 `message_ids`，返回引用的 `reply_seq` 与受当前可见性保护的原消息。原消息已清空、删除或撤回时 `message=null`，客户端显示不可用，不保留旧引用内容。
- `GET /public-users/legacy/{id}` 只解析迁入数字用户 ID，校验账号状态、双向拉黑并限频；不能直接把数字当作本地 UUID 查找键。
- `GET /profiles/{id}/common-groups?page=&size=` 返回真实页号、总数和列表。邀请候选 `/groups/{id}/invite-candidates` 支持 `limit=1..100`，隐私过滤后的空页允许携带向前推进的 `next_after`。
- 好友申请创建响应包含真实 `status`；互发申请自动通过时附 `conversation_id`。后台消息补充会话、发送者和接收者信息，任务记录和导出使用相同的用户、任务、状态与日期筛选。
- 后台维护任务持久化账号处理进度及实际清理项数；缓存分批处理时不会重复停用账号。预览数据放在 `cache_preview`，不冒充已释放空间。定时时间按北京时间自然日计算。
- Go `/client/config` 输出统一的 `/api/v2`、同源 `/api/v2/realtime` 线路，保留旧设置原始记录；客户端从指定业务入口读取可信别名，其他写入不因切换线路被自动重放。
