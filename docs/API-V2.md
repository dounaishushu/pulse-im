# API v2 与旧前端接入契约

更新：2026-11-10。下列接口已经进入默认程序；现有前端代码保留，尚需逐端改接和联调。

通用：普通请求使用 Authorization: Bearer <token>；ID、序号、版本在 JSON 中均为字符串；时间为 UTC RFC3339。POST/PATCH/PUT 仅接受声明字段，JSON 请求体最多 32 KiB。错误为 {"error":{"code":"..."}}，HTTP 状态可为 400/401/403/404/409/429/503；429/503 带 Retry-After。禁止将长期 token 放到 URL。

| 方法与路径 | 输入/输出要点 |
| --- | --- |
| POST /api/v2/auth/login | account, password, device_id；返回 access_token、user_id、session_id、device_id、expires_at |
| POST /api/v2/auth/logout | 撤销当前持久会话并关闭其 WS，204；Redis 故障时仍可退出 |
| GET /api/v2/auth/sessions | 仅列本人的有效设备会话，含当前会话标记 |
| DELETE /api/v2/auth/sessions/{id} | 撤销本人的指定设备会话并关闭对应 WS |
| PUT /api/v2/auth/password | current_password、new_password；成功后注销该账号全部会话 |
| GET /api/v2/me | 当前持久身份，不含密码和 token 摘要 |
| GET /api/v2/users/by-account/{account} | 完整账号精确查询，仅返回公开 ID 和账号；双方屏蔽时不可查询 |
| GET /api/v2/friends?after=UUID | 本人有效好友 ID 分页；资料与备注待补充 |
| POST /api/v2/friend-requests | target_id、note，可带 context_conversation_id；指定来源群须双方仍在群内且允许互加；检查目标申请开关和双方屏蔽。双方互发申请视为同意 |
| GET /api/v2/friend-requests?direction=incoming/outgoing&after=UUID | 本人申请分页，包含处理状态 |
| PUT /api/v2/friend-requests/{id}/decision | accept=true/false；同一决定重试返回已有结果 |
| POST /api/v2/friends/direct-add | target_id；仅内部人员免申请建立双方好友并处理双方待定申请，仍检查屏蔽 |
| DELETE /api/v2/friends/{peer} | 删除双方好友关系，不删除既有消息 |
| GET /api/v2/blocks?after=UUID | 本人黑名单分页 |
| PUT/DELETE /api/v2/blocks/{peer} | 明确拉黑/解除，不以 toggle 翻转 |
| POST /api/v2/realtime/tickets | 返回 ticket、expires_in=30；只能消费一次 |
| GET /api/v2/realtime?ticket=… | 升级 WS；登记完成后先发送 ready，长连接只负责变化提示与心跳 |
| GET /api/v2/conversations?after=UUID | items、next_after；每页至多 100，按 UUID 排序；保留 next_after 循环到空 |
| POST /api/v2/conversations/direct | peer_id；好友或满足接收方临时聊天隐私的非好友可打开；双方屏蔽则拒绝，复用原 id，不自动加好友 |
| GET /api/v2/conversations/{id}/access | can_send、role、reason；供输入框显示当前禁言/只读原因，发送时仍重新鉴权 |
| POST /api/v2/conversations/{id}/messages | request_id 和 body；或 request_id 和 source_message_id 转发 |
| GET /api/v2/conversations/{id}/sync | after、limit=1..100，可传 snapshot_max_seq；返回事件分页 |
| GET /api/v2/conversations/{id}/personal-sync | 同样的固定上界分页参数，仅同步本人的删除、清空和提醒变更 |
| GET /api/v2/conversations/{id}/unread?cap=999 | 仅统计可见的他人未读文字；超上限明确 truncated |
| POST /api/v2/conversations/{id}/personal-deletions | message_ids，1—100 个；只删除本人视角，重复提交不重复产生个人事件 |
| PUT /api/v2/conversations/{id}/clear | 必须传 {"through_seq":"42"}，使用确认清空时的消息序号；重试沿用同一边界，不能扩大到新消息；不推进已读/送达事实 |
| PUT /api/v2/conversations/{id}/reminder | reminder=true/false；只设置个人提醒，不回退已读事实 |
| PUT /api/v2/conversations/{id}/read | {"seq":"42"}；返回单调 read/delivered/clear/version |
| PUT /api/v2/conversations/{id}/delivered | {"seq":"42"}；只推进送达 |
| GET /api/v2/conversations/{id}/states?after=UUID | 只返回当前用户私有 read/delivered/clear/version，不公开其他成员水位 |
| GET /api/v2/conversations/{id}/messages/{message}/receipts | 仅发送者查询自己可见消息的 recipient_count/delivered_count/read_count；不提供具体阅读人，不适用于频道 |
| PATCH /api/v2/conversations/{id}/messages/{message} | body、expected_version；普通用户仅本人文字，内部人员可编辑可见他人文字，仍检查发言约束 |
| DELETE /api/v2/conversations/{id}/messages/{message} | 内部人员撤回可见消息；重复撤回幂等；不是个人删除 |
| POST /api/v2/groups | title、initial_members（最多 499 个）；返回群 ID 和仅本次可见的邀请码 |
| GET/PATCH /api/v2/groups/{id} | 成员查看资料；群主/管理员修改群名、简介、公告、入群规则、容量等 |
| POST /api/v2/groups/{id}/invite-code/rotate | 群主/管理员轮换邀请码，旧码立即失效 |
| GET /api/v2/groups/{id}/members?after=UUID | 当前可见成员分页；互加好友受限时普通成员仅见群主/管理员 |
| POST /api/v2/groups/{id}/join | invite_code；邀请码/开放规则、容量和屏蔽检查；重复加入幂等 |
| POST /api/v2/groups/{id}/members | target_id、必填 allow_history 布尔值；群主/管理员邀请单人；校验目标邀请隐私及屏蔽 |
| POST /api/v2/groups/{id}/members/batch | user_ids，1—50 个、必填 allow_history；本批次统一历史选择，逐目标隐私/权限检查 |
| DELETE /api/v2/groups/{id}/members/{user} | 管理者移除或非群主本人退出 |
| PUT /api/v2/groups/{id}/members/{user}/muted | muted=true/false；永久禁言/解除，重复设置不翻转 |
| PUT /api/v2/groups/{id}/mute-all | muted=true/false；仅群主/管理员可操作 |
| PUT /api/v2/groups/{id}/members/{user}/role | role=admin/member；仅群主可任免 |
| POST /api/v2/groups/{id}/transfer | target_id；仅群主可转让 |
| DELETE /api/v2/groups/{id} | 仅群主解散，后续禁止发送和正常补齐 |
| GET /healthz | 进程存活 |
| GET /readyz | PostgreSQL/Redis 可用；故障 503 |

