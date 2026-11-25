# Pulse IM Android — Codex 工作约定

> 本文件放在仓库根目录（`E:\多窗口项目\IM开发\go-rewrite\AGENTS.md`），Codex 每次会话自动读取。
> **同一时间只启用一个阶段**。默认启用 `P0`，附录 A/B/C 为后续阶段，未启用前不要执行。

---

## 0. 仓库与构建

| 项 | 值 |
|---|---|
| 根目录 | `E:\多窗口项目\IM开发\go-rewrite` |
| Android 工程 | `android/`（AGP 8.7.3、Kotlin 2.0.21、JDK 17、minSdk 26、targetSdk 35、versionCode 119） |
| 包名 | `com.pulseim.android` |
| 构建 | `gradlew.bat :app:assembleDebug` |
| 单测 | `gradlew.bat :app:testDebugUnitTest` |
| 后端 | `server/`（Go），**本仓库所有任务禁止修改** |
| 现有依赖 | androidx.core 1.13.1、okhttp 4.12.0、zxing 3.5.3 + embedded 4.3.0、pinyin4j 2.5.1、firebase-messaging（条件） |

允许新增的依赖：**仅** `testImplementation("junit:junit:4.13.2")`。
其他任何依赖都必须先说明理由并等待人工确认。

---

## 1. 硬性约束（违反任何一条即视为失败）

1. **不改协议**：HTTP 路径、请求体字段、`request_id` 生成规则（`android-text-<uuid>`）、WebSocket 包类型，一律不动。
2. **不改加密与持久化语义**：`LocalAccountStore`、`OutboxAttachments`、`LocalChatStore` 的 AAD / ticket / epoch / 事务边界保持现状，除非任务明确要求。
3. **不做大规模重构**：不改类名、不拆 `MainActivity`、不引入协程 / ViewModel / Room / RecyclerView（除非当阶段明确要求）。
4. **不改交互与文案**：UI 中文文案、按钮位置、状态提示保持原样。
5. **每个缺陷必须留下 JVM 单测**：`android/app/src/test/java/com/pulseim/android/`。
   `TextSendQueue.java`、`DurableMediaOutbox.java` 是纯 Java（无 `android.*` import），
   测试必须能在 JVM 直接跑，**禁止引入 Robolectric**。
6. **不顺手优化**：发现的其他问题写进报告第 6 节"发现但未修改"，不要动代码。
7. **不改构建配置**：`build.gradle.kts`、`AndroidManifest.xml` 除加测试依赖外不动。
8. **禁止**：`Thread.sleep` 修时序、整体放宽 `fail` 语义、吞异常、删除/重命名现有类与方法。

---

## 2. 工作流程

1. 先读本文件 + 任务涉及的文件，输出 **执行计划**，等待确认。
2. 确认后按"一个缺陷一个 commit"推进，commit message 格式：
   `fix(outbox): 队头失败不再阻塞同会话后续消息`
3. 每步跑验证命令，贴真实输出。**未通过单测的代码不得提交**。
4. 报告严格按第 5 节输出格式。

若本地缺 Android SDK 导致 `assembleDebug` 失败：可跳过 build，但**单测必须真跑**，
并在报告中标注"未验证 assemble"。

---

## 3. 阶段索引

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 修复 4 个确定性缺陷（失败阻塞、误判失败、媒体阻塞、同步探活） | 已完成 |
| **P1** | 消息列表迁移到 RecyclerView | **当前启用（用户已确认新增 RecyclerView 依赖）** |
| P2 | 状态收敛到 ViewModel + StateFlow | 附录 B，未启用 |
| P3 | outbox 落 Room（单行 upsert） | 附录 C，未启用 |

---

## 4. 当前任务：P1 —— 消息列表迁移到 RecyclerView

当前执行附录 A 全部要求。用户已确认新增 `androidx.recyclerview:recyclerview:1.4.0` 及必要传递依赖；允许加入默认 false 的 CHAT_V2 构建开关。以下 P0 记录仅作历史依据，发送和 outbox 代码不再修改。

