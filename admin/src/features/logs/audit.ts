import type { RecordData } from "../../domain/types";
const labels: Record<string, string> = {
  "admin.login": "后台登录",
  "admin.logout": "后台退出",
  "admin.login_failed": "后台登录失败",
  "admin.access_denied": "后台越权访问已拦截",
  "user.status": "用户状态变更",
  "user.permission": "用户权限变更",
  "user.edit": "编辑用户资料",
  "user.create": "新增用户",
  "user.batch_create": "批量创建用户",
  "user.clear_chat": "清理用户聊天",
  "user.reset_token": "重置用户令牌",
  "user.logout": "强制下线",
  "user.delete": "删除用户",
  "message.moderate_recall": "管理员撤回消息",
  "group.create": "新增群组",
  "group.update": "修改群组",
  "group.delete": "删除群组",
  "client.diagnostics": "客户端诊断",
  "announcement.update": "修改通知公告",
  "client_navigation.update": "修改探索入口",
  "admin_account.create": "新增后台账号",
  "admin_account.update": "编辑后台账号",
  "admin_account.status": "变更后台账号状态",
  "admin_account.password_reset": "重置后台账号密码",
  "admin.account.create": "新增后台账号",
  "admin.account.update": "编辑后台账号",
  "admin.account.status": "变更后台账号状态",
  "admin.password_reset": "重置后台密码",
  "dispatch.task.create": "新增分发任务",
  "dispatch.task.update": "修改分发任务",
  "dispatch.task.status": "更改分发任务状态",
  "dispatch.task.delete": "删除分发任务",
  "mobile_device.unbind": "解绑手机设备",
  "mobile_device.unbind_all": "解绑全部手机",
  "mobile_device.policy": "设备锁策略",
  "maintenance.settings": "修改清理计划",
  "maintenance.start": "手动清理数据",
};
export function auditLabel(row: RecordData) {
  return labels[row.action] || row.action || "未知操作";
}
export function auditDetail(row: RecordData) {
  const detail = row.detail || {};
  if (row.action !== "client.diagnostics") return detail;
  return {
    应用名称: detail.app_name,
    应用版本: detail.app_version,
    平台: detail.platform,
    设备型号: detail.model,
    系统版本: detail.sdk,
    上传方式: detail.upload_mode,
    诊断编号: detail.diagnostic_id,
    异常记录: detail.incidents || [],
    操作记录: detail.events || [],
    ...detail,
  };
}