当前支持文字与文字转发。请求 ID 允许 1—64 位字母数字及 _ . : -，同一次用户发送必须在重试时保持不变。同键同载荷返回 200 duplicate=true，首次 201；同键不同载荷返回 409 request_conflict。body 最多 5000 个 Unicode 字符，图片/文件结构暂未开放。

## 重连的正确时序

1. 通过持久 token 申请短票据；创建 WS，等待 {"type":"ready"}。
2. 缓存后续变化通知，同时分页取会话目录，记录每个会话 event_seq。
3. 对每个会话从本地事件游标开始补齐，第一页的 snapshot_max_seq 必须沿用到最后一页；客户端事务中合并消息与保存 next_after_seq。
4. 按 message.id 去重、按 message.version 只前进；页内旧事件可能携带该消息当前版本，不能据此把事件游标跳到更远。
5. 将缓存通知按会话取最大 event_seq，继续从已持久游标补齐。通知可重复、乱序、被合并；每会话只维持一个补齐任务。
6. 收到 state.changed 后刷新自己的 states；其他成员只收到匿名 receipts.changed，可按需刷新自己发送消息的聚合人数。初次连接/重连也获取自己的 states 和 personal-sync。
7. 收到 personal.changed 后仅刷新该账号的 personal-sync；收到 membership.changed 后重新取会话目录和相关群 access/details。被移除者会收到一次定向失效提示，随后不再能补齐该群历史。每次发送前仍须以后端鉴权结果为准。

