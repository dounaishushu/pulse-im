# Android 图片长按保存与头像加载修复（2026-11-27）

## 1. 计划（先输出，等确认）

用户明确要求修复手机端“查看图片不能长按保存”和“群聊/私聊头像偶尔不可见”。先读 AGENTS.md 与涉及源码，说明检查、补齐保存、头像授权恢复和回归计划；沿用本次明确修复授权执行，未要求重复确认。只做这两项修复，无新增依赖、后端或持久化修改。

按一个缺陷一个提交：图片保存为 083ad4c；头像及本报告为独立提交。完整包基于当前工作区，含用户此前未提交的客户端修改；本次提交只纳入对应修复，MainActivity/ApiClient 的其他本地修改保留。整体 diff 大于 P0 热修的 400 行参考范围，主要为两项功能、17 项 JVM 回归及完整 diff 文档，没有追加其他优化任务。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

图片根因：查看器缺少保存菜单和导出入口，PreviewPhotoImage 自定义手势没有把长按转发给 View.performLongClick。修改 PhotoSendPreview.kt 的长按回调、GroupMessageMedia.kt 的 showImage/菜单释放/权限恢复、MainActivity.kt 的恢复和权限分发。原图和放大状态均能长按保存，关闭预览时关闭所属菜单。

ChatImageCache.kt 抽取既有原文件消费者流程，加载和保存继续共用下载合并/取消，导出原始压缩字节，不重编码缩略图。新增 ChatImageExport.kt：Android 10+ 用 MediaStore.IS_PENDING 写完再发表；Android 8/9 复用已有写存储权限，隐藏临时文件写完改名并扫描。GalleryImageWriter.java 在空图、超限、失败和失效时回滚，清理异常不掩盖原错误。生产 Manifest 未改。

头像根因：共享加载器在短暂网络失败或私有媒体授权过期后通常直接留下空图；原来仅在请求中恰巧收到新 URL 时重试，不能主动恢复过期授权。修改 ChatScreens.kt 的 ChatAvatars 请求/账号捕获/重试完成路径，继续用原两个加载线程及多视图合并，已知同范围私有媒体仅更新一次授权，其他临时错误最多三个加载回合、1/2 秒延后，保持大小限制并补充读流预算。

ApiClient.kt 新增本地 freshAvatarUrl，使用已有 POST /api/v2/media/{id}/grants，由服务端鉴权，不新增接口或请求字段。AvatarLoadPolicy.java 约束同源 API、UUID 路径与上限，其他域名、带凭据/查询/片段/穿越路径不能成为授权目标。迟到响应仍按账号 generation/媒体身份丢弃，群聊、私聊与列表共用此加载器。没有改消息/AAD/ticket/epoch/事务或关闭 TLS 校验。

以上通过源码和隔离夹具验证；用户故障真机未连接，不能宣称全部生产头像现象均已实机复现。

## 3. 完整 diff

完整产品改动及全部新增 JVM 测试如下（unified=0；不含既有未提交内容）。


