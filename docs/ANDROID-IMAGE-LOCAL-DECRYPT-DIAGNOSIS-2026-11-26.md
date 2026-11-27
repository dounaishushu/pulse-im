# 安卓部分图片无法发送：本地附件校验失败排查（2026-11-26）

## 1. 计划（先输出，等确认）

先说明检查“保存相册再发送”路径、待发附件读取和服务器请求，再只读核对截图 19:33–19:45 附近的记录；使用既有服务器授权，不修改生产服务。已询问失败账号/手机/版本，并针对匹配时间的候选账号发出核对问题，用户随后明确确认截图为 hehe14777，此处故障账号已对应上。此轮只读排查，没有开始需要确认的产品修改。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

已确认的故障环节是手机本地加密待发附件在解密认证时失败，尚未进入该失败条目的图片上传请求；尚不能从这些栈进一步断定是密文内容异常、密钥不匹配还是特定设备密钥服务的问题，不能将“已丢失或损坏”直接解释为相册原图已经被删除。

用户确认的故障账号 hehe14777 上报 7 次 ANDROID_DURABLE_MEDIA_UNREADABLE，实际发生时间为 19:31:21、19:33:36、19:35:35、19:38:12、19:39:15、19:40:11、19:41:23；服务端收到部分报告晚于实际故障，不能混用两个时间。报告设备 V1990A、SDK 29（Android 10）、App 0.2.119；19:47:27 的网络观测仍是 0.2.119。用户已确认截图为此账号；底层认证失败的具体触发原因仍待问题设备复现。

