# 点击名片整行直接发送（2026-11-27）

## 1. 计划

按用户截图要求修改指定的 go-rewrite PC 名片选择窗口。点击本地列表、筛选结果或账号查找结果中的名片，即直接发送，不再要求瞄准右侧发送按钮。先复现、再修改整行交互，检查重复点击、失败重试和原名片流程，随后在隔离副本构建新版 PC 包。沿用本轮及前续修改授权，不再要求重复确认同一交互。

## 2. 根因、文件与理由

原组件只把 `send(row)` 绑定在右侧小按钮，头像、姓名等没有发送事件。`web-vue/src/features/contacts/ContactCardPicker.vue` 改为整张名片一个原生 button，覆盖头像、姓名、账号和空白区域，右侧发送文字作为同一个按钮中的提示。保留原有可访问名称，新增焦点轮廓、整行 hover 和 aria-busy；不嵌套按钮，支持 Enter/Space。

原发送函数、busy 同步防重复、请求编号复用、权限/账号/会话校验与成功关闭均未修改。没有新增协议、依赖或持久化变更，也没有改 Android 和 server。该组件由 PC 与 Web 共用；本轮构建 PC，未部署 Web 前端。

`web-vue/tests/contact-card.e2e.cjs` 将已有名片发送操作改为真实点击姓名和搜索结果头像，新增默认列表头像、账号、整行留白、Enter/Space 五种激活检查，每种只发送选中的用户一次。账号查找后仍由用户选择名片才发出消息。

## 3. 完整 diff

以下为全部产品/测试变更的零上下文统一补丁。报告本身不递归包含。工作区已有版本文件和其他改动保留；版本仅在隔离副本升至 2.4.234。