```diff
diff --git a/android/app/src/main/java/com/pulseim/android/ChatImageCache.kt b/android/app/src/main/java/com/pulseim/android/ChatImageCache.kt
index 06be324..ed77cab 100644
--- a/android/app/src/main/java/com/pulseim/android/ChatImageCache.kt
+++ b/android/app/src/main/java/com/pulseim/android/ChatImageCache.kt
@@ -127 +127 @@ internal object ChatImageCache {
-        val epoch = synchronized(lock) {
+        synchronized(lock) {
@@ -130 +129,0 @@ internal object ChatImageCache {
-            generation
@@ -131,0 +131,20 @@ internal object ChatImageCache {
+        return useOriginal(context, scope, url, current) { file, epoch ->
+            // Decoding must not hold the lock used by synchronous UI cache reads.
+            val bitmap = try { safeDecode(context, file, pixel) } catch (error: Exception) { synchronized(lock) { file.delete() }; throw error }
+            synchronized(lock) {
+                if (!current() || generation != epoch) throw IOException("已取消")
+                (memory.get("$key:$pixel") ?: memory.get("$key:2560"))?.let { return@synchronized it }
+                memory.put("$key:$pixel", bitmap)
+                bitmap
+            }
+        }
+    }
+
+    fun saveToGallery(context: Context, scope: String, url: String, current: () -> Boolean) =
+        useOriginal(context, scope, url, current) { file, epoch ->
+            ChatImageExport.save(context, file) { current() && synchronized(lock) { generation == epoch } }
+        }
+
+    private fun <T> useOriginal(context: Context, scope: String, url: String, current: () -> Boolean, consume: (File, Int) -> T): T {
+        val key = key(scope, url)
+        val epoch = synchronized(lock) { if (!current()) throw IOException("已取消"); generation }
@@ -148,9 +167 @@ internal object ChatImageCache {
-          val file = awaitFile()
-        // Decoding must not hold the lock used by synchronous UI cache reads.
-        val bitmap = try { safeDecode(context, file, pixel) } catch (error: Exception) { synchronized(lock) { file.delete() }; throw error }
-          return synchronized(lock) {
-            if (!current() || generation != epoch) throw IOException("已取消")
-            (memory.get("$key:$pixel") ?: memory.get("$key:2560"))?.let { return@synchronized it }
-            memory.put("$key:$pixel", bitmap)
-            bitmap
-          }
+            return consume(awaitFile(), epoch)
diff --git a/android/app/src/main/java/com/pulseim/android/ChatImageExport.kt b/android/app/src/main/java/com/pulseim/android/ChatImageExport.kt
new file mode 100644
index 0000000..dcbab33
--- /dev/null
+++ b/android/app/src/main/java/com/pulseim/android/ChatImageExport.kt
@@ -0,0 +1,58 @@
+package com.pulseim.android
+
+import android.content.ContentValues
+import android.content.Context
+import android.graphics.BitmapFactory
+import android.media.MediaScannerConnection
+import android.os.Build
+import android.os.Environment
+import android.provider.MediaStore
+import java.io.File
+import java.io.IOException
+import java.io.OutputStream
+import java.util.UUID
+
+/** Copy the original image bytes, preserving animation and avoiding preview re-encoding. */
+internal object ChatImageExport {
+    fun save(context: Context, file: File, current: () -> Boolean) {
+        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
+        BitmapFactory.decodeFile(file.absolutePath, bounds)
+        val extension = when (bounds.outMimeType) {
+            "image/jpeg" -> "jpg"; "image/png" -> "png"; "image/gif" -> "gif"; "image/webp" -> "webp"
+            else -> throw IOException("图片格式暂不支持保存")
+        }
+        if (!current() || bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("图片不可用")
+        val folder = context.getString(R.string.app_name).replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(64).ifBlank { "小猿口算" }
+        val name = "$folder-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}.$extension"
+        file.inputStream().use { source ->
+          val destination = if (Build.VERSION.SDK_INT >= 29) {
+            val resolver = context.contentResolver
+            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
+                put(MediaStore.Images.Media.DISPLAY_NAME, name); put(MediaStore.Images.Media.MIME_TYPE, bounds.outMimeType)
+                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$folder")
+                put(MediaStore.Images.Media.IS_PENDING, 1)
+            }) ?: throw IOException("无法创建相册图片")
+            object : GalleryImageWriter.Destination {
+                override fun open(): OutputStream = resolver.openOutputStream(uri) ?: throw IOException("无法写入相册")
+                override fun publish() { if (resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null) != 1) throw IOException("无法保存到相册") }
+                override fun rollback() { resolver.delete(uri, null, null) }
+            }
+        } else {
+            val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), folder)
+            if (!directory.isDirectory && !directory.mkdirs()) throw IOException("无法创建相册目录")
+            val target = File(directory, name)
+            val partial = File(directory, ".$name.part")
+            if (!partial.createNewFile()) throw IOException("无法创建相册图片")
+            object : GalleryImageWriter.Destination {
+                override fun open(): OutputStream = partial.outputStream()
+                override fun publish() {
+                    if (!partial.renameTo(target)) throw IOException("无法保存到相册")
+                    MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf(bounds.outMimeType), null)
+                }
+                override fun rollback() { partial.delete(); target.delete() }
+            }
+          }
+          GalleryImageWriter.write(source, destination, 32L * 1024 * 1024, current)
+        }
+    }
+}
diff --git a/android/app/src/main/java/com/pulseim/android/GalleryImageWriter.java b/android/app/src/main/java/com/pulseim/android/GalleryImageWriter.java
new file mode 100644
index 0000000..365080d
--- /dev/null
+++ b/android/app/src/main/java/com/pulseim/android/GalleryImageWriter.java
@@ -0,0 +1,36 @@
+package com.pulseim.android;
+
+import java.io.IOException;
+import java.io.InputStream;
+import java.io.OutputStream;
+import java.util.function.BooleanSupplier;
+
+/** Publish a gallery item only after the complete, still-authorized image was written. */
+final class GalleryImageWriter {
+    interface Destination {
+        OutputStream open() throws IOException;
+        void publish() throws IOException;
+        void rollback();
+    }
+    static void write(InputStream source, Destination destination, long limit, BooleanSupplier current) throws IOException {
+        try {
+            long total = 0;
+            try (OutputStream output = destination.open()) {
+                byte[] buffer = new byte[32 * 1024];
+                for (int size; (size = source.read(buffer)) != -1;) {
+                    if (!current.getAsBoolean()) throw new IOException("已取消");
+                    total += size;
+                    if (total > limit) throw new IOException("图片超过保存大小限制");
+                    output.write(buffer, 0, size);
+                }
+                if (total == 0) throw new IOException("图片内容为空");
+            }
+            if (!current.getAsBoolean()) throw new IOException("已取消");
+            destination.publish();
+        } catch (IOException | RuntimeException | Error failure) {
+            try { destination.rollback(); }
+            catch (RuntimeException | Error cleanup) { failure.addSuppressed(cleanup); }
+            throw failure;
+        }
+    }
+}
diff --git a/android/app/src/main/java/com/pulseim/android/GroupMessageMedia.kt b/android/app/src/main/java/com/pulseim/android/GroupMessageMedia.kt
index 4931fbf..f005b8f 100644
--- a/android/app/src/main/java/com/pulseim/android/GroupMessageMedia.kt
+++ b/android/app/src/main/java/com/pulseim/android/GroupMessageMedia.kt
@@ -77,0 +78,3 @@ internal class GroupMessageMedia(
+    private var pendingImageSave: (() -> Unit)? = null
+    private var imageSaving = false
+    private var imageMenu: android.app.AlertDialog? = null
@@ -125,0 +129,30 @@ internal class GroupMessageMedia(
+        fun save() {
+            if (!previewCurrent(dialog, generation) || imageSaving) return
+            if (android.os.Build.VERSION.SDK_INT <= 28 && activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
+                pendingImageSave = { save() }
+                activity.requestPermissions(arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE), IMAGE_SAVE_PERMISSION)
+                return
+            }
+            imageSaving = true
+            launch {
+                try {
+                    fun current() = previewCurrent(dialog, generation)
+                    try { ChatImageCache.saveToGallery(activity.applicationContext, imageScope, url, ::current) }
+                    catch (error: Exception) {
+                        if (!ChatImageCache.authorizationExpired(error) || refresh == null || !current()) throw error
+                        url = resolved(refresh()) ?: throw IOException("图片地址无效")
+                        ChatImageCache.saveToGallery(activity.applicationContext, imageScope, url, ::current)
+                    }
+                    handler.post { if (previewCurrent(dialog, generation)) notice("图片已保存到相册") }
+                } catch (error: Exception) {
+                    handler.post { if (previewCurrent(dialog, generation)) notice(friendlyError(error, "图片保存失败，请重试")) }
+                } finally { handler.post { imageSaving = false } }
+            }
+        }
+        image.setOnLongClickListener {
+            if (previewCurrent(dialog, generation) && image.drawable != null && !imageSaving) {
+                imageMenu?.dismiss()
+                imageMenu = android.app.AlertDialog.Builder(activity).setItems(arrayOf("保存图片")) { _, _ -> save() }.create().also { it.show() }
+            }
+            true
+        }
@@ -226,0 +260,11 @@ internal class GroupMessageMedia(
+    fun permissionResult(requestCode: Int, granted: Boolean): Boolean {
+        if (requestCode != IMAGE_SAVE_PERMISSION) return false
+        if (granted) resumeImageSave() else { pendingImageSave = null; notice("需要允许保存图片权限，请重试") }
+        return true
+    }
+    fun resumeImageSave() {
+        if (!alive()) return
+        val action = pendingImageSave ?: return
+        pendingImageSave = null; action()
+    }
+
@@ -229,0 +274 @@ internal class GroupMessageMedia(
+        pendingImageSave = null
@@ -297,0 +343 @@ internal class GroupMessageMedia(
+                imageMenu?.dismiss(); imageMenu = null
@@ -317,0 +364 @@ internal class GroupMessageMedia(
+        imageMenu?.dismiss(); imageMenu = null
@@ -420 +467,4 @@ internal class GroupMessageMedia(
-    companion object { private const val MAX_BYTES = 100L * 1024 * 1024 }
+    companion object {
+        private const val MAX_BYTES = 100L * 1024 * 1024
+        private const val IMAGE_SAVE_PERMISSION = 7318
+    }
diff --git a/android/app/src/main/java/com/pulseim/android/MainActivity.kt b/android/app/src/main/java/com/pulseim/android/MainActivity.kt
index 482a290..ebe3c3c 100644
--- a/android/app/src/main/java/com/pulseim/android/MainActivity.kt
+++ b/android/app/src/main/java/com/pulseim/android/MainActivity.kt
@@ -704,0 +705 @@ class MainActivity : Activity(), ViewModelStoreOwner {
+        groupMedia?.resumeImageSave()
@@ -4999,0 +5001 @@ class MainActivity : Activity(), ViewModelStoreOwner {
+        if (groupMedia?.permissionResult(requestCode, grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) == true) return
diff --git a/android/app/src/main/java/com/pulseim/android/PhotoSendPreview.kt b/android/app/src/main/java/com/pulseim/android/PhotoSendPreview.kt
index 79e07b4..ab928b7 100644
--- a/android/app/src/main/java/com/pulseim/android/PhotoSendPreview.kt
+++ b/android/app/src/main/java/com/pulseim/android/PhotoSendPreview.kt
@@ -190,0 +191 @@ internal class PreviewPhotoImage(context: android.content.Context) : ImageView(c
+        override fun onLongPress(event: MotionEvent) { if (!pinch.isInProgress) performLongClick() }
diff --git a/android/app/src/test/java/com/pulseim/android/GalleryImageWriterTest.java b/android/app/src/test/java/com/pulseim/android/GalleryImageWriterTest.java
new file mode 100644
index 0000000..ec02378
--- /dev/null
+++ b/android/app/src/test/java/com/pulseim/android/GalleryImageWriterTest.java
@@ -0,0 +1,80 @@
+package com.pulseim.android;
+
+import org.junit.Test;
+import java.io.*;
+import java.util.concurrent.atomic.AtomicBoolean;
+import static org.junit.Assert.*;
+
+public class GalleryImageWriterTest {
+    private static class Target implements GalleryImageWriter.Destination {
+        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
+        boolean published, rolledBack, closed;
+        @Override public OutputStream open() throws IOException {
+            return new FilterOutputStream(bytes) { @Override public void close() throws IOException { super.close(); closed = true; } };
+        }
+        @Override public void publish() throws IOException { assertTrue(closed); published = true; }
+        @Override public void rollback() { rolledBack = true; }
+    }
+    @Test public void originalImageBytesArePreservedAcrossMultipleChunks() throws Exception {
+        byte[] original = new byte[100_007];
+        for (int i = 0; i < original.length; i++) original[i] = (byte)(i * 31);
+        Target target = new Target();
+        GalleryImageWriter.write(new ByteArrayInputStream(original), target, original.length, () -> true);
+        assertArrayEquals(original, target.bytes.toByteArray()); assertTrue(target.published); assertFalse(target.rolledBack);
+    }
+    @Test public void emptyImageNeverPublishesAnAlbumItem() {
+        Target target = new Target();
+        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[0]), target, 10, () -> true));
+        assertTrue(target.rolledBack); assertFalse(target.published);
+    }
+    @Test public void exceedingTheLimitRemovesThePartialItem() {
+        Target target = new Target();
+        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[11]), target, 10, () -> true));
+        assertTrue(target.rolledBack); assertFalse(target.published);
+    }
+    @Test public void accountOrPreviewChangeDuringCopyCancelsAndRollsBack() {
+        Target target = new Target(); AtomicBoolean current = new AtomicBoolean(true);
+        InputStream source = new ByteArrayInputStream(new byte[70_000]) {
+            @Override public synchronized int read(byte[] bytes, int offset, int length) {
+                int n = super.read(bytes, offset, length); if (pos > 32_768) current.set(false); return n;
+            }
+        };
+        assertThrows(IOException.class, () -> GalleryImageWriter.write(source, target, 100_000, current::get));
+        assertTrue(target.rolledBack); assertFalse(target.published);
+    }
+    @Test public void cancellationAfterTheLastByteStillPreventsPublication() {
+        AtomicBoolean current = new AtomicBoolean(true); Target target = new Target();
+        InputStream source = new ByteArrayInputStream(new byte[]{1, 2}) {
+            @Override public synchronized int read(byte[] bytes, int offset, int length) {
+                int n = super.read(bytes, offset, length); if (n < 0) current.set(false); return n;
+            }
+        };
+        assertThrows(IOException.class, () -> GalleryImageWriter.write(source, target, 10, current::get));
+        assertTrue(target.rolledBack); assertFalse(target.published);
+    }
+    @Test public void outputOpenFailureDoesNotLeaveAPendingAlbumItem() {
+        Target target = new Target() { @Override public OutputStream open() throws IOException { throw new IOException("storage"); } };
+        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[]{1}), target, 10, () -> true));
+        assertTrue(target.rolledBack); assertFalse(target.published);
+    }
+    @Test public void galleryPublicationFailureRollsBackTheWrittenImage() {
+        Target target = new Target() { @Override public void publish() throws IOException { throw new IOException("publish"); } };
+        assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[]{1}), target, 10, () -> true));
+        assertTrue(target.closed); assertTrue(target.rolledBack); assertFalse(target.published);
+    }
+    @Test public void brokenInputDoesNotPublishThePartialImage() {
+        Target target = new Target();
+        InputStream source = new InputStream() { @Override public int read() throws IOException { throw new IOException("read"); } };
+        assertThrows(IOException.class, () -> GalleryImageWriter.write(source, target, 10, () -> true));
+        assertTrue(target.rolledBack); assertFalse(target.published);
+    }
+    @Test public void cleanupFailureDoesNotHideTheOriginalWriteError() {
+        IOException problem = new IOException("open");
+        Target target = new Target() {
+            @Override public OutputStream open() throws IOException { throw problem; }
+            @Override public void rollback() { throw new IllegalStateException("cleanup"); }
+        };
+        IOException observed = assertThrows(IOException.class, () -> GalleryImageWriter.write(new ByteArrayInputStream(new byte[]{1}), target, 10, () -> true));
+        assertSame(problem, observed); assertEquals(1, observed.getSuppressed().length);
+    }
+}

diff --git a/android/app/src/main/java/com/pulseim/android/ApiClient.kt b/android/app/src/main/java/com/pulseim/android/ApiClient.kt
index faec996..1fad4ae 100644
--- a/android/app/src/main/java/com/pulseim/android/ApiClient.kt
+++ b/android/app/src/main/java/com/pulseim/android/ApiClient.kt
@@ -457,0 +458,11 @@ class ApiClient(private val baseUrl: String) {
+    internal fun freshAvatarUrl(source: String): String {
+        val captured = credentials.get()
+        val ownerToken = captured.first ?: throw ClientApiException(401, "unauthenticated", "请先登录")
+        check(BuildConfig.GO_BACKEND) { "头像授权无需刷新" }
+        val identity = GoMediaIdentity.identity(baseUrl.trimEnd('/') + "|" + ownerToken, source)
+        val id = AvatarLoadPolicy.mediaId(baseUrl, identity) ?: throw java.io.IOException("头像授权标识不可用")
+        val grant = goRequest("/media/$id/grants", "POST", JSONObject(), captured.second)
+        check(credentials.get() == captured) { "账号已改变" }
+        return go.rememberMediaAccess(id, grant, captured.second)
+    }
+
diff --git a/android/app/src/main/java/com/pulseim/android/AvatarLoadPolicy.java b/android/app/src/main/java/com/pulseim/android/AvatarLoadPolicy.java
new file mode 100644
index 0000000..9edfdde
--- /dev/null
+++ b/android/app/src/main/java/com/pulseim/android/AvatarLoadPolicy.java
@@ -0,0 +1,34 @@
+package com.pulseim.android;
+
+import java.net.URI;
+import java.util.Objects;
+import java.util.regex.Matcher;
+import java.util.regex.Pattern;
+
+/** Bound transient retries and renew a private grant at most once per visible request. */
+final class AvatarLoadPolicy {
+    enum Next { STOP, RETRY, RENEW }
+    private int attempts;
+    private boolean renewed;
+    void started() { attempts++; }
+    Next failed(int status, boolean newerUrl, boolean renewable) {
+        if (attempts >= 3) return Next.STOP;
+        if (newerUrl) return Next.RETRY;
+        if ((status == 401 || status == 403 || status == 404) && renewable && !renewed) {
+            renewed = true;
+            return Next.RENEW;
+        }
+        return status <= 0 || status == 408 || status == 429 || status >= 500 && status <= 599 ? Next.RETRY : Next.STOP;
+    }
+    long delayMs() { return attempts * 1000L; }
+    static String mediaId(String base, String identity) {
+        try {
+            URI api = new URI(base), media = new URI(identity);
+            if (!("https".equals(api.getScheme()) || "http".equals(api.getScheme())) || api.getHost() == null
+                    || !Objects.equals(api.getScheme(), media.getScheme()) || !Objects.equals(api.getHost(), media.getHost()) || api.getPort() != media.getPort()
+                    || media.getUserInfo() != null || media.getRawQuery() != null || media.getRawFragment() != null) return null;
+            Matcher match = Pattern.compile(Pattern.quote(api.getPath().replaceAll("/+$", "")) + "/media/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/content").matcher(media.getRawPath());
+            return match.matches() ? match.group(1) : null;
+        } catch (Exception invalid) { return null; }
+    }
+}
diff --git a/android/app/src/main/java/com/pulseim/android/ChatScreens.kt b/android/app/src/main/java/com/pulseim/android/ChatScreens.kt
index b8bdcb9..859bafe 100644
--- a/android/app/src/main/java/com/pulseim/android/ChatScreens.kt
+++ b/android/app/src/main/java/com/pulseim/android/ChatScreens.kt
@@ -86,0 +87 @@ internal object ChatAvatars {
+    private val retryHandler = android.os.Handler(android.os.Looper.getMainLooper())
@@ -90,0 +92 @@ internal object ChatAvatars {
+    private var owner: Pair<String, String?>? = null
@@ -93,2 +95,4 @@ internal object ChatAvatars {
-        mediaScope = "$base|${token.orEmpty()}"
-        synchronized(lock) { if (account != next) { account = next; generation++; requests.clear(); displayed.clear(); bindings.clear(); cache.evictAll() } }
+        synchronized(lock) {
+            mediaScope = "$base|${token.orEmpty()}"; owner = base to token
+            if (account != next) { account = next; generation++; requests.clear(); displayed.clear(); bindings.clear(); cache.evictAll() }
+        }
@@ -99 +103 @@ internal object ChatAvatars {
-    private class Request(val key: String, var url: String, val generation: Long, val diskEpoch: Int) {
+    private class Request(val key: String, var url: String, val generation: Long, val diskEpoch: Int, val owner: Pair<String, String?>?) {
@@ -100,0 +105,2 @@ internal object ChatAvatars {
+        val recovery = AvatarLoadPolicy()
+        var renew = false
@@ -135 +141 @@ internal object ChatAvatars {
-            pending = Request(key, url, generation, diskEpoch).apply { views.add(java.lang.ref.WeakReference(view)) }
+            pending = Request(key, url, generation, diskEpoch, owner).apply { views.add(java.lang.ref.WeakReference(view)) }
@@ -137,0 +144,4 @@ internal object ChatAvatars {
+        load(context, key, pending)
+    }
+    private class AvatarHttpFailure(val status: Int) : java.io.IOException("头像加载失败")
+    private fun load(context: Context, key: String, pending: Request) {
@@ -138,0 +149 @@ internal object ChatAvatars {
+            if (synchronized(lock) { pending.generation != generation || requests[key] !== pending }) return@execute
@@ -141,3 +152,3 @@ internal object ChatAvatars {
-            for (attempt in 0..1) {
-                if (bitmap != null || synchronized(lock) { pending.generation != generation }) break
-                val source = synchronized(lock) { pending.url }
+            if (bitmap == null) {
+                pending.recovery.started()
+                var source = synchronized(lock) { pending.url }
@@ -144,0 +156,8 @@ internal object ChatAvatars {
+                    if (pending.renew) {
+                        val account = pending.owner ?: throw java.io.IOException("头像账号已改变")
+                        source = ApiClient(account.first).apply { token = account.second }.freshAvatarUrl(source)
+                        synchronized(lock) {
+                            if (pending.generation != generation || requests[key] !== pending) return@execute
+                            pending.url = source; pending.renew = false
+                        }
+                    }
@@ -146 +165,2 @@ internal object ChatAvatars {
-                    connection.connectTimeout = 6000; connection.readTimeout = 6000
+                    connection.connectTimeout = 6000; connection.readTimeout = 6000; connection.instanceFollowRedirects = false
+                    val started = android.os.SystemClock.elapsedRealtime()
@@ -149 +169,4 @@ internal object ChatAvatars {
-                        while (true) { val n = input.read(buffer); if (n < 0) break; require(out.size() + n <= 10 * 1024 * 1024); out.write(buffer, 0, n) }
+                        while (true) {
+                            if (android.os.SystemClock.elapsedRealtime() - started > 12000 || synchronized(lock) { pending.generation != generation }) throw java.io.IOException("头像加载已停止")
+                            val n = input.read(buffer); if (n < 0) break; require(out.size() + n <= 10 * 1024 * 1024); out.write(buffer, 0, n)
+                        }
@@ -151 +174,4 @@ internal object ChatAvatars {
-                    } } finally { connection.disconnect() }
+                    } } catch (error: java.io.IOException) {
+                        val status = connection.responseCode
+                        if (status !in 200..299) throw AvatarHttpFailure(status) else throw error
+                    } finally { connection.disconnect() }
@@ -156,4 +182,13 @@ internal object ChatAvatars {
-                    bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
-                    break
-                } catch (_: Exception) {
-                    if (attempt == 1 || synchronized(lock) { pending.url == source || pending.generation != generation }) break
+                    bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: throw java.io.IOException("头像图片无法解码")
+                } catch (error: Exception) {
+                    if (synchronized(lock) { pending.generation != generation || requests[key] !== pending }) return@execute
+                    val status = when (error) { is AvatarHttpFailure -> error.status; is ClientApiException -> error.status; else -> 0 }
+                    val renewable = pending.owner?.let { account -> BuildConfig.GO_BACKEND && account.second != null &&
+                        AvatarLoadPolicy.mediaId(account.first, GoMediaIdentity.identity(account.first.trimEnd('/') + "|" + account.second, source)) != null } == true
+                    val next = pending.recovery.failed(status, synchronized(lock) { pending.url != source }, renewable)
+                    if (next != AvatarLoadPolicy.Next.STOP) {
+                        if (next == AvatarLoadPolicy.Next.RENEW) pending.renew = true
+                        retryHandler.postDelayed({ load(context, key, pending) }, pending.recovery.delayMs())
+                        return@execute
+                    }
+                    ClientDiagnostics.get(context).fault("ANDROID_AVATAR_LOAD", error)
diff --git a/android/app/src/test/java/com/pulseim/android/AvatarLoadPolicyTest.java b/android/app/src/test/java/com/pulseim/android/AvatarLoadPolicyTest.java
new file mode 100644
index 0000000..0e6f1b8
--- /dev/null
+++ b/android/app/src/test/java/com/pulseim/android/AvatarLoadPolicyTest.java
@@ -0,0 +1,60 @@
+package com.pulseim.android;
+
+import org.junit.Test;
+import static org.junit.Assert.*;
+
+public class AvatarLoadPolicyTest {
+    private static final String BASE = "https://api.example.test/api/v2";
+    private static final String ID = "00000000-1111-2222-3333-444444444444";
+    @Test public void expiredPrivateGrantRenewsOnce() {
+        AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
+        assertEquals(AvatarLoadPolicy.Next.RENEW, p.failed(403, false, true));
+        p.started(); assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(403, false, true));
+    }
+    @Test public void expiredGrantNotFoundCanRenewButPublicNotFoundStops() {
+        AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
+        assertEquals(AvatarLoadPolicy.Next.RENEW, p.failed(404, false, true));
+        AvatarLoadPolicy publicAvatar = new AvatarLoadPolicy(); publicAvatar.started();
+        assertEquals(AvatarLoadPolicy.Next.STOP, publicAvatar.failed(404, false, false));
+    }
+    @Test public void transientFailuresStopAfterThreeAttempts() {
+        for (int transport : new int[]{0, -1}) {
+            AvatarLoadPolicy p = new AvatarLoadPolicy();
+            p.started(); assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(transport, false, false)); assertEquals(1000, p.delayMs());
+            p.started(); assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(503, false, false)); assertEquals(2000, p.delayMs());
+            p.started(); assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(503, false, false));
+        }
+    }
+    @Test public void rateLimitsAndRequestTimeoutsGetABoundedRetry() {
+        for (int status : new int[]{408, 429, 500, 502, 504}) {
+            AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
+            assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(status, false, false));
+        }
+    }
+    @Test public void permanentFailuresDoNotLoop() {
+        for (int status : new int[]{301, 400, 401, 403, 404, 422}) {
+            AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
+            assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(status, false, false));
+        }
+    }
+    @Test public void aNewerBoundUrlIsTriedBeforeRequestingAnotherGrant() {
+        AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
+        assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(403, true, true));
+        p.started(); assertEquals(AvatarLoadPolicy.Next.RENEW, p.failed(403, false, true));
+        p.started(); assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(403, true, true));
+    }
+    @Test public void mediaIdentityMustBelongToTheCapturedApi() {
+        assertEquals(ID, AvatarLoadPolicy.mediaId(BASE, BASE + "/media/" + ID + "/content"));
+        assertEquals(ID, AvatarLoadPolicy.mediaId(BASE + "/", BASE + "/media/" + ID + "/content"));
+        assertNull(AvatarLoadPolicy.mediaId(BASE, "https://elsewhere.test/api/v2/media/" + ID + "/content"));
+        assertNull(AvatarLoadPolicy.mediaId(BASE, "http://api.example.test/api/v2/media/" + ID + "/content"));
+        assertNull(AvatarLoadPolicy.mediaId(BASE, "https://api.example.test:444/api/v2/media/" + ID + "/content"));
+    }
+    @Test public void mediaIdentityRejectsCredentialsQueriesAndUntrustedPaths() {
+        for (String raw : new String[]{BASE + "/media/" + ID + "/content?token=secret", BASE + "/media/" + ID + "/content#fragment",
+                BASE + "/media/" + ID + "/preview", BASE + "/media/../media/" + ID + "/content", BASE + "/media/%30" + ID.substring(1) + "/content",
+                "https://name@api.example.test/api/v2/media/" + ID + "/content", "bad"}) {
+            assertNull(raw, AvatarLoadPolicy.mediaId(BASE, raw));
+        }
+    }
+}
```


