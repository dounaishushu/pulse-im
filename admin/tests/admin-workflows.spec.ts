import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(
  readFileSync(process.env.PULSE_ADMIN_FIXTURE!, "utf8"),
);
if (
  !String(fixture.database).startsWith("pulse_admin_ui_") ||
  !String(fixture.database).endsWith("_test") ||
  new URL(fixture.base).hostname !== "127.0.0.1"
)
  throw new Error("Only isolated local fixture data may be mutated");
const password = "WorkflowTest_" + Date.now();
const errors: string[] = [];

async function login(page: Page) {
  await page.goto("/");
  await page.evaluate(
    (entry) => sessionStorage.setItem("pulse.go.admin.entry", entry),
    fixture.admin_entry,
  );
  await page
    .getByRole("textbox", { name: "管理员账号", exact: true })
    .fill(fixture.admin_account);
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill(fixture.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "运营总览", exact: true }),
  ).toBeVisible();
}
async function route(page: Page, key: string, title: string) {
  await page.locator(`nav a[href="#/${key}"]`).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator(".el-loading-mask:visible")).toHaveCount(0);
}
async function api(page: Page, path: string, body?: any) {
  return page.evaluate(
    async ({ path, body }) =>
      window.PulseGoAdmin.request(
        path,
        body === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(body) },
      ),
    { path, body },
  );
}
function drawer(page: Page) {
  return page.locator(".el-drawer:visible");
}
async function fillField(page: Page, label: string, value: string) {
  await drawer(page).getByLabel(label, { exact: true }).fill(value);
}
async function saveDrawer(page: Page, label = "保存") {
  await drawer(page).getByRole("button", { name: label, exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
}

test("real Go admin workflows, permissions and both themes", async ({
  page,
}, testInfo) => {
  const suffix = String(Date.now()).slice(-7);
  const groupName = "Vue 回归群组 " + suffix,
    word = "vue-workflow-" + suffix,
    dispatchName = "Vue 计划分发 " + suffix;
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.screenshot({
    path: testInfo.outputPath("dashboard-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换深色", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: testInfo.outputPath("dashboard-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换浅色", exact: true }).click();
  await page.getByRole("button", { name: "放大地图", exact: true }).click();
  await expect(page.locator(".map-tools")).toContainText("120%");

  await route(page, "users", "用户管理");
  await page.getByRole("button", { name: "新增用户", exact: true }).click();
  const account = "Vue" + String(Date.now()).slice(-6);
  await fillField(page, "账号", account);
  await fillField(page, "昵称", "界面回归用户");
  await fillField(page, "初始密码", "Workflow2026");
  await saveDrawer(page);
  await page.locator(".filters").getByRole("textbox").fill(account);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  const row = page.locator(".el-table__body tr").filter({ hasText: account });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await fillField(page, "昵称", "界面回归已编辑");
  await saveDrawer(page);
  await expect(row).toContainText("界面回归已编辑");
  await row
    .getByRole("switch", { name: `${account.toLowerCase()} 禁言`, exact: true })
    .locator("..")
    .click();
  await expect(
    row.getByRole("switch", {
      name: `${account.toLowerCase()} 禁言`,
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: testInfo.outputPath("users-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "批量建号", exact: true }).click();
  const batchPrefix = "batch" + String(Date.now()).slice(-4);
  await fillField(page, "账号前缀", batchPrefix);
  await drawer(page)
    .getByRole("spinbutton", { name: "创建数量", exact: true })
    .fill("2");
  await fillField(page, "初始密码", password);
  await saveDrawer(page, "创建用户");

  await route(page, "groups", "群组管理");
  await page.getByRole("button", { name: "新增群组", exact: true }).click();
  await drawer(page).locator(".entity-select .el-select").click();
  await page
    .getByRole("option")
    .filter({ hasText: fixture.prefixes.web + "a" })
    .click();
  await fillField(page, "群组名称", groupName);
  await saveDrawer(page);
  const groupRow = page
    .locator(".el-table__body tr")
    .filter({ hasText: groupName });
  await expect(groupRow).toHaveCount(1);
  await groupRow.getByRole("button", { name: "编辑", exact: true }).click();
  await fillField(page, "群公告", "这是 Vue 后台保存的群公告");
  await drawer(page)
    .getByRole("spinbutton", { name: "虚拟显示人数", exact: true })
    .fill("100");
  await saveDrawer(page);
  await expect(groupRow).toContainText("100 人");
  await groupRow.getByRole("button", { name: "编辑", exact: true }).click();
  await drawer(page)
    .locator('.el-select:has(input[aria-label="群组类型"])')
    .click();
  await page.getByRole("option", { name: "客服", exact: true }).click();
  await saveDrawer(page);
  await expect(groupRow).toContainText("客服");
  await groupRow.getByRole("button", { name: "编辑", exact: true }).click();
  await drawer(page)
    .locator('.el-select:has(input[aria-label="群组类型"])')
    .click();
  await page.getByRole("option", { name: "群组", exact: true }).click();
  await saveDrawer(page);

  await route(page, "sensitive-words", "敏感词管理");
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await fillField(page, "匹配文字", word);
  await fillField(page, "替换文字", "[已过滤]");
  await saveDrawer(page);
  await expect(page.locator(".el-table__body")).toContainText(word);
  await page
    .locator(".el-table__body tr")
    .filter({ hasText: word })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await fillField(page, "替换文字", "[新版替换]");
  await saveDrawer(page);
  await expect(page.locator(".el-table__body")).toContainText("[新版替换]");

  await route(page, "announcement", "通知公告");
  await page
    .getByRole("textbox", { name: "公告标题", exact: true })
    .fill("新版后台公告");
  await page
    .getByRole("textbox", { name: "公告正文", exact: true })
    .fill("欢迎使用 {app_name}，<script>bad()</script>");
  await page.getByRole("button", { name: "保存公告", exact: true }).click();
  await expect(page.locator(".notice-preview")).toContainText(
    "欢迎使用 脉冲即时通讯，<script>bad()</script>",
  );
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "公告标题", exact: true }),
  ).toHaveValue("新版后台公告");

  await route(page, "question-bank", "题库管理");
  const questionA = crypto.randomUUID(),
    questionB = crypto.randomUUID();
  for (const [code, answer] of [
    [questionA, true],
    [questionB, false],
  ] as const) {
    await page.getByRole("button", { name: "新增", exact: true }).click();
    await fillField(page, "题目编号", code);
    await fillField(
      page,
      "题目图片地址",
      "https://example.invalid/question.png",
    );
    if (!answer) {
      await drawer(page).locator(".el-select").click();
      await page.getByRole("option", { name: "错", exact: true }).click();
    }
    await saveDrawer(page);
  }
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "模板", exact: true }).click();
  const file = await downloadEvent;
  expect(file.suggestedFilename()).toBe("题库导入模板.xlsx");

  await route(page, "task-config", "任务配置");
  await page.getByRole("button", { name: "新增", exact: true }).click();
  const taskKey = "vui" + String(Date.now()).slice(-5);
  await fillField(page, "任务标识", taskKey);
  await fillField(page, "任务名称", "Vue 每日任务");
  await drawer(page)
    .getByRole("spinbutton", { name: "题目数量", exact: true })
    .fill("2");
  await saveDrawer(page);
  const taskRow = page
    .locator(".el-table__body tr")
    .filter({ hasText: taskKey });
  await expect(taskRow).toHaveCount(1);
  await taskRow.getByRole("button", { name: "停用", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(taskRow).toContainText("停用");
  await taskRow.getByRole("button", { name: "验证码", exact: true }).click();
  await expect(page.locator(".task-code")).toHaveText(/^\d{6}$/);
  await page
    .locator(".el-dialog:visible")
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();

  await route(page, "dispatch-tasks", "分发任务");
  await page.getByRole("button", { name: "新增分发任务", exact: true }).click();
  await fillField(page, "任务名称", dispatchName);
  const entities = drawer(page).locator(".entity-select .el-select");
  await entities.nth(0).click();
  await page
    .getByRole("option")
    .filter({ hasText: fixture.prefixes.web + "a" })
    .click();
  await entities.nth(1).click();
  await page.getByRole("option").filter({ hasText: groupName }).click();
  await drawer(page)
    .getByRole("textbox", { name: "文字内容", exact: true })
    .fill("这是计划中的通知");
  await saveDrawer(page, "保存任务");
  await expect(page.locator(".el-table__body")).toContainText(dispatchName);

  await route(page, "client-config", "客户端配置");
  await page.getByRole("tab", { name: "探索与商城", exact: true }).click();
  await page
    .getByRole("button", { name: "添加入口", exact: true })
    .first()
    .click();
  await page.getByPlaceholder("入口名称").last().fill("新探索入口");
  await page
    .getByPlaceholder("https://example.com")
    .last()
    .fill("https://example.invalid/explore");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByText("客户端配置已保存", { exact: true }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("入口名称").last()).toHaveValue(
    "新探索入口",
  );

  await route(page, "routes", "线路管理");
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await fillField(page, "线路名称", "Vue HTTPS 线路 " + suffix);
  await fillField(
    page,
    "API 地址",
    `https://v${suffix}.example.invalid/api/v2`,
  );
  await fillField(
    page,
    "WebSocket 地址",
    `wss://v${suffix}.example.invalid/api/v2/realtime`,
  );
  await fillField(
    page,
    "媒体地址",
    `https://v${suffix}.example.invalid/api/v2`,
  );
  await saveDrawer(page);
  await expect(page.locator(".el-table__body")).toContainText("Vue HTTPS 线路");

  await route(page, "maintenance", "数据清理");
  await page.getByRole("button", { name: "预览账号", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "清理选中（0）", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "扫描可清理数据", exact: true })
    .click();
  await expect(page.locator(".cache-counts")).toContainText("过期用户登录凭据");

  await route(page, "admin-accounts", "后台账号");
  await page.getByRole("button", { name: "新增后台账号", exact: true }).click();
  const operator = "op" + String(Date.now()).slice(-6);
  await fillField(page, "管理员账号", operator);
  await fillField(page, "初始密码", password);
  await drawer(page)
    .getByRole("checkbox", { name: "用户管理查看权限", exact: true })
    .locator("..")
    .click();
  await saveDrawer(page);
  await expect(
    page.getByRole("heading", { name: "保存专属入口", exact: true }),
  ).toBeVisible();
  const entry = await page.locator(".el-dialog:visible textarea").inputValue();
  expect(new URL(entry).hash).toMatch(/^#[0-9a-f]{64}$/);
  await page.getByRole("button", { name: "已保存", exact: true }).click();

  for (const [key, title] of [
    ["devices", "设备管理"],
    ["messages", "消息与会话"],
    ["moderation", "内容审核"],
    ["login-logs", "系统日志"],
    ["task-records", "作业记录"],
  ])
    await route(page, key, title);
  await page.getByRole("button", { name: "切换深色", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "打开导航", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("records-mobile-dark.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".el-message--error")).toHaveCount(0);
  expect(errors).toEqual([]);

  await page.getByRole("button", { name: "账号菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "管理后台", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (entry) =>
      sessionStorage.setItem(
        "pulse.go.admin.entry",
        new URL(entry).hash.slice(1),
      ),
    entry,
  );
  await page
    .getByRole("textbox", { name: "管理员账号", exact: true })
    .fill(operator);
  await page.getByRole("textbox", { name: "密码", exact: true }).fill(password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "用户管理", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新增用户", exact: true }),
  ).toHaveCount(0);
  expect(await page.locator("nav a").count()).toBe(1);
  const result = await api(page, "/admin/users?page=1&size=1");
  expect(result.items).toHaveLength(1);
});
