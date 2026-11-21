# PC 迁移验收记录 · 2026 年 11 月 21 日

本轮继续验收 Pulse IM 的 Tauri 2.4.199 Windows 候选。基准是已发 Electron 2.4.182、2.4.192 安装包内的实际代码，以及目标分支 `codex/go-rewrite` 的 `4e294f0`。功能表中的 84 项均更新了新版落点、已有证据和待核事项。68 项已有实现和本地验收记录，16 项仍有迁移或对照缺口。全量发布验收未结束。[逐项验收表](PC-TAURI-PARITY.csv)

## 本轮确认的行为

| 项目 | 实测结果 |
| --- | --- |
| 覆盖、回退和重装 | 两个 Windows 11 Tauri 测试包在同一测试档案来回安装。每次均恢复原会话，已导入的输入和输出音量继续生效。[原生实测](../.local/pc-tauri-20261120/windows-candidate-rollback-acceptance.json) |
| 旧版设置 | 从两个已发包的实际渲染代码操作设置导出。Windows 候选从原生文件选择器分别导入，群组媒体上限、视频开关和输入输出音量与旧设置一致。重启保留。[旧界面记录](../.local/pc-tauri-20261120/legacy-packaged-renderer-acceptance.json) · [Windows 导入记录](../.local/pc-tauri-20261120/windows-legacy-settings-migration-acceptance.json) |
| 旧版待发消息 | 在两个旧版渲染代码中各造一条待发消息。迁移版 2.4.194 读取同一浏览器档案里的加密待发数据并导出。Windows 候选导入后待确认，重复导入不增加记录。回退与重装后确认发送，两条消息在接收端各出现一次，原请求编号保持一致。[旧存储验证](../.local/pc-tauri-20261120/legacy-queue-format-bridge-acceptance.json) · [发送记录](../.local/pc-tauri-20261120/windows-old-queue-delivery-acceptance.json) |
| 多账号、锁屏和隐私 | Windows 同窗添加账号、失效后重登、退出后返回仍登录的另一个账号已验证。锁屏拒绝错误密码。在线状态按授权显示，隐藏后会话列表圆点和最近上线时间均移除。共用界面通过 18 项账号回归，验证两步校验和恢复码一次性使用。普通用户只提交允许修改的隐私字段。[Windows 账号](../.local/pc-tauri-20261120/windows-account-revocation-roundtrip.json) · [锁屏](../.local/pc-tauri-20261120/windows-lock-acceptance.json) · [在线隐私](../.local/pc-tauri-20261120/windows-presence-acceptance.json) · [共用界面安全](../.local/pc-tauri-20261120/shared-security-acceptance.json) |
| 群发 | 恢复好友备注搜索、好友和群组选择及图片视频入口。实际 Windows 包选一张 PNG 和文字创建任务，关闭后重新打开显示已完成，接收端收到一张图片和一条文字。[Windows 群发结果](../.local/pc-tauri-20261120/windows-broadcast-acceptance.json) |
| 群管理和历史 | 隔离 Go 结合共用界面验证群主和普通成员入口差异、邀请搜索、群通知来回切换、归档和恢复、会话分组、引用存储与上翻历史。350 人合成群验证首屏、分页和连续搜索，共用界面搜索样本 11 次，P50 为 70 毫秒，P95 为 108 毫秒。在 Windows 候选上连续八次搜索均查到目标，UI Automation 按钮调用约占两秒，不用这组数字衡量用户体感。[群和历史](../.local/pc-tauri-20261120/acceptance-shared-chat-group.json) · [工作台操作](../.local/pc-tauri-20261120/shared-workspace-actions-acceptance.json) · [分页测试](../.local/pc-tauri-20261120/shared-large-roster-acceptance.json) · [Windows 群成员](../.local/pc-tauri-20261120/windows-large-roster-acceptance.json) |
| 图片发送 | 恢复同批图片最多两项同时上传，在聊天内按选图顺序提交。延迟第一张图的请求时，第二张先启动，接收端仍按正确顺序收到两条消息。[图片队列](../.local/pc-tauri-20261120/shared-batch-image-order-acceptance.json) |

## 追加验收结果

