package com.pulseim.android

import android.content.Context
import android.graphics.*
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.Editable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.TextUtils
import android.text.TextWatcher
import android.view.*
import android.view.inputmethod.EditorInfo
import android.widget.*
import net.sourceforge.pinyin4j.PinyinHelper
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.roundToInt

internal const val CHAT_BG = 0xFFF8F7FF.toInt()
internal const val CHAT_INK = 0xFF111111.toInt()
internal const val CHAT_GREY = 0xFF98999B.toInt()
internal const val CHAT_BLUE = 0xFF5688F9.toInt()

internal open class ChatScreen(context: Context) : LinearLayout(context) {
    fun px(value: Int) = (value * resources.displayMetrics.widthPixels / 873f).roundToInt()
    fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    fun label(value: String, size: Float = 16f, color: Int = CHAT_INK) = TextView(context).apply {
        text = value; textSize = size; setTextColor(color); includeFontPadding = false
    }
    fun surface(color: Int = Color.WHITE, radius: Int = 0) = GradientDrawable().apply { setColor(color); cornerRadius = px(radius).toFloat() }
    fun command(value: String, idValue: Int = NO_ID, action: () -> Unit) = label(value).apply {
        id = idValue; gravity = Gravity.CENTER; minHeight = dp(44); setOnClickListener { action() }
    }
    fun header(title: String, back: (() -> Unit)?, right: View? = null) {
        addView(FrameLayout(context).apply {
            setBackgroundColor(Color.WHITE)
            addView(label(title, 19f).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }, FrameLayout.LayoutParams(-1, -1))
            if (back != null) addView(ContactIconView(context, "back", CHAT_INK).apply {
                contentDescription = "返回"; setPadding(px(41), px(35), px(41), px(35)); setOnClickListener { back() }
            }, FrameLayout.LayoutParams(px(140), -1, Gravity.START))
            if (right != null) addView(right, FrameLayout.LayoutParams(px(150), -1, Gravity.END).apply { rightMargin = px(20) })
        }, LayoutParams(-1, px(128)))
    }
    fun search(hintValue: String, idValue: Int, onSubmit: (String) -> Unit) = EditText(context).apply {
        id = idValue; hint = hintValue; textSize = 16f; isSingleLine = true
        setTextColor(CHAT_INK); setHintTextColor(CHAT_GREY); background = surface(0xFFF3F2FA.toInt(), 24)
        setPadding(px(90), 0, px(24), 0)
        imeOptions = EditorInfo.IME_ACTION_SEARCH
        setOnEditorActionListener { _, action, event ->
            if (action == EditorInfo.IME_ACTION_SEARCH || event?.keyCode == KeyEvent.KEYCODE_ENTER) {
                if (event == null || event.action == KeyEvent.ACTION_UP) {
                    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
                        .hideSoftInputFromWindow(windowToken, 0)
                    onSubmit(text.toString().trim())
                }
                true
            } else false
        }
    }
    fun searchBand(edit: EditText, top: Int = 0) = FrameLayout(context).apply {
        setBackgroundColor(Color.WHITE)
        addView(edit, FrameLayout.LayoutParams(-1, px(96)).apply { setMargins(px(34), px(top), px(34), px(20)) })
        addView(ContactIconView(context, "search", CHAT_GREY).apply { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }, FrameLayout.LayoutParams(px(39), px(39)).apply { leftMargin = px(66); topMargin = px(top + 29) })
    }
    init {
        orientation = VERTICAL; setBackgroundColor(CHAT_BG)
        setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            } else setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
    }
}