WS 提示示例：

    {"type":"conversation.changed","conversation_id":"…","event_seq":"42"}
    {"type":"state.changed","conversation_id":"…","user_id":"本人","state_version":"8"}
    {"type":"receipts.changed","conversation_id":"…"}
    {"type":"personal.changed","conversation_id":"…","user_id":"本人","state_version":"8"}
    {"type":"membership.changed","conversation_id":"…"}

WS 每 25 秒协议 ping；浏览器原生处理 pong，移动端须按自身 SDK 实现。也允许低频 {"type":"ping"} 应用心跳，每连接每分钟最多 60 帧（包含协议 ping/pong）；超过 4 KiB 输入帧、非法帧或慢消费会断开。客户端指数退避加抖动重连；不能把断开判定成消息发送失败而换 request_id 再发。

## 前端保留与改接范围

保留原 PC/移动端/Web UI、路由、任务入口及本地资源。后续先封装统一 API/WS 适配层，修改 token、device_id、持久请求 ID、消息版本和同步游标；再逐个业务接入。不得直接拿旧 WS ACK 结构或“当前打开会话=全部已读”的行为接到新接口。

没有改接时，旧前端仍指向旧后端；不会通过修改页面品牌就自动兼容新服务。注册/验证码、二步验证、完整资料、头像/附件、媒体消息及任务后台等 API 尚未交付，不能让前端猜测路径。

## 2026-11-10 审查补充

- 受限群的普通成员列表只显示群主/管理员；搜索好友是另一个尚未交付的入口，不混入列表。
- 建群最多 499 名初始成员加群主，默认容量 500；后续批量邀请仍为每批 50 人。
- 用户已确认临时聊天和邀请时选择历史；实现契约见下节。整体旧业务仍未全量完成。

清空/个人删除会记录当时尚未读到或送达的排除区间。随后推进 read_seq/delivered_seq 时，回执聚合跳过这些区间，已经真实确认的回执不回退。004 迁移只增加前向结构，不能从早期错误水位重建历史阅读事实。

## 临时聊天、邀请历史与隐私（2026-11-10）

