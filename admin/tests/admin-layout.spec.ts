import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

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
  await expect(page.locator(".el-loading-mask:visible")).toHaveCount(0);
}

async function openPage(page: Page, key: string) {
  const mobile = await page
    .getByRole("button", { name: "打开导航", exact: true })
    .isVisible();
  if (
    mobile &&
    !(await page
      .locator(".admin-shell")
      .evaluate((node) => node.classList.contains("mobile-open")))
  ) {
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
  }
  await page.locator(`nav a[href="#/${key}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/#/${key}$`));
  if (mobile)
    await expect(page.locator(".admin-shell")).not.toHaveClass(/mobile-open/);
  await expect(page.locator(".el-loading-mask:visible")).toHaveCount(0);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)!;
      const box = node.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        bottom: box.bottom,
        scrollTop: node.scrollTop,
        scrollLeft: node.scrollLeft,
        scrollHeight: node.scrollHeight,
        scrollWidth: node.scrollWidth,
        clientHeight: node.clientHeight,
        clientWidth: node.clientWidth,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
        scrollY,
      },
      sidebar: rect(".admin-sidebar"),
      brand: rect(".brand"),
      header: rect(".workspace-header"),
      tabs: rect(".work-tabs"),
      content: rect(".workspace-scroll"),
      nav: rect(".side-nav"),
    };
  });
}

test("scrolling content, menu, wide tables and drawers keeps the app frame fixed", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1132, height: 630 });
  await login(page);
  const before = await geometry(page);
  expect(before.document.height).toBeLessThanOrEqual(631);
  expect(before.document.width).toBeLessThanOrEqual(1133);
  expect(before.brand.height).toBeLessThanOrEqual(60);
  expect(before.sidebar.width).toBeLessThanOrEqual(208);
  expect(before.sidebar.height).toBe(630);
  expect(before.content.scrollHeight).toBeGreaterThan(
    before.content.clientHeight,
  );
  await expect(
    page.locator(".admin-sidebar .el-avatar, .sidebar-bottom, .tabs-session"),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("dashboard-fixed-top.png"),
    animations: "disabled",
  });

  const map = page.locator(".province-map");
  const mapBox = await map.boundingBox();
  await page.mouse.move(
    mapBox!.x + mapBox!.width / 2,
    Math.min(mapBox!.y + 60, 580),
  );
  await page.mouse.wheel(0, 650);
  await expect
    .poll(async () => (await geometry(page)).content.scrollTop)
    .toBeGreaterThan(0);
  await expect(page.locator(".map-tools > span")).toHaveText("100%");
  const after = await geometry(page);
  expect(after.document.scrollY).toBe(0);
  expect(after.sidebar.y).toBe(before.sidebar.y);
  expect(after.header.y).toBe(before.header.y);
  expect(after.tabs.y).toBe(before.tabs.y);
  expect(after.document.height).toBeLessThanOrEqual(631);
  await page.screenshot({
    path: info.outputPath("dashboard-fixed-scrolled.png"),
    animations: "disabled",
  });

  await page.mouse.move(110, 510);
  await page.mouse.wheel(0, 500);
  await expect
    .poll(async () => (await geometry(page)).nav.scrollTop)
    .toBeGreaterThan(0);
  const menuScrolled = await geometry(page);
  expect(menuScrolled.content.scrollTop).toBe(after.content.scrollTop);
  expect(menuScrolled.brand.y).toBe(0);
  await expect(page.locator('nav a[href="#/admin-accounts"]')).toBeInViewport();

  await openPage(page, "users");
  await expect
    .poll(async () => (await geometry(page)).content.scrollTop)
    .toBe(0);
  const table = page.locator(".art-table .el-scrollbar__wrap").first();
  expect(
    await table.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBeTruthy();
  await table.evaluate((node) => (node.scrollLeft = node.scrollWidth));
  await expect
    .poll(() => table.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  const wideTable = await geometry(page);
  expect(wideTable.content.scrollWidth).toBeLessThanOrEqual(
    wideTable.content.clientWidth + 1,
  );
  expect(wideTable.document.width).toBeLessThanOrEqual(1133);

  await page.getByRole("button", { name: "新增用户", exact: true }).click();
  const drawer = page.locator(".el-drawer:visible");
  await expect(drawer).toBeVisible();
  const position = (await geometry(page)).content.scrollTop;
  await page
    .locator(".el-drawer__body")
    .evaluate((node) => (node.scrollTop = node.scrollHeight));
  await expect(
    drawer.getByRole("button", { name: "保存", exact: true }),
  ).toBeInViewport();
  expect((await geometry(page)).content.scrollTop).toBe(position);
  await drawer.getByRole("button", { name: "取消", exact: true }).click();
  await expect(drawer).toHaveCount(0);

  await page.getByRole("button", { name: "账号菜单", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "退出登录", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await info.attach("scroll-geometry.json", {
    body: JSON.stringify({ before, after, menuScrolled, wideTable }, null, 2),
    contentType: "application/json",
  });
});

test("all business pages stay within desktop and mobile widths in both themes", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const pages = await page
    .locator("nav a")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        key: node.getAttribute("href")!.split("/").pop()!,
        title: node.textContent!.trim(),
      })),
    );
  expect(pages).toHaveLength(17);
  const checks: unknown[] = [];
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const dark of [false, true]) {
      const toggle = page.getByRole("button", {
        name: dark ? "切换深色" : "切换浅色",
        exact: true,
      });
      if (await toggle.isVisible()) await toggle.click();
      for (const target of pages) {
        await openPage(page, target.key);
        await expect(
          page
            .getByRole("heading", { name: target.title, exact: true })
            .first(),
        ).toBeVisible();
        await expect
          .poll(
            async () => {
              const bounds = await geometry(page);
              return bounds.content.scrollWidth - bounds.content.clientWidth;
            },
            {
              message: `${target.key} at ${viewport.width}px in ${dark ? "dark" : "light"} theme`,
            },
          )
          .toBeLessThanOrEqual(1);
        const bounds = await geometry(page);
        expect(bounds.document.width, target.key).toBeLessThanOrEqual(
          viewport.width + 1,
        );
        expect(bounds.document.height, target.key).toBeLessThanOrEqual(
          viewport.height + 1,
        );
        expect(bounds.header.y, target.key).toBe(0);
        expect(bounds.content.scrollTop, target.key).toBe(0);
        await expect(page.locator(".work-tab.active")).toBeInViewport({
          ratio: 0.99,
        });
        checks.push({ page: target.key, viewport, dark, bounds });
      }
      await openPage(page, "dashboard");
      await page.screenshot({
        path: info.outputPath(
          `dashboard-${viewport.width}-${dark ? "dark" : "light"}.png`,
        ),
        animations: "disabled",
      });
    }
  }
  expect(errors).toEqual([]);
  await info.attach("page-bounds.json", {
    body: JSON.stringify(checks, null, 2),
    contentType: "application/json",
  });
});