P1 续推进度（2026-11-25）：已补充性能门槛自动验收及 15 项 JVM 测试，总计 57 项 JVM 测试通过。
宿主 GPU 模拟器三轮 p99 为 13 / 24 / 13ms，仍未稳定满足 <16ms；失败轮次必须使探针返回失败，不能仅以采集成功判定达标。
`CHAT_V2` 继续默认 false，P1 保持性能验收待完成，P2/P3 未启用。详细记录见 `docs/ANDROID-P1-ACCEPTANCE-2026-11-25.md`。

P1 再续推进度（2026-11-25）：修复多选模式下勾选单条消息仍刷新全部消息的问题，实测单次通知由 205 行降为 1 行，重复状态为 0 行。
新增 12 项 JVM 回归，总计 69 项通过；群聊/私聊 20 项功能检查通过，旧路径像素与基准一致。
本轮模拟器三轮 p99 为 12 / 23 / 12ms，仍有失败轮次；默认关闭新列表，继续等待真机性能验收，P2/P3 未启用。

P1 下一轮进度（2026-11-25）：复现并修复复用群聊行的发送者名称未随元数据更新的问题，保留本机备注优先级并更新备用昵称，不重建消息内容。
新增 10 项 JVM 回归，总计 79 项通过；三轮各 22 项功能检查通过，旧路径 4 项回归及像素对比通过。
三轮 p99 为 28 / 15 / 12ms；失败轮次图形缓冲等待最大 37.04ms、主线程布局最大 1.11ms。仍无已连接真机，CHAT_V2 默认 false，P2/P3 未启用。

P1 绑定续推（2026-11-25）：修复状态更新重复写入正文和时间的问题。设备回归由含 @ 正文 2 次写入、时间 1 次写入降为均 0 次；正文/时间实际改变时各只写 1 次，行与内容实例、阅读锚点保留。
新增 12 项 JVM 回归，总计 91 项通过；三轮各 26 项功能检查及旧路径 4 项回归、像素对比通过。
本轮模拟器三轮 p99 为 13 / 11 / 12ms，卡顿率均 0.1661%，全部达到门槛。真机复核未完成，CHAT_V2 仍默认 false，P2/P3 未启用。

P1 真机复核（2026-11-25）：OPPO PEXM00、Android 12/API 31、1080×2400、60Hz；保留手机原有 408dpi 显示密度，省电模式开启、电量约 19%。三轮各 26 项功能检查通过，但 p99 为 36 / 38 / 34ms，卡顿率为 3.5959% / 3.6458% / 3.4188%，全部未通过性能门槛。
三轮均采集 10 秒 Perfetto；可见主线程 animation 最大 28.00 / 29.76 / 27.49ms，以及 RenderThread dequeueBuffer 最大 38.12 / 4.50 / 23.56ms。第一轮还有系统扫描负载，不能将全部慢帧归因于单一因素或直接套用模拟器结论。
普通电源模式对照尚未完成；旧路径安装首次等待 180 秒超时，重试后 4 项真机检查通过。改造前基准组件受 OPPO 身份验证阻塞，用户要求暂时跳过；已取消安装并清理测试包，未完成真机像素对照。当前只记录验收证据，不修改产品源码，不默认开启 CHAT_V2，不启用 P2/P3。详情见 `docs/ANDROID-P1-ACCEPTANCE-2026-11-25.md`。

P1 关闭省电后复核（本轮）：同一 OPPO PEXM00、Android 12/API 31，三轮前后均确认 low_power=0、60Hz，电量 24%，USB 充电。每轮 26 项功能检查通过，但 p99 为 34 / 36 / 40ms，卡顿率为 2.2109% / 3.2590% / 6.2069%，三轮性能仍全部失败。
独立测试组件安装受系统账号验证阻塞；用户无法完成验证后，在本地副本中将相同探针打入带桌面入口的隔离 debug APK，经正常安装成功，91 项 JVM 测试通过。207 个原始源文件比对一致；打包方式及 APK 哈希发生变化，因此不是仅改变省电开关的严格对照。
每轮 10 秒 Perfetto 显示主线程 animation 最大 29.30 / 28.57 / 37.83ms、RenderThread dequeueBuffer 最大 14.36 / 22.68 / 27.67ms；具体慢帧根因仍待定位。只更新验收文档，测试包已卸载，未修改产品源码，CHAT_V2 默认 false，P1 未完成，P2/P3 未启用，改造前基准对照继续按用户要求跳过。