/** Reuse decoded avatars across row updates and renewed access signatures. */
internal object ChatAvatars {
    private val pool = Executors.newFixedThreadPool(2)
    private val lock = Any()
    private var generation = 0L
    @Volatile private var account = "guest"
    fun account(base: String, userId: Int, token: String?) {
        val next = AvatarDiskCache.key("account", "$base|$userId|${token.orEmpty()}")
        synchronized(lock) { if (account != next) { account = next; generation++; requests.clear(); displayed.clear(); bindings.clear(); cache.evictAll() } }
    }
    private val cache = object : android.util.LruCache<String, Bitmap>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private class Request(val key: String, var url: String, val generation: Long, val diskEpoch: Int) {
        val views = ArrayList<java.lang.ref.WeakReference<ImageView>>()
    }
    private val requests = mutableMapOf<String, Request>()
    private val displayed = java.util.WeakHashMap<ImageView, String>()
    private val bindings = java.util.WeakHashMap<ImageView, String>()
    fun identity(url: String): String = runCatching {
        val uri = android.net.Uri.parse(url)
        if (!uri.isHierarchical || listOf("media_expires", "media_signature", "media_session", "media_kind").any { uri.getQueryParameter(it).isNullOrBlank() }) return@runCatching url
        val builder = uri.buildUpon().clearQuery()
        uri.queryParameterNames.sorted().filterNot { it == "media_expires" || it == "media_signature" }.forEach { name ->
            uri.getQueryParameters(name).forEach { builder.appendQueryParameter(name, it) }
        }
        builder.build().toString()
    }.getOrDefault(url)
    fun bind(view: ImageView, url: String) = bind(view, url, false)
    fun bind(view: ImageView, url: String, keepCurrent: Boolean) {
        val key = AvatarDiskCache.key(account, identity(url))
        val previous = synchronized(lock) { bindings.put(view, url)?.let { AvatarDiskCache.key(account, identity(it)) } }
        if (url.isBlank()) { view.setImageDrawable(null); synchronized(lock) { displayed.remove(view) }; return }
        if (previous == key && view.drawable != null && synchronized(lock) { displayed[view] == key }) return
        cache.get(key)?.let { view.setImageBitmap(it); synchronized(lock) { displayed[view] = key }; return }
        if (!keepCurrent || previous == null) { view.setImageDrawable(null); synchronized(lock) { displayed.remove(view) } }
        val diskEpoch = AvatarDiskCache.epoch()
        val context = view.context.applicationContext
        val pending: Request
        synchronized(lock) {
            cache.get(key)?.let { view.setImageBitmap(it); displayed[view] = key; return }
            requests[key]?.let { existing ->
                existing.url = url
                existing.views.removeAll { it.get() == null }
                if (existing.views.none { it.get() === view }) existing.views.add(java.lang.ref.WeakReference(view))
                return
            }
            pending = Request(key, url, generation, diskEpoch).apply { views.add(java.lang.ref.WeakReference(view)) }
            requests[key] = pending
        }
        pool.execute {
            var bitmap: Bitmap? = runCatching { AvatarDiskCache.read(context, key) }.getOrNull()
            val fromDisk = bitmap != null
            for (attempt in 0..1) {
                if (bitmap != null || synchronized(lock) { pending.generation != generation }) break
                val source = synchronized(lock) { pending.url }
                try {
                    val connection = URL(source).openConnection() as HttpURLConnection
                    connection.connectTimeout = 6000; connection.readTimeout = 6000
                    val bytes = try { connection.inputStream.use { input ->
                        val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                        while (true) { val n = input.read(buffer); if (n < 0) break; require(out.size() + n <= 10 * 1024 * 1024); out.write(buffer, 0, n) }
                        out.toByteArray()
                    } } finally { connection.disconnect() }
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0)
                    val options = BitmapFactory.Options().apply { inSampleSize = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 256) inSampleSize *= 2 }
                    bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                    break
                } catch (_: Exception) {
                    if (attempt == 1 || synchronized(lock) { pending.url == source || pending.generation != generation }) break
                }
            }
            val image = bitmap
            if (image != null && !fromDisk) AvatarDiskCache.write(context, key, image, pending.diskEpoch) { synchronized(lock) { pending.generation == generation && requests[key] === pending } }
            val targets = synchronized(lock) {
                if (requests[key] !== pending || pending.generation != generation) return@execute
                requests.remove(key)
                if (image != null) cache.put(key, image)
                pending.views.toList()
            }
            if (image != null) targets.forEach { reference -> reference.get()?.let { target ->
                target.post { if (synchronized(lock) { pending.generation == generation && AvatarDiskCache.key(account, identity(bindings[target] ?: "")) == key }) {
                    target.setImageBitmap(image); synchronized(lock) { displayed[target] = key }
                } }
            } }
        }
    }
    fun clear() { synchronized(lock) { generation++; requests.clear(); displayed.clear(); cache.evictAll() } }
    fun clear(context: Context) { clear(); AvatarDiskCache.clear(context) }
    fun trimMemory() { cache.evictAll() }
}

internal fun ChatScreen.avatar(name: String, key: Int, url: String = "", size: Int = 116): FrameLayout = FrameLayout(context).apply {
    val colors = intArrayOf(0xFF78C54A.toInt(), 0xFFF58D43.toInt(), 0xFFE86559.toInt(), 0xFF649DE3.toInt(), 0xFF47BDA8.toInt())
    background = surface(colors[Math.floorMod(key, colors.size)], 23); clipToOutline = true
    addView(label(name.take(1), 20f, Color.WHITE).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }, FrameLayout.LayoutParams(-1, -1))
    if (url.isNotBlank()) addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, url) }, FrameLayout.LayoutParams(-1, -1))
    layoutParams = LinearLayout.LayoutParams(px(size), px(size))
}

internal fun jsonText(item: JSONObject, key: String): String = if (item.isNull(key)) "" else item.optString(key)
internal fun messageSummary(message: JSONObject?, selfId: Int, appName: String): String {
    if (message == null) return ""
    if (!message.isNull("recalled_at") || message.optString("status") == "recalled") return "[消息已撤回]"
    val body = message.optJSONObject("body")
    val value = when (message.optString("type")) {
        "text", "system" -> body?.optString("text").orEmpty()
        "image" -> "[图片]"; "video" -> "[视频]"; "voice" -> "[语音]"; "file" -> "[文件]"
        "contact_card" -> "[名片]"; "red_packet" -> "[历史红包已停用]"; "shake" -> "[窗口抖动]"
        else -> "[消息]"
    }
    return (if (message.optInt("sender_id") == selfId) "您:" else "") + value
}

