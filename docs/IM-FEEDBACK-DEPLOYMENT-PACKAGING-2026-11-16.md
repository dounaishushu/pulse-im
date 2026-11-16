# IM 问题汇总、服务器上线与后续客户端打包交接

更新时间：**2026 年 11 月 16 日，北京时间**。

本文件集中说明：用户汇总的 18 项问题、本次 Go 后端及管理员后台改动、实际发布与验证、未完成部分，以及作者后续打包和代码保护的方法。

**最新状态（2026-11-16 11:50，北京时间）：第二批 Go 和用户 Web 已上线 `97c7e2d`。** 修复会话切换刷新竞态、选图返回整屏重载、成员头像逐个授权和回执触发历史重载；接入稳定媒体缓存；未读计数按权限/状态版本复用，worker 心跳合并及空闲退避已经实施。PC 2.4.166、Android 0.2.92 提供包；Android 仍是测试签名，作者正式签名和 Firebase 配置仍缺失。iOS 提交对应媒体退避代码，不打包。详细日志、178 项 Go 测试、68 项客户端测试、安卓模拟器及线上 27 次 HTTPS 验收见 [性能与问题修复记录](PERFORMANCE-REVIEW-2026-11-16.md)。以下早前“客户端暂停”“未读/worker 未做”描述保留为当时状态，以本段和性能记录为准。

安装包发布在 GitHub `pc-v2.4.166`：https://github.com/dounaishushu/pulse-im/releases/tag/pc-v2.4.166 。`pulse-im-pc-2.4.166-x64.exe` 为 Windows x64 安装包；`pulse-im-android-0.2.92-test.apk` 为安卓测试签名包。安卓补充修复了缓存键主线程开销和后台暂停自动续发，最终源码为 `bdd91fd`。Windows 包未配置代码签名证书；本批包未新增混淆/加壳，作者正式打包仍需按本文后续章节完成签名、Firebase 和加固验收。

**最新状态（2026-11-16 10:34，北京时间）：首批性能优化已上线，Go/后台应用为 `069169e`，发布目录 `/opt/pulse/releases/20261116-069169ed-performance`。媒体鉴权、停用头像响应、后台请求/媒体缓存和静态资源缓存已处理。175 项 Go、8 项并发检查、后台回归及 147 次生产 HTTPS 验收通过；客户端仍未重新打包。效果、回滚和未实施项见 [性能优化上线记录](PERFORMANCE-REVIEW-2026-11-16.md)。**

**后续状态更新（2026-11-16 09:12，北京时间）：作者 `51c066d` 的 Go 群成员目录/好友模糊搜索已审查并上线；173 项全量测试、6 项 race、69 次生产 HTTPS 验收通过。当前 Go 发布为 `/opt/pulse/releases/20261116-51c066d6-member-search`。管理员后台保持此前版本，数据库仍为 61；客户端本轮未重新打包。详见 [群成员搜索 Go 审查与上线记录](MEMBER-DIRECTORY-DEPLOYMENT-2026-11-16.md)。下文 00:20 批次的版本及“客户端暂停/待改”是该批次历史状态，作者后续客户端改动应结合 [客户端聊天修复记录](CLIENT-CHAT-FIXES-2026-11-16.md) 查看。**

**本次已上线 Go 后端、管理员后台及 IM 专用 Nginx 配置，并已推送 GitHub。PC、Android、iOS 和用户 Web 的后续改动按用户要求暂停；本次没有发布新客户端包，也没有把全部 18 项标为已解决。**

## 1. 本次上线了什么

### 1.1 管理员批量重置用户密码：已新增并上线

入口：**管理员后台 → 用户管理 → 勾选用户 → 批量重置密码**。