### P0 历史记录（已完成）

### Bug 1（P0）失败队头永久阻塞同会话后续消息

- 文件：`android/app/src/main/java/com/pulseim/android/TextSendQueue.java`
- 锚点：`claim(...)` 约 86–97 行
- 根因：`seen.add(entry.conversationId)` 在 `phase` / `retryAtMs` 判断**之前**执行。
  队头是 `FAILED` 时 `result` 不加它，但同会话后续条目已被 `seen` 判掉 →
  整条会话再也发不出去，只能人工点"重试 / 移除"。
- 期望：`seen` 只用于"每会话最多取 1 条"的计数，不得因队头不可发而跳过整个会话。
  两种实现二选一，说明理由后实现更简单可靠的那种：
  - (a) 队头不可发 → 跳过该会话，继续看下一个会话；
  - (b) 跳过 FAILED，取同会话内后面第一条 `QUEUED`。
- 验收单测：
  - 同会话 `[FAILED, QUEUED]` → claim 能取到那条 QUEUED（或明确返回空且不阻塞其他会话）；
    且 FAILED 条目状态与 error 不被改写。
  - 两个会话各 1 条 `FAILED` → claim 返回空且不抛异常。

### Bug 2（P0）"已禁止发言"被误判为永久失败

- 文件：`android/app/src/main/java/com/pulseim/android/MainActivity.kt`
- 锚点：`drainTextOutbox()` 约 5052–5058 行；`sendClaimedText(...)` 约 5090–5108 行
- 根因：`drainTextOutbox()` 不校验 `chatCanSend`；`sendClaimedText` 在
  `chatCanSend=false` 时抛 `IllegalStateException("已禁止发言")`。它不是 `IOException`，
  也不在 408/425/429/5xx 里，于是走 `queue.fail()` → 永久 `FAILED`，进而触发 Bug 1。
- 期望：
  - `drainTextOutbox()` 入口：`chatCanSend == false` 时直接 `return`，不 claim。
  - `sendClaimedText` 中"权限未就绪 / 账号切换"类异常走 `defer`（保留原 error 文案），不走 `fail`。
  - 真正的 4xx（400 / 403 / 404 / 409 等）仍然 `fail`。**不要把 `fail` 全部改成 `defer`。**
- 验收：
  - 把三态判定抽成可单测的函数：`(异常, chatCanSend) -> DEFER | FAIL | SEND`，并为其写单测。
  - 报告中标出 `MainActivity` 里至少 3 处调用点被覆盖。

### Bug 3（P0）媒体队头非 QUEUED 直接 return null，阻塞整个会话

- 文件：`android/app/src/main/java/com/pulseim/android/DurableMediaOutbox.java`
- 锚点：`claim(int cid)` 约 74–84 行
- 根因：遍历到本会话队头后，只要 `phase != QUEUED` 或 `retryAtMs` 未到就 `return null`，
  同会话后面所有附件永远停在"等待发送"。
- 期望：与 Bug 1 同思路；`UNREADABLE` 应跳过继续找下一条。
- 验收单测：
  - 同会话 `[UNREADABLE, QUEUED]` → claim 返回 QUEUED 那条。
  - `retryAtMs` 在未来的队头不会被提前领取；时间推进后能领到。

### Bug 4（P1）失败重试同步做线路探活，卡死发送线程

- 文件：`android/app/src/main/java/com/pulseim/android/ApiClient.kt` 约 507–515 行；
  `android/app/src/main/java/com/pulseim/android/RouteManager.kt` 约 299–316 行
- 根因：任何 `IOException` 都在调用线程上同步执行 `RouteManager.failover`，
  内部还会 probe（`GET /client/config`，4s timeout），最坏 3 次网络调用、8–12s 卡在发送线程。
- 期望：
  - 探活改为后台执行，不阻塞当前请求；当前请求立即把原错误抛给上层重试逻辑。
  - 保留"切到备用线路后重放 GET / 带 `request_id` 的 POST"的既有语义，但重放**不得**再触发探活。
  - 不新建线程池：复用 `RouteManager` 已有的 `background` / `healthWorker`。