internal class ChatHomeView(
    context: Context, private val selfId: Int, private val resolveAvatar: (String) -> String,
    private val onOpen: (JSONObject) -> Unit, private val onDelete: (List<Int>) -> Unit,
    private val onMenu: (View) -> Unit, onLine: () -> Unit, onSearch: (String) -> Unit,
    onNavigate: (String) -> Unit, private val onMore: (Int) -> Unit,
    private val onNotice: () -> Unit
) : ChatScreen(context) {
    val refreshGate = ConversationRefreshGate()
    val loadState = HomeTabLoadState()
    var contactName: (Int, String) -> String = { _, fallback -> fallback }
    fun refreshContactNames() { adapter.notifyDataSetChanged() }
    private val snapshots = ConversationSnapshotState<JSONObject>()
    val realtimeRevision get() = snapshots.revision
    private val items = mutableListOf<JSONObject>()
    private val selected = mutableSetOf<Int>()
    private var editing = false
    private var pageNumber = 1
    private var completeDirectoryShown = false
    private var completeDirectoryRevision = -1
    private val status = label("", 14f, CHAT_GREY).apply { gravity = Gravity.CENTER; setPadding(0, dp(24), 0, dp(24)); visibility = GONE; accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE }
    private val loadingIndicator = listLoadingIndicator(context)
    private val moreIndicator = listLoadingIndicator(context).apply { visibility = GONE }
    private val delete = command("删除", R.id.chat_delete_selected) { if (selected.isNotEmpty()) onDelete(selected.toList()) }.apply { visibility = GONE; setTextColor(0xFFE45D54.toInt()) }
    private val pencil = ChatGlyph(context, "pencil").apply { id = R.id.chat_edit; contentDescription = "选择删除聊天窗口"; setPadding(px(27), px(28), px(27), px(28)); setOnClickListener { setEditing(!editing) } }
    private val more = command("加载更多") { onMore(pageNumber + 1) }.apply { visibility = GONE; layoutParams = AbsListView.LayoutParams(-1, dp(48)) }
    private val notice = label("", 14.5f).apply { id = R.id.chat_announcement; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
    private val noticeBand = LinearLayout(context).apply {
        gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(Color.WHITE); setPadding(px(34), 0, px(34), 0); visibility = GONE
        addView(ChatGlyph(context, "notice"), LayoutParams(px(40), px(40)))
        addView(notice, LayoutParams(0, -2, 1f).apply { leftMargin = px(16) })
    }
    private var displayedItems: List<JSONObject> = emptyList()
    private val adapter = object : BaseAdapter() {
        override fun hasStableIds() = true
        override fun notifyDataSetChanged() { list.publishRows { displayedItems = items.toList(); super.notifyDataSetChanged() } }
        override fun getCount() = displayedItems.size
        override fun getItem(position: Int) = displayedItems[position]
        override fun getItemId(position: Int) = displayedItems[position].optInt("id").toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val holder = (convertView?.tag as? Holder) ?: Holder()
            holder.bind(displayedItems[position]); return holder.row
        }
    }
    private val list: TapResponsiveListView = TapResponsiveListView(context).apply {
        divider = ColorDrawable(0xFFF3F2F6.toInt()); dividerHeight = 1; setSelector(ColorDrawable(Color.TRANSPARENT)); scrollBarSize = dp(2)
        addFooterView(FrameLayout(context).apply {
            addView(more, FrameLayout.LayoutParams(-1, dp(48)))
            addView(moreIndicator, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER))
        }, null, false); adapter = this@ChatHomeView.adapter
        setOnItemClickListener { _, _, position, _ ->
            val shown = displayedItems.getOrNull(position) ?: return@setOnItemClickListener
            items.firstOrNull { it.optInt("id") == shown.optInt("id") }?.let { if (editing) toggle(it.optInt("id")) else onOpen(it) }
        }
    }
    init {
        val head = FrameLayout(context).apply {
            setBackgroundColor(Color.WHITE)
            addView(label("聊天", 19f).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }, FrameLayout.LayoutParams(-1, -1))
            addView(pencil, FrameLayout.LayoutParams(px(112), -1, Gravity.START))
            addView(command("切换线路", R.id.chat_switch_line, onLine).apply { textSize = 14.5f }, FrameLayout.LayoutParams(px(150), -1, Gravity.END).apply { rightMargin = px(138) })
            addView(ContactIconView(context, "plus", CHAT_INK).apply { id = R.id.chat_add; contentDescription = "聊天操作菜单"; setPadding(px(32), px(32), px(32), px(32)); setOnClickListener { onMenu(this) } }, FrameLayout.LayoutParams(px(112), -1, Gravity.END).apply { rightMargin = px(20) })
        }
        addView(head, LayoutParams(-1, px(128)))
        addView(noticeBand, LayoutParams(-1, px(84)))
        addView(searchBand(search("搜索消息或用户", R.id.chat_search, onSearch), 0))
        val body = FrameLayout(context)
        body.addView(list, FrameLayout.LayoutParams(-1, -1))
        body.addView(status, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        body.addView(loadingIndicator, FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER))
        addView(body, LayoutParams(-1, 0, 1f)); addView(delete, LayoutParams(-1, dp(48)))
        addView(ContactsNavigation(context, "chat", onNavigate))
    }
    fun setNotice(value: String) {
        notice.text = value.replace("{app_name}", context.getString(R.string.app_name)); noticeBand.visibility = if (value.isBlank()) GONE else VISIBLE
        noticeBand.setOnClickListener { onNotice() }
    }
    fun accept(result: JSONObject, page: Int, requestRevision: Int = realtimeRevision) {
        if (requestRevision < completeDirectoryRevision) return
        loadState.accept(android.os.SystemClock.elapsedRealtime())
        loadingIndicator.visibility = GONE; moreIndicator.visibility = GONE
        status.setOnClickListener(null)
        val rows = result.getJSONArray("items")
        val incoming = (0 until rows.length()).map { rows.getJSONObject(it).let { item -> item.optInt("id") to item } }
        val merged = snapshots.merge(requestRevision, incoming, items.map { it.optInt("id") to it }, page == 1 && !completeDirectoryShown)
        items.clear(); items.addAll(merged)
        sortConversations()
        pageNumber = page; status.visibility = if (items.isEmpty()) VISIBLE else GONE; status.text = "还没有会话"
        more.visibility = if (items.size < result.optInt("total")) VISIBLE else GONE; more.isEnabled = true; more.text = "加载更多"
        selected.retainAll(items.map { it.optInt("id") }.toSet()); adapter.notifyDataSetChanged(); updateDelete()
    }
    /** A late disk read never replaces network results or already observed message/hide events. */
    fun restoreLocalSnapshot(result: JSONObject): Boolean {
        if (items.isNotEmpty() || loadState.hasSnapshot || realtimeRevision != 0) return false
        val rows = result.getJSONArray("items")
        val restored = (0 until rows.length()).map { JSONObject(rows.getJSONObject(it).toString()) }
        require(restored.all { it.optInt("id") > 0 } && restored.map { it.optInt("id") }.toSet().size == restored.size)
        items.addAll(restored); sortConversations(); loadState.restore()
        completeDirectoryShown = restored.size >= result.optInt("total")
        loadingIndicator.visibility = GONE
        pageNumber = result.optInt("page", 1)
        status.visibility = if (items.isEmpty()) VISIBLE else GONE; status.text = "还没有会话"
        more.visibility = if (items.size < result.optInt("total")) VISIBLE else GONE
        more.isEnabled = !loadState.loading; more.text = "加载更多"
        adapter.notifyDataSetChanged(); return true
    }
    fun acceptCompleteSnapshot(result: JSONObject, requestRevision: Int): Boolean {
        if (requestRevision != realtimeRevision) return false
        completeDirectoryShown = false
        accept(result, 1, requestRevision)
        completeDirectoryShown = true
        // This complete result supersedes any ordinary page that was already in flight.
        completeDirectoryRevision = snapshots.advanceSnapshotRevision()
        return true
    }
    fun mergeFriendConversations(result: JSONObject, requestRevision: Int) {
        if (requestRevision < completeDirectoryRevision) return
        val rows = result.getJSONArray("items")
        val incoming = (0 until rows.length()).map { rows.getJSONObject(it).let { row -> row.optInt("id") to row } }.filter { it.first > 0 }
        val merged = snapshots.merge(requestRevision, incoming, items.map { it.optInt("id") to it }, false)
        items.clear(); items.addAll(merged)
        // Older page responses must not erase these newly accepted chats.
        val changed = incoming.map { it.first }.toSet()
        items.filter { it.optInt("id") in changed }.forEach { snapshots.changed(it.optInt("id")) }
        sortConversations(); status.visibility = if (items.isEmpty()) VISIBLE else GONE
        more.visibility = if (items.size < result.optInt("total")) VISIBLE else GONE
        adapter.notifyDataSetChanged()
    }
    fun updateConversationMessage(message: JSONObject): Boolean {
        val item = items.firstOrNull { it.optInt("id") == message.optInt("conversation_id") } ?: return false
        val id = message.optInt("id")
        if (id <= maxOf(item.optInt("cleared_before_message_id"), item.optJSONObject("last_message")?.optInt("id") ?: 0)) return true
        item.put("last_message", message); item.put("updated_at", message.optString("created_at", item.optString("updated_at")))
        if (message.optInt("sender_id") != selfId) item.put("unread_count", item.optInt("unread_count") + 1)
        val body = message.optJSONObject("body")
        val targets = body?.optJSONArray("mention_user_ids")
        if (item.optString("type") == "group" && message.optInt("sender_id") != selfId &&
            (body?.optBoolean("mention_all") == true || (0 until (targets?.length() ?: 0)).any { targets?.optInt(it) == selfId })) {
            item.put("unread_mention_count", item.optInt("unread_mention_count") + 1)
            item.put("last_mention_message_id", id)
        }
        snapshots.changed(item.optInt("id"))
        sortConversations(); adapter.notifyDataSetChanged(); return true
    }
    fun invalidateConversation(id: Int, message: JSONObject? = null) {
        if (message == null) return
        val item = items.firstOrNull { it.optInt("id") == id } ?: return
        if (item.optJSONObject("last_message")?.optInt("id") == message.optInt("id")) {
            item.put("last_message", message); snapshots.changed(id); adapter.notifyDataSetChanged()
        }
    }
    private fun sortConversations() { items.sortWith(compareByDescending<JSONObject> { it.optBoolean("is_pinned") }.thenByDescending { it.optString("updated_at") }.thenByDescending { it.optInt("id") }) }
    fun showError(value: String, requestRevision: Int = realtimeRevision) {
        if (requestRevision < completeDirectoryRevision) return
        loadState.fail(); loadingIndicator.visibility = GONE; moreIndicator.visibility = GONE
        status.text = value; status.visibility = VISIBLE; status.setOnClickListener { onMore(1) }
        more.isEnabled = true; more.text = "加载更多"
    }
    fun busy(page: Int = 1) {
        loadState.begin(); more.isEnabled = false
        loadingIndicator.visibility = if (!loadState.hasSnapshot && items.isEmpty()) VISIBLE else GONE
        moreIndicator.visibility = if (page > 1) VISIBLE else GONE
        more.text = if (page > 1) "" else "加载更多"
        if (!loadState.hasSnapshot) status.visibility = GONE
    }
    fun refreshReadCounts(read: (Int, Int, Int) -> Int) {
        var changed = false
        items.forEach { item ->
            val count = read(item.optInt("id"), item.optJSONObject("last_message")?.optInt("id") ?: 0, item.optInt("unread_count"))
            if (count != item.optInt("unread_count")) { item.put("unread_count", count); changed = true }
        }
        if (changed) adapter.notifyDataSetChanged()
    }
    fun cachedDirectConversation(userId: Int): JSONObject? = items.firstOrNull { it.optString("type") == "direct" && it.optInt("peer_user_id") == userId && it.optInt("id") > 0 }?.let { JSONObject(it.toString()) }
    fun leaveTab() { if (editing) setEditing(false) }
    fun finishDelete(ids: List<Int>, error: String? = null) {
        ids.forEach { snapshots.hide(it) }
        items.removeAll { it.optInt("id") in ids }; selected.removeAll(ids.toSet()); adapter.notifyDataSetChanged()
        delete.isEnabled = true
        if (error != null) showError(error) else setEditing(false)
        if (items.isEmpty() && error == null) { status.text = "还没有会话"; status.visibility = VISIBLE }
    }
    fun deleting() { delete.isEnabled = false }
    fun handleBack(): Boolean { if (!editing) return false; setEditing(false); return true }
    private fun setEditing(value: Boolean) { editing = value; selected.clear(); delete.visibility = if (value) VISIBLE else GONE; pencil.contentDescription = if (value) "取消删除聊天窗口" else "选择删除聊天窗口"; adapter.notifyDataSetChanged(); updateDelete() }
    private fun toggle(id: Int) { if (!selected.add(id)) selected.remove(id); adapter.notifyDataSetChanged(); updateDelete() }
    private fun updateDelete() { delete.text = "删除 (${selected.size})"; delete.isEnabled = selected.isNotEmpty() }
    private inner class Holder {
        val row = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(px(34), px(26), px(34), px(26)); setBackgroundColor(Color.WHITE); minimumHeight = maxOf(px(174), dp(78)); tag = this@Holder }
        private val choice = CheckBox(context).apply { isClickable = false; isFocusable = false; buttonTintList = android.content.res.ColorStateList.valueOf(CHAT_BLUE) }
        private var avatarConversation = 0
        private val avatarInitial = label("", 20f, Color.WHITE).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }
        private val avatarImage = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        private val avatarBox = FrameLayout(context).apply {
            clipToOutline = true
            addView(avatarInitial, FrameLayout.LayoutParams(-1, -1))
            addView(avatarImage, FrameLayout.LayoutParams(-1, -1))
        }
        private val name = label("", 17f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        private val preview = label("", 13.5f, CHAT_GREY).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        private val time = label("", 12f, CHAT_GREY).apply { gravity = Gravity.END }
        private val badge = label("", 12f, Color.WHITE).apply { gravity = Gravity.CENTER; background = surface(0xFFF16559.toInt(), 50) }
        init {
            row.addView(choice, LayoutParams(dp(34), dp(44)))
            row.addView(avatarBox, LayoutParams(px(116), px(116)))
            row.addView(LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.CENTER_VERTICAL; addView(name); addView(preview, LayoutParams(-1, -2).apply { topMargin = px(20) }) }, LayoutParams(0, -1, 1f).apply { leftMargin = px(28) })
            row.addView(LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.END; addView(time); addView(badge, LayoutParams(px(44), px(44)).apply { topMargin = px(22); gravity = Gravity.END }) }, LayoutParams(px(90), -2))
        }
        fun bind(item: JSONObject) {
            val fallback = jsonText(item, "name").ifBlank { "会话" }
            val title = if (item.optString("type") == "direct") contactName(item.optInt("peer_user_id"), fallback) else fallback
            name.text = title
            val id = item.optInt("id")
            val colors = intArrayOf(0xFF78C54A.toInt(), 0xFFF58D43.toInt(), 0xFFE86559.toInt(), 0xFF649DE3.toInt(), 0xFF47BDA8.toInt())
            avatarInitial.text = title.take(1).ifBlank { "友" }
            avatarBox.background = surface(colors[Math.floorMod(id, colors.size)], 23)
            val url = jsonText(item, "avatar_url").let { if (it.isBlank()) "" else resolveAvatar(it) }
            ChatAvatars.bind(avatarImage, url, avatarConversation == id)
            avatarConversation = id
            val summary = messageSummary(item.optJSONObject("last_message"), selfId, context.getString(R.string.app_name))
            preview.text = if (item.optString("type") == "group" && item.optInt("unread_mention_count") > 0)
                SpannableString("有人@你 $summary").apply { setSpan(ForegroundColorSpan(0xFFDF3434.toInt()), 0, 4, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                else summary
            time.text = item.optJSONObject("last_message")?.optString("created_at")?.let { if (it.length >= 16) it.substring(11, 16) else "" }.orEmpty()
            badge.text = item.optInt("unread_count").let { if (it > 99) "99+" else it.toString() }; badge.visibility = if (item.optInt("unread_count") > 0) VISIBLE else INVISIBLE
            choice.visibility = if (editing) VISIBLE else GONE; choice.isChecked = item.optInt("id") in selected
        }
    }
}