## 4. 测试代码 + 实际运行输出（贴原始终端输出）

完整测试代码见上节。GalleryImageWriterTest 9 项覆盖跨分块原字节、空图/超限/读失败/打开失败/发表失败回滚、复制中/末尾失效取消、清理异常保留原错误。AvatarLoadPolicyTest 8 项覆盖授权更新一次、私有/公共 404、0/-1 传输错误、5xx/408/429 上限、永久错误、新 URL 优先和同源身份拒绝。

JDK 17、离线 Gradle 真实命令任务：:app:testDebugUnitTest :app:assembleDebug :app:compileDebugAndroidTestKotlin。


```text
> Task :app:compileDebugJavaWithJavac
> Task :app:bundleDebugClassesToRuntimeJar
> Task :app:bundleDebugClassesToCompileJar
> Task :app:processDebugJavaRes
> Task :app:compileDebugUnitTestKotlin
> Task :app:dexBuilderDebug
> Task :app:compileDebugUnitTestJavaWithJavac
> Task :app:processDebugUnitTestJavaRes

> Task :app:testDebugUnitTest
Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8

> Task :app:mergeDebugGlobalSynthetics
> Task :app:mergeProjectDexDebug
> Task :app:mergeDebugJavaResource
> Task :app:packageDebug
> Task :app:createDebugApkListingFileRedirect
> Task :app:assembleDebug
> Task :app:compileDebugAndroidTestKotlin

BUILD SUCCESSFUL in 53s
53 actionable tasks: 53 executed
```