test("search and edit overlays fit tablet and phone screens with independent scrolling", async ({
  page,
}, info) => {
  await login(page);
  const checks: unknown[] = [];
  for (const viewport of [
    { width: 768, height: 640 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    for (const dark of [false, true]) {
      const toggle = page.getByRole("button", {
        name: dark ? "切换深色" : "切换浅色",
        exact: true,
      });
      if (await toggle.isVisible()) await toggle.click();
      await page.getByRole("button", { name: "搜索页面", exact: true }).click();
      const dialog = page.locator(".el-dialog:visible");
      await expect(dialog).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox!.x, "search dialog left edge").toBeGreaterThanOrEqual(0);
      expect(
        dialogBox!.x + dialogBox!.width,
        "search dialog right edge",
      ).toBeLessThanOrEqual(viewport.width + 1);
      expect(
        dialogBox!.y + dialogBox!.height,
        "search dialog bottom edge",
      ).toBeLessThanOrEqual(viewport.height + 1);
      const results = dialog.locator(".command-results");
      await results.hover();
      await page.mouse.wheel(0, 1500);
      await expect
        .poll(() => results.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await expect(results.getByRole("button").last()).toBeInViewport({
        ratio: 0.99,
      });
      await dialog.locator(".el-dialog__headerbtn").click();
      await expect(dialog).toHaveCount(0);
      for (const target of [
        { key: "users", button: "新增用户" },
        { key: "groups", button: "新增群组" },
        { key: "dispatch-tasks", button: "新增分发任务" },
        { key: "admin-accounts", button: "新增后台账号" },
      ]) {
        await openPage(page, target.key);
        await page
          .getByRole("button", { name: target.button, exact: true })
          .click();
        const drawer = page.locator(".el-drawer:visible");
        await expect(drawer).toBeVisible();
        await expect(page.locator(".el-loading-mask:visible")).toHaveCount(0);
        await expect
          .poll(
            () =>
              drawer.evaluate((node) => {
                const box = node.getBoundingClientRect();
                return Math.min(
                  box.x,
                  innerWidth - box.right,
                  innerHeight - box.bottom,
                );
              }),
            {
              message: `${target.key} drawer fits ${viewport.width}px viewport after opening`,
            },
          )
          .toBeGreaterThanOrEqual(-1);
        const bounds = await drawer.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const body = node.querySelector<HTMLElement>(".el-drawer__body")!;
          return {
            x: box.x,
            right: box.right,
            y: box.y,
            bottom: box.bottom,
            bodyWidth: body.clientWidth,
            bodyScrollWidth: body.scrollWidth,
            bodyHeight: body.clientHeight,
            bodyScrollHeight: body.scrollHeight,
          };
        });
        expect(
          bounds.x,
          `${target.key} drawer left edge`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          bounds.right,
          `${target.key} drawer right edge`,
        ).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.height + 1);
        expect(
          bounds.bodyScrollWidth,
          `${target.key} drawer horizontal overflow`,
        ).toBeLessThanOrEqual(bounds.bodyWidth + 1);
        const mainPosition = (await geometry(page)).content.scrollTop;
        if (bounds.bodyScrollHeight > bounds.bodyHeight + 1) {
          await drawer.locator(".el-drawer__body").hover();
          await page.mouse.wheel(0, 800);
          await expect
            .poll(() =>
              drawer
                .locator(".el-drawer__body")
                .evaluate((node) => node.scrollTop),
            )
            .toBeGreaterThan(0);
        }
        await expect(drawer.locator(".el-drawer__footer")).toBeInViewport({
          ratio: 0.99,
        });
        expect((await geometry(page)).content.scrollTop).toBe(mainPosition);
        expect((await geometry(page)).document.scrollY).toBe(0);
        if (target.key === "dispatch-tasks")
          await page.screenshot({
            path: info.outputPath(
              `dispatch-drawer-${viewport.width}-${dark ? "dark" : "light"}.png`,
            ),
            animations: "disabled",
          });
        checks.push({ viewport, dark, page: target.key, bounds });
        await drawer.getByRole("button", { name: "取消", exact: true }).click();
        await expect(drawer).toHaveCount(0);
      }
    }
  }
  await info.attach("overlay-bounds.json", {
    body: JSON.stringify(checks, null, 2),
    contentType: "application/json",
  });
});