internal class ContactPickerView(context: Context, private val groupMode: Boolean, private val resolveAvatar: (String) -> String,
    back: () -> Unit, private val onPick: (JSONObject) -> Unit, private val onNext: (List<JSONObject>) -> Unit
) : ChatScreen(context) {
    private val contacts = mutableListOf<JSONObject>()
    private val chosen = linkedMapOf<Int, JSONObject>()
    private val rows = mutableListOf<Pair<String, JSONObject?>>()
    private var keyword = ""
    private val next = command(if (groupMode) "下一步" else "取消") { if (groupMode) onNext(chosen.values.toList()) else back() }
    private val status = label("正在加载…", 14f, CHAT_GREY).apply { gravity = Gravity.CENTER; setPadding(0, dp(24), 0, dp(24)) }
    private val adapter = object : BaseAdapter() {
        override fun getCount() = rows.size
        override fun getItem(position: Int) = rows[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getViewTypeCount() = 2
        override fun getItemViewType(position: Int) = if (rows[position].second == null) 0 else 1
        override fun isEnabled(position: Int) = rows[position].second != null
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val (section, item) = rows[position]
            if (item == null) return label(section, 14f, CHAT_GREY).apply { setBackgroundColor(CHAT_BG); setPadding(px(40), px(17), 0, px(17)) }
            return LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(Color.WHITE); setPadding(px(38), px(26), px(66), px(26)); minimumHeight = dp(70)
                if (groupMode) addView(CheckBox(context).apply { isChecked = item.optInt("user_id") in chosen; isClickable = false; isFocusable = false; buttonTintList = android.content.res.ColorStateList.valueOf(0xFF45C3E9.toInt()) }, LayoutParams(px(80), dp(44)).apply { rightMargin = px(32) })
                val title = jsonText(item, "remark").ifBlank { jsonText(item, "nickname") }
                addView(avatar(title, item.optInt("user_id"), jsonText(item, "avatar_url").let { if (it.isBlank()) "" else resolveAvatar(it) }, 106))
                addView(LinearLayout(context).apply {
                    orientation = VERTICAL; addView(label(title, 17f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
                    if (!groupMode) addView(label(when {
                        item.optBoolean("online") -> "在线"
                        jsonText(item, "last_seen_at").isNotBlank() -> "最近上线于 " + jsonText(item, "last_seen_at")
                        item.optBoolean("last_seen_hidden") -> "最近登录时间不可见"
                        else -> "离线"
                    }, 13f, CHAT_GREY).apply { setPadding(0, px(14), 0, 0) })
                }, LayoutParams(0, -2, 1f).apply { leftMargin = px(28) })
            }
        }
    }
    private val list = ListView(context).apply { divider = null; scrollBarSize = dp(2); setSelector(ColorDrawable(Color.TRANSPARENT)); adapter = this@ContactPickerView.adapter
        setOnItemClickListener { _, _, position, _ -> rows.getOrNull(position)?.second?.let { item ->
            if (!groupMode) onPick(item) else { val id = item.optInt("user_id"); if (chosen.remove(id) == null) chosen[id] = item; next.isEnabled = chosen.isNotEmpty(); next.setTextColor(if (next.isEnabled) CHAT_BLUE else CHAT_GREY); this@ContactPickerView.adapter.notifyDataSetChanged() }
        } }
    }
    init {
        setBackgroundColor(if (groupMode) CHAT_BG else Color.WHITE)
        header(if (groupMode) "新建群组" else "发起聊天", if (groupMode) back else null, next)
        if (groupMode) { next.isEnabled = false; next.setTextColor(CHAT_GREY); addView(label("选择一个或多个联系人发起群聊", 14.5f, CHAT_GREY).apply { gravity = Gravity.CENTER; setBackgroundColor(Color.WHITE) }, LayoutParams(-1, px(195))) }
        val edit = search("搜索用户", R.id.chat_search) { filter(it) }
        edit.addTextChangedListener(object : TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { filter(s.toString()) }; override fun afterTextChanged(s: Editable?) = Unit })
        addView(searchBand(edit))
        val body = FrameLayout(context); body.addView(list, FrameLayout.LayoutParams(-1, -1)); body.addView(status, FrameLayout.LayoutParams(-1, -2))
        body.addView(AlphabetIndex(context) { letter -> val position = rows.indexOfFirst { it.first == letter }; if (position >= 0) list.setSelection(position) }, FrameLayout.LayoutParams(px(65), minOf(px(980), dp(440)), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = px(20) })
        addView(body, LayoutParams(-1, 0, 1f))
    }
    fun accept(items: List<JSONObject>) { contacts.clear(); contacts.addAll(items); filter(keyword) }
    fun error(value: String) { status.text = value; status.visibility = VISIBLE }
    private fun filter(value: String) {
        keyword = value.trim(); rows.clear()
        val sorted = contacts.filter { keyword.isBlank() || PublicUserId.matches(it.opt("public_id"), keyword) || listOf("nickname", "remark", "username", "phone").any { field -> jsonText(it, field).contains(keyword, true) } }.sortedWith(compareBy({ letter(it) }, { jsonText(it, "nickname") }))
        var last = ""
        for (item in sorted) { val letter = letter(item); if (last != letter) { rows.add(letter to null); last = letter }; rows.add(letter to item) }
        adapter.notifyDataSetChanged(); status.text = if (keyword.isBlank()) "您还未添加联系人" else "没有找到联系人"; status.visibility = if (sorted.isEmpty()) VISIBLE else GONE
    }
    private fun letter(item: JSONObject): String {
        val char = jsonText(item, "remark").ifBlank { jsonText(item, "nickname") }.firstOrNull() ?: return "#"
        val initial = if (char.code in 0x4E00..0x9FFF) PinyinHelper.toHanyuPinyinStringArray(char)?.firstOrNull()?.firstOrNull() ?: char else char
        return initial.uppercaseChar().let { if (it in 'A'..'Z') it.toString() else "#" }
    }
}