```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.pulseim.android.GalleryImageWriterTest" tests="9" skipped="0" failures="0" errors="0" timestamp="2026-11-26T18:50:02" hostname="YJ-20260621IJBF" time="0.006">
  <properties/>
  <testcase name="brokenInputDoesNotPublishThePartialImage" classname="com.pulseim.android.GalleryImageWriterTest" time="0.001"/>
  <testcase name="cleanupFailureDoesNotHideTheOriginalWriteError" classname="com.pulseim.android.GalleryImageWriterTest" time="0.0"/>
  <testcase name="galleryPublicationFailureRollsBackTheWrittenImage" classname="com.pulseim.android.GalleryImageWriterTest" time="0.001"/>
  <testcase name="emptyImageNeverPublishesAnAlbumItem" classname="com.pulseim.android.GalleryImageWriterTest" time="0.0"/>
  <testcase name="outputOpenFailureDoesNotLeaveAPendingAlbumItem" classname="com.pulseim.android.GalleryImageWriterTest" time="0.0"/>
  <testcase name="originalImageBytesArePreservedAcrossMultipleChunks" classname="com.pulseim.android.GalleryImageWriterTest" time="0.003"/>
  <testcase name="cancellationAfterTheLastByteStillPreventsPublication" classname="com.pulseim.android.GalleryImageWriterTest" time="0.0"/>
  <testcase name="accountOrPreviewChangeDuringCopyCancelsAndRollsBack" classname="com.pulseim.android.GalleryImageWriterTest" time="0.0"/>
  <testcase name="exceedingTheLimitRemovesThePartialItem" classname="com.pulseim.android.GalleryImageWriterTest" time="0.001"/>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>

<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.pulseim.android.AvatarLoadPolicyTest" tests="8" skipped="0" failures="0" errors="0" timestamp="2026-11-26T18:50:02" hostname="YJ-20260621IJBF" time="0.002">
  <properties/>
  <testcase name="rateLimitsAndRequestTimeoutsGetABoundedRetry" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.001"/>
  <testcase name="transientFailuresStopAfterThreeAttempts" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.0"/>
  <testcase name="mediaIdentityMustBelongToTheCapturedApi" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.0"/>
  <testcase name="permanentFailuresDoNotLoop" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.0"/>
  <testcase name="mediaIdentityRejectsCredentialsQueriesAndUntrustedPaths" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.001"/>
  <testcase name="expiredGrantNotFoundCanRenewButPublicNotFoundStops" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.0"/>
  <testcase name="aNewerBoundUrlIsTriedBeforeRequestingAnotherGrant" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.0"/>
  <testcase name="expiredPrivateGrantRenewsOnce" classname="com.pulseim.android.AvatarLoadPolicyTest" time="0.0"/>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>
```


