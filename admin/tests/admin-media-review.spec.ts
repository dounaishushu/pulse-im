import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const fixture = JSON.parse(
  readFileSync(process.env.PULSE_ADMIN_FIXTURE!, "utf8"),
);
if (
  !/^pulse_admin_ui_[a-f0-9]+_test$/.test(fixture.database) ||
  new URL(fixture.base).hostname !== "127.0.0.1"
)
  throw new Error("Isolated fixture required");
async function login(page: Page) {
  await page.goto("/");
  await page.evaluate(
    (value) => sessionStorage.setItem("pulse.go.admin.entry", value),
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
async function png(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#edf3ff";
    ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = "#5d87ff";
    ctx.fillRect(20, 20, 80, 40);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(base64, "base64");
}

test("avatar, question image upload and CSV import use real Go media", async ({
  page,
}, info) => {
  await login(page);
  const image = await png(page),
    account = fixture.prefixes.web + "b";
  await page.locator('nav a[href="#/users"]').click();
  await page.locator(".filters input").first().fill(account);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  const row = page.locator(".el-table__body tr").filter({ hasText: account });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .locator(".el-drawer:visible")
    .getByLabel("昵称", { exact: true })
    .fill("媒体回归用户");
  await page.locator(".el-drawer:visible input[type=file]").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(page.locator(".upload-preview img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await page
    .locator(".el-drawer:visible")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.locator(".el-drawer:visible")).toHaveCount(0);
  await expect(row.locator("img")).toBeVisible();

  await page.locator('nav a[href="#/question-bank"]').click();
  await page.getByRole("button", { name: "新增", exact: true }).click();
  const code = crypto.randomUUID();
  await page
    .locator(".el-drawer:visible")
    .getByLabel("题目编号", { exact: true })
    .fill(code);
  await page.locator(".el-drawer:visible input[type=file]").setInputFiles({
    name: "question.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(page.locator(".upload-preview img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await page
    .locator(".el-drawer:visible")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.locator(".el-drawer:visible")).toHaveCount(0);
  await expect(
    page.locator(".el-table__body tr").filter({ hasText: code }).locator("img"),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("questions-light.png"),
    fullPage: true,
  });
  const imported = crypto.randomUUID();
  await page.locator('input[accept=".xlsx,.xls,.csv"]').setInputFiles({
    name: "questions.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "\ufeffUUID,图片地址,答案\r\n" +
        imported +
        ",https://example.invalid/import.png,1\r\n",
    ),
  });
  await expect(page.getByText("题库导入完成", { exact: true })).toBeVisible();
  const result = await api(page, "/admin/work-questions?uuid=" + imported);
  expect(
    result.items.some((row: any) => row.question_uuid === imported),
  ).toBeTruthy();
});

test("review an imported pending record and export the result", async ({
  page,
}, info) => {
  await login(page);
  const taskName = "逐题批改回归 " + Date.now();
  for (const correct of ["1", "0"])
    await api(page, "/admin/work-questions", {
      question_uuid: crypto.randomUUID(),
      image_url: "https://example.invalid/review.png",
      correct_answer: correct,
    });
  const task = await api(page, "/admin/work-tasks", {
    task_key: "review" + Date.now(),
    name: taskName,
    open_time: "00:00",
    estimated_minutes: 10,
    question_count: 2,
    intern_unit_price: "0.100",
    formal_unit_price: "0.200",
    sort_order: 0,
    status: "enabled",
  });
  const code = await api(page, "/admin/work-tasks/code?task_id=" + task.id);
  const started = await page.evaluate(
    async ({ account, password, task, code }) => {
      const auth = await fetch("/api/v2/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account,
          password,
          device_id: "admin-ui-test",
          platform: "web",
        }),
      }).then((r) => r.json());
      const response = await fetch(
        "/api/v2/tasks/" + window.PulseGoAdmin.wire("task", task.id) + "/start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + auth.access_token,
          },
          body: JSON.stringify({ code: code.code }),
        },
      );
      return { status: response.status, record: await response.json() };
    },
    {
      account: fixture.prefixes.web + "c",
      password: fixture.password,
      task,
      code,
    },
  );
  expect(started.status).toBe(200);
  const id = started.record.id;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  // Represent the old PHP pending-review state in this explicitly isolated database.
  const sql = `UPDATE pulse.work_records SET status='pending_review',submitted_at=now(),answers=(SELECT jsonb_object_agg(q->>'id',true) FROM jsonb_array_elements(questions)q) WHERE id='${id}'`;
  execFileSync(
    "C:/Program Files/PostgreSQL/17/bin/psql.exe",
    [
      "-XAt",
      "-w",
      "-h",
      "127.0.0.1",
      "-p",
      "15439",
      "-U",
      "pulse_test",
      "-d",
      fixture.database,
      "-c",
      sql,
    ],
    { stdio: "pipe", windowsHide: true },
  );
  await page.locator('nav a[href="#/task-records"]').click();
  await expect(
    page.locator(".el-table__body tr").filter({ hasText: taskName }),
  ).toHaveCount(1);
  await page
    .locator(".el-table__body tr")
    .filter({ hasText: taskName })
    .getByRole("button", { name: "查看详情", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "第 1 题", exact: true }),
  ).toBeVisible();
  await page
    .locator(".el-drawer:visible")
    .getByRole("button", { name: "按标准答案批改", exact: true })
    .click();
  await expect(page.locator(".review-metrics")).toContainText("2 / 2");
  await page.getByRole("button", { name: "批改错误", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("record-review-light.png"),
    fullPage: true,
  });
  await page
    .locator(".el-drawer:visible")
    .getByRole("button", { name: "保存批改", exact: true })
    .click();
  await expect(page.locator(".el-drawer:visible")).toHaveCount(0);
  await expect(
    page.locator(".el-table__body tr").filter({ hasText: taskName }),
  ).toContainText("已完成");
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出记录", exact: true }).click();
  expect((await event).suggestedFilename()).toBe("作业记录.xlsx");
});