private class AlphabetIndex(context: Context, private val select: (String) -> Unit) : View(context) {
    private val letters = ('A'..'Z').map { it.toString() } + "#"
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; textSize = 10f * resources.displayMetrics.scaledDensity }
    private var current = ""
    override fun onDraw(canvas: Canvas) {
        val step = height / letters.size.toFloat()
        letters.forEachIndexed { i, letter ->
            paint.color = if (letter == current) 0xFF43C6ED.toInt() else CHAT_GREY
            if (letter == current) canvas.drawCircle(width / 2f, (i + .5f) * step, minOf(width * .43f, step * .48f), paint)
            paint.color = if (letter == current) Color.WHITE else CHAT_GREY
            canvas.drawText(letter, width / 2f, (i + .5f) * step - (paint.ascent() + paint.descent()) / 2f, paint)
        }
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN || event.actionMasked == MotionEvent.ACTION_MOVE) { current = letters[(event.y / height * letters.size).toInt().coerceIn(0, letters.lastIndex)]; select(current); invalidate() }
        if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
        return true
    }
    override fun performClick(): Boolean { super.performClick(); return true }
}

internal class GroupCreateView(context: Context, members: List<JSONObject>, private val limit: Int, back: () -> Unit, onAvatar: () -> Unit,
    private val onCreate: (String, List<JSONObject>, Boolean, String) -> Unit, private val resolveAvatar: (String) -> String
) : ChatScreen(context) {
    private val selected = members.toMutableList()
    private var uploadedAvatar = ""
    private val create = command("创建", R.id.chat_group_create) { submit() }
    private val name = EditText(context).apply { id = R.id.chat_group_name; hint = "请输入群组名字"; textSize = 17f; background = null; isSingleLine = true; setHintTextColor(CHAT_GREY); filters = arrayOf(android.text.InputFilter.LengthFilter(128)) }
    private val forbid = Switch(context).apply { contentDescription = "禁止群成员间私聊"; id = R.id.chat_group_forbid; buttonTintList = android.content.res.ColorStateList.valueOf(CHAT_BLUE) }
    private val count = label("", 14.5f, CHAT_GREY)
    private val people = LinearLayout(context).apply { orientation = HORIZONTAL }
    private val picture = FrameLayout(context).apply { id = R.id.chat_group_avatar; contentDescription = "上传群组头像"; background = surface(0xFFF8F8FA.toInt(), 8); setOnClickListener { onAvatar() }; addView(ChatGlyph(context, "camera", CHAT_GREY), FrameLayout.LayoutParams(-1, -1)) }
    private val error = label("", 13f, 0xFFE45D54.toInt()).apply { visibility = GONE; accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE }
    init {
        header("新建群组", back, create)
        val body = FrameLayout(context)
        val form = LinearLayout(context).apply { orientation = VERTICAL; setBackgroundColor(Color.WHITE); setPadding(px(32), px(26), px(32), px(50)) }
        val entry = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(px(34), px(34), px(34), px(34)); addView(picture, LayoutParams(px(112), px(112))); addView(name, LayoutParams(0, -1, 1f).apply { leftMargin = px(38) }) }
        form.addView(entry)
        form.addView(View(context).apply { setBackgroundColor(0xFFF4F4F5.toInt()) }, LayoutParams(-1, 1))
        form.addView(LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(px(32), 0, px(32), 0); addView(label("禁止群成员间私聊", 17f), LayoutParams(0, -2, 1f)); addView(forbid) }, LayoutParams(-1, px(115)))
        form.addView(label("开启后，群成员之间不能互相添加好友。已有的好友关系保留。", 14f, CHAT_GREY).apply { setPadding(px(32), px(24), px(32), px(30)); setBackgroundColor(CHAT_BG) })
        form.addView(count, LayoutParams(-1, -2).apply { setMargins(px(32), px(24), 0, px(28)) })
        form.addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(people) })
        form.addView(error, LayoutParams(-1, -2).apply { topMargin = px(24) })
        body.addView(ScrollView(context).apply { isFillViewport = true; addView(form) }, FrameLayout.LayoutParams(-1, -1).apply { setMargins(px(24), px(24), px(24), 0) })
        addView(body, LayoutParams(-1, 0, 1f)); renderPeople()
    }
    private fun renderPeople() {
        count.text = "群组成员 ${selected.size}/$limit"; people.removeAllViews()
        selected.forEach { member -> people.addView(FrameLayout(context).apply {
            addView(avatar(jsonText(member, "nickname"), member.optInt("user_id"), jsonText(member, "avatar_url").let { if (it.isBlank()) "" else resolveAvatar(it) }, 134), FrameLayout.LayoutParams(-1, -1))
            addView(command("×") { selected.remove(member); renderPeople() }.apply { contentDescription = "移除" + jsonText(member, "nickname"); textSize = 24f }, FrameLayout.LayoutParams(px(44), px(44), Gravity.TOP or Gravity.END))
        }, LayoutParams(px(134), px(134)).apply { leftMargin = px(30) }) }
    }
    private fun submit() {
        if (name.text.toString().trim().isBlank()) { showError("请输入群组名字"); return }
        if (selected.isEmpty()) { showError("请选择至少一个联系人"); return }
        if (selected.size + 1 > limit) { showError("群组成员数量超过上限"); return }
        create.isEnabled = false; error.visibility = GONE
        onCreate(name.text.toString().trim(), selected.toList(), !forbid.isChecked, uploadedAvatar)
    }
    fun setUploading(value: Boolean) { create.isEnabled = !value; picture.isEnabled = !value }
    fun avatarUploaded(url: String) { uploadedAvatar = url; picture.removeAllViews(); picture.addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, resolveAvatar(url)) }, FrameLayout.LayoutParams(-1, -1)); setUploading(false) }
    fun showError(value: String) { error.text = value; error.visibility = VISIBLE; create.isEnabled = true; picture.isEnabled = true }
}