1. 勾选当前页的用户，一次 1—100 人；可调整分页大小。已删除用户不可选择，翻页或重新查询会清空选择，避免误操作。
2. 弹窗列出所选账号，输入统一新密码并再次确认。密码要求为 **8—128 字节**，中文通常每字占 3 字节。
3. 核对名单、勾选确认后提交。成功后这些用户使用新密码重新登录。
4. 修改密码、撤销旧登录会话、生成通知和写入审计在同一数据库事务内完成。失败不会出现一半账号改好、一半没改的结果。
5. 每个用户仍使用独立随机盐的 Argon2 密码校验值。密码不进入接口结果、审计明文或发布资料。
6. 相同提交可安全重试，只执行一次；用户后来又修改了密码，旧请求重试不会覆盖新密码，也不会踢掉后来重新登录的会话。
7. 只有具有用户管理写权限的管理员可操作，仍校验专属入口、管理员会话、CSRF 和当前权限。重置被冻结账号不会自动解冻它。

这项功能用于**管理员重置普通用户的登录密码**，不是批量修改后台管理员账号密码。已上线功能，未对现有真实用户执行批量改密；线上验收只操作专用测试账号。

### 1.2 Go 后端已修复

- **群资料状态缺失**：补充 `status: active`。旧客户端部分群主菜单、邀请操作会检查该字段，之前只有角色没有状态，合法操作可能被判为不可用。
- **定时禁言残留**：移出/重新邀请成员、转交群主、后台指定群主时，同时处理 `muted` 与 `muted_until`，避免界面显示解除但服务端仍按定时禁言限制。
- **普通成员模糊搜索**：Go 接口支持搜索其有权查看的群成员，匹配昵称、账号、公开 ID 和备注；`can_search` 与 `can_mention_all` 分离，普通成员不会因此取得 @ 全体或群管理权限。隐藏成员/频道等原有可见性规则仍生效。
- **媒体授权地址稳定**：同一登录会话、同一媒体复用随机授权地址。身份别名最长 24 小时且不超过登录有效期；实际访问许可仍为 120 秒，并在续期及每次读取时检查权限。
- **批量媒体授权提速**：从逐个媒体查询改为单次集合查询，减少大量图片和头像同时刷新时的数据库往返。
- **减少重复下载正文**：用户媒体和后台媒体增加会话隔离的 ETag，采用 `private, no-cache, must-revalidate`。允许缓存文件，但再次读取仍须经过服务器授权校验；校验通过且文件未变时返回 304。JSON、认证错误等仍使用 `no-store`。
- **桌面资源嵌入兼容**：有效短期媒体授权允许跨来源嵌入，解决桌面自定义页面来源受 `same-site` 资源策略阻拦的情况。需要 Bearer 的接口不因此变成公开接口。
- **批量建号规则修正**：恢复旧 PHP 已允许的 8—128 字节密码、1—999999999 起始编号和 1—100 数量；提供前缀、数量、范围、密码、账号重复的具体错误。
- **批量建号超时与重试**：请求和界面等待上限调整为 150 秒，保持原密码哈希强度；重复/并发重试不会重复建号。
- **分发时间预览与详情**：新增使用 Go 同一 Cron 解析器的预览接口，并让详情重新获取当前配置，避免展示列表中缓存的旧值。

### 1.3 管理员后台已修复

- 开关显示“已开启/已关闭”；禁言开关显示“已禁言/可发言”。
- 批量建号显示生成账号范围、字段规则和具体失败原因。
- 用户“更多”菜单新增独立“修改密码”；同时新增上述批量重置功能。
- 分发编辑、详情逐步显示 **年-月-日 时:分（北京时间）**，修改步骤延迟后同步更新，支持跨日。
- Cron 计划显示下一次执行时间，详情读取实时配置。
- 步骤时间按任务基准时间加累计延迟计算。它是计划时间；拥塞、重试或服务恢复可能导致实际执行更晚。

### 1.4 线上 Nginx 补漏

线上验收发现宿主机全局启用了 `proxy_cache cache_one`。IM 继承该设置后，媒体条件请求没有按预期进入 Go，虽然本地测试返回 304，线上仍返回 200 和图片正文。

已在 **IM 专用 `/etc/pulse/nginx/proxy.conf`** 显式设置：

```nginx
proxy_cache off;
proxy_set_header If-None-Match $http_if_none_match;
proxy_set_header If-Modified-Since $http_if_modified_since;
```

已通过 Nginx 配置检查并重新加载；线上复测得到 304 和零正文。其他站点的全局代理配置未改。