```json
{
  "passed": true,
  "tests": 279,
  "new_regressions": {
    "GalleryImageWriterTest": 9,
    "AvatarLoadPolicyTest": 8
  },
  "emulator_checks": 12,
  "emulator_sdk": 37,
  "qa_main_source_files_match_current": 192,
  "final_apk_source_matches_worktree": true,
  "actual_apk_feature_classes_verified": true,
  "diagnostic_harness_in_deliverable_apk": false,
  "same_signer_as_previous": true,
  "private_key_in_apk": false,
  "server_source_files_unchanged": 572,
  "real_phone_connected": false,
  "real_phone_tests_run": false,
  "production_accounts_used_for_ui_test": false,
  "first_automation_failure_retained": true,
  "version": "0.2.124",
  "version_code": 126,
  "sha256": "463c4c7cd778892d67a37d4169cee1e1ac00f790404ada99773ab2eed26cc3c4"
}
```


API 37 隔离模拟器实际触摸、平台菜单、相册写入及本地 HTTP 错误/延迟夹具的结果：


```json
{
  "passed": true,
  "checks": [
    "actual long-press opens the save-image menu",
    "MediaStore published the exact original PNG after memory eviction",
    "preview and gallery export reused one compressed original download",
    "long-press also opens save while the photo is zoomed",
    "closing the viewer dismisses its save menu",
    "eight avatar views coalesced one expired fetch and one authorized renewal",
    "grant renewal uses the captured fixture account",
    "an expired grant still reuses its scoped disk thumbnail without a network fetch",
    "a transient 503 retries once and displays the avatar",
    "persistent failures stop after three attempts",
    "a late old response cannot overwrite a recycled view",
    "account switching rejects a late previous-account avatar"
  ],
  "sdk": 37,
  "production_accounts_used": false
}
```