- 验收单测（注入假 probe）：
  - 一次 `IOException` 后，调用方 200ms 内返回，probe 在后台完成。
  - 明确写出 goMode 单线路时 `failover` 的行为（应快速返回 false，不做探活）。

---

## 5. 报告输出格式（严格按此结构）

```markdown
## 1. 计划（先输出，等确认）
## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改
## 3. 完整 diff
## 4. 测试代码 + 实际运行输出（贴原始终端输出）
## 5. 兼容性检查
   - 账号切换
   - 进程被杀后重启恢复
   - 多会话并发
   （逐项说明"受影响/不受影响 + 依据"）
## 6. 发现但未修改的问题清单（只列，不动）
```

---

## 6. P0 完成判定

- [ ] 4 个 bug 全部修复，单测覆盖到位且 `testDebugUnitTest` 全绿
- [ ] `assembleDebug` 通过（或明确标注未验证及原因）
- [ ] `git diff` 总行数 < 400（超出说明你在做别的）
- [ ] 报告第 6 节不为空（说明你真的读了代码，而不是只改 4 行）

---

---

# 附录 A：P1 —— 消息列表迁移到 RecyclerView（当前启用）

> 本阶段已获用户确认；以下为当前任务要求。`CHAT_V2` 仍默认 false，性能门槛未通过前不默认启用。

## A.1 目标

只替换**消息列表的渲染层**。发送链路、Socket、outbox、协议一律不动。
新增开关 `BuildConfig.CHAT_V2`，**默认 false**，false 时完全走现有路径。

## A.2 现状锚点（先读这些位置再动手）

| 位置 | 内容 |
|---|---|
| `MainActivity.kt:3162` | `currentMessages = column(...)` 建容器 |
| `MainActivity.kt:3165–3187` | `object : ScrollView` + `addOnLayoutChangeListener`（到底跟随） |
| `MainActivity.kt:3191–3195` | `ChatMessageScroll(messages, scroll, current = {...}, navigation = {...})` |
| `MainActivity.kt:3221–3233` | `trimLiveMessages`：200 条窗口裁剪 |
| `MainActivity.kt:4997–5036` | `renderPendingTextMessages`（待发文字行） |
| `MainActivity.kt:5344–5420` | `renderPendingMediaMessages`（待发媒体行） |
| `MainActivity.kt:6229–6399` | `addMessage(...)`：按 `type` 建整行 View |
| `MainActivity.kt:6568–6586` | `insertMessageRow`（按 id 二分插入）、`selectableMessageRow` |
| `ChatMessageScroll.kt` | 阅读位置 / 跟随最新 / `positionRevision` 语义 |

## A.3 设计要求

1. **容器替换**：`ScrollView + LinearLayout` → `RecyclerView + LinearLayoutManager`。
   底部对齐行为用 `stackFromEnd = true` + `scrollToPosition(last)` 实现，不要用 `reverseLayout`
   （会打乱现有 `tag = messageId` 的顺序假设和"上翻加载更早"的逻辑）。
2. **行类型**（`getItemViewType`）：
   `OLDER_LOADING`（原 child 0 的"加载更早消息"）、`MESSAGE`、`PENDING_TEXT`、`PENDING_MEDIA`。
3. **Diff**：`ListAdapter` + `DiffUtil.ItemCallback`，`areItemsTheSame` 用 `messageId`，
   `areContentsTheSame` 用现有 `messageVersions` / `messageAuthority()` 得到的 version。
4. **局部刷新**：状态变化（已读 / 编辑 / 撤回 / 发送中→已发送）必须用
   `notifyItemChanged(index)`，**禁止** `notifyDataSetChanged`，**禁止**删行重建。
5. **必须保留**（它们只依赖 `View`，不依赖容器类型）：
   `SelectableMessageRow` 多选外壳、`MessageActionMenu` 长按、`ChatMessageTouch`、
   `ChatScrollBottom`、`RichMessageContent`、`VoiceMessageView`、`IOSGroupChatStyle.message(...)`。
