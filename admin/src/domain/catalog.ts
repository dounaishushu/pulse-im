export const pages = [
  {
    key: "dashboard",
    title: "运营总览",
    group: "工作空间",
    icon: "DataAnalysis",
    description: "连接、用户与系统状态，一目了然",
    manage: false,
  },
  {
    key: "users",
    title: "用户管理",
    group: "用户与沟通",
    icon: "User",
    description: "管理用户资料、账号状态与业务权限",
    manage: true,
  },
  {
    key: "devices",
    title: "设备管理",
    group: "用户与沟通",
    icon: "Iphone",
    description: "查看手机绑定，管理设备锁策略",
    manage: true,
  },
  {
    key: "groups",
    title: "群组管理",
    group: "用户与沟通",
    icon: "ChatLineSquare",
    description: "群组、频道及客服会话的统一管理",
    manage: true,
  },
  {
    key: "messages",
    title: "消息与会话",
    group: "用户与沟通",
    icon: "ChatDotRound",
    description: "检索会话与消息，查看完整内容",
    manage: true,
  },
  {
    key: "moderation",
    title: "内容审核",
    group: "内容与安全",
    icon: "CircleCheck",
    description: "检查消息内容，处理违规信息",
    manage: true,
  },
  {
    key: "sensitive-words",
    title: "敏感词管理",
    group: "内容与安全",
    icon: "Filter",
    description: "配置文字匹配与替换规则",
    manage: true,
  },
  {
    key: "announcement",
    title: "通知公告",
    group: "内容与安全",
    icon: "Bell",
    description: "编辑用户启动公告并即时预览",
    manage: true,
  },
  {
    key: "login-logs",
    title: "系统日志",
    group: "内容与安全",
    icon: "Document",
    description: "登录记录、客户端诊断和操作审计",
    manage: false,
  },
  {
    key: "dispatch-tasks",
    title: "分发任务",
    group: "任务与作业",
    icon: "Promotion",
    description: "编排发送内容、接收对象与执行计划",
    manage: true,
  },
  {
    key: "task-config",
    title: "任务配置",
    group: "任务与作业",
    icon: "Calendar",
    description: "配置任务时间、题量和计件单价",
    manage: true,
  },
  {
    key: "question-bank",
    title: "题库管理",
    group: "任务与作业",
    icon: "Reading",
    description: "维护图片题目与标准答案，导入导出题库",
    manage: true,
  },
  {
    key: "task-records",
    title: "作业记录",
    group: "任务与作业",
    icon: "EditPen",
    description: "批改作业，核对用时与工资明细",
    manage: true,
  },
  {
    key: "client-config",
    title: "客户端配置",
    group: "系统设置",
    icon: "Monitor",
    description: "四端更新、注册策略与探索入口",
    manage: true,
  },
  {
    key: "routes",
    title: "线路管理",
    group: "系统设置",
    icon: "Connection",
    description: "管理客户端 API、实时与媒体线路",
    manage: true,
  },
  {
    key: "maintenance",
    title: "数据清理",
    group: "系统设置",
    icon: "Brush",
    description: "预览与清理过期数据，管理定时计划",
    manage: true,
  },
  {
    key: "admin-accounts",
    title: "后台账号",
    group: "系统设置",
    icon: "Key",
    description: "管理员角色、页面权限和专属入口",
    manage: true,
  },
] as const;
export type PageKey = (typeof pages)[number]["key"];
export const roles = {
  admin: "超级管理员",
  operator: "自定义权限账号",
  auditor: "只读账号",
};
export const statusLabels: Record<string, string> = {
  active: "正常",
  frozen: "已冻结",
  deleted: "已删除",
  enabled: "启用",
  disabled: "停用",
  sent: "已发送",
  recalled: "已撤回",
  pending_review: "待批改",
  reviewed: "已完成",
  in_progress: "进行中",
  open: "开放中",
  waiting: "等待中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  success: "成功",
  scheduled: "已计划",
  cancelled: "已取消",
};
export const labelStatus = (value: string) =>
  statusLabels[value] || value || "—";
export const tagStatus = (value: string) =>
  [
    "active",
    "enabled",
    "reviewed",
    "completed",
    "success",
    "sent",
    "open",
  ].includes(value)
    ? ("success" as const)
    : ["frozen", "deleted", "failed", "recalled"].includes(value)
      ? ("danger" as const)
      : ["pending_review", "running", "in_progress", "scheduled"].includes(
            value,
          )
        ? ("warning" as const)
        : ("info" as const);
export const platforms: Record<string, string> = {
  pc: "电脑端",
  web: "网页端",
  android: "Android",
  ios: "iOS",
};
export const options = (items: Record<string, string>) =>
  Object.entries(items).map(([value, label]) => ({ value, label }));
export const formatTime = (value: string | number) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(date);
};
export const publicId = (row: Record<string, any>) =>
  row.public_id || row.legacy_public_id || row.member_id || row.id;
