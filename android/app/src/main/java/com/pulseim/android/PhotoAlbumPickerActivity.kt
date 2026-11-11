package com.pulseim.android

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.provider.MediaStore
import android.provider.Settings
import android.text.TextUtils
import android.util.LruCache
import android.util.Size
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.ImageView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Local image selection. The caller uploads only after receiving RESULT_OK. */
class PhotoAlbumPickerActivity : Activity() {
    companion object {
        const val MAX_CHAT_PHOTOS = 9
        const val RESULT_MEDIA_KIND = "selected_media_kind"
        const val START_VIDEO = "start_video_picker"
        fun intent(activity: Activity, previewBeforeSend: Boolean = false) = Intent(activity, PhotoAlbumPickerActivity::class.java).putExtra("preview_before_send", previewBeforeSend)
        fun selectedUris(data: Intent?): List<Uri> {
            val items = linkedSetOf<Uri>()
            data?.clipData?.let { clip -> for (i in 0 until minOf(clip.itemCount, MAX_CHAT_PHOTOS)) clip.getItemAt(i).uri?.let { items.add(it) } }
            data?.data?.let { items.add(it) }
            return items.filter { it.scheme == "content" }.take(MAX_CHAT_PHOTOS)
        }
        private const val STORAGE_REQUEST = 6101
        private const val SYSTEM_PICK_REQUEST = 6102
        internal const val VIDEO_PICK_REQUEST = 6103
    }
    private data class Photo(val uri: Uri, val album: String, val name: String, val orientation: Int)
    private data class Album(val key: String, val name: String, val cover: Photo, var count: Int = 0)
    private val queryWorker = Executors.newSingleThreadExecutor()
    private val thumbnails = ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, ArrayBlockingQueue(32), ThreadPoolExecutor.AbortPolicy())
    private val thumbnailJobs = mutableMapOf<String, Runnable>()
    private var fastScrolling = false
    private val cache = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    private var querySignal: CancellationSignal? = null
    @Volatile private var generation = 0
    private var photos = emptyList<Photo>()
    private var albums = emptyList<Album>()
    private var tab = "photos"
    private var album: String? = null
    private var visiblePhotos = emptyList<Photo>()
    private val selected = linkedSetOf<Uri>()
    private var previewDialog: PhotoSendPreview? = null
    private var previewUri: Uri? = null
    private var videoPreview: ChatVideoSendPreview? = null
    private var videoPreviewUri: Uri? = null
    private var videoSelectionToast: Toast? = null
    private val videoOnly get() = previewBeforeSend && intent.getBooleanExtra(START_VIDEO, false)
    private val previewBeforeSend get() = intent.getBooleanExtra("preview_before_send", false)
    private val maxSelection get() = if (previewBeforeSend) intent.getIntExtra("max_selection", 1).coerceIn(1, MAX_CHAT_PHOTOS) else 1
    private var returning = false
    private var permissionBusy = false
    private lateinit var title: TextView
    private lateinit var confirm: TextView
    private lateinit var photosTab: TextView
    private lateinit var albumsTab: TextView
    private lateinit var section: TextView
    private lateinit var permissionBar: LinearLayout
    private lateinit var empty: LinearLayout
    private lateinit var grid: GridView
    private val blue = 0xFF2586D5.toInt()
    private val ink get() = if (AppAppearance.dark) 0xFFF4F5F7.toInt() else 0xFF222222.toInt()
    private val muted get() = if (AppAppearance.dark) 0xFFABB1BE.toInt() else 0xFF9299A7.toInt()
    private val surface get() = if (AppAppearance.dark) 0xFF22252D.toInt() else Color.WHITE
    private val adapter = PhotoAdapter()
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    private fun label(value: String, size: Float, color: Int = ink) = TextView(this).apply { text = value; textSize = size; setTextColor(color); includeFontPadding = false }
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun current(revision: Int) = generation == revision && !isFinishing && !isDestroyed
    private fun fullAccess() = checkSelfPermission(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    private fun partialAccess() = Build.VERSION.SDK_INT >= 34 && checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED
    private fun askedBefore() = getSharedPreferences("pulse_photo_picker", MODE_PRIVATE).getBoolean("asked_for_access", false)

    override fun onCreate(savedInstanceState: Bundle?) {
        AppAppearance.load(this)
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        tab = savedInstanceState?.getString("tab") ?: if (previewBeforeSend) "photos" else "albums"
        album = savedInstanceState?.getString("album")
        savedInstanceState?.getStringArrayList("selected_uris")?.map(Uri::parse)?.filter { it.scheme == "content" }?.take(maxSelection)?.let(selected::addAll)
        if (selected.isEmpty()) savedInstanceState?.getString("selected")?.let(Uri::parse)?.let(selected::add)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = surface; window.navigationBarColor = surface
        WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = !AppAppearance.dark; isAppearanceLightNavigationBars = !AppAppearance.dark }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(surface) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12), dp(4), dp(12), dp(4)) }
        header.addView(label("×", 32f).apply { id = R.id.album_picker_close; gravity = Gravity.CENTER; contentDescription = "取消选择照片"; setOnClickListener { finish() } }, LinearLayout.LayoutParams(dp(48), dp(48)))
        title = label("请选择项目", 19f).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        header.addView(title, LinearLayout.LayoutParams(0, dp(48), 1f))
        confirm = label("✓", 28f).apply { id = R.id.album_picker_confirm; gravity = Gravity.CENTER; contentDescription = "确认选择照片"; setOnClickListener { if (selected.isNotEmpty()) returnSelections(selected.toList()) } }
        if (previewBeforeSend) { confirm.text = "发送"; confirm.textSize = 15f; confirm.contentDescription = "发送已选照片" }
        header.addView(confirm, LinearLayout.LayoutParams(dp(if (previewBeforeSend) 100 else 48), dp(48)))
        root.addView(header)
        val tabs = LinearLayout(this).apply { gravity = Gravity.CENTER }
        photosTab = label("照片", 19f).apply { id = R.id.album_picker_photos; gravity = Gravity.CENTER; setOnClickListener { tab = "photos"; album = null; render(true) } }
        albumsTab = label("相册", 19f).apply { id = R.id.album_picker_albums; gravity = Gravity.CENTER; setOnClickListener { tab = "albums"; album = null; render(true) } }
        tabs.addView(photosTab, LinearLayout.LayoutParams(dp(68), dp(56)))
        if (previewBeforeSend) tabs.addView(label("视频", 19f).apply {
            id = R.id.album_picker_videos; gravity = Gravity.CENTER; contentDescription = "从手机相册选择视频"
            setOnClickListener { openVideoPicker() }
        }, LinearLayout.LayoutParams(dp(68), dp(56)))
        tabs.addView(albumsTab, LinearLayout.LayoutParams(dp(68), dp(56)))
        root.addView(tabs)
        root.addView(View(this).apply { setBackgroundColor(if (AppAppearance.dark) 0xFF383D47.toInt() else 0xFFEEEEEE.toInt()) }, LinearLayout.LayoutParams(-1, dp(1)).apply { leftMargin = dp(22); rightMargin = dp(22) })
        permissionBar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(22), dp(8), dp(22), dp(4)) }
        permissionBar.addView(label("仅显示已授权的照片", 12f, muted), LinearLayout.LayoutParams(0, dp(32), 1f))
        permissionBar.addView(label("更改", 14f, blue).apply { id = R.id.album_picker_reselect; gravity = Gravity.CENTER; setOnClickListener { requestAccess() } }, LinearLayout.LayoutParams(dp(56), dp(40)))
        root.addView(permissionBar)
        section = label("我的相册", 14f, muted).apply { id = R.id.album_picker_section; typeface = Typeface.DEFAULT_BOLD; setPadding(dp(22), dp(24), dp(22), dp(16)) }
        root.addView(section)
        val body = FrameLayout(this)
        grid = GridView(this).apply {
            id = R.id.album_picker_grid; numColumns = 3; horizontalSpacing = dp(12); verticalSpacing = dp(20)
            stretchMode = GridView.STRETCH_COLUMN_WIDTH; setPadding(dp(22), dp(2), dp(22), dp(20)); clipToPadding = false
            selector = android.graphics.drawable.ColorDrawable(Color.TRANSPARENT); adapter = this@PhotoAlbumPickerActivity.adapter
            setOnScrollListener(object : AbsListView.OnScrollListener {
                override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) = Unit
                override fun onScrollStateChanged(view: AbsListView?, state: Int) {
                    fastScrolling = state == AbsListView.OnScrollListener.SCROLL_STATE_FLING
                    if (fastScrolling) clearQueuedThumbnails()
                    else if (state == AbsListView.OnScrollListener.SCROLL_STATE_IDLE) fillVisibleCovers()
                }
            })
        }
        body.addView(grid, FrameLayout.LayoutParams(-1, -1))
        empty = LinearLayout(this).apply { id = R.id.album_picker_empty; orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(dp(24), dp(20), dp(24), dp(20)) }
        body.addView(empty, FrameLayout.LayoutParams(-1, -1))
        root.addView(body, LinearLayout.LayoutParams(-1, 0, 1f)); setContentView(root)
        ViewCompat.requestApplyInsets(root)
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        if (!videoOnly && !fullAccess() && !partialAccess() && savedInstanceState == null && !askedBefore()) requestAccess()
        savedInstanceState?.getString("preview_uri")?.let { raw -> root.post { showPreview(Uri.parse(raw)) } }
        val restoredVideo = savedInstanceState?.getString("video_preview_uri")
        if (restoredVideo != null) root.post { showVideoPreview(Uri.parse(restoredVideo)) }
        else if (videoOnly && savedInstanceState == null) root.post { openVideoPicker() }
    }
    override fun onResume() { super.onResume(); if (::grid.isInitialized && !permissionBusy) reload() }
    private fun requestAccess() {
        if (permissionBusy || returning) return
        permissionBusy = true
        getSharedPreferences("pulse_photo_picker", MODE_PRIVATE).edit().putBoolean("asked_for_access", true).apply()
        requestPermissions(when {
            Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
            else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }, STORAGE_REQUEST)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == STORAGE_REQUEST) { permissionBusy = false; reload() }
    }
    private fun reload() {
        querySignal?.cancel(); val revision = ++generation
        clearQueuedThumbnails(); thumbnailJobs.clear()
        photos = emptyList(); albums = emptyList(); render()
        if (!fullAccess() && !partialAccess()) { cache.evictAll(); render(); return }
        showEmpty("正在加载相册…")
        val signal = CancellationSignal(); querySignal = signal
        queryWorker.execute {
            try {
                val collection = if (Build.VERSION.SDK_INT >= 29) MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                val projection = mutableListOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.BUCKET_ID, MediaStore.Images.Media.BUCKET_DISPLAY_NAME, MediaStore.Images.Media.ORIENTATION)
                if (Build.VERSION.SDK_INT >= 29) projection.add(MediaStore.Images.Media.VOLUME_NAME)
                val found = ArrayList<Photo>(); val buckets = linkedMapOf<String, Album>()
                contentResolver.query(collection, projection.toTypedArray(), "${MediaStore.Images.Media.SIZE}>0", null, "${MediaStore.Images.Media.DATE_ADDED} DESC, ${MediaStore.Images.Media._ID} DESC", signal)?.use { cursor ->
                    while (cursor.moveToNext()) {
                        signal.throwIfCanceled()
                        val volume = if (Build.VERSION.SDK_INT >= 29) cursor.getString(4) ?: MediaStore.VOLUME_EXTERNAL_PRIMARY else "external"
                        val itemCollection = if (Build.VERSION.SDK_INT >= 29) MediaStore.Images.Media.getContentUri(volume) else collection
                        val key = volume + ":" + (cursor.getString(1) ?: "other")
                        val photo = Photo(ContentUris.withAppendedId(itemCollection, cursor.getLong(0)), key, cursor.getString(2)?.takeIf { it.isNotBlank() } ?: "其他相册", cursor.getInt(3))
                        found.add(photo); buckets.getOrPut(key) { Album(key, photo.name, photo) }.count++
                    }
                }
                runOnUiThread { if (current(revision)) { photos = found; albums = buckets.values.toList(); render() } }
            } catch (error: Exception) {
                runOnUiThread { if (current(revision) && !signal.isCanceled) { render(); showEmpty("无法读取相册，请重新授权或重试", true) } }
            }
        }
    }
    private fun render(scrollToTop: Boolean = false) {
        val showingAlbums = tab == "albums" && album == null
        title.text = if (album != null) albums.firstOrNull { it.key == album }?.name ?: "相册" else if (previewBeforeSend) "选择照片" else "请选择项目"
        photosTab.setTextColor(if (tab == "photos") blue else ink); albumsTab.setTextColor(if (tab == "albums") blue else ink)
        photosTab.typeface = if (tab == "photos") Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        albumsTab.typeface = if (tab == "albums") Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        photosTab.isSelected = tab == "photos"; albumsTab.isSelected = tab == "albums"
        updateSelectionControls()
        permissionBar.visibility = if (!fullAccess() && partialAccess()) View.VISIBLE else View.GONE
        visiblePhotos = if (showingAlbums) emptyList() else if (album == null) photos else photos.filter { it.album == album }
        grid.horizontalSpacing = dp(if (showingAlbums) 12 else 4)
        grid.verticalSpacing = dp(if (showingAlbums) 20 else 4)
        grid.setPadding(dp(if (showingAlbums) 22 else 4), dp(2), dp(if (showingAlbums) 22 else 4), dp(20))
        section.setPadding(dp(if (showingAlbums) 22 else 12), dp(if (showingAlbums) 24 else 10), dp(12), dp(if (showingAlbums) 16 else 10))
        section.text = if (showingAlbums) "我的相册" else if (album == null) "全部照片" else "${visiblePhotos.size} 张照片"
        adapter.items = if (showingAlbums) albums else visiblePhotos
        adapter.notifyDataSetChanged()
        grid.visibility = if (adapter.count > 0) View.VISIBLE else View.GONE
        empty.visibility = if (adapter.count == 0) View.VISIBLE else View.GONE
        if (adapter.count == 0) showEmpty(if (fullAccess() || partialAccess()) "暂无照片" else "允许访问照片后查看相册", true)
        if (scrollToTop) grid.setSelection(0)
    }
    private fun updateSelectionControls() {
        confirm.isEnabled = selected.isNotEmpty() && !returning
        confirm.setTextColor(if (confirm.isEnabled) blue else muted)
        if (previewBeforeSend) { confirm.text = if (selected.isEmpty()) "发送" else "发送(${selected.size})"; confirm.contentDescription = "发送已选${selected.size}张照片" }
    }
    private fun refreshSelection() {
        updateSelectionControls()
        for (index in 0 until grid.childCount) (grid.getChildAt(index) as? Cell)?.let { cell ->
            if (!cell.isAlbum) cell.photo?.let { bindSelection(cell, it) }
        }
    }
    private fun bindSelection(cell: Cell, photo: Photo) {
        val checked = photo.uri in selected
        cell.tick.text = if (checked) { if (maxSelection > 1) (selected.indexOf(photo.uri) + 1).toString() else "✓" } else ""
        cell.tick.background = rounded(if (checked) blue else 0x77000000, 20).apply { if (!checked) setStroke(dp(1), Color.WHITE) }
        // GridView owns its children's selected/focus state while recycling.
        // Keep the photo's checked state independent of that navigation state.
        cell.isActivated = checked
        cell.contentDescription = if (checked) "预览已选择照片" else "预览照片"
        cell.tickTarget.contentDescription = if (checked) "已选择第${selected.indexOf(photo.uri) + 1}张，取消选择照片" else "选择照片"
        cell.tickTarget.isActivated = checked
    }
    private fun showEmpty(message: String, actions: Boolean = false) {
        empty.removeAllViews(); empty.visibility = View.VISIBLE
        empty.addView(label(message, 15f, muted).apply { gravity = Gravity.CENTER; setPadding(0, 0, 0, dp(16)) })
        if (!actions) return
        empty.addView(label(if (fullAccess() || partialAccess()) "重新加载" else "授权相册", 15f, blue).apply {
            id = R.id.album_picker_access; gravity = Gravity.CENTER; minHeight = dp(48)
            setOnClickListener {
                if (fullAccess()) reload()
                else if (partialAccess() || !askedBefore() || shouldShowRequestPermissionRationale(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE)) requestAccess()
                else startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
        }, LinearLayout.LayoutParams(-1, dp(48)))
        empty.addView(label("选择指定照片", 15f, blue).apply { id = R.id.album_picker_system; gravity = Gravity.CENTER; setOnClickListener { openSystemPicker() } }, LinearLayout.LayoutParams(-1, dp(48)))
    }
    private fun openSystemPicker() {
        val picker = if (Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*").apply {
            if (maxSelection > 1) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, minOf(maxSelection, MediaStore.getPickImagesMaxLimit()))
        } else Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, maxSelection > 1)
        try { startActivityForResult(picker, SYSTEM_PICK_REQUEST) }
        catch (error: android.content.ActivityNotFoundException) { Toast.makeText(this, "没有可用的系统相册，请先授权相册访问", Toast.LENGTH_LONG).show() }
    }
    private fun openVideoPicker() {
        if (!previewBeforeSend || returning || isFinishing || isDestroyed) return
        if (selected.isNotEmpty()) {
            videoSelectionToast?.cancel()
            videoSelectionToast = Toast.makeText(this, "视频需要单独发送，请先取消已选照片", Toast.LENGTH_SHORT).also { it.show() }
            return
        }
        videoSelectionToast?.cancel(); videoSelectionToast = null
        try { startActivityForResult(ChatVideoPicker.intent(this), VIDEO_PICK_REQUEST) }
        catch (_: android.content.ActivityNotFoundException) { Toast.makeText(this, "没有可用的视频相册，请安装相册应用后重试", Toast.LENGTH_LONG).show(); if (videoOnly) finish() }
    }
    private fun showVideoPreview(uri: Uri) {
        if (!previewBeforeSend || returning || isFinishing || isDestroyed || uri.scheme != "content") return
        if (videoPreview?.isShowing == true) return
        videoPreviewUri = uri
        videoPreview = ChatVideoSendPreview(this, uri, { returnSelections(listOf(uri), "video") }, {
            videoPreview = null; videoPreviewUri = null
            if (videoOnly && !returning && !isFinishing && !isChangingConfigurations && !isDestroyed) finish()
        }).also { it.show() }
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VIDEO_PICK_REQUEST) {
            val uri = selectedUris(data).firstOrNull()
            if (resultCode == RESULT_OK && uri != null) showVideoPreview(uri)
            else if (videoOnly) finish()
            return
        }
        if (requestCode == SYSTEM_PICK_REQUEST && resultCode == RESULT_OK) {
            val picked = selectedUris(data).take(maxSelection)
            if (picked.isEmpty()) return
            if (maxSelection == 1) selected.clear()
            picked.forEach { if (selected.size < maxSelection) selected.add(it) }
            returnSelections(selected.toList())
        }
    }
    private fun showPreview(uri: Uri) {
        if (!previewBeforeSend || returning || isFinishing || isDestroyed || uri.scheme != "content") return
        previewDialog?.dismiss()
        previewUri = uri
        val gallery = (visiblePhotos.map { it.uri } + selected + uri).distinct()
        val dialog = PhotoSendPreview(this, gallery, gallery.indexOf(uri), selected.toList(), { items, current ->
            selected.clear(); selected.addAll(items); previewUri = current; refreshSelection()
        }) { confirmed -> returnSelections(confirmed) }
        previewDialog = dialog
        dialog.setOnDismissListener { if (previewDialog === dialog) { previewDialog = null; previewUri = null } }
        dialog.show()
    }
    private fun returnSelection(uri: Uri, previewConfirmed: Boolean = false) {
        if (returning || uri.scheme != "content") return
        if (previewBeforeSend && !previewConfirmed) { showPreview(uri); return }
        returnSelections(listOf(uri))
    }
    private fun returnSelections(uris: List<Uri>, kind: String = "image") {
        if (returning || uris.isEmpty() || uris.size > maxSelection || uris.any { it.scheme != "content" }) return
        if (kind !in listOf("image", "video") || (kind == "video" && (!previewBeforeSend || uris.size != 1))) return
        val confirmed = uris.distinct().toList()
        returning = true; confirm.isEnabled = false
        queryWorker.execute {
            val unreadable = confirmed.filter { uri -> !runCatching { contentResolver.openFileDescriptor(uri, "r")?.use { true } ?: false }.getOrDefault(false) }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (unreadable.isNotEmpty()) { returning = false; selected.removeAll(unreadable.toSet()); previewDialog?.dismiss(); Toast.makeText(this, "部分照片已移动或访问权限已变化，请重新选择", Toast.LENGTH_LONG).show(); reload(); return@runOnUiThread }
                val clips = ClipData.newUri(contentResolver, if (kind == "video") "视频" else "照片", confirmed.first())
                confirmed.drop(1).forEach { clips.addItem(ClipData.Item(it)) }
                setResult(RESULT_OK, Intent().setData(confirmed.first()).putExtra(RESULT_MEDIA_KIND, kind).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = clips }); finish()
            }
        }
    }
    private fun navigateBack() { if (videoPreview?.isShowing == true) videoPreview?.dismiss() else if (previewDialog?.isShowing == true) previewDialog?.dismiss() else if (album != null) { album = null; render(true) } else finish() }
    @Deprecated("Used on Android 8–12") override fun onBackPressed() { navigateBack() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("tab", tab); outState.putString("album", album); outState.putStringArrayList("selected_uris", ArrayList(selected.map(Uri::toString))); outState.putString("preview_uri", previewUri?.toString()); outState.putString("video_preview_uri", videoPreviewUri?.toString()); super.onSaveInstanceState(outState) }
    override fun onDestroy() { previewDialog?.dismiss(); videoPreview?.dismiss(); videoSelectionToast?.cancel(); generation++; querySignal?.cancel(); queryWorker.shutdownNow(); clearQueuedThumbnails(); thumbnails.shutdownNow(); thumbnailJobs.clear(); cache.evictAll(); super.onDestroy() }

    private inner class Cell : LinearLayout(this@PhotoAlbumPickerActivity) {
        var photo: Photo? = null
        var isAlbum = false
        val cover = ImageView(this@PhotoAlbumPickerActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; background = rounded(if (AppAppearance.dark) 0xFF363B45.toInt() else 0xFFF1F2F4.toInt(), 12); clipToOutline = true }
        val tick = label("", 14f, Color.WHITE).apply { gravity = Gravity.CENTER; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        val tickTarget = FrameLayout(this@PhotoAlbumPickerActivity).apply {
            isClickable = true; isFocusable = true
            addView(tick, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER))
        }
        val name = label("", 15f).apply { setPadding(0, dp(8), 0, dp(4)); maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        val count = label("", 12f, muted)
        init {
            orientation = VERTICAL
            val frame = FrameLayout(this@PhotoAlbumPickerActivity)
            val side = ((resources.displayMetrics.widthPixels - dp(68)) / 3).coerceAtLeast(dp(48))
            frame.addView(cover, FrameLayout.LayoutParams(-1, -1)); frame.addView(tickTarget, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.BOTTOM or Gravity.END))
            addView(frame, LayoutParams(-1, side)); addView(name); addView(count)
        }
    }
    private inner class PhotoAdapter : BaseAdapter() {
        var items: List<Any> = emptyList()
        override fun getCount() = items.size
        override fun getItem(position: Int) = items[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val item = items[position]; val cell = convertView as? Cell ?: Cell()
            val photo = if (item is Album) item.cover else item as Photo
            cell.photo = photo; cell.isAlbum = item is Album
            val side = ((resources.displayMetrics.widthPixels - grid.paddingLeft - grid.paddingRight - grid.horizontalSpacing * 2) / 3).coerceAtLeast(dp(48))
            (cell.cover.parent as? FrameLayout)?.let { frame -> if (frame.layoutParams.height != side) frame.layoutParams = frame.layoutParams.apply { height = side } }
            cell.name.visibility = if (item is Album) View.VISIBLE else View.GONE; cell.count.visibility = cell.name.visibility
            cell.tickTarget.visibility = if (item is Album) View.GONE else View.VISIBLE
            if (item is Album) {
                cell.isActivated = false
                cell.name.text = item.name; cell.count.text = item.count.toString(); cell.contentDescription = "相册：${item.name}，${item.count}张照片"
                cell.setOnClickListener { album = item.key; render(true) }
            } else {
                bindSelection(cell, photo)
                val choose = View.OnClickListener { if (!returning) {
                    if (photo.uri in selected) selected.remove(photo.uri)
                    else if (selected.size < maxSelection || maxSelection == 1) { if (maxSelection == 1) selected.clear(); selected.add(photo.uri) }
                    else Toast.makeText(this@PhotoAlbumPickerActivity, "一次最多选择${maxSelection}张照片", Toast.LENGTH_SHORT).show()
                    refreshSelection()
                } }
                cell.tick.setOnClickListener(choose)
                cell.tickTarget.setOnClickListener(choose)
                cell.setOnClickListener { if (previewBeforeSend) showPreview(photo.uri) else choose.onClick(it) }
            }
            loadCover(photo, cell.cover)
            return cell
        }
    }
    private fun loadCover(photo: Photo, image: ImageView) {
        val key = photo.uri.toString()
        if (image.tag == key && image.drawable != null) return
        image.tag = key; image.setImageDrawable(null)
        cache.get(key)?.let { image.setImageBitmap(it); return }
        if (fastScrolling || thumbnailJobs.containsKey(key)) return
        val revision = generation
        lateinit var task: Runnable
        task = Runnable {
            val bitmap = if (current(revision)) runCatching { decodeCover(photo) }.getOrNull() else null
            runOnUiThread {
                if (thumbnailJobs[key] === task) thumbnailJobs.remove(key)
                if (!current(revision)) { bitmap?.recycle(); return@runOnUiThread }
                if (bitmap != null) {
                    cache.put(key, bitmap)
                    for (index in 0 until grid.childCount) (grid.getChildAt(index) as? Cell)?.cover?.let { cover ->
                        if (cover.tag == key) cover.setImageBitmap(bitmap)
                    }
                }
            }
        }
        thumbnailJobs[key] = task
        try { thumbnails.execute(task) } catch (_: RejectedExecutionException) { if (thumbnailJobs[key] === task) thumbnailJobs.remove(key) }
    }
    private fun clearQueuedThumbnails() {
        val removed = ArrayList<Runnable>(); thumbnails.queue.drainTo(removed)
        thumbnailJobs.entries.removeAll { it.value in removed }
    }
    private fun fillVisibleCovers() {
        for (index in 0 until grid.childCount) (grid.getChildAt(index) as? Cell)?.let { cell -> cell.photo?.let { loadCover(it, cell.cover) } }
    }
    private fun decodeCover(photo: Photo): Bitmap? {
        val edge = dp(120).coerceIn(128, 512)
        if (Build.VERSION.SDK_INT >= 29) runCatching { contentResolver.loadThumbnail(photo.uri, Size(edge, edge), null) }.getOrNull()?.let { return it }
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(photo.uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        if (options.outWidth <= 0 || options.outHeight <= 0) return null
        var sample = 1; while (maxOf(options.outWidth, options.outHeight) / sample > edge * 2) sample *= 2
        options.inJustDecodeBounds = false; options.inSampleSize = sample
        var bitmap = contentResolver.openInputStream(photo.uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
        if (maxOf(bitmap.width, bitmap.height) > edge) {
            val scale = edge.toFloat() / maxOf(bitmap.width, bitmap.height)
            val resized = Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true)
            if (resized !== bitmap) { bitmap.recycle(); bitmap = resized }
        }
        if (photo.orientation == 0) return bitmap
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(photo.orientation.toFloat()) }, true).also { if (it !== bitmap) bitmap.recycle() }
    }
}