## 2. 18 项反馈逐项对应

“服务端部分完成”表示已补对应服务器能力或缺陷，不能据此宣称 PC/手机的具体界面问题已全部恢复。

| # | 原问题 | 本次后端 / 后台处理 | 尚未修改或待验收部分 |
| --- | --- | --- | --- |
| 1 | 通知、解除禁言开关状态不清晰 | **后台已改**明确状态文字；Go 修复永久/定时禁言状态不一致 | 用户端通知/解禁言控件的样式和显示联动待客户端阶段 |
| 2 | 群主成员右键菜单灰色不可用 | **服务端已修**群资料状态缺项，并处理群主变更时的禁言残留 | 仍需在原 PC 安装包和后续客户端修复包中逐项实测右键操作，不保证所有灰色项都由同一原因引起 |
| 3 | 后台强制加好友后，邀请候选不显示 | 后端回归确认强制好友关系会进入邀请候选；群状态缺项已修 | 客户端候选列表刷新、搜索、分页、缓存和最终邀请操作仍需验收 |
| 4 | PC/移动端群头像不显示 | **服务端部分完成**：稳定授权地址、批量鉴权、条件缓存、桌面资源嵌入 | 客户端默认头像、解码失败、过期授权重试及账号切换缓存仍需完成 |
| 5 | 普通群员输入 @ 和模糊搜索 | **后端已支持**可见成员模糊搜索，普通成员不能 @ 全体 | 旧 PC 适配器仍把 `can_search` 写成 `can_manage`，普通成员输入框开关须后续改客户端 |
| 6 | 群内搜索报“搜索结果或权限已变化” | **后端部分完成**：成员搜索与可见目录规则一致 | 旧 PC `/conversations/members` 适配器未透传 `q/page/search_scope` 等契约；该截图错误不能只更新服务器彻底解决 |
| 7 | 重进会话后图片一直加载 | **服务端部分完成**：稳定且可续期的地址、ETag 和 304 | 客户端重新进入会话后的加载状态、错误提示和点击重试待改 |
| 8 | 每发消息已有图片都重新加载 | **服务端部分完成**：减少授权 URL 变化和重复下载 | 客户端 DOM/列表节点重建、图片解码缓存、头像保留仍需修复与测量 |
| 9 | 手机不能发图 | 现有服务器上传和媒体处理链路回归、线上专用图片上传通过 | 手机相册/文件选择、生命周期回调、上传队列及发送状态需要客户端包验收；本次未发布手机包 |
| 10 | 收到群图片打断本地图片选择 | 本次没有改变选择器处理 | PC/移动端窗口、Activity/视图生命周期和新消息刷新逻辑待改 |
| 11 | 自己发消息后不滚到会话底部 | 本次没有改变客户端滚动行为 | PC/移动端列表定位、用户正在读历史时的交互规则待改 |
| 12 | 会话/历史空白，卡在校验权限 | 已有并发打开、历史权限边界回归通过；本次不取消成员权限校验 | 客户端取消请求、超时恢复、会话切换、历史游标和占位状态需要继续修复 |
| 13 | 闪屏、切换不流畅 | 媒体授权及重复下载的服务器部分优化已上线 | 页面/会话切换渲染、节点复用、解码、动画和滚动性能待客户端处理 |
| 14 | 关掉群发窗口任务停止 | 已提交到 Go 的发送队列独立持久化，回归证明 HTTP 返回后由新 worker 继续执行；后台分发本就由服务端执行 | 旧客户端若仍逐个提交目标，关窗后未提交的部分服务器无法继续；需把全部待发对象一次提交到队列并提供状态、取消入口 |
| 15 | 后台批量建号校验不明、提交失败 | **已修复并上线**；8 位密码建号、登录、重复提交和并发提交通过 | 后续按实际运营数据继续观察，不能把本次用例当作 10000 并发容量证明 |
| 16 | 分发任务/详情缺每步执行时间 | **已修复并上线**；累计延迟、跨日、保存再打开显示一致；Cron 由 Go 预览 | 计划时间与实际执行时间不同；此次没有声称补齐每一步真实完成时间的运营报表 |
| 17 | 用户管理缺查看密码/修改密码 | **单个修改与批量重置已上线**，旧会话失效，有权限/CSRF/审计/去重 | 原密码查看未恢复。旧 PHP 有加密密码库；当前 Go 只有单向密码校验值，不能从哈希还原原密码。后续若要恢复密码库需单独设计和评审 |
| 18 | 发布包缺混淆/加壳 | 本轮仅整理本文件的实施方法和验收要求 | **尚未实施、尚未生成加固包**。需在客户端功能修完后逐平台接入，不能把现有包称为已加固 |

