const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
const { chromium } = require("../../admin/node_modules/@playwright/test");
const cfg = JSON.parse(
    fs.readFileSync(
      process.env.PULSE_WEB_TEST_FIXTURE ||
        path.join(__dirname, "vue-fixtures.private.json"),
    ),
  ),
  checks = [];
if (!["127.0.0.1", "localhost"].includes(new URL(cfg.base).hostname))
  throw Error(
    "Account browser fixtures must use an isolated localhost backend",
  );
let browser,
  page,
  current = "startup";
const step = async (name, fn) => {
  current = name;
  await fn();
  checks.push(name);
  console.log("PASS " + name);
};
(async () => {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(18000);
  const errors = [],
    requests = [],
    sessions = {};
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "warn") errors.push(message.text());
  });
  page.on("request", (req) => {
    if (req.url().includes("/api/v2/"))
      requests.push({
        url: req.url(),
        method: req.method(),
        token: req.headers().authorization,
        time: Date.now(),
        body: req.postData(),
      });
  });
  page.on("response", async (response) => {
    if (response.url().endsWith("/auth/login") && response.status() === 200) {
      const data = await response.json();
      sessions[JSON.parse(response.request().postData()).account] = data;
    }
  });
  const login = async (account) => {
    await page.getByLabel("用户名 / 手机号", { exact: true }).fill(account);
    await page.locator("#password").fill(cfg.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator("[data-workspace-runtime=vue]").waitFor();
  };
  const accounts = async () => {
    await page
      .getByRole("button", { name: /切换或添加账号$/ })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "已登录账号",
      exact: true,
    });
    await dialog.waitFor();
    return dialog;
  };
  const close = async () => {
    await page
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  };
  const ownerProfile = await (
    await context.request.get(cfg.base + "/me/profile", {
      headers: {
        Authorization: "Bearer " + cfg.logins.vueowner01.access_token,
      },
    })
  ).json();
  const ownerDisplay = ownerProfile.nickname;
  const previous = new URL("/__account-test-previous", cfg.ui).href;
  try {
    await page.route(previous, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Previous browser page</h1>",
      }),
    );
    await page.goto(previous);
    await step(
      "first login enters the workspace with isolated account storage",
      async () => {
        await page.goto(cfg.ui);
        await login("vueowner01");
        await page
          .getByRole("button", { name: /Vue完整验收群/ })
          .first()
          .click();
        await page.locator("[data-message-id]").first().waitFor();
        await page.locator("#message-input").fill("账号A独立草稿");
      },
    );
    await step(
      "browser Back dismisses an accidental add-account visit and restores the same chat",
      async () => {
        const dialog = await accounts();
        await dialog
          .getByRole("button", { name: "添加账号", exact: true })
          .click();
        const cancel = page.getByRole("button", {
          name: "返回已登录账号", exact: true,
        });
        await cancel.waitFor();
        await page.goBack();
        assert.equal(page.url(), new URL(cfg.ui).href);
        await dialog.waitFor();
        await page.goForward();
        await cancel.waitFor();
        await page.goBack();
        await dialog.waitFor();
        await close();
        await page
          .getByRole("heading", { name: "Vue完整验收群", exact: true })
          .waitFor();
        await page.waitForFunction(() =>
          document.querySelector("#message-input")?.textContent?.includes("账号A独立草稿"),
        );
      },
    );
    await step(
      "adding a second account preserves the first connection and restores the account list",
      async () => {
        const dialog = await accounts();
        await dialog
          .getByRole("button", { name: "添加账号", exact: true })
          .click();
        await page
          .getByRole("button", { name: "返回已登录账号", exact: true })
          .waitFor();
        await login("vuemember01");
        const list = await accounts();
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              "[role=dialog] [data-account-connected=true]",
            ).length === 2,
        );
        assert.equal(await list.locator("[data-account-id]").count(), 2);
        assert.equal(
          await page.locator("[data-workspace-runtime=vue]").count(),
          1,
        );
        await close();
      },
    );
    let sentAt = 0,
      marker = "后台账号收消息 " + Date.now();
    await step(
      "inactive account receives unread messages without reading its chat history",
      async () => {
        sentAt = Date.now();
        const response = await context.request.post(
          cfg.base + "/conversations/" + cfg.group + "/messages",
          {
            headers: {
              Authorization: "Bearer " + cfg.logins.vueadmin01.access_token,
            },
            data: {
              kind: "text",
              body: marker,
              request_id: "multi-inbox-" + Date.now(),
            },
          },
        );
        assert.ok(response.ok());
        const dialog = await accounts();
        const owner = dialog.locator("li").filter({ hasText: "vueowner01" });
        await owner.locator(".unread").waitFor();
        await close();
        const ownerToken = "Bearer " + sessions.vueowner01.access_token;
        assert.equal(
          requests.filter(
            (row) =>
              row.time >= sentAt &&
              row.token === ownerToken &&
              /\/(read|history)(?:\?|$)/.test(row.url),
          ).length,
          0,
        );
      },
    );
    await step(
      "switching restores the correct draft and authenticates sends with the selected account",
      async () => {
        const dialog = await accounts();
        await dialog
          .getByRole("button", { name: /vueowner01/ })
          .first()
          .click();
        await page.locator("#message-input").waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector("#message-input")?.textContent === "账号A独立草稿",
        );
        await page.getByText(marker, { exact: true }).waitFor();
        const text = "账号A发送归属 " + Date.now();
        await page.locator("#message-input").fill(text);
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page
          .locator("[data-message-id] .vue-message-text")
          .getByText(text, { exact: true })
          .waitFor();
        const call = requests.find(
          (row) =>
            row.method === "POST" &&
            /\/messages$/.test(row.url) &&
            row.body?.includes(text),
        );
        assert.equal(call?.token, "Bearer " + sessions.vueowner01.access_token);
      },
    );
    await step(
      "saved tokens are encrypted with a nonextractable browser key and plaintext passwords are absent",
      async () => {
        const result = await page.evaluate(async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("pulse-web-accounts-v1");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const read = (store) =>
            new Promise((resolve) => {
              const request = db.transaction(store).objectStore(store).getAll();
              request.onsuccess = () => resolve(request.result);
            });
          const rows = await read("accounts"),
            keys = await read("keys");
          return {
            encrypted: rows.every(
              (row) =>
                row.sealed instanceof ArrayBuffer &&
                row.iv &&
                row.token === undefined &&
                row.password === undefined,
            ),
            keyExtractable: keys[0]?.extractable,
            localValues: Object.values(localStorage).join("|"),
          };
        });
        assert.equal(result.encrypted, true);
        assert.equal(result.keyExtractable, false);
        for (const session of Object.values(sessions))
          assert.ok(!result.localValues.includes(session.access_token));
        assert.ok(!result.localValues.includes(cfg.password));
      },
    );
    await step(
      "refresh restores both online accounts and the active selection",
      async () => {
        await page.reload();
        await page
          .getByRole("heading", { name: "Vue完整验收群", exact: true })
          .waitFor();
        const dialog = await accounts();
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              "[role=dialog] [data-account-connected=true]",
            ).length === 2,
        );
        assert.equal(
          await dialog
            .locator("[aria-current=true]")
            .filter({ hasText: "vueowner01" })
            .count(),
          1,
        );
        await close();
      },
    );
    await step(
      "canceling an extra login leaves existing accounts online",
      async () => {
        const dialog = await accounts();
        await dialog
          .getByRole("button", { name: "添加账号", exact: true })
          .click();
        await page
          .getByRole("button", { name: "返回已登录账号", exact: true })
          .click();
        await page.locator("[data-workspace-runtime=vue]").waitFor();
        const restored = await accounts();
        assert.equal(await restored.locator("[data-account-id]").count(), 2);
        await close();
      },
    );
    await step(
      "different tabs select different accounts without forcing the other tab to log out",
      async () => {
        const other = await context.newPage();
        try {
          await other.goto(cfg.ui);
          await other.locator("[data-workspace-runtime=vue]").waitFor();
          await other
            .getByRole("button", { name: /切换或添加账号$/ })
            .click();
          await other
            .getByRole("dialog", { name: "已登录账号" })
            .getByRole("button", { name: /vuemember01/ })
            .first()
            .click();
          await other
            .locator(".vue-profile button")
            .filter({ hasText: "vuemember01" })
            .waitFor();
          await page.bringToFront();
          await page
            .locator(".vue-profile button")
            .filter({ hasText: ownerDisplay })
            .waitFor();
          assert.equal(
            await page.getByLabel("用户名 / 手机号", { exact: true }).count(),
            0,
          );
        } finally {
          await other.close();
        }
      },
    );
    await step(
      "revoking an inactive account only expires that account",
      async () => {
        const dialog = await accounts();
        await dialog
          .getByRole("button", { name: /vuemember01/ })
          .first()
          .click();
        const response = await context.request.delete(
          cfg.base + "/auth/sessions/" + sessions.vueowner01.session_id,
          {
            headers: {
              Authorization: "Bearer " + cfg.logins.vueowner01.access_token,
            },
          },
        );
        assert.ok(response.ok());
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        const list = await accounts();
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll("[role=dialog] li")].some(
              (node) =>
                node.textContent.includes("vueowner01") &&
                node.textContent.includes("登录已失效"),
            ),
          { timeout: 60000 },
        );
        assert.equal(
          await list
            .locator("li")
            .filter({ hasText: "vuemember01" })
            .getByText(/在线/)
            .count(),
          1,
        );
        await close();
      },
    );
    await step(
      "reauthentication reuses the existing account entry",
      async () => {
        const dialog = await accounts();
        await dialog
          .getByRole("button", { name: /vueowner01/ })
          .first()
          .click();
        await login("vueowner01");
        const list = await accounts();
        assert.equal(await list.locator("[data-account-id]").count(), 2);
        await close();
      },
    );
    await step(
      "logging out one account preserves the other account and clears only its saved credential",
      async () => {
        const dialog = await accounts();
        await dialog
          .locator("li")
          .filter({ hasText: "vueowner01" })
          .getByRole("button", { name: /^退出账号 / })
          .click();
        await page
          .getByRole("dialog", { name: "退出账号", exact: true })
          .getByRole("button", { name: "确认退出", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll("[role=dialog] [data-account-id]")
              .length === 1,
        );
        await close();
        await page
          .locator(".vue-profile button")
          .filter({ hasText: "vuemember01" })
          .waitFor();
        await page.reload();
        await page.locator("[data-workspace-runtime=vue]").waitFor();
        const remaining = await accounts();
        assert.equal(await remaining.locator("[data-account-id]").count(), 1);
        await close();
      },
    );
    await step(
      "multi-account runtime has no JavaScript or Vue lifecycle warnings",
      async () => assert.deepEqual(errors, []),
    );
    await page.screenshot({
      path: path.join(
        path.dirname(process.env.PULSE_WEB_TEST_FIXTURE || __filename),
        "accounts-desktop.png",
      ),
      fullPage: true,
    });
  } catch (error) {
    await page.screenshot({
      path: path.join(
        path.dirname(process.env.PULSE_WEB_TEST_FIXTURE || __filename),
        "accounts-failure.png",
      ),
      fullPage: true,
    });
    throw Error(
      current +
        ": " +
        error.message +
        "; browserErrors=" +
        JSON.stringify(errors),
    );
  } finally {
    await browser.close();
    fs.writeFileSync(
      path.join(
        path.dirname(process.env.PULSE_WEB_TEST_FIXTURE || __filename),
        "accounts-e2e.json",
      ),
      JSON.stringify({ passed: checks.length, checks }, null, 2),
    );
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