首轮失败保留：测试直接调用系统列表子 TextView.performClick 没有触发列表项点击，长按菜单通过但相册无新增项，最终 NoSuchElementException，原始 instrumentation-first.json/log 留存。改为真实触摸后 12 项通过；保存产品代码未因这次夹具修正改变。账号/旧行回包检查使用线程池和 UI 空闲屏障，避免只等待固定时间即判通过。

初版内部构建在补齐菜单释放、无 HTTP 状态重试边界后被最终包替代，未交付真机；两次生产配置构建均保留。报告脚本首次在工具解析时失败，没有执行文件修改，修正脚本后生成本报告。

QA 包名 com.pulseim.android.galleryqa，无真实 Firebase 配置，仅访问本机夹具，不使用生产账号。192 个原始 main 文件与最终工作区逐字节相同；最终生产配置 APK 的 265 个输入核对一致，实际字节码含新功能类/方法，不含 QA 入口/探针，私钥排除通过。279 项 JVM、Debug 与 AndroidTest Kotlin 编译通过。没有 USB 真机，未进行真机覆盖安装或真机相册/头像验收；Android 8/9 权限分支未在对应设备实测。

证据目录：.local/android-gallery-avatar-20261127-023604

最终构建、签名、端点、资源及 JVM 原始结果：.local/artifacts/android-gallery-avatar-final-20261127-024913/verification