## 3. 本次实际发布细节

| 项目 | 已核对的值 |
| --- | --- |
| GitHub 仓库 / 分支 | `dounaishushu/pulse-im` / `codex/go-rewrite` |
| 服务器与后台主要修复提交 | `b434c39771aa6934db00b36e53f50d0766d4683d` |
| 批量重置密码应用提交 | `fed9e4133c6ecd59a4e465570189ae7b4901ecb0` |
| Nginx 条件请求补丁提交 | `09e1579664a1420e38f8ab34af84f2d548f2a52c` |
| 服务切换完成时间 | **2026-11-16 00:20:04，北京时间** |
| 最后复核时间 | **2026-11-16 00:25:29，北京时间** |
| 当前服务器发布目录 | `/opt/pulse/releases/20261116-fed9e413-server`，由 `/opt/pulse/current` 指向 |
| 回滚所需旧发布目录 | `/opt/pulse/releases/20261115-13b83f1` |
| Go 镜像 | `sha256:c56adb1d5580b21f4600f8923a2f1e81c6d2ae1e1324d34503d9efb3a562d842` |
| Go 二进制 SHA-256 | `c3a44d4c2033bc78080a36392fc2856f13e65ef66041c4599ca36db8eb0ad9b2` |
| 数据库 schema | **61，本次未增加数据库迁移，也未重新导入旧 MySQL** |
| 服务状态 | ready、容器 healthy、restart count = 0 |
| 发布完整性 | **3117 个文件校验通过** |
| 后台静态资源 | **67 个文件经正式 HTTPS 逐个核对哈希通过**，包含首页和专属入口 |
| 切换耗时 | 约 8 秒的部署切换过程；不把这个数当作对所有用户准确测量的中断时长 |
| 复核时资源快照 | 容器 CPU 1.09%，内存 28.73 MiB；只是一次采样，不是容量压测结论 |
| 测试清理 | 共 6 个专用测试用户已停用、其有效会话为 0；专用测试管理员已停用；真实既有账号修改数为 0 |

Go/后台应用来自 `fed9e41`；Nginx 配置来自 `09e1579`，两者均已上线。后续仅文档/证据提交的 SHA 与正在运行的应用 SHA 不同是正常的。

数据库备份已完成并通过恢复流读取校验。服务器上的本次备份、部署记录和 Nginx 原配置保存在 `/root/pulse-im-migration/backend-admin-feedback-20261115/`；包含内部数据的文件不应上传 GitHub。旧发布目录保留。回滚应用前需核对当前 `/opt/pulse/current`、镜像与配置清单；若需要同时回滚代理配置，单独使用已备份的 `proxy-before.conf`，先 `nginx -t` 再 reload，不能只换应用后假定外部 Nginx 也回退。

## 4. 已完成的测试与验证边界

- **Go 最终全量：172 项通过、0 跳过、0 失败**；音视频用例使用真实 ffprobe 和素材。
- **并发检查**：媒体/会话等 7 项、批量密码重置 4 项分别通过 race 检查。
- **后台**：TypeScript 类型检查、正式构建通过；使用构建文件连接隔离 Go，3 组浏览器工作流通过，覆盖用户、群组、媒体、题库、作业、分发及权限。
- **额外实际操作**：7 字节密码拒绝、8 字节密码批量建号成功；单个改密后新密码可登录、旧密码拒绝；勾选 2 人批量重置后均可用新密码登录，旧会话失效；跨日步骤时间保存后重开一致。
- **线上 HTTPS**：专用账号完成批量建号、批量改密、重试不影响新会话、群主状态、普通成员搜索、图片上传、稳定媒体授权、零正文 304、注销后媒体拒绝、后台分发时间预览。
- 线上条件请求第一次失败促成了本次 Nginx 补丁；修正后再次通过。另一次验收脚本对 `ETag` 大小写取值不兼容已修正，属于验收工具问题。
- 这些结果不代表 PC/安卓/iOS 的 18 项界面行为已全部实机验收，也不代表高峰容量或公网用户端时延已压测完成。