- `POST /api/v2/conversations/direct` 不要求好友关系；接收方账号有效、双方未拉黑且临时聊天隐私允许即可。临时聊天沿用 direct 类型，目录的 temporary=true 表示当前不是好友。接受好友申请复用同一会话与消息；删好友后重新按临时聊天隐私检查。
- 新增 `GET /api/v2/me/privacy` 和 `PATCH /api/v2/me/privacy`。返回 temporary_chat、group_invites、version、can_manage_group_invites；只可读改自己的设置。每条规则为 `{ "visibility":"everyone|contacts|nobody", "allow":[], "deny":[] }`，每个例外列表最多 100 个用户，禁止重复、交叉和自身 ID。
- PATCH 必须携带 expected_version 字符串，只替换提供的规则（包含该规则的完整例外列表），版本过期返回 409。新用户尚无设置行时 version 为 "0"。未知用户例外、非法枚举和重复名单返回 400。
- temporary_chat 为当前新增的普通账号自助隐私项，仅限制非好友；设置 contacts/nobody 都可关闭普通陌生人来信，再用 allow 指定非好友例外。已经是好友时按好友聊天授权，禁止其联系应使用拉黑。group_invites 沿用原受保护隐私权限，仅内部人员能修改本人设置；普通账号可查看本人规则。内部人员发送或邀请仍不能绕过接收方规则。
- 群邀请支持 everyone/contacts/nobody 及 allow/deny；无论例外怎么配置，双方拉黑或目标停用都拒绝。默认 everyone；005 迁移将原 allow_group_invites=false 转为 nobody，之后以新规则表为准。新建群的初始成员同样校验邀请隐私。
- 单人/批量邀请必须显式提交 allow_history：false 只看此次入群后的消息，true 可看历史；不改变个人 clear_seq 和删除记录，也不能恢复撤回正文。前端勾选框默认不选。重复邀请已经在群的成员不会改其历史范围；移除后再次邀请按此次选项建立新的 membership_version。
- 普通成员无权邀请或授予历史权限。自行通过开放/邀请码加入默认只看入群后内容；join 不接受 allow_history，不能自己提交 true 扩权。新建群初始成员从建群开始可见全部消息。
- conversations、groups/{id}、access、sync 返回 visible_from_seq、visible_from_event_seq、membership_version、history_allowed。前端每次重连核对目录，成员版本变化时停止旧同步、重新核对个人删除/清空，剔除本地越界内容并从新起点重建；扩大范围时也须重新拉取旧页，不能继续沿用旧事件游标。
- sync 支持 `membership_version=...`，值与当前成员版本不同返回 409 membership_changed；本轮未改旧客户端，后续适配应每页携带目录提供的版本。

PATCH 示例（只关闭临时聊天，保留一名允许的非好友）：

```json
{
  "expected_version": "0",
  "temporary_chat": {"visibility":"nobody", "allow":["目标 UUID"], "deny":[]}
}
```

邀请示例：`{"target_id":"目标 UUID","allow_history":false}`；批量使用 `user_ids` 替代 target_id。长期凭据仍放 Authorization，不放 URL。

## Android 接入所需读取接口

- `GET /api/v2/client/config` 返回真实已开放能力，未开放注册和推送不伪装为可用。
- `GET /api/v2/me/profile`、`GET /api/v2/client/users/{id}?conversation_id=UUID` 提供基础账号显示资料；他人资料受好友、私聊或来源群授权，不返回手机号/IP/登录秘密。
- `GET /api/v2/client/conversation-page?page=1&size=50&kind=group`、`client/friend-page`、`client/friend-request-page?direction=incoming` 提供 Android 目录页和真实 total；size 1—100、page 1—1000。目录分页不可充当消息同步水位。
- `GET /api/v2/client/conversations?after=UUID` 保留 UUID 目录分页读取；`GET /api/v2/conversations/{id}` 返回单会话当前资料、权限、受可见性保护的最近消息及 capped 未读。
- `GET /api/v2/groups/{id}/member-profiles?after=UUID` 使用现有受限成员名单规则，附带账号、角色和禁言状态；群详情附带真实 member_count 和 owner_id。
- `GET /api/v2/conversations/{id}/history` 支持 limit、order=asc/desc、after_seq、before_seq、floor_seq、snapshot_max_seq、membership_version。正常读取排除撤回/个人删除/清空/不可见历史，返回明确 has_more 与扫描上界，不复制已撤回正文。
- `POST /api/v2/groups/join` 接受 invite_code，服务器查找后复用当前入群授权；不允许通过请求授予旧历史。
- 消息附带 updated_at，显示编辑时间与 version 分开。隐私读取附带 exception_users 的 ID/账号，供本人维护例外名单。

Android 的实际适配与未完成范围见 ANDROID-API-V2.md；PC/Web/iOS 本轮未改接。

建群可额外传 block_member_friend_requests，与新群和初始成员在同一事务保存。UI 会话页按 updated_at 倒序排列，UUID 目录游标接口仍保持按 ID 排序；消息 updated_at 使用 UTC RFC3339，Android 显示时间按设备时区转换。