版本 0.2.124 / versionCode 126 仅在隔离副本递增，根构建默认值不动，沿用标准包调试签名，不称为商店正式签名包。

## 5. 兼容性检查

- 账号切换：授权更新捕获原登录会话，前后核验代次；UI 回包校验当前 generation/绑定身份。模拟器通过旧账号迟到响应不覆盖新头像，JVM 通过复制中和发表前取消，不改账号存储或授权规则。
- 进程被杀后重启恢复：未改持久化、Outbox 或启动流程。内存清除后的磁盘头像复用、原文件保存已测；未运行本轮杀进程恢复，不能把清内存视为该项通过。
- 多会话并发：头像按账号/媒体合并，8 个视图只一次过期读取和一次更新；旧行迟到回包不覆盖新图。群聊/私聊共用实现；没有进行真人多会话消息发送。
- 平台：Android 10+ 相册路径已在 API 37 实测；Android 8/9 代码及原权限分发已实现，对应设备未测。iOS/PC/web 未在本轮修改。
- 服务/发布：572 个 server 文件相对构建前未变（包含保留用户原有脏文件）；未部署或重启服务器。生产端点、消息协议、AAD、Root Gradle、生产 Manifest、CHAT_V2=false、Room 门槛及 FCM 配置保持。标准包 com.pulseim.android，同包名同签名可覆盖；第三方改包或重签名兼容性未核对。

## 6. 发现但未修改的问题清单（只列，不动）

- hehe14777 / V1990A / 0.2.119 的待发附件 AEAD 失败仍待问题设备复现；本轮查看图片保存不等同于修复待发密文，未宣称旧发图问题已解决。
- 后台约 30 秒断连与 FCM 真实离线送达仍待处理；本次不混作推送修复。
- P1 真机性能、P3 真实一周及旧列表真机待验收项保持原状，不默认打开新列表或切读。
- 未覆盖全部生产头像来源、OEM 网络限制或历史数据，授权确实被撤销/删除仍遵守服务端拒绝。
- 无故障真机、Android 8/9 权限及 iOS 同类功能实机验收。