可机读证据位于：

- `docs/evidence/backend-admin-feedback-production-2026-11-16.json`
- `docs/evidence/backend-admin-feedback-tests-2026-11-16.json`

## 5. 后续客户端应按什么顺序继续

1. **PC 优先**：修成员列表搜索契约、普通群员 @ 开关、群主菜单/邀请列表真实 UI 回归；完善稳定媒体身份、头像节点保留、图片重进恢复及自动滚底。
2. **Android**：同步稳定媒体缓存、选图与新消息不互相打断、后台/前台切换、登录过期和批量上传队列；至少在真实手机和模拟器各验一次。
3. **iOS**：同类授权缓存、会话/历史、选图生命周期与 @ 搜索源码修复；由作者在 Mac/Xcode 和 iPhone 验收，本轮不打 IPA。
4. **群发**：把完整任务和目标持久化到服务器，界面关闭后只停止观看进度；暂停/取消必须调用明确的服务端控制接口。
5. 上述功能通过后再接入混淆/加固；最后对**加固后的最终安装包**重跑核心用例。

本机曾有 PC 2.4.160、Android 0.2.88 的未完成缓存修复草稿；**它们未纳入本次 push、未部署、未发布为可交付的新包**。不能直接从带有这些未提交改动的工作目录打包交给用户。

## 6. 作者打包前必须知道的现状

### 6.1 已发布的包与缺少的资料

截至本文件写作时，GitHub 实际最新相关发布为 **PC `pc-v2.4.159`、Android `android-v0.2.87`（versionCode 89）**。PC 2.4.159 发布附带 Android 0.2.87。仓库历史交接文档部分段落仍写 2.4.158/0.2.86，版本判断以本节与实际 Release 为准。

| 平台 | 当前实际情况 | 后续正式打包仍需提供 |
| --- | --- | --- |
| Windows PC | Electron + NSIS；现有包未做 Authenticode 代码签名 | 作者的有效代码签名证书或签名服务；发布凭据受控注入 |
| Android | 现有 0.2.87 是**调试签名验收包**，不是作者正式签名包 | 原 `.jks/.keystore`、别名和密码；匹配包名的 `google-services.json`；真实离线推送验收 |
| iOS | 仅源码与部分 Foundation/语法验证，没有完整 Apple 工程/设备验收 | Mac、Xcode、Apple Team、证书/描述文件、APNs 材料及真实 iPhone 验收 |

“本次未取得”不表示作者其他机器一定没有；应由作者找回和长期保管。不要每次发布新建 Android 签名，否则不能保证覆盖原安装包。

### 6.2 正式地址与版本

```text
Go API:       https://api.imapi.shop/api/v2
Go WebSocket: wss://api.imapi.shop/api/v2/realtime
Android applicationId: com.pulseim.android
源码分支: codex/go-rewrite
```

- 最终包内配置须核对，不只看构建环境变量。不能带入 `localhost`、`10.0.2.2`、测试端口、`example.com`、旧 `/api` 或旧 `/ws`。
- 从干净检出的、已完成客户端验收的提交构建。先保存/移交未提交草稿；不要使用 `reset --hard` 丢掉它们。
- PC 同时递增 `package.json` 与锁文件版本；Android 的 `versionCode` 必须高于要覆盖的已安装包，并核对证书。
- 每个包对应唯一源码提交、构建参数和 SHA-256。不要覆盖同名同版本安装包。
- GitHub Release 不会自动改变客户端升级提示；后台升级配置、下载链接和是否强更须单独核对。

### 6.3 Windows 构建与签名

当前源码锁定 Node 要求 `>=22.12.0`、Electron `43.8.10`、electron-builder `26.18.0`。保持锁文件。

