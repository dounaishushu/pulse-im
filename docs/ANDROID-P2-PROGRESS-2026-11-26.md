# Android P2 第一步：状态模型与回归基础

用户在三步计划后要求“进行修改”，当前阶段切换为 P2。P1 的真机性能仍未通过，CHAT_V2 继续默认 false；P3 未启用。

本轮完成不依赖新库的状态基础，**尚未接入运行中的消息、权限或发送链路，不能视为 P2 已完成，也未证明真机滚动变快**。

## 已完成

- 新增纯 Kotlin ChatUiState，包含会话、消息、待发项、发送权限和历史加载状态，消息载荷以不可变字符串保存。
- ChatStateReducer 通过账号与会话代次票据拒绝过期结果，包括 A→B→A 或关闭后重开同一会话；切换身份清除旧消息、待发状态及发送权限。
- 捕获并冻结列表，过滤其他会话及无效 ID；相同消息快照保持状态及列表实例，便于后续减少无效渲染。消息版本权威仍应由既有 MessageVersionGuard 判定，不能用本 reducer 替代该规则。
- 新增独立 ChatRetryPolicy，定义指数退避乘以 0.5～1.0 的 jitter，初始发送之后最多自动重试 5 次；无效参数或极大恢复计数不会造成位移溢出和无限重试。策略尚未接入现有队列，因此当前发送重试行为未变。

## 验证

新增 22 项 JVM 回归：15 项状态/隔离/不可变性测试，7 项重试边界测试。实际执行 `:app:testDebugUnitTest :app:assembleDebug`：

```text
tests=113, failures=0, errors=0, skipped=0
BUILD SUCCESSFUL in 47s
42 actionable tasks: 42 executed
```

测试与构建使用本地隔离工程副本，未安装或发布产物。GO_BACKEND=true，CHAT_V2=false。源码、完整终端输出、单测 XML、完整增量 diff 与六节报告保存在 `.local/android-p2-20261126-002125/`。

## 下一步依赖与实施边界

已向用户列明但尚未收到确认的依赖：

- `androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7`：提供 ViewModel 生命周期及作用域。
- `org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0`：提供 StateFlow 与 Android 主线程调度。
- 上述库正常解析所需的传递依赖。

现有 MainActivity 直接继承 Activity，需明确 ViewModelStore 的保留与清理，以及订阅的启动、停止和账号隔离。依赖通过确认后再接入真实 ViewModel 和 StateFlow，最后迁移发送编排；本轮没有添加这些库，也没有使用自制同名替代实现。

P2 其余验收尚未完成：真实进程恢复不丢失/重复发送、无权限不误标 FAILED、连续发送 10 条无永久阻塞、MainActivity 行数减少至少 800。MainActivity 当前仍为 7385 行。本轮后端、网络协议、加密存储、UI 文案和原有工作区改动均保留。