internal class AddFriendView(context: Context, back: () -> Unit, onSearch: (String) -> Unit, onQr: () -> Unit, onScan: () -> Unit) : ChatScreen(context) {
    val query = search("输入完整用户名", R.id.chat_friend_search, onSearch)
    init {
        header("添加朋友", back); addView(searchBand(query))
        val body = FrameLayout(context)
        val entries = LinearLayout(context).apply {
            orientation = VERTICAL; setBackgroundColor(Color.WHITE)
            listOf(Triple("我的二维码", "分享二维码添加我为联系人", onQr), Triple("扫一扫", "扫描二维码添加联系人", onScan)).forEachIndexed { index, (title, subtitle, action) ->
                addView(LinearLayout(context).apply {
                    id = if (index == 0) R.id.chat_my_qr else R.id.chat_scan; gravity = Gravity.CENTER_VERTICAL; setPadding(px(64), px(28), px(50), px(28))
                    addView(ChatGlyph(context, if (index == 0) "qr" else "scan", Color.WHITE).apply { background = surface(if (index == 0) 0xFF3EC4AA.toInt() else 0xFF39BCCE.toInt(), 16); setPadding(px(12), px(12), px(12), px(12)) }, LayoutParams(px(84), px(84)))
                    addView(LinearLayout(context).apply { orientation = VERTICAL; addView(label(title, 17f)); addView(label(subtitle, 13f, CHAT_GREY), LayoutParams(-1, -2).apply { topMargin = px(15) }) }, LayoutParams(0, -2, 1f).apply { leftMargin = px(44) })
                    addView(label("›", 25f, CHAT_GREY)); setOnClickListener { action() }
                }, LayoutParams(-1, maxOf(px(174), dp(80))))
                if (index == 0) addView(View(context).apply { setBackgroundColor(0xFFF2F2F3.toInt()) }, LayoutParams(-1, 1).apply { leftMargin = px(192) })
            }
        }
        body.addView(entries, FrameLayout.LayoutParams(-1, -2).apply { setMargins(px(24), px(24), px(24), 0) })
        addView(body, LayoutParams(-1, 0, 1f))
    }
}

