# Android P2 进度：发送状态迁移与本地验收

用户在三步计划后要求“进行修改”，当前阶段切换为 P2。P1 的真机性能仍未通过，CHAT_V2 继续默认 false；P3 未启用。

第三轮已完成发送状态机迁移及 P2 本地功能验收。**本轮验证来自隔离模拟器，未复测真机滚动性能；P1 的真机性能失败结论继续保留。** 第二轮记录中的“尚未完成”描述的是该轮结束时的范围。

## 第一步：状态模型与回归基础（提交 0eff6b7）

- 新增纯 Kotlin ChatUiState，包含会话、消息、待发项、发送权限和历史加载状态，消息载荷以不可变字符串保存。
- ChatStateReducer 通过账号与会话代次票据拒绝过期结果，包括 A→B→A 或关闭后重开同一会话；切换身份清除旧消息、待发状态及发送权限。
- 捕获并冻结列表，过滤其他会话及无效 ID；相同消息快照保持状态及列表实例，便于后续减少无效渲染。消息版本权威仍应由既有 MessageVersionGuard 判定，不能用本 reducer 替代该规则。
- 新增独立 ChatRetryPolicy，定义指数退避乘以 0.5～1.0 的 jitter，初始发送之后最多自动重试 5 次；无效参数或极大恢复计数不会造成位移溢出和无限重试。策略尚未接入现有队列，因此当前发送重试行为未变。

### 第一步验证

新增 22 项 JVM 回归：15 项状态/隔离/不可变性测试，7 项重试边界测试。实际执行 `:app:testDebugUnitTest :app:assembleDebug`：

```text
tests=113, failures=0, errors=0, skipped=0
BUILD SUCCESSFUL in 47s
42 actionable tasks: 42 executed
```

测试与构建使用本地隔离工程副本，未安装或发布产物。GO_BACKEND=true，CHAT_V2=false。源码、完整终端输出、单测 XML、完整增量 diff 与六节报告保存在 `.local/android-p2-20261126-002125/`。

## 第二轮：运行时接入

用户在明确列出以下依赖后要求“继续推进下一轮修改”，本轮已按确认加入这两项及必要传递依赖：

- `androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7`：提供 ViewModel 生命周期及作用域。
- `org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0`：提供 StateFlow 与 Android 主线程调度。
- 上述库正常解析所需的传递依赖。

MainActivity 继续继承原有 Activity，增加 ViewModelStoreOwner 桥接；onStart 启动一次订阅，onStop 取消订阅。配置重建通过系统非配置实例保留同一 ViewModelStore，永久销毁时清理；ViewModel 不持有 Activity、View、Context 或传输回调。

发送权限和更早消息加载状态从 ViewModel 读取；旧回调仍须匹配账号/会话代次。消息字典迁入 ViewModel，以兼容映射供既有渲染器使用；不可变行快照在单行变化时更新，新列表读取已捕获快照，不再每次提交重新序列化全部可见消息。待发文字和附件的状态快照同步到同一 ChatUiState，队列和发送编排保持原有实现。

保留 MessageVersionGuard 对编辑、撤回和过期快照的权威判定；保留旧列表、原 UI 文案、网络协议、request_id、加密格式和持久化事务边界。没有修改后端或 AndroidManifest.xml。

### 第二轮验证

新增 ChatViewModelTest 9 项及 ChatMessageMapTest 7 项，总计 129 项 JVM 测试通过，0 失败、0 错误、0 跳过。新旧 CHAT_V2 开关的调试构建通过；全部 AndroidTest Kotlin 源码编译通过。

在 API 37、1080×2400 的隔离模拟器测试，新旧路径分别通过 8 项运行时检查：200 条消息快照归属、权限更新、分页/待发投影、实际 Activity 停止后取消订阅、返回前台重放最新状态、A→B→A 过期票据、Activity.recreate 保留 ViewModel、永久销毁拒绝晚到任务。新列表原 26 项功能检查通过，旧列表原 4 项回归通过。

旧列表与本轮修改前的控制基准在同一模拟器、同一隔离包名运行，两张初始 PNG 逐字节一致：

- 群聊：`fcbae01a0a836826c8d036bb8133bf0e6e6827c2f8e68c682d4a0f3fbeb8b57f`
- 私聊：`5cd1f0b923551c707dd56d2563ee5dcf9c5b50c60886ca55b3f29747465f8f18`

首轮新增生命周期夹具在重建 Activity 前未释放测试占用线程，产生 InterruptedException 并退出；已改为确认线程释放后再重建，随后新旧路径均通过。保留首轮失败日志，不将其计为成功。

真机 USB 安装未完成，观察时前台为通知栏、安装客户端仍在等待；已取消该客户端，没有调整手机安全设置。**上述运行时通过结果来自模拟器，不能称为本轮真机通过。** 测试使用假账号和关闭的本机端点，没有访问生产接口；没有发布安装包或部署。

