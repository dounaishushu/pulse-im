# 移动端答题卡顿修复（2026-11-20）

本次修改 Android 和 iOS 任务答题页，兼容现有 Go API。未修改服务端和数据库，也未部署或推送 GitHub。客户端需要重新编译、安装更新后生效。

## 确认的问题与修改

1. 两端原来都等待单题保存成功后才切题，网络延迟会直接变成按钮和切题的等待时间。现在先保存本地草稿、立即更新当前题目，再串行同步答案；等待期间的新答案合并为下一批，重复修改以最后一次为准。
2. 提交结算前等待在途保存完成，再提交完整答案快照，避免旧的进度保存晚于提交。后台保存失败会保留草稿，并显示重试入口，不阻塞继续答题。
3. 原来进度保存会重新映射整个任务及所有题图授权。新增客户端适配器内部的进度回执路径，只验证返回的任务 ID；实际服务器仍使用原来的 `GET /task-records/{id}` 和 `PUT /task-records/{id}/answers`。
4. 首次任务映射改为批量申请题图授权，避免逐题串行请求。Android 捕获答题会话时，仅复制当前题目仍有效的授权；两端均支持按当前题目续签过期授权。
5. Android 题图复用现有有容量限制的内存及磁盘缓存，切题时取消旧任务，校验页面、账号和题目标识后才显示图片。iOS 复用现有图片缓存，下载与 ImageIO 缩略解码在后台执行，取消后不更新旧图片。

图片展示沿用现有缓存的 2560 像素档；首次遇到且未缓存的图片仍需要网络下载。未增加全量图片预下载，避免手机内存和流量明显增加。

## 已执行验证

在隔离的 Android API 37 模拟器上使用合成 24 道题目，没有真实账号和生产请求。最终原生仪器测试通过（`INSTRUMENTATION_CODE: -1`）：

| 场景 | 最终一次测量 |
| --- | --- |
| 服务端每次保存故意延迟 1200 ms，点击后切到下一题 | 40 ms |
| 快速连续选择 3 题 | 合并为 2 次保存 |
| 首次获取 24 道题的图片授权 | 1 次批量请求，无额外单题授权 |
| 返回已加载的图片 | 86 ms，无新增图片下载 |
| 一个慢图正在下载，再连续跳过 12 题，显示未缓存的新图 | 56 ms |
| 慢图随后返回 | 不会覆盖当前题图 |

这些数据用于验证逻辑不再等待网络，不代表所有真机和公网环境的固定耗时。

- Android `assembleDebug`、`assembleDebugAndroidTest` 构建通过。
- `WorkAnswerSyncChecks` 7 项通过：延迟不阻塞、批次合并、最后一次修改优先、失败重试、提交顺序、账号切换和关闭页面。
- 修改的 4 个 iOS 应用源码文件和新增适配器测试通过 Swift Tree-sitter 语法检查。
- `scripts/verify-ios-project.py` 静态项目检查通过（55 个 Swift 引用、136 个项目对象）。
- `git diff --check` 通过。

当前 Windows 环境没有 Xcode。**未执行 iOS 编译、iOS 新增回归测试或 iPhone 真机体验测试**；这些仍需在 Mac 验证。Android 结果来自模拟器，尚未覆盖系统应用分身和低内存真机。

## 回归测试入口

Android 队列测试（纯 Java，无需服务器）：编译 `android/app/src/main/java/com/pulseim/android/WorkAnswerSync.java` 和 `android/tests/WorkAnswerSyncChecks.java`，运行 `com.pulseim.android.WorkAnswerSyncChecks`。

Android 原生性能测试：启动 `python android/tests/work-task-performance-fixture.py 18233`；将测试构建的 `PULSE_API_URL` 设为 `http://10.0.2.2:18233/api/v2`、`PULSE_WS_URL` 设为 `ws://10.0.2.2:18233/api/v2/realtime`，构建并安装 debug 及 androidTest APK 后运行：

```text
adb -s <隔离模拟器> shell am instrument -w -e live work-task-performance -e base http://10.0.2.2:18233/api/v2 com.pulseim.android.test/com.pulseim.android.GoV2Probe
```

每轮使用新的测试服务进程和干净的隔离模拟器数据。不能在真实用户设备上清除应用数据。**上述 loopback APK 仅用于验证，不可发布给用户。**

Mac 上运行新增的 iOS 适配器、解码、授权回归测试：

```bash
bash ios/Tests/run-work-task-performance.sh
```

脚本编译真实适配器并启动本机合成服务，覆盖批量题图授权、进度保存不重复授权、过期授权续签，以及旧题目缺少 `media_id` 时的兼容解码。该脚本不替代 Xcode 构建和真机答题测试。

本次本地验证日志位于 `.local/task-answer-performance-20261120-003742/`。
