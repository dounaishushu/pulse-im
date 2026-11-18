const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
const { chromium } = require("../../admin/node_modules/@playwright/test");
const cfg = JSON.parse(
  fs.readFileSync(
    process.env.PULSE_WEB_TEST_FIXTURE ||
      path.join(__dirname, "vue-fixtures.private.json"),
  ),
);
if (!["127.0.0.1", "localhost"].includes(new URL(cfg.base).hostname))
  throw Error(
    "Account browser fixtures must use an isolated localhost backend",
  );
const checks = [];
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const errors = [];
  try {
    const context = await browser.newContext();
    await context.addInitScript(
      ({ base, token }) => {
        localStorage.setItem(
          "pulse_go_v2:" + encodeURIComponent(base) + ":token",
          token,
        );
      },
      { base: cfg.ui + "/api/v2", token: cfg.logins.vueowner01.access_token },
    );
    let page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(cfg.ui);
    await page.locator("[data-workspace-runtime=vue]").waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) => key.endsWith(":token"))
            .length,
      ),
      0,
    );
    checks.push(
      "legacy single-account token is adopted and removed only after encrypted persistence",
    );
    await context.close();
    const failure = await browser.newContext({
      viewport: { width: 1200, height: 900 },
    });
    page = await failure.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    let fail = true;
    await page.route("**/api/v2/me/profile", (route) =>
      fail
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "unavailable" } }),
          })
        : route.continue(),
    );
    await page.goto(cfg.ui);
    await page
      .getByLabel("用户名 / 手机号", { exact: true })
      .fill("vueowner01");
    await page.locator("#password").fill(cfg.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page
      .getByRole("heading", { name: "暂时无法进入聊天", exact: true })
      .waitFor();
    const hasCredential = await page.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open("pulse-web-accounts-v1");
        request.onsuccess = () => resolve(request.result);
      });
      return new Promise((resolve) => {
        const request = db
          .transaction("accounts")
          .objectStore("accounts")
          .getAll();
        request.onsuccess = () =>
          resolve(
            request.result.some((row) => row.sealed instanceof ArrayBuffer),
          );
      });
    });
    assert.ok(hasCredential);
    fail = false;
    await page.getByRole("button", { name: "重新进入", exact: true }).click();
    await page.locator("[data-workspace-runtime=vue]").waitFor();
    checks.push(
      "successful login retains its encrypted session across profile initialization failures and retry",
    );
    await page
      .getByRole("button", { name: "切换或添加账号", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "已登录账号" })
      .getByRole("button", { name: "添加账号", exact: true })
      .click();
    await page
      .getByLabel("用户名 / 手机号", { exact: true })
      .fill("vuemember01");
    await page.locator("#password").fill("wrong-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page
      .locator(".pc-auth-error")
      .filter({ hasText: /登录|账号|密码/ })
      .waitFor();
    await page
      .getByRole("button", { name: "返回已登录账号", exact: true })
      .click();
    await page.locator("[data-workspace-runtime=vue]").waitFor();
    checks.push("a rejected extra login leaves the original account usable");
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "切换或添加账号", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "已登录账号" })
      .getByRole("button", { name: "添加账号", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(
        path.dirname(process.env.PULSE_WEB_TEST_FIXTURE || __filename),
        "accounts-mobile.png",
      ),
      fullPage: true,
    });
    checks.push(
      "account management remains reachable on the mobile Web layout",
    );
    assert.deepEqual(errors, []);
    await failure.close();
  } finally {
    await browser.close();
    fs.writeFileSync(
      path.join(
        path.dirname(process.env.PULSE_WEB_TEST_FIXTURE || __filename),
        "account-edges-e2e.json",
      ),
      JSON.stringify({ passed: checks.length, checks }, null, 2),
    );
  }
  console.log("PASS " + checks.join("\nPASS "));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