| 项目 | 操作与结果 |
| --- | --- |
| 群成员搜索 | Windows 2.4.199 实测 350 人测试群，输入框与搜索按钮同一行、匹配成员可见，Esc 关闭后焦点回到搜索按钮。Web 在 1280 与 1090 像素窗口测到 4 像素间距，输入框和按钮共用边框。[Windows](../.local/pc-tauri-20261120/windows-member-search-current.json) · [Web 截图](../.local/pc-tauri-20261120/web-member-search-current.png) |
| 联系人资料 | Windows 内部账号展开六项登录及注册信息。复制的账号和公开 ID 与隔离 Go 返回值一致。普通账号仍能看公开资料、共同群组和私聊入口，明细入口隐藏。[内部账号](../.local/pc-tauri-20261120/windows-contact-profile-internal.json) · [普通账号](../.local/pc-tauri-20261120/windows-contact-profile-ordinary.json) |
| 超过 100 个接收者的群发 | 新版从 Go 取得单任务上限 900，使用一次汇总请求显示状态。Windows 实际选择 105 个测试群，关闭群发界面后进度继续，重新打开显示 105/105。隔离库核对 105 个不同群和 105 个不同请求编号，重复提交和取消保留已发数在 Go 集成通过。[Windows 和落库](../.local/pc-tauri-20261120/windows-large-broadcast-acceptance.json) · [Go 用例](../.local/pc-tauri-20261120/go-large-broadcast-contract-acceptance.log) |
| 断线、慢媒体与 429 | Windows 实际停止隔离 Go，输入文字，恢复后消息只落库一次，断线提示随同步成功消失。共用 Vue 在 Chrome 同时挂起媒体请求并给文字请求返回一次 429，按两秒 Retry-After 重试，仍在媒体等待期间送达。客户端保留原请求编号。[Windows](../.local/pc-tauri-20261120/windows-network-recovery-current.json) · [Chrome](../.local/pc-tauri-20261120/shared-weak-network-media-acceptance.json) |
| 已记账号与下载迁移 | 新版 Windows 记住两个测试账号，重启后移除其中一个，另一个可直接登录。旧备份中保存的下载目录能打开原生文件夹选择器，取消可重新选择，确认后立即更新目录和询问开关，重启保留。[记住账号](../.local/pc-tauri-20261120/windows-saved-signins-current.json) · [下载恢复](../.local/pc-tauri-20261120/windows-legacy-download-location-acceptance.json) · [重启](../.local/pc-tauri-20261120/windows-legacy-download-after-restart.json) |
| 录音与播放 | Windows 首次授权的等待提示和拒绝后的中文反馈经窗口实测。共用 Vue 在 Chrome 使用测试音源完成录音、试听、WAV 发送和播放，对端历史可读。物理麦克风、设备切换和旧格式 Windows 播放仍待验。[录音和回放](../.local/pc-tauri-20261120/shared-voice-capture-acceptance.json) |
| 托盘、跨端消息和缓存 | Windows 关闭窗口后常驻。普通再次启动会在同进程打开独立窗口，启动指令会恢复原窗口。同一个隔离 Go 下，Windows 和 Android 模拟器在各自界面收发成功，每方向只出现一次。Windows 原生清缓存后账号、草稿和已下载文件哈希保留。[常驻](../.local/pc-tauri-20261120/windows-tray-resident-acceptance.json) · [Windows 跨端](../.local/pc-tauri-20261120/windows-cross-device-ui.json) · [Android 跨端](../.local/pc-tauri-20261120/android-cross-device-evidence.log) · [缓存](../.local/pc-tauri-20261120/windows-local-cache-acceptance.json) |
| 附件编辑和下载 | 在 Windows 实际选择文件，先退格删文字，再删附件卡片。重新发送后，双方卡片均显示文件名、类型和大小。接收方下载到迁移过来的目录，字节校验一致。[收发与下载](../.local/pc-tauri-20261120/windows-attachment-card-roundtrip.json) |
| 会话切换和历史 | 最新 Windows 安装包在群聊读到合成数据最早一页，之后在群聊和私聊往返五轮，群聊历史和私聊的文件卡始终可见。在 820 像素窄窗仍能从顶部打开带标签的群资料，放宽后右栏恢复。[切换与历史](../.local/pc-tauri-20261120/windows-history-switch-current.json) · [窄窗](../.local/pc-tauri-20261120/windows-narrow-layout-acceptance.json) |
| 群管理、@ 和名片 | Windows 群成员行先打开操作菜单。普通群员能进入好友验证及私聊，群主能升降管理员、设置两分钟禁言并解除，Go 确认状态。共用 Vue 实测普通群员用昵称片段 @ 到正确账号，接收方能通过名片打开联系人资料。[成员菜单](../.local/pc-tauri-20261120/windows-member-menu-current.json) · [禁言解除](../.local/pc-tauri-20261120/windows-member-mute-current.json) · [@ 与名片](../.local/pc-tauri-20261120/shared-mention-and-card-acceptance.json) |
| 好友申请和黑名单 | Windows 实际发送、收到和接受好友验证，再拉黑并解除。修复黑名单的重复通用名称，已知好友的显示名可搜索。解除后从 Go 核对对应记录消失。[好友验证](../.local/pc-tauri-20261120/windows-contact-lifecycle-current.json) · [黑名单](../.local/pc-tauri-20261120/windows-blacklist-labels-current.json) |
| 最小化、锁屏通知及抖动 | 最小化实际收到桌面通知，两个测试账号同时在线时，锁屏期间没有弹出后台账号的新消息内容，解锁后消息可查。Windows 录下聊天区域有位移并回到原位。[最小化](../.local/pc-tauri-20261120/windows-minimized-notice-current.json) · [锁屏](../.local/pc-tauri-20261120/windows-lock-notice-acceptance.json) · [抖动](../.local/pc-tauri-20261120/windows-chat-shake-current.json) |