internal class ChatGlyph(context: Context, private val kind: String, private val tint: Int = CHAT_INK) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        val side = minOf(width - paddingLeft - paddingRight, height - paddingTop - paddingBottom).toFloat()
        canvas.save(); canvas.translate(paddingLeft + (width - paddingLeft - paddingRight - side) / 2f, paddingTop + (height - paddingTop - paddingBottom - side) / 2f); canvas.scale(side / 100f, side / 100f)
        paint.color = AppAppearance.ink(tint); paint.style = Paint.Style.STROKE; paint.strokeWidth = 6f; paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
        when (kind) {
            "pencil" -> { paint.style = Paint.Style.FILL; canvas.drawPath(Path().apply { moveTo(12f, 71f); lineTo(68f, 15f); lineTo(87f, 34f); lineTo(31f, 90f); lineTo(12f, 90f); close() }, paint); canvas.drawPath(Path().apply { moveTo(73f, 10f); lineTo(79f, 4f); lineTo(98f, 23f); lineTo(92f, 29f); close() }, paint) }
            "start" -> { paint.style = Paint.Style.FILL; canvas.drawRoundRect(12f, 16f, 90f, 76f, 8f, 8f, paint); canvas.drawPath(Path().apply { moveTo(12f, 66f); lineTo(12f, 94f); lineTo(40f, 73f); close() }, paint); paint.color = Color.WHITE; canvas.drawCircle(40f, 46f, 6f, paint); canvas.drawCircle(65f, 46f, 6f, paint) }
            "group", "friend" -> { paint.style = Paint.Style.FILL; canvas.drawOval(24f, 10f, 59f, 52f, paint); canvas.drawPath(Path().apply { moveTo(40f, 48f); cubicTo(39f, 67f, 8f, 66f, 9f, 90f); lineTo(77f, 90f); cubicTo(77f, 66f, 51f, 69f, 48f, 48f); close() }, paint); if (kind == "group") { canvas.drawOval(61f, 15f, 81f, 51f, paint); canvas.drawPath(Path().apply { moveTo(66f, 53f); lineTo(63f, 61f); lineTo(92f, 85f); lineTo(92f, 78f); close() }, paint) } else { paint.style = Paint.Style.STROKE; canvas.drawLine(76f, 42f, 98f, 42f, paint); canvas.drawLine(87f, 31f, 87f, 53f, paint) } }
            "scan" -> { for ((x, y) in listOf(18f to 18f, 82f to 18f, 18f to 82f, 82f to 82f)) { canvas.drawLine(x, y, x + if (x < 50) 17 else -17, y, paint); canvas.drawLine(x, y, x, y + if (y < 50) 17 else -17, paint) }; canvas.drawLine(28f, 50f, 72f, 50f, paint) }
            "qr" -> { for ((x, y) in listOf(13f to 13f, 57f to 13f, 13f to 57f)) canvas.drawRoundRect(x, y, x + 29f, y + 29f, 5f, 5f, paint); for (x in listOf(58f, 72f, 85f)) canvas.drawLine(x, 59f, x, 85f, paint) }
            "notice" -> { canvas.drawPath(Path().apply { moveTo(18f, 38f); lineTo(69f, 15f); lineTo(69f, 82f); lineTo(18f, 60f); close() }, paint); canvas.drawLine(69f, 48f, 85f, 48f, paint); canvas.drawLine(29f, 65f, 34f, 87f, paint) }
            "camera" -> { canvas.drawRoundRect(12f, 30f, 88f, 83f, 6f, 6f, paint); canvas.drawCircle(50f, 56f, 16f, paint); canvas.drawPath(Path().apply { moveTo(30f, 30f); lineTo(35f, 18f); lineTo(65f, 18f); lineTo(70f, 30f) }, paint) }
            "photo" -> { canvas.drawRect(12f, 14f, 88f, 85f, paint); canvas.drawCircle(31f, 35f, 8f, paint); canvas.drawPath(Path().apply { moveTo(13f, 76f); lineTo(36f, 52f); lineTo(51f, 64f); lineTo(67f, 42f); lineTo(88f, 65f) }, paint) }
            "flash" -> canvas.drawPath(Path().apply { moveTo(47f, 9f); lineTo(74f, 9f); lineTo(51f, 43f); lineTo(73f, 43f); lineTo(29f, 94f); lineTo(42f, 55f); lineTo(22f, 55f); close() }, paint)
        }
        canvas.restore()
    }
}