本轮完整终端输出、单测 XML、新旧路径与控制基准、像素比对、完整增量 diff 和六节报告位于 `.local/android-p2-runtime-20261126-003406/`。

## 第二轮结束时的剩余验收（历史记录）

发送状态机及带 jitter 的最多 5 次重试尚未迁入 ViewModel；真实杀进程后的待发恢复、不重复发送、无权限期间不误标 FAILED、连续发送 10 条无永久阻塞仍需后续验证。MainActivity 当前 7459 行（本轮开始 7385 行），减少至少 800 行的目标未达。P2 不标记完成，P1 真机性能问题继续保留，CHAT_V2 默认 false，P3 未启用。

## 第三轮：完成发送迁移和本地验收

用户要求继续推进 P2 剩余部分，沿用已确认的阶段和依赖。ViewModel 现在拥有 ChatSendController，统一控制队列恢复、并发领取、发送、回执、暂停与重试唤醒；AndroidChatSendPorts 仅持有 Application Context，网络线程随 ViewModel 生命周期清理。配置重建保留发送所有者，账号切换及永久销毁取消原任务并将未确认项目保留在原有队列中。

文字和附件自动重试使用同一 ChatRetryPolicy，最多 5 次，带 jitter；继续使用原有持久化 attempt/retryAt 元数据，重启不会获得新的自动重试预算。attempt 仍是原有单调递增的领取票据，权限变化造成的暂停不会标为 FAILED，预算采取保守的领取次数上限，不新增存储字段。永久性 400/403 等响应仍保留失败；失败项目不会阻塞同会话后续条目。原捕获式发送的尝试状态也由 ViewModel 管理，手工重试明确开启新预算。

既有队列方法增加可注入时钟的重载，原签名保留并仍使用系统时钟；序列化、AAD、ticket、epoch 和事务边界不变。HTTP 和 WebSocket 确认共用原请求编号，附件回复只在本地确认提交成功后清除，不重复渲染已由实时通道显示的消息。

第 6 次请求途中重启的项目会在发出第 7 次自动请求前停止，等待人工确认。点击界面的“重试”可显式开始新的受限预算，请求编号保持原样；这项授权仅保留在当前 ViewModel 内，进程再重启时按已持久化的领取次数从严处理，可能需要再次点击重试。这样无需新增存储字段，也不会因重启获得无限自动重试。

ChatComposerActions、ChatOutboxViews 是 Activity 所有的界面协作类，处理按钮、录音、预览和待发界面；它们不会进入 ViewModel。旧方法保留转发入口及 JVM 名称；必要的同模块访问桥接使用 internal。MainActivity 从 P2 起点 7385 行降至 6552 行，减少 833 行（本轮由 7459 行减少 907 行），未通过压缩空行凑行数。

### 第三轮验证

- 新增 ChatSendControllerTest 19 项、ChatCapturedAttemptTest 4 项；总计 152 项 JVM 测试通过，0 失败、0 错误、0 跳过。
- 新旧 CHAT_V2 调试构建通过，全部 AndroidTest Kotlin 编译通过。
- API 37、1080×2400 隔离模拟器中，新旧路径各 8 项生命周期检查、新列表 26 项既有功能检查、旧列表 4 项既有检查通过。
- 旧路径群聊和私聊 PNG 与本轮修改前控制基准逐字节一致，SHA256 分别仍为 `fcbae01a0a836826c8d036bb8133bf0e6e6827c2f8e68c682d4a0f3fbeb8b57f`、`5cd1f0b923551c707dd56d2563ee5dcf9c5b50c60886ca55b3f29747465f8f18`。
- 两种开关均执行三次独立进程的 seed/resume/verify，阶段之间实际 force-stop 隔离测试包：10 条文字和 2 个加密附件恢复完整，权限未就绪时无 FAILED，连续发送完成，不确定回执沿用原编号；持久化幂等测试服务最终仅 12 条记录，第三个进程未再次发送。
- 重启测试实际经过 Android Keystore、SQLite 和加密附件。幂等服务为测试夹具，未用生产 Go 服务进行写入；不将此结论扩展为生产链路压测。

最初构建修正了语音适配调用名及界面协作类的访问桥接；首轮队列单测的时钟混用和 Long 断言问题已修正后重跑。生命周期探针起初仍访问已迁出的 textExecutor，随后改为控制实际发送线程池，新旧路径均重跑通过。控制基准打包先修正了测试源选择。失败记录与原始输出保留在本地报告，没有放宽原检查或门槛。

本轮证据与六节完整报告位于 `.local/android-p2-sending-20261126-011150/`。P2 本地功能验收完成；未进行真机安装、生产发送或滚动性能复测。CHAT_V2 默认 false，P1 性能问题仍需独立复核，P3 未启用；未部署服务器或发布安装包。