Web 与 Windows 隔离包构建通过，客户端 211 项、Web 多账号 18 项和 Go 22 个顶层集成用例通过。Go 用独立 PostgreSQL 数据库和 Redis 测试前缀。不同批次的 Windows 证据保留各自程序摘要。[客户端](../.local/pc-tauri-20261120/client-functional-acceptance-current.log) · [多账号](../.local/pc-tauri-20261120/web-recovery-accounts-retry.log) · [Go](../.local/pc-tauri-20261120/go-functional-acceptance-current.log)

## 发布前尚需完成

本轮优先验收用户功能，快捷键的完整矩阵后移。

- 旧 Electron 正式安装版到 Tauri 的覆盖升级与回退需要在能启动旧包的 Windows 测试机演练，覆盖已记账号、下载目录、旧磁盘缓存和卸载范围。本机可运行两个旧包解出的实际渲染代码，并可在两个 Tauri 包之间覆盖、回退和重装。自动审批审查拒绝了启动旧 Electron 的操作，给出的原因是 `blocked by policy`。
- 当前迁移支持旧设置、下载目录、窗口组、草稿及待发数据。旧记住的密码需在新版首次输入，旧原生代理设置和旧媒体缓存仍需逐项对照。两版旧 Go 包的持久聊天历史应以服务端和实际旧档案为准，旧客户端源码中的本地持久历史存在于 PHP 模式。
- Windows 物理麦克风、混合 DPI、多独立窗口组的通知与静音、实际休眠恢复仍需补证。慢媒体与 429 的组合已在共用 Vue 验证，原生 Windows 目前验证的是断线恢复、关小窗托管待发和代理媒体独立通道。[逐项清单](PC-TAURI-PARITY.csv)

当前可安装测试包为 2.4.199，独立标识 `com.pulseim.desktop.migrationqa`，用于本机隔离 Go。安装包 SHA-256 为 `ba8afa4dbc28c4aae97a7f9cc77542d51504059cbbb402b9bf3bd25cf9f36982`。版本留在本地验收，推送和上线待完整验收。[Windows 验收安装包](../.local/pc-tauri-20261120/pulse-im-windows-functional-qa-2.4.199-x64-setup.exe) · [当前安装记录](../.local/pc-tauri-20261120/windows-functional-candidate-install.json)

## Windows x64 双包交付 · 2.4.199

- 安装版 `Pulse-IM-2.4.199-windows-x64-setup.exe`，SHA-256 `2591fe3321047ebec8df6b5ee326274abf19683a23689c3631515fc4ecc46289`。从实际安装生成的开始菜单快捷方式启动，正常出现登录界面。
- 便携版 `Pulse-IM-2.4.199-windows-x64-portable.exe`，SHA-256 `86db2c00a84a98754e59f8cb4429c5ff3f404de665bb9d1bd878808663d29469`。在只有一个 EXE 的测试目录启动，正常出现登录界面并在相邻的 `PulseIM-Data/` 下生成 WebView2 数据。
- 两版应用均实测为 Windows x64 GUI 程序，启动监测期间未出现控制台窗口。两份交付文件本次没有 Authenticode 签名。
- 联系人资料页进入私聊、频道创建后显示简介、用邀请码关注频道和订阅者只读均在共用 Vue 界面与隔离 Go 上复验。群组的创建、改名和公告、禁言和解除、普通成员退出与群主解散也已复验。这些是隔离环境的功能结果。最终两份成品已验证冷启动，旧 Electron 正式包的原位升级及旧密码、完整历史和媒体缓存迁移仍待验收。快捷键按本轮要求后移。

本轮另从独立的 Windows Tauri 测试构建连接本机隔离 Go。实际操作登录、打开联系人资料后进入私聊、创建频道、从资料页读取已保存的频道简介均通过。最终两个交付成品使用正式端点，启动复验止于登录页。

源码位于 `codex/pc-tauri` 分支。生成这两个包的源码提交为 `ed7afbd52b699f2e271db8e4774c29158c698408`。旧版 `pc/` 的原有文件均保留。构建命令见 [Tauri 目录说明](../pc-tauri/README.md)。