```powershell
# 在干净且完成客户端修复验收的检出目录执行
$env:PULSE_API_URL = 'https://api.imapi.shop/api/v2'
$env:PULSE_WS_URL = 'wss://api.imapi.shop/api/v2/realtime'
npm --prefix pc ci
npm --prefix pc run check
npm --prefix pc run dist -- --publish never
```

每一步非零退出码应停止发布。`predist` 生成正式运行配置；`dist:local` 是本地预览，不是用户正式包。

当前 `win.signAndEditExecutable: false`，所以仅配置证书环境变量并不等于真正签名。作者安全注入证书/签名服务后需启用签名、失败即中止，例如：

```powershell
npm --prefix pc run dist -- --publish never `
  --config.win.signAndEditExecutable=true `
  --config.forceCodeSigning=true

# 文件名替换为本次实际版本，分别查安装器与主程序
Get-AuthenticodeSignature -LiteralPath 'pc/dist/本次安装程序.exe'
Get-AuthenticodeSignature -LiteralPath 'pc/dist/win-unpacked/小猿口算.exe'
Get-FileHash -LiteralPath 'pc/dist/本次安装程序.exe' -Algorithm SHA256
```

EXE 的资源编辑、fuse、混淆/加固必须发生在最终签名之前。修改已签名 EXE 会使签名校验不再代表修改后的内容；修改包后要重新按发布流程签名并验收。

### 6.4 Android 构建与签名

当前工程为 AGP `8.7.3`、Kotlin `2.0.21`、Gradle Wrapper `8.10.2`、JDK 17、compile/target SDK 35、min SDK 26。本轮不顺便升级工具链。

```powershell
$env:PULSE_API_URL = 'https://api.imapi.shop/api/v2'
$env:PULSE_WS_URL = 'wss://api.imapi.shop/api/v2/realtime'
$env:PULSE_BACKEND_PROTOCOL = 'go-v2'
$env:PULSE_SIGNING_STORE = 'C:/private-signing/作者的原签名.jks'
$env:PULSE_SIGNING_ALIAS = '作者的实际别名'
# PULSE_SIGNING_PASSWORD / PULSE_SIGNING_KEY_PASSWORD 通过受控输入或 CI Secrets 注入

.\android\gradlew.bat -p .\android :app:verifyProductionConfig
.\android\gradlew.bat -p .\android :app:assembleRelease
# 如需商店 AAB：:app:bundleRelease
```

`verifyProductionConfig` 当前会检查签名和 FCM。缺 `google-services.json` 或原签名时，不能靠删除门禁、改名 debug APK、虚填 Firebase 信息来宣布正式包完成。若决定正式产品不提供 FCM，需要单独设计并验收该发布配置。

构建完成后使用 SDK Build Tools 的 `apksigner verify --verbose --print-certs <最终.apk>` 检查最终证书，并测试覆盖旧包升级。FCM 客户端 JSON 与服务端服务账号私钥是不同材料；服务账号私钥不能放入 APK 或 GitHub。

### 6.5 iOS

由作者在自己的 Mac/Xcode 上使用 Release/Archive，配置 Team、Bundle ID、签名和正式 API/WSS；当前 Release 工程仍有模板地址，必须在发布配置中替换并检查归档实际内容。

本轮不生成 IPA，也没有承诺 iPhone 真机通过。最终发布须验证 APNs、通知权限、相册权限、后台切换、图片和会话恢复，并保留与归档对应的 dSYM。

## 7. 代码混淆、加壳与加固的方法

**下面是后续实施方案，不是本轮已经落地的功能。** 代码压缩/混淆主要增加阅读成本；ASAR 打包不是加密；完整性校验和代码签名关注篡改/来源。任何随客户端运行的代码与数据都不能承诺绝对无法分析，密码和决定权限的业务逻辑应继续由服务端控制。

### 7.1 PC：优先“发布目录混淆 + ASAR + fuse + 代码签名”

建议流水线：

```text
干净源码 → 客户端功能测试 → 生成发布暂存目录 → JS 压缩/混淆
→ Electron/ASAR 打包 → 资源编辑与 fuse → 最终代码签名
→ 实际安装并回归 → 生成哈希与 GitHub Release
```