```diff
diff --git a/web-vue/src/features/contacts/ContactCardPicker.vue b/web-vue/src/features/contacts/ContactCardPicker.vue
index 407333d..d9ed0f3 100644
--- a/web-vue/src/features/contacts/ContactCardPicker.vue
+++ b/web-vue/src/features/contacts/ContactCardPicker.vue
@@ -118,9 +118,11 @@ onScopeDispose(() => { lifetime.abort(); lookup?.abort(); });
-            <AvatarImage :name="row.remark || row.nickname || row.username" :src="row.avatar_url" :media-id="row.avatar_id" />
-            <div class="contact-card-person">
-              <strong :title="row.remark || row.nickname || row.username">{{ row.remark || row.nickname || row.username }}</strong>
-              <span v-if="row.remark && row.nickname && row.remark !== row.nickname" :title="row.nickname">昵称：{{ row.nickname }}</span>
-              <span v-if="row.username" :title="'@' + row.username">@{{ row.username }}</span>
-              <small v-if="row.public_id" :title="row.public_id">ID：{{ row.public_id }}</small>
-            </div>
-            <button type="button" class="ui-text-button contact-card-send" :disabled="busy"
-              :aria-label="'发送 ' + (row.remark || row.nickname || row.username) + ' 的名片'" @click="send(row)">{{ sending === row.id ? '发送中…' : '发送' }}</button>
+            <button type="button" class="contact-card-select" :disabled="busy" :aria-busy="sending === row.id"
+              :aria-label="'发送 ' + (row.remark || row.nickname || row.username) + ' 的名片'" @click="send(row)">
+              <AvatarImage :name="row.remark || row.nickname || row.username" :src="row.avatar_url" :media-id="row.avatar_id" />
+              <span class="contact-card-person">
+                <strong :title="row.remark || row.nickname || row.username">{{ row.remark || row.nickname || row.username }}</strong>
+                <span v-if="row.remark && row.nickname && row.remark !== row.nickname" :title="row.nickname">昵称：{{ row.nickname }}</span>
+                <span v-if="row.username" :title="'@' + row.username">@{{ row.username }}</span>
+                <small v-if="row.public_id" :title="row.public_id">ID：{{ row.public_id }}</small>
+              </span>
+              <span class="contact-card-send" aria-hidden="true">{{ sending === row.id ? '发送中…' : '发送' }}</span>
+            </button>
@@ -147 +149,4 @@ onScopeDispose(() => { lifetime.abort(); lookup?.abort(); });
-.contact-card-picker .contact-card-list .contact-card-row { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 11px; min-height: 83px; padding: 9px 5px; border-bottom: 1px solid var(--ui-line); }
+.contact-card-picker .contact-card-list .contact-card-select { display: grid; width: 100%; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 11px; min-height: 83px; padding: 9px 5px; border: 0; border-bottom: 1px solid var(--ui-line); border-radius: 0; background: transparent; color: var(--ui-text); text-align: start; font: inherit; cursor: pointer; }
+.contact-card-select:not(:disabled):hover { background: var(--ui-surface-soft); }
+.contact-card-select:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
+.contact-card-select:disabled { cursor: default; }
@@ -154 +159 @@ onScopeDispose(() => { lifetime.abort(); lookup?.abort(); });
-.contact-card-row .contact-card-send { min-width: 39px; padding: 5px; font-size: 12px; }
+.contact-card-row .contact-card-send { min-width: 39px; padding: 5px; color: var(--ui-primary); font-size: 12px; }
@@ -160 +165 @@ onScopeDispose(() => { lifetime.abort(); lookup?.abort(); });
-  .contact-card-picker .contact-card-list .contact-card-row { gap: 8px; }
+  .contact-card-picker .contact-card-list .contact-card-select { gap: 8px; }
diff --git a/web-vue/tests/contact-card.e2e.cjs b/web-vue/tests/contact-card.e2e.cjs
index db8a24c..8cac55f 100644
--- a/web-vue/tests/contact-card.e2e.cjs
+++ b/web-vue/tests/contact-card.e2e.cjs
@@ -255 +255,2 @@ async function waitFor(test) { for (let i = 0; i < 300; i++) { if (await test())
-    const send=picker().getByRole('button',{name:'发送 备注四 的名片',exact:true});await send.click();
+    const send=picker().getByRole('button',{name:'发送 备注四 的名片',exact:true});
+    await rows().first().getByText('备注四',{exact:true}).click();
@@ -265 +266 @@ async function waitFor(test) { for (let i = 0; i < 300; i++) { if (await test())
-    pass('sending calls the real contact-card wire contract; a refused send preserves the search and retries the same request ID, while double clicks create just one message');
+    pass('clicking a filtered card name sends directly; a refused send preserves the search and retries the same wire request ID, while double clicks create just one message');
@@ -271 +272,3 @@ async function waitFor(test) { for (let i = 0; i < 300; i++) { if (await test())
-    await search().press('Enter');await picker().getByRole('button',{name:'发送 外部联系人 的名片',exact:true}).waitFor();
+    const beforeLookup=cardPosts().length;
+    await search().press('Enter');await picker().getByRole('button',{name:'发送 外部联系人 的名片',exact:true}).waitFor();
+    assert.equal(cardPosts().length,beforeLookup,'account lookup must not send before selecting a card');
@@ -274 +277 @@ async function waitFor(test) { for (let i = 0; i < 300; i++) { if (await test())
-    await picker().getByRole('button',{name:'发送 外部联系人 的名片',exact:true}).click();await picker().waitFor({state:'hidden'});
+    await rows().first().locator('.avatar').click();await picker().waitFor({state:'hidden'});
@@ -307 +310,16 @@ async function waitFor(test) { for (let i = 0; i < 300; i++) { if (await test())
-    pass('a later friend-page failure exposes retry without discarding loaded users, and revoking send permission closes the picker and ignores a late account lookup');
+    pass('a later friend-page failure exposes retry without discarding loaded users, and revoking send permission closes the picker and ignores a late account lookup');
+    for(const target of ['avatar','account','padding','Enter','Space']) {
+      await open();await ready();
+      if(target!=='avatar')await search().fill('peer6');
+      const row=rows().first(),button=row.getByRole('button');
+      assert.equal(await row.getByRole('button').count(),1,'one interactive card, no nested send button');
+      const before=cardPosts().length,deliveries=model.deliveries.size;
+      if(target==='avatar')await row.locator('.avatar').click();
+      else if(target==='account')await row.getByText('@peer6',{exact:true}).click();
+      else if(target==='padding')await button.click({position:{x:5,y:5}});
+      else {await button.focus();await page.keyboard.press(target);}
+      await picker().waitFor({state:'hidden'});
+      assert.equal(cardPosts().length,before+1);assert.equal(model.deliveries.size,deliveries+1);
+      assert.equal(cardPosts().at(-1).body.card_user_id,uuid(target==='avatar'?4:6));
+      pass('a '+target+' activation sends the displayed card exactly once without a separate send-button click');
+    }

```