6. **滚动语义保持**：
   - 上翻后新消息不强制回底（`shouldFollowIncoming()`）；
   - 自己发送 / 点回到底部 / 手动滑到底部 → 恢复跟随；
   - 图片回填、引用块渲染不得改变阅读位置。
   用 `LinearLayoutManager.findFirstVisibleItemPosition()` + `getViewTop()` 做锚点，
   替换现有 `(0 until childCount).map { it.top - scrollY }` 的做法。
7. **图片回填不再改 `layoutParams`**：行内用固定 `aspectRatio` 占位，
   避免回填后触发整树 measure（对应 `MainActivity.kt:6477` 的现有行为）。
8. **`findViewWithTag` 全部移除**：用 `adapter.currentList.indexOfFirst { it.id == id }`，
   待发行用 `indexOfFirst { it.requestId == requestId }`。

## A.4 禁止事项

- 不改 `sendClaimedText` / `drainTextOutbox` / `DurableMediaOutbox`（P0 已改的部分不动）。
- 不改 `SocketClient`、`GoV2Api`、`ApiClient`、`RouteManager`。
- 不删 `MainActivity` 里旧路径代码；用 `if (BuildConfig.CHAT_V2) ... else ...` 并存一个版本。
- 不引入 Coil / Glide / Paging。

## A.5 验收

- [ ] 200 条消息滚动：`dumpsys gfxinfo` p99 < 16ms，Jank < 1%（Perfetto 抓 10s）
- [ ] 连续收 5 条消息，不出现整表重建（可在 `onBindViewHolder` 加计数器自证）
- [ ] 上翻 2 页后收到新消息，阅读位置不动
- [ ] 图片回填、语音行、引用块、多选模式、待发状态更新 5 个场景无跳位
- [ ] `CHAT_V2=false` 时与改动前行为完全一致（回归对比）

---

# 附录 B：P2 —— 状态收敛到 ViewModel（未启用）

## B.1 目标

把消息页散落在 `MainActivity` 的状态收敛成 `ChatViewModel` + `ChatUiState(StateFlow)`，
`MainActivity` 只订阅渲染。发送状态机搬进 ViewModel。

## B.2 必须定义的状态

```kotlin
data class ChatUiState(
    val conversationId: Int = 0,
    val messages: List<ChatRow> = emptyList(),
    val outbox: List<OutboxRow> = emptyList(),
    val canSend: Boolean = false,
    val canSendReason: String? = null,
    val loadingOlder: Boolean = false,
    val hasMoreOlder: Boolean = true,
)
```

## B.3 发送状态机规则

- `QUEUED → SENDING → SENT`；失败进 `FAILED`，**不阻塞后续消息**。
- 权限未就绪 → `defer`，不是 `fail`。
- 重试带 jitter：`delay = min(30s, 1s shl n) * (0.5 + random*0.5)`，最多 5 次。
- 队头 `FAILED` 时允许后续消息继续（与 P0 的 Bug 1 保持一致）。

## B.4 验收

- [ ] 进程被杀重启，待发队列完整恢复且不重复发送
- [ ] `canSend=false` 期间不产生 `FAILED`
- [ ] 连发 10 条无永久阻塞
- [ ] `MainActivity` 行数下降 ≥ 800

---

# 附录 C：P3 —— outbox 落 Room（未启用）

## C.1 目标

`TextSendQueue` / `DurableMediaOutbox` 的内存队列 → Room 单行 upsert，双写过渡一周后切读。

## C.2 表结构

```kotlin
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val requestId: String,
    val accountKey: String,        // scope(base, userId)，多账号隔离
    val conversationId: Int,
    val kind: String,              // text / image / voice / file
    val payload: String,           // 文本或本地文件路径
    val replyToId: Int,
    val state: String,             // QUEUED / UPLOADING / SENDING / SENT / FAILED
    val attempt: Int = 0,
    val nextAttemptAt: Long = 0,
    val lastError: String? = null,
    val serverMessageId: Int? = null,
    val createdAt: Long,
)
```

## C.3 验收

- [ ] 同账号 50 条待发时，单次状态变化的写放大从 O(n) 降到 O(1)（SQLite trace 佐证）
- [ ] 加密：字段级继续用 `LocalAccountStore.encryptCipher/decryptCipher`，AAD 规则不变
- [ ] 双写期间两套数据一致性校验通过，回滚开关可用