**JS 混淆：**可评估开源 `javascript-obfuscator`，固定版本到 devDependencies/锁文件。只处理自己的发布暂存副本，保留原源码；先覆盖 renderer 的业务文件，再逐项评估 main/preload，不批量混淆 Electron、第三方依赖和原生模块。

可从保守配置开始（示例，尚未接入本项目）：

```json
{
  "compact": true,
  "identifierNamesGenerator": "hexadecimal",
  "renameGlobals": false,
  "renameProperties": false,
  "controlFlowFlattening": false,
  "deadCodeInjection": false,
  "debugProtection": false,
  "selfDefending": false,
  "stringArray": false,
  "sourceMap": false
}
```

处理规则：

- IPC channel、`contextBridge` 方法、跨文件全局 API、JSON 字段、DOM 属性和反射使用的名称属于接口契约，不可随意改名。
- 本项目已有图片/切换性能问题，先避免控制流扁平化、死代码注入、反调试轮询等高开销选项；实测启动、收发和大图后再逐项调节。
- 需要 source map 排错时单独保存在私有构建产物中，与源码提交对应，不能把可还原源码的 map 放进公开包。
- 不为混淆而放宽 CSP 到不受限的 `unsafe-eval`，不打开 renderer 的 Node 权限。

**ASAR 与 fuse：**当前安装的 electron-builder 配置 schema 支持 `electronFuses`。可在后续受控分支增加如下构建配置；需与现有品牌资源编辑 hook 一起实测，不能直接宣称开启配置等于已通过完整性验收。

```json
{
  "asar": true,
  "electronFuses": {
    "runAsNode": false,
    "enableNodeOptionsEnvironmentVariable": false,
    "enableNodeCliInspectArguments": false,
    "enableEmbeddedAsarIntegrityValidation": true,
    "onlyLoadAppFromAsar": true
  }
}
```

确认最终 Electron 二进制确实包含这些 fuse 状态，ASAR 完整性元数据已生成；对完整性校验、只从 ASAR 加载以及现有截图/子进程功能做负面和正常用例验证。完整性校验不能阻止别人读取 ASAR，不能把它描述为源码加密。

**是否使用传统 EXE 壳：**本项目主要业务是 Electron JS，仅给 EXE 套壳不能自动保护 `app.asar`。如作者有合适的原生加固产品，需要以最终包验证启动、Chromium 多进程、IPC、截图、剪贴板、WebSocket、杀毒软件、签名与升级；当前没有选型或实测某款商业壳，不建议直接把未验证壳引入用户包。先完成上述 JS/ASAR/签名方案，再决定是否有必要增加外壳。

### 7.2 Android：先启用 R8，再评估 APK 加固平台

当前 `release` 未显式开启 `isMinifyEnabled` / `isShrinkResources`。后续可在 `android/app/build.gradle.kts` 的 Release 配置中接入：

```kotlin
release {
    isMinifyEnabled = true
    isShrinkResources = true
    proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro"
    )
    // 保留原生产签名、正式地址和 verifyProductionConfig
}
```

- 在 `proguard-rules.pro` 中依据实际反射、JNI、序列化、第三方 SDK 的官方要求添加最小 keep 规则；不要用 `-keep class ** { *; }` 保住全部代码后又宣称已混淆。
- 优先验证登录/二步校验、消息模型、媒体上传、后台任务、Firebase、扫码、文件选择和权限回调；debug 包通过不能证明 R8 后的 release 包通过。
- 私有保存与每个发布版本匹配的 `mapping.txt`，用于 ReTrace/线上堆栈还原，不作为公开 Release 附件。
- 如还需“加壳”，可选择支持当前 Android/ABI/发布渠道的 APK 加固平台。先用不含签名私钥的受控产物评估：Dex 保护、资源保护、完整性校验、兼容性和报告。作者需核对服务的数据处理、签名方式与授权；本轮没有上传代码/包给任何加固厂商。
- 一般顺序为 **Release + R8 → 加固 → 对最终输出对齐/签名 → 验签 → 安装与覆盖升级测试**；如果平台已负责其中某步骤，以它的有效输出规范为准，不能在签名后再随意改包。
- APK 与 AAB/Play App Signing 的流程不同，不要默认“给 APK 加固”可直接用于 AAB。最终证书必须与用户安装及发布渠道要求匹配。
- 不把“检测到模拟器就退出”作为本项目的默认加固方案：作者明确使用模拟器验收图片功能，必须保留可测试路径。