## 4. 测试代码与实际运行输出

测试新增/修改代码见第 3 节，完整文件见上述 e2e。使用真实 Vue 工作区、useChat 和 Go-v2 适配，HTTP 数据与发卡回执全部由本机夹具提供，没有发送生产消息。

修复前点击搜索到的名片姓名，未发出任何名片 POST，探针在等待发送错误提示时超时，确认旧版该区域无发送行为。原始输出：

```text
PASS the picker opens before paginated names/avatars finish, shows all 236 friends one per row, and only loads visible avatars with at most four simultaneous grants
PASS remark, nickname, account and public ID filtering includes later friend pages; space-separated terms match together and @account works
locator.waitFor: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('dialog', { name: '发送站内名片', exact: true }).getByRole('alert') to be visible

    at E:\多窗口项目\IM开发\go-rewrite\web-vue\tests\contact-card.e2e.cjs:257:39

```

修复后命令 `node web-vue/tests/contact-card.e2e.cjs`，13 项检查全部通过：

```text
PASS the picker opens before paginated names/avatars finish, shows all 236 friends one per row, and only loads visible avatars with at most four simultaneous grants
PASS remark, nickname, account and public ID filtering includes later friend pages; space-separated terms match together and @account works
PASS clicking a filtered card name sends directly; a refused send preserves the search and retries the same wire request ID, while double clicks create just one message
PASS an exact account outside the local friend list can be found explicitly with its avatar and sent as an actual card; ordinary friend cards open their message-scoped profiles
PASS received/reloaded cards keep their avatar and open the server-authorized profile, even if a legacy UI snapshot has no local user ID; old unrelated group context is cleared
PASS a denied card profile remains denied without public fallback; contacts without a picture retain a readable name/letter card
PASS a later friend-page failure exposes retry without discarding loaded users, and revoking send permission closes the picker and ignores a late account lookup
PASS a avatar activation sends the displayed card exactly once without a separate send-button click
PASS a account activation sends the displayed card exactly once without a separate send-button click
PASS a padding activation sends the displayed card exactly once without a separate send-button click
PASS a Enter activation sends the displayed card exactly once without a separate send-button click
PASS a Space activation sends the displayed card exactly once without a separate send-button click
PASS the searchable single-row picker fits a 740x560 PC window and the sent/received card remains within a narrow chat viewport
{"passed":13,"output":"E:\\多窗口项目\\IM开发\\go-rewrite\\.local\\pc-contact-card-click-20261127-035739\\fixed"}

```

前端类型检查 `npm run typecheck`：

```text

> pulse-web@2.4.198 typecheck
> vue-tsc --noEmit


```

`node --check web-vue/tests/contact-card.e2e.cjs`、产品与测试补丁 `git diff --check` 退出 0。已查看实际窗口截图，名片保持单行列表与原信息布局；740×560 窗口及窄屏边界检查通过。未将窄浏览器视口称为 Android 真机测试。

隔离源完整构建命令为 `npm run tauri -- build --ci --config src-tauri/tauri.release.conf.json --bundles nsis -- --locked -j 4`。该命令再次运行前端类型检查、生产资源编译和资源清单校验，随后生成 Rust Release 与 NSIS 安装器。尾部实际输出：

