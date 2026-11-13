# Go 后端补齐追踪（2026-11-11）

旧 PHP 的 166 个编号完整保留，仅 F024、F054、F055、F161 沿用用户已确认的排除。下面的文件列是实现定位，**不是完成判定**。客户端本地能力仍保留但本轮暂停联调。旧库导入、外部平台到达、Linux 实机和四端验收不由代码存在或容量测试推断。

| 编号 | 功能 | 当前证据状态 | 后端来源 | 验证入口 |
| --- | --- | --- | --- | --- |
| F001 | 账号注册 | 新后端回归通过；旧库记录尚未对账 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F002 | 注册时设置头像 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F003 | 图形验证码与注册防刷 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F004 | 密码登录与退出当前登录 | 新后端回归通过；旧库记录尚未对账 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F005 | 修改个人资料 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F006 | 修改登录密码 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F007 | 查看与撤销登录设备会话 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F008 | 两步验证密码与恢复码 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F009 | 手机设备绑定策略 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, profiles.go, sessions.go, registration_avatar.go | TestRegistrationCaptchaSingleUseAndProfileVersion; TestTwoStepRecoveryReplayAndMobileBinding; TestImageHeaderBudgetAndRegistrationAvatar |
| F010 | 按完整账号查找用户 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F011 | 公开用户 ID 与二维码解析 | 新后端回归通过；旧库记录尚未对账 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F012 | 发送好友申请和验证留言 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F013 | 查看、同意或拒绝好友申请 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F014 | 联系人列表 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F015 | 联系人备注和个人分组 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F016 | 删除好友关系 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F017 | 查看联系人资料和共同群组 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F018 | 从收到的名片查看资料与加好友 | 有相关后端代码；旧业务逐项等价尚未验收 | social.go, profiles.go, client_completion.go | TestSavedFoldersChannelsAndPrivacyProfiles; TestMentionReplyPinsSearchAndContactCards |
| F019 | 发起或继续单聊 | 有相关后端代码；旧业务逐项等价尚未验收 | conversations.go, organization.go, groups.go | TestSavedFoldersChannelsAndPrivacyProfiles |
| F020 | 我的收藏会话 | 有相关后端代码；旧业务逐项等价尚未验收 | conversations.go, organization.go, groups.go | TestSavedFoldersChannelsAndPrivacyProfiles |
| F021 | 会话列表、摘要和未读状态 | 有相关后端代码；旧业务逐项等价尚未验收 | conversations.go, organization.go, groups.go | TestSavedFoldersChannelsAndPrivacyProfiles |
| F022 | 个人会话文件夹 | 有相关后端代码；旧业务逐项等价尚未验收 | conversations.go, organization.go, groups.go | TestSavedFoldersChannelsAndPrivacyProfiles |
| F023 | 创建、关注与退出频道 | 有相关后端代码；旧业务逐项等价尚未验收 | conversations.go, organization.go, groups.go | TestSavedFoldersChannelsAndPrivacyProfiles |
| F024 | 客服类型会话（接口能力） | 用户此前明确排除 | — | 原范围决策，未自行新增排除 |
| F025 | 会话置顶、免打扰与归档 | 有相关后端代码；旧业务逐项等价尚未验收 | conversations.go, organization.go, groups.go | TestSavedFoldersChannelsAndPrivacyProfiles |
| F026 | 隐藏和重新打开会话 | 有相关后端代码；旧业务逐项等价尚未验收 | conversations.go, organization.go, groups.go | TestSavedFoldersChannelsAndPrivacyProfiles |
| F027 | 文字消息 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F028 | 图片消息：选择、预览、发送与原图 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F029 | 视频消息：选择、预览与播放 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F030 | 语音消息：录制、试听、发送与播放 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F031 | 文件消息：发送条件、接收、查看与下载 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F032 | 发送联系人名片 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F033 | 引用回复 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F034 | @成员与@所有人 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F035 | 搜索、按日期筛选和定位消息 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F036 | 共享图片、视频和文件列表 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F037 | 已读回执与群消息阅读数量 | 新后端回归通过；旧库记录尚未对账 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F038 | 编辑文字消息 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F039 | 删除指定消息或清空个人历史 | 新后端回归通过；旧库记录尚未对账 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F040 | 标记会话未读 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F041 | 置顶和取消置顶消息 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F042 | 单条、多条消息转发与目标选择 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, message_content.go, global_search.go, delivery_jobs.go, media.go | TestMentionReplyPinsSearchAndContactCards; TestPrivateMediaOriginalForwardRevocationAndRange; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F043 | 创建群组与选择初始成员 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F044 | 按群号或邀请码加入群组 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F045 | 维护群资料和公告 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F046 | 群成员列表与搜索 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F047 | 邀请候选人和批量拉人 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F048 | 设置或取消群管理员 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F049 | 移除群成员和退出群组 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F050 | 定时、永久成员禁言及解除 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F051 | 全员禁言、互加好友和入群规则 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F052 | 转让群主与解散群组 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F053 | 禁言提示、输入框禁用与解除恢复 | 有相关后端代码；旧业务逐项等价尚未验收 | groups.go, client_completion.go, profile_media.go | social_groups_test.go; contact_policy_test.go |
| F054 | 创建单选或多选投票 | 用户此前明确排除 | — | 原范围决策，未自行新增排除 |
| F055 | 投票、改投、查看结果和结束 | 用户此前明确排除 | — | 原范围决策，未自行新增排除 |
| F056 | 手机号、邀请等隐私设置及例外名单 | 有相关后端代码；旧业务逐项等价尚未验收 | privacy.go, profiles.go, activity.go, maintenance.go | TestMaintenanceStalePreviewAndProtectedUsers; TestSavedFoldersChannelsAndPrivacyProfiles |
| F057 | 在线状态与最近活动可见性 | 有相关后端代码；旧业务逐项等价尚未验收 | privacy.go, profiles.go, activity.go, maintenance.go | TestMaintenanceStalePreviewAndProtectedUsers; TestSavedFoldersChannelsAndPrivacyProfiles |
| F058 | 黑名单与解除屏蔽 | 有相关后端代码；旧业务逐项等价尚未验收 | privacy.go, profiles.go, activity.go, maintenance.go | TestMaintenanceStalePreviewAndProtectedUsers; TestSavedFoldersChannelsAndPrivacyProfiles |
| F059 | 长期不活跃自动注销 | 有相关后端代码；旧业务逐项等价尚未验收 | privacy.go, profiles.go, activity.go, maintenance.go | TestMaintenanceStalePreviewAndProtectedUsers; TestSavedFoldersChannelsAndPrivacyProfiles |
| F060 | 个人通知中心与未读数 | 有相关后端代码；旧业务逐项等价尚未验收 | notifications.go, push.go, media.go, media_processing.go | TestPushProviderProtocolAndNotificationPrivacy; TestPrivateMediaOriginalForwardRevocationAndRange |
| F061 | 手机后台消息推送与设备登记 | 本机模拟或配置接口已接入；真实平台未验收 | notifications.go, push.go, media.go, media_processing.go | TestPushProviderProtocolAndNotificationPrivacy; TestPrivateMediaOriginalForwardRevocationAndRange |
| F062 | 上传文件校验与附件归属 | 有相关后端代码；旧业务逐项等价尚未验收 | notifications.go, push.go, media.go, media_processing.go | TestPushProviderProtocolAndNotificationPrivacy; TestPrivateMediaOriginalForwardRevocationAndRange |
| F063 | 受权限保护的附件读取和图片预览 | 新后端回归通过；旧库记录尚未对账 | notifications.go, push.go, media.go, media_processing.go | TestPushProviderProtocolAndNotificationPrivacy; TestPrivateMediaOriginalForwardRevocationAndRange |
| F064 | 撤回可见消息 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, admin_groups.go, social.go, delivery_jobs.go | TestQueuedForwardRetryCancelAndDispatchPermission; review_test.go |
| F065 | 内部资料查看（登录设备、IP 等） | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, admin_groups.go, social.go, delivery_jobs.go | TestQueuedForwardRetryCancelAndDispatchPermission; review_test.go |
| F066 | 免申请直接添加好友 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, admin_groups.go, social.go, delivery_jobs.go | TestQueuedForwardRetryCancelAndDispatchPermission; review_test.go |
| F067 | 单聊抖动提醒 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, admin_groups.go, social.go, delivery_jobs.go | TestQueuedForwardRetryCancelAndDispatchPermission; review_test.go |
| F068 | 群发助手 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, admin_groups.go, social.go, delivery_jobs.go | TestQueuedForwardRetryCancelAndDispatchPermission; review_test.go |
| F069 | 多账号切换 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F070 | 记住登录账号和凭据 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F071 | 独立多开主窗口 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F072 | 独立聊天、历史和大图窗口 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F073 | 应用口令锁定 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F074 | PC托盘与开机启动 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F075 | 输入框草稿保留 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F076 | 文字待发、失败重试和删除 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, delivery_jobs.go, media.go | TestMediaProcessingAndCancelledUpload; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F077 | 图片、视频、文件及已录好语音的持久待发 | 有相关后端代码；旧业务逐项等价尚未验收 | messages.go, delivery_jobs.go, media.go | TestMediaProcessingAndCancelledUpload; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F078 | 本地会话、联系人和群频道目录 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F079 | 本地聊天历史优先读取 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F080 | 本地数据隔离和加密 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F081 | 本地图片、语音和视频缓存 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F082 | 头像缓存与加载恢复 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F083 | 清理本地缓存和查看存储占用 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F084 | 设置导出 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F085 | 图片上传进度、停止与失败重试 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F086 | 手机拍照发送与桌面截图入口边界 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F087 | 图片大图和GIF查看 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F088 | 受控下载队列、进度和取消 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F089 | 媒体自动加载和大小限制 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F090 | 表情与最近使用 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F091 | 系统消息提醒 | 有相关后端代码；旧业务逐项等价尚未验收 | notifications.go, push.go, sync.go, realtime.go | TestPushProviderProtocolAndNotificationPrivacy; reliability_test.go |
| F092 | 通知静音、内容预览和提示音 | 有相关后端代码；旧业务逐项等价尚未验收 | notifications.go, push.go, sync.go, realtime.go | TestPushProviderProtocolAndNotificationPrivacy; reliability_test.go |
| F093 | 实时收发、断线重连与历史补齐 | 有相关后端代码；旧业务逐项等价尚未验收 | notifications.go, push.go, sync.go, realtime.go | TestPushProviderProtocolAndNotificationPrivacy; reliability_test.go |
| F094 | 离开界面时取消过期读取 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F095 | 图片可见性与多窗口共享下载释放 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F096 | 线路选择与代理配置 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F097 | 深浅主题和跟随系统 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F098 | 聊天字体、字号与界面阅读调整 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F099 | 麦克风、输出音量与设备设置 | 保留客户端能力，暂停联调 | — | 本轮只补后端 |
| F100 | 发现页内置网页 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go, notifications.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F101 | 客户端检查更新 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go, notifications.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F102 | 本地诊断日志和问题报告 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go, notifications.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F103 | 后台登录与会话退出 | 有相关后端代码；旧业务逐项等价尚未验收 | admin.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F104 | 超级管理员、操作员与审计员 | 有相关后端代码；旧业务逐项等价尚未验收 | admin.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F105 | 后台账号创建、编辑与停用（菜单隐藏） | 有相关后端代码；旧业务逐项等价尚未验收 | admin.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F106 | 后台权限变更后撤销旧会话 | 有相关后端代码；旧业务逐项等价尚未验收 | admin.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F107 | 后台独立入口与 IP 访问限制 | 有相关后端代码；旧业务逐项等价尚未验收 | admin.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F108 | 用户、消息与数据库概况 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, ip_location.go | TestLocationRefreshAndBackgroundAuditRead |
| F109 | 注册来源地区统计 | 本机模拟或配置接口已接入；真实平台未验收 | admin_operations.go, ip_location.go | TestLocationRefreshAndBackgroundAuditRead |
| F110 | 异地登录线索 | 本机模拟或配置接口已接入；真实平台未验收 | admin_operations.go, ip_location.go | TestLocationRefreshAndBackgroundAuditRead |
| F111 | 用户检索、筛选与资料查看 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F112 | 创建用户与批量开户 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F113 | 修改用户资料、密码和头像 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F114 | 查看已保存的用户密码 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F115 | 冻结、恢复与删除用户 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F116 | 用户能力、内部员工及正式员工标记 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F117 | 强制退出和重置用户登录凭据 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F118 | 清理指定用户可见的聊天历史 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, admin_bulk.go, admin_groups.go, profile_media.go | TestAdminIsolationCSRFPermissionsAndRevocation; TestAdminBatchGroupsDeviceViewAndConfigurationBounds; 原个人清理测试 |
| F119 | 手机绑定策略开关 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, configuration.go, admin_operations.go | TestTwoStepRecoveryReplayAndMobileBinding |
| F120 | 绑定设备查询 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, configuration.go, admin_operations.go | TestTwoStepRecoveryReplayAndMobileBinding |
| F121 | 单人解绑与全部解绑 | 有相关后端代码；旧业务逐项等价尚未验收 | accounts.go, configuration.go, admin_operations.go | TestTwoStepRecoveryReplayAndMobileBinding |
| F122 | 后台群组检索与详情 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_groups.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F123 | 创建群组和维护群规则 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_groups.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F124 | 停用和删除群组 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_groups.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F125 | 跨会话消息查询 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, configuration.go, messages.go | TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F126 | 后台撤回消息与人工内容查看 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, configuration.go, messages.go | TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F127 | 敏感词词库维护 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, configuration.go, messages.go | TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F128 | 文字敏感词替换规则 | 有相关后端代码；旧业务逐项等价尚未验收 | admin_operations.go, configuration.go, messages.go | TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F129 | 全局公告编辑和发布 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F130 | 任务档案与工作参数 | 新后端回归通过；旧库记录尚未对账 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F131 | 任务启停与受保护删除 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F132 | 按日期生成和重置任务验证码 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F133 | 每日题目快照与重复进入 | 新后端回归通过；旧库记录尚未对账 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F134 | 题目检索、编辑和删除 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F135 | 题目图片上传和归属检查 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F136 | Excel、CSV 批量导入题库 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F137 | 题库模板与导出 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F138 | 答题进度保存与完整提交 | 新后端回归通过；旧库记录尚未对账 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F139 | 提交后自动判分并计算工资 | 新后端回归通过；旧库记录尚未对账 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F140 | 遗留待审记录人工批改 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F141 | 作业明细与历史查询 | 有相关后端代码；旧业务逐项等价尚未验收 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F142 | 工资明细导出与业务边界 | 新后端回归通过；旧库记录尚未对账 | work_tasks.go, work_review.go, work_import.go, xls_pictures.go | TestWorkTaskSnapshotGradingAndProtectedDelete; TestQuestionImportExportEmbeddedAndManualReview; TestLegacyXLSWithEmbeddedBitmap |
| F143 | 分发计划与接收目标 | 有相关后端代码；旧业务逐项等价尚未验收 | delivery_jobs.go, delivery_controls.go | TestQueuedForwardRetryCancelAndDispatchPermission; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F144 | 分步骤文字、图片和图文内容 | 有相关后端代码；旧业务逐项等价尚未验收 | delivery_jobs.go, delivery_controls.go | TestQueuedForwardRetryCancelAndDispatchPermission; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F145 | 一次性与循环定时执行 | 有相关后端代码；旧业务逐项等价尚未验收 | delivery_jobs.go, delivery_controls.go | TestQueuedForwardRetryCancelAndDispatchPermission; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F146 | 分发运行结果、停用和修改保护 | 有相关后端代码；旧业务逐项等价尚未验收 | delivery_jobs.go, delivery_controls.go | TestQueuedForwardRetryCancelAndDispatchPermission; TestCompoundMessageIsAtomicAndSensitiveTextOnly |
| F147 | 客户端版本、最低版本与强制更新 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F148 | 安装包下载地址与更新说明 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F149 | 注册头像要求、同 IP 数量和群人数展示 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F150 | 商城或外部服务导航 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F151 | API、WebSocket 与媒体线路管理 | 有相关后端代码；旧业务逐项等价尚未验收 | configuration.go | TestAdminBatchGroupsDeviceViewAndConfigurationBounds |
| F152 | 登录成功与失败日志 | 有相关后端代码；旧业务逐项等价尚未验收 | auth.go, admin_operations.go, notifications.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F153 | 后台操作审计 | 有相关后端代码；旧业务逐项等价尚未验收 | auth.go, admin_operations.go, notifications.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F154 | 已上传的客户端诊断日志 | 有相关后端代码；旧业务逐项等价尚未验收 | auth.go, admin_operations.go, notifications.go | TestAdminIsolationCSRFPermissionsAndRevocation |
| F155 | 闲置账号筛选和清理预览 | 有相关后端代码；旧业务逐项等价尚未验收 | maintenance.go | TestMaintenanceStalePreviewAndProtectedUsers |
| F156 | 过期凭据、缓存和日志清理 | 有相关后端代码；旧业务逐项等价尚未验收 | maintenance.go | TestMaintenanceStalePreviewAndProtectedUsers |
| F157 | 定时清理、执行进度和历史结果 | 有相关后端代码；旧业务逐项等价尚未验收 | maintenance.go | TestMaintenanceStalePreviewAndProtectedUsers |
| F158 | 通过 Telegram 查询任务验证码 | 本机模拟或配置接口已接入；真实平台未验收 | telegram.go | TestTelegramSecretGrantPINAndReplay |
| F159 | 通过 Telegram 创建后台账号 | 本机模拟或配置接口已接入；真实平台未验收 | telegram.go | TestTelegramSecretGrantPINAndReplay |
| F160 | 查询本人关联后台入口 | 本机模拟或配置接口已接入；真实平台未验收 | telegram.go | TestTelegramSecretGrantPINAndReplay |
| F161 | 通过 Telegram 管理后台 IP 白名单 | 用户此前明确排除 | — | 原范围决策，未自行新增排除 |
| F162 | WebSocket 实时服务与 Redis 加速选项 | 有相关后端代码；旧业务逐项等价尚未验收 | realtime.go, outbox.go, push.go, observability.go, scripts/sample-backend.* | reliability_test.go; observability.go; 独立资源约束压测报告 |
| F163 | 持久实时事件排序进程 | 有相关后端代码；旧业务逐项等价尚未验收 | realtime.go, outbox.go, push.go, observability.go, scripts/sample-backend.* | reliability_test.go; observability.go; 独立资源约束压测报告 |
| F164 | Android、iOS 离线通知工作进程 | 本机模拟或配置接口已接入；真实平台未验收 | realtime.go, outbox.go, push.go, observability.go, scripts/sample-backend.* | reliability_test.go; observability.go; 独立资源约束压测报告 |
| F165 | 系统健康检查与进程部署模板 | 有相关后端代码；旧业务逐项等价尚未验收 | realtime.go, outbox.go, push.go, observability.go, scripts/sample-backend.* | reliability_test.go; observability.go; 独立资源约束压测报告 |
| F166 | 服务器峰值诊断采样工具 | 有相关后端代码；旧业务逐项等价尚未验收 | realtime.go, outbox.go, push.go, observability.go, scripts/sample-backend.* | reliability_test.go; observability.go; 独立资源约束压测报告 |

旧库迁移详情见 [LEGACY-MIGRATION.md](LEGACY-MIGRATION.md)；容量测试详情见 [BACKEND-LOAD-2026-11-11.md](BACKEND-LOAD-2026-11-11.md)。