### 7.3 iOS：Release 优化、符号与静态保护

iOS 不适合直接照搬 Windows EXE 壳或 Android Dex 壳。先完成原生 Release 构建、编译优化、无用代码移除和符号处理，保留私有 dSYM；配置项以当前 Xcode 的 Build Settings 为准，例如审核 `SWIFT_OPTIMIZATION_LEVEL`、`SWIFT_COMPILATION_MODE`、`DEAD_CODE_STRIPPING`、`STRIP_INSTALLED_PRODUCT` 和 `DEBUG_INFORMATION_FORMAT`。

如作者后续选用 Swift/LLVM 混淆器，应在受控分支先验证 `@objc`、动态查找、Codable、系统回调、推送、持久化模型及反射名字，保证最终 Archive 可签名、可安装并符合分发渠道要求。不要为“加壳”在运行时下载/替换可执行代码，也不要把服务端私钥或可复用管理员凭据藏在字符串混淆里。

### 7.4 每次加固后的发布验收

| 检查 | 必须验证的最终产物行为 |
| --- | --- |
| 安装与升级 | Windows 安装/启动/卸载；Android 原证书覆盖升级；iOS Archive/实际安装 |
| 身份 | 新登录、失效登录恢复、管理员改密后的被动下线、多账号隔离 |
| 群组 | 群主菜单、邀请、普通成员 @、搜索、禁言和解除 |
| 媒体 | 图片/头像首次加载、重进、发送新消息不重载旧图、选图不中断、失败重试 |
| 历史与滚动 | 打开会话、上翻、断网恢复、自己发送后定位底部 |
| 队列 | 连发顺序、重试去重、关窗口后服务端任务继续、明确取消 |
| 平台集成 | PC 截图/剪贴板/子窗口；Android 相册/权限/FCM；iOS 相册/APNs/后台切换 |
| 性能与兼容 | 与未混淆版本比较启动、切换、收图、CPU/内存；至少包含真实设备和作者使用的模拟器 |
| 可追溯性 | 源码 SHA、工具版本、保护配置、最终证书、SHA-256、私有 mapping/dSYM/source map 归档 |

混淆后的最终 EXE/APK/IPA 才是验收对象，不能用未混淆的开发运行结果替代。

## 8. 参考资料与交接边界

项目配置依据本次已提交源码和实际构建：`pc/package.json`、`pc/brand-executable.cjs`、`android/app/build.gradle.kts`、`android/build.gradle.kts`、iOS 工程以及当前安装的 electron-builder schema。平台工具继续更新，实施时核对所锁定版本的说明。

官方/项目原始资料：

- Electron ASAR Integrity：`https://www.electronjs.org/docs/latest/tutorial/asar-integrity`
- Electron Fuses：`https://www.electronjs.org/docs/latest/tutorial/fuses`
- electron-builder 配置：`https://www.electron.build/configuration.html`
- javascript-obfuscator 项目与选项：`https://github.com/javascript-obfuscator/javascript-obfuscator`
- Android 代码/资源优化：`https://developer.android.com/topic/performance/app-optimization/enable-app-optimization`
- Android 签名：`https://developer.android.com/studio/publish/app-signing`
- Apple Xcode Build Settings：`https://developer.apple.com/documentation/xcode/build-settings-reference`
- Apple App Review Guidelines：`https://developer.apple.com/app-store/review/guidelines/`

本文件不包含服务器密码、测试账号口令、签名私钥或数据库备份。后续客户端打包无需重新迁移旧库、清空 PostgreSQL 或批量重置真实用户。需要继续处理的项目在第 2、5、7 节逐条保留，不应把它们从验收清单中删除。