```text
   Compiling pulse-im-desktop v2.4.234 (E:\多窗口项目\IM开发\go-rewrite\.local\pc-contact-card-click-20261127-035739\source\pc-tauri\src-tauri)
warning: unused import: `Manager`
 --> src\upload_stage.rs:5:38
  |
5 | use tauri::{ipc::Request, AppHandle, Manager, State, WebviewWindow};
  |                                      ^^^^^^^
  |
  = note: `#[warn(unused_imports)]` (part of `#[warn(unused)]`) on by default

warning: `pulse-im-desktop` (bin "pulse-im-desktop") generated 1 warning
    Finished `release` profile [optimized] target(s) in 57.41s
       Built application at: E:\多窗口项目\IM开发\go-rewrite\.local\pc-contact-card-click-20261127-035739\source\pc-tauri\src-tauri\target\release\pulse-im-desktop.exe
        Info Patching E:\多窗口项目\IM开发\go-rewrite\.local\pc-contact-card-click-20261127-035739\source\pc-tauri\src-tauri\target\release\pulse-im-desktop.exe with bundle type information: nsis
        Info Target: x64
     Running makensis to produce E:\多窗口项目\IM开发\go-rewrite\.local\pc-contact-card-click-20261127-035739\source\pc-tauri\src-tauri\target\release\bundle\nsis\Pulse IM_2.4.234_x64-setup.exe
    Finished 1 bundle at:
        E:\多窗口项目\IM开发\go-rewrite\.local\pc-contact-card-click-20261127-035739\source\pc-tauri\src-tauri\target\release\bundle\nsis\Pulse IM_2.4.234_x64-setup.exe (18.48 MiB)

```

安装包：`E:\多窗口项目\IM开发\go-rewrite\.local\pc-contact-card-click-20261127-035739\PC-Tauri\Pulse-IM-2.4.234-Windows-x64-setup.exe`，19,374,139 字节，SHA256 `fce0a194e7ad5a53caf87e98323c404f176f1d9ae6eec013a5d0a615dcda1628`，Go v2 Tauri Windows x64，应用标识 `com.pulseim.desktop.tauri`，生产接口 `https://api.imapi.shop/api/v2`。沿用未签名配置；安装器未运行，未覆盖用户客户端或登录真人账号手工发送。

7810 个工作区源文件在构建期间一致，隔离副本 6434 个输入和 3037 个前端文件核对通过。包内提取程序与构建原生程序除 Tauri 正常 `UNK` → `NSS` 打包类型标记外全部字节一致；其 SHA256 为 `f5aa1c513608dc6bd3c40f9004ffa26c392e3b99deac372c9e49447c69e3d77f`。版本资源为 2.4.234。上轮图片复制修复源码与开始快照逐字节一致，包含在新包中，没有重复宣称跑了未改的原生/剪贴板测试。全部 575 个服务器源文件与开始快照相同，未部署后端。

完整证据目录 `E:/多窗口项目/IM开发/go-rewrite/.local/pc-contact-card-click-20261127-035739`，包括 `baseline/failure.json`、`fixed/results.json`、截图、构建日志、完整补丁、输入清单和 `package-verification.json`。

## 5. 兼容性检查

- 账号切换：原 token、用户、会话、权限检查与卸载 abort 完全不变，只将点击入口扩大。13 项检查含收件方页面重载、查找期间权限撤销和忽略晚回调。未用真人账号做额外切换验收。
- 进程退出/重启：没有新增存储、队列、账号或窗口状态。夹具多次重载真实页面，发送/接收卡片与按消息授权的资料查看通过；未测试 OS 强杀时的发送恢复。
- 多会话与重复激活：原 `current()` 和 `busy` 保持。发卡失败保留搜索，重试复用同一个 request_id；连续点击只生成一条消息，姓名、头像、账号和留白没有多个冒泡发送入口。普通卡片按钮与键盘 Enter/Space 共用同一发送函数。

## 6. 发现但未修改

- `src/upload_stage.rs:5` 的既有未使用 Manager 导入警告仍存在，本轮不修改上传代码。
- 完整 PC 迁移清单仍有其他待验收项；此轮 13 项名片回归与构建通过不表示整份迁移清单已完成。
- Android 原生名片选择器与服务器 Web 发布未包含在本轮 PC 交互修改及安装包交付范围中。