栈进入 OutboxAttachments.open:73，也就是捕获 AEADBadTagException 后重新包装 Unreadable 的分支；原因栈经过 AndroidKeyStoreCipherSpiBase.engineDoFinal:517、Cipher.doFinal、OutboxAttachments.transform:108。不是 openEncrypted:83 的文件不存在分支，也不是图片解码器拒绝格式分支。[Android 官方定义](https://developer.android.com/reference/kotlin/javax/crypto/AEADBadTagException)说明这种异常意味着 AEAD 认证标签无法校验；不能通过忽略认证来发送失败内容。

本地源码调用顺序：AndroidChatSendPorts.sendMedia 先 queue.openFile，再 client.uploadMedia；ChatSendController.sendMedia 捕获 Unreadable 后只调用 queue.markUnreadable。DurableMediaOutbox.markUnreadable 保留失败附件项及重新选择提示，不生成聊天消息。故本例文本能发送、部分图片能发送，与某些本地待发密文校验失败可以同时存在。

截图中的“保存图片失败、截图可发送”是用户观察，原因尚未通过同一图片/同一问题手机的对照复现。候选账号 19:44:26 和 19:45:33 的两张图片均 ready 且分别有一条已提交消息；这些成功记录不能自动认定为截图或指定的二维码图片。

## 3. 完整 diff

本轮没有产品代码改动，无修复 diff，没有生成新安装包。留存 5 个相关产品文件的原始字节，并与排查结束时逐一核对一致；服务端仅执行只读事务和有扫描上限的日志读取，不部署、不重启、不修改限流或数据库。

## 4. 测试代码 + 实际运行输出（贴原始终端输出）

本轮没有修改产品，也没有添加/运行 JVM 或真机功能测试；不能把只读查询视为修复或用上一轮 262 项通过证明本轮图片故障已解决。

实际只读结果摘要：

```json
{
  "checked_at": "2026-11-26T19:53:18.775893+08:00",
  "candidate_account": "hehe14777",
  "screenshot_account_confirmed": true,
  "model": "V1990A",
  "sdk": "29",
  "version": "0.2.119",
  "unreadable_incidents": 7,
  "earliest_incident": "2026-11-26T19:31:21.344+08:00",
  "latest_incident": "2026-11-26T19:41:23.069+08:00",
  "failure_stage": "local encrypted outbox attachment authentication before upload",
  "physical_file_missing_proven": false,
  "underlying_ciphertext_or_keystore_cause_proven": false,
  "server_health": "healthy",
  "server_restarts": 0,
  "database_and_queue": {
    "lock_waiters": 0,
    "queued_media": 0,
    "message_outbox": 0,
    "receiving_media": 0,
    "processing_media": 0
  },
  "successful_media_in_server_window": 64,
  "candidate_successful_image_message_times": [
    "2026-11-26T19:28:59.620394+08:00",
    "2026-11-26T19:44:26.324553+08:00",
    "2026-11-26T19:45:33.36558+08:00"
  ],
  "product_code_changed": false,
  "new_apk_generated": false,
  "server_changed": false,
  "tests_run": false,
  "sensitive_tokens_or_image_content_read": false
}
```

19:30–19:48:58 的媒体记录共 64 张 image，全部 ready、error_code 为空。Nginx 在此窗口记录 POST /api/v2/media/uploads 64 次 HTTP 201、PUT /api/v2/media/:id/bytes 64 次 HTTP 202。另有两条媒体访问授权 403 和一条授权批量请求 499，它们是访问授权接口，不能写成上传接口失败，也不能将其从报告中省略。

候选账号实际媒体记录：

```json
[
  {
    "kind": "image",
    "status": "ready",
    "created_at": "2026-11-26T19:28:59.620394+08:00",
    "error_code": "",
    "updated_at": "2026-11-26T19:29:01.824905+08:00",
    "expected_bytes": 52485,
    "committed_messages": 1
  },
  {
    "kind": "image",
    "status": "ready",
    "created_at": "2026-11-26T19:44:26.324553+08:00",
    "error_code": "",
    "updated_at": "2026-11-26T19:44:27.014226+08:00",
    "expected_bytes": 33427,
    "committed_messages": 1
  },
  {
    "kind": "image",
    "status": "ready",
    "created_at": "2026-11-26T19:45:33.36558+08:00",
    "error_code": "",
    "updated_at": "2026-11-26T19:45:34.046405+08:00",
    "expected_bytes": 53558,
    "committed_messages": 1
  }
]
```

保留查询失败：首次目标查询使用 n.updated_at，数据库返回 column does not exist；事务只读，未改数据。根据仓库 migration 确认列名为 checked_at，修正本地诊断脚本后重新查询成功。AOSP 指定 tag 页面 web 工具首次无法打开，随后查到 Android 官方异常说明，未依赖未读取的 OEM 源码或推测设备缺陷。

证据目录：`.local/android-image-send-20261126-194718`。server-check.json、server-target.json、server-target-first-query-failure.json 和 diagnosis-result.json 保存原始结果及失败记录。没有读取账号密码、登录 token、相册/图片内容或密钥，没有人工向真人账号发送消息。

## 5. 兼容性检查

- 账号切换：未改账号、token、scope、AAD 或存储。用户已确认账号，未在其手机切账号。
- 进程被杀后重启恢复：未操作问题手机、未清数据；没有验证该问题条目能在重启后恢复。此前连接/死锁修复不覆盖本例具体认证失败的验证。
- 多会话并发：未改队列/事务边界，现有 FAILED/UNREADABLE 跳过规则保持；不能把本地单条失败解释为整个上传服务停止。
- 版本/安装：问题日志为 0.2.119，最新已交付包为 0.2.123，但当前附件加密代码未针对本例作修复；不能承诺仅升级就解决。上报类包名前缀与标准包 com.pulseim.android 不同，只记录事实，不推断为故障原因，也不默认认为标准包能够原地覆盖这台手机的安装。

## 6. 发现但未修改的问题清单（只列，不动）

- 问题手机密文校验失败的具体触发原因未确定，账号已确认，仍需在该设备复现或提供更细的非敏感诊断。
- 当前 Unreadable 把认证失败统一展示为“本地附件已丢失或损坏”；该提示不能区分真正缺文件与认证失败。
- 老版/改包客户端是否与最新标准包同签名同包名未核对，不能建议直接卸载重装并声称保留数据。
- 部分媒体访问授权 403/499 未在本轮扩展处理；没有证据表明它们导致当前本地解密失败。
- 上一轮发现的后台约 30 秒断连与 FCM 未真实送达保持待处理，不混作此次图片错误的已证根因。
