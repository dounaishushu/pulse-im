package com.pulseim.android

import android.content.Context
import android.graphics.*
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.text.TextUtils
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.LruCache
import android.os.Build
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.roundToInt
import kotlin.math.ceil

private const val CONTACTS_BACKGROUND = 0xFFF8F7FF.toInt()
private const val CONTACTS_BLUE = 0xFF5688F9.toInt()
private const val CONTACTS_INK = 0xFF202124.toInt()
private const val CONTACTS_MUTED = 0xFF99999F.toInt()

/** Recycled native lists; the 873-pixel reference defines spacing, not fixed screen coordinates. */
class ContactsView(
    context: Context,
    private val selfId: Int,
    private val onLoad: (Page, Int, String, Int) -> Unit,
    private val onAdd: (JSONObject) -> Unit,
    private val onRequest: (JSONObject, String) -> Unit,
    private val onContact: (JSONObject) -> Unit,
    private val onConversation: (JSONObject) -> Unit,
    private val onMenu: (View, Page) -> Unit,
    private val onNavigate: (String) -> Unit,
    private val showMemberCount: () -> Boolean,
    private val resolveAvatar: (String) -> String
) : LinearLayout(context) {
    enum class Page { CONTACTS, SEARCH, REQUESTS, GROUPS, CHANNELS }
    var page = Page.CONTACTS
        private set
    var version = 0
        private set
    private var currentPage = 0
    private var completeDirectoryShown = false
    private var failedPage = 1
    private var hasMore = false
    private var loading = false
    internal val loadState = HomeTabLoadState()
    private var refreshQueued = false
    private lateinit var loadingIndicator: ProgressBar
    private lateinit var moreIndicator: ProgressBar
    private var query = ""
    private val items = mutableListOf<JSONObject>()
    private val liveMessages = mutableMapOf<Int, JSONObject>()
    private var conversationRefreshPosted = false
    private val conversationRefresh = object : Runnable {
        override fun run() {
            if (!isAttachedToWindow || !isConversationPage) { conversationRefreshPosted = false; return }
            if (loading) { postDelayed(this, 250); return }
            conversationRefreshPosted = false; refresh()
        }
    }
    private lateinit var list: TapResponsiveListView
    private lateinit var empty: TextView
    private lateinit var more: TextView
    private lateinit var message: TextView
    private var requestsEmpty: NewFriendsEmptyState? = null
    private var requestsRefresh: NewFriendsRefreshView? = null
    private var channelsEmpty: ChannelEmptyState? = null
    private val isConversationPage get() = page == Page.GROUPS || page == Page.CHANNELS
    private var searchInput: EditText? = null
    private val chromePaint = Paint().apply { color = Color.WHITE }
    private val referenceUnit get() = resources.displayMetrics.widthPixels / 873f
    private fun px(value: Int) = (value * referenceUnit).roundToInt()
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    fun showPage(next: Page) {
        hideKeyboard()
        if (page != next) liveMessages.clear()
        page = next
        loading = false; refreshQueued = false; loadState.reset()
        version++; items.clear(); currentPage = 0; hasMore = false; completeDirectoryShown = false
        query = ""
        searchInput = null
        render()
        if (next == Page.SEARCH) {
            version++
            items.clear()
            adapter.notifyDataSetChanged()
            showEmpty("输入完整用户名")
        } else refresh()
    }

    fun handleBack(): Boolean {
        if (page == Page.CONTACTS) return false
        showPage(Page.CONTACTS)
        return true
    }

    fun refresh(fromPull: Boolean = false) {
        if (loading) { refreshQueued = true; return }
        version++
        message.visibility = GONE
        load(1, fromPull)
    }

    private fun load(number: Int, showRefreshIndicator: Boolean = false) {
        if (page == Page.SEARCH && query.isBlank()) return
        loading = true; loadState.begin()
        requestsRefresh?.setBusy(showRefreshIndicator)
        failedPage = number
        loadingIndicator.visibility = if (items.isEmpty() && !loadState.hasSnapshot) VISIBLE else GONE
        if (loadingIndicator.visibility == VISIBLE) {
            empty.visibility = GONE; requestsEmpty?.visibility = GONE; channelsEmpty?.visibility = GONE
        }
        moreIndicator.visibility = if (number > 1) VISIBLE else GONE
        more.text = if (number > 1) "" else "加载更多"
        more.isEnabled = false
        onLoad(page, number, query, version)
    }

    fun acceptPage(result: JSONObject, expectedVersion: Int) {
        if (version != expectedVersion) return
        loading = false
        requestsRefresh?.setBusy(false)
        loadState.accept(android.os.SystemClock.elapsedRealtime())
        loadingIndicator.visibility = GONE; moreIndicator.visibility = GONE
        val anchor = items.getOrNull(list.firstVisiblePosition)?.let { itemKey(it) }
        val anchorTop = list.getChildAt(0)?.top ?: 0
        currentPage = result.optInt("page", 1)
        val retained = if (currentPage == 1 && completeDirectoryShown) items.toList() else emptyList()
        if (currentPage == 1) items.clear()
        val rows = result.getJSONArray("items")
        val seen = items.map { itemKey(it) }.toMutableSet()
        for (index in 0 until rows.length()) {
            val item = rows.getJSONObject(index)
            if (isConversationPage) {
                val live = liveMessages[item.optInt("id")]
                val liveId = live?.optInt("id") ?: 0
                val snapshotId = item.optJSONObject("last_message")?.optInt("id") ?: 0
                if (live != null && liveId > maxOf(snapshotId, item.optInt("cleared_before_message_id"))) {
                    item.put("last_message", live); item.put("updated_at", live.optString("created_at", item.optString("updated_at")))
                } else if (snapshotId >= liveId) liveMessages.remove(item.optInt("id"))
            }
            if (seen.add(itemKey(item))) items.add(item)
            else items.indexOfFirst { itemKey(it) == itemKey(item) }.takeIf { it >= 0 }?.let { items[it] = item }
        }
        retained.filter { seen.add(itemKey(it)) }.forEach { items.add(it) }
        hasMore = if (completeDirectoryShown) items.size < result.optInt("total") else currentPage * result.optInt("size", 50) < result.optInt("total")
        more.visibility = if (hasMore) VISIBLE else GONE
        more.text = "加载更多"
        more.isEnabled = true
        more.setOnClickListener { if (!loading) load(currentPage + 1) }
        message.visibility = GONE
        adapter.notifyDataSetChanged()
        if (items.isEmpty()) showEmpty(when (page) {
            Page.CONTACTS -> "您还未添加联系人"
            Page.SEARCH -> "用户不存在"
            Page.REQUESTS -> "暂时未有新申请"
            Page.GROUPS -> "您还未加入群组"
            Page.CHANNELS -> "您还未关注任何频道"
        }) else {
            empty.visibility = GONE
            requestsEmpty?.visibility = GONE
            channelsEmpty?.visibility = GONE
        }
        if (anchor != null) list.afterRowsPublished { displayedItems.indexOfFirst { itemKey(it) == anchor }.takeIf { it >= 0 }?.let { list.setSelectionFromTop(it, anchorTop) } }
        if (refreshQueued) { refreshQueued = false; refresh() }
    }

    internal fun refreshIfNeeded() { if (loadState.needsRefresh(android.os.SystemClock.elapsedRealtime())) refresh() }

    /** Restore display only. The in-flight network request and freshness state keep their ownership. */
    fun restoreLocalSnapshot(result: JSONObject): Boolean {
        if (page == Page.SEARCH || items.isNotEmpty() || loadState.hasSnapshot || liveMessages.isNotEmpty()) return false
        val rows = result.getJSONArray("items")
        val restored = (0 until rows.length()).map { JSONObject(rows.getJSONObject(it).toString()) }
        require(restored.all { itemKey(it) > 0 } && restored.map { itemKey(it) }.toSet().size == restored.size)
        items.addAll(restored); loadState.restore(); currentPage = result.optInt("page", 1)
        completeDirectoryShown = restored.size >= result.optInt("total")
        hasMore = items.size < result.optInt("total")
        loadingIndicator.visibility = GONE
        more.visibility = if (hasMore) VISIBLE else GONE; more.text = "加载更多"; more.isEnabled = !loading
        more.setOnClickListener { if (!loading) load(currentPage + 1) }
        message.visibility = GONE
        if (items.isNotEmpty()) { empty.visibility = GONE; requestsEmpty?.visibility = GONE; channelsEmpty?.visibility = GONE }
        else showEmpty(when (page) { Page.CONTACTS -> "您还未添加联系人"; Page.REQUESTS -> "暂时未有新申请"; Page.GROUPS -> "您还未加入群组"; Page.CHANNELS -> "您还未关注任何频道"; Page.SEARCH -> "用户不存在" })
        adapter.notifyDataSetChanged(); return true
    }
    fun acceptCompleteSnapshot(result: JSONObject, expectedVersion: Int): Boolean {
        if (version != expectedVersion || page == Page.SEARCH) return false
        val queued = refreshQueued
        completeDirectoryShown = false; refreshQueued = false
        acceptPage(result, expectedVersion)
        completeDirectoryShown = true
        // Discard pages and errors started before this authoritative complete result.
        version++
        if (queued) refresh()
        return true
    }

    fun showLoadError(error: String, expectedVersion: Int) {
        if (version != expectedVersion) return
        loading = false; refreshQueued = false; loadState.fail()
        loadingIndicator.visibility = GONE; moreIndicator.visibility = GONE
        requestsRefresh?.setBusy(false)
        more.visibility = VISIBLE
        more.isEnabled = true
        more.text = "重新加载"
        more.setOnClickListener { load(failedPage) }
        if (items.isEmpty()) showEmpty(error) else showMessage(error, true)
    }

    fun listedConversationIds(): List<Int> = if (isConversationPage) items.map { it.optInt("id") } else emptyList()

    fun updateConversationMessage(message: JSONObject) {
        if (!isConversationPage) return
        val conversation = message.optInt("conversation_id")
        if (message.optInt("id") > (liveMessages[conversation]?.optInt("id") ?: 0)) liveMessages[conversation] = message
        val item = items.firstOrNull { it.optInt("id") == message.optInt("conversation_id") } ?: return
        if (message.optInt("id") <= maxOf(item.optInt("cleared_before_message_id"), item.optJSONObject("last_message")?.optInt("id") ?: 0)) return
        item.put("last_message", message)
        item.put("updated_at", message.optString("created_at", item.optString("updated_at")))
        items.sortWith(compareByDescending<JSONObject> { it.optBoolean("is_pinned") }.thenByDescending { it.optString("updated_at") }.thenByDescending { it.optInt("id") })
        adapter.notifyDataSetChanged()
    }
    fun scheduleConversationRefresh() {
        if (!isConversationPage || conversationRefreshPosted) return
        conversationRefreshPosted = true; postDelayed(conversationRefresh, 150)
    }
    fun invalidateConversation(id: Int) { liveMessages.remove(id); scheduleConversationRefresh() }

    fun finishAdd(userId: Int, result: JSONObject?, error: String? = null) {
        items.firstOrNull { it.optInt("id") == userId }?.let {
            it.put("_busy", false)
            if (result != null) it.put("_sent", result.optString("status"))
        }
        val status = result?.optString("status")
        showMessage(error ?: when {
            status == "accepted" -> "已添加为好友，可在联系人中查看"
            result?.optBoolean("created", true) == false -> "已发送过好友申请，请等待对方验证"
            else -> "好友申请已发送，请等待对方验证"
        }, error != null)
        adapter.notifyDataSetChanged()
    }

    fun finishAddPending(userId: Int) {
        items.firstOrNull { it.optInt("id") == userId }?.put("_busy", false)
        adapter.notifyDataSetChanged()
    }

    fun finishRequest(requestId: Int, action: String, error: String? = null) {
        items.firstOrNull { it.optInt("id") == requestId }?.let {
            it.put("_busy", false)
            if (error == null) it.put("status", if (action == "accept") "accepted" else "rejected")
        }
        showMessage(error ?: if (action == "accept") "已同意，好友已加入联系人" else "已拒绝好友申请", error != null)
        adapter.notifyDataSetChanged()
    }

    private fun itemKey(item: JSONObject) = item.optInt(if (page == Page.CONTACTS) "user_id" else "id")
    private fun showEmpty(value: String) {
        empty.text = value
        empty.visibility = VISIBLE
        requestsEmpty?.apply {
            visibility = VISIBLE
            illustration.visibility = if (value == "暂时未有新申请") VISIBLE else INVISIBLE
        }
        channelsEmpty?.apply {
            visibility = VISIBLE
            illustration.visibility = if (value == "您还未关注任何频道") VISIBLE else INVISIBLE
        }
    }
    private fun showMessage(value: String, error: Boolean) {
        message.text = value
        message.setTextColor(if (error) 0xFFC44545.toInt() else CONTACTS_BLUE)
        message.visibility = VISIBLE
    }

    private fun render() {
        displayedItems = items.toList()
        removeAllViews()
        setBackgroundColor(if (isConversationPage) CONTACTS_BACKGROUND else Color.WHITE)
        requestsEmpty = null
        requestsRefresh = null
        channelsEmpty = null
        addView(header(), LayoutParams(-1, px(128)))
        if (page == Page.CONTACTS || page == Page.SEARCH) addView(searchBar(), LayoutParams(-1, px(134)))
        if (page == Page.CONTACTS) {
            val font = Paint().apply { textSize = 14.5f * resources.displayMetrics.scaledDensity }.fontMetrics
            // Keep the reference proportions, while reserving a complete native text line
            // on narrow screens and devices with a larger system font setting.
            val requiredHeight = px(40) + px(12) + px(118) + px(16) + px(31) + ceil(font.descent - font.ascent).toInt() + 5
            addView(shortcuts(), LayoutParams(-1, maxOf(px(252), requiredHeight)))
        }
        message = label("", 13f, CONTACTS_BLUE).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(8), dp(16), dp(8))
            visibility = GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        addView(message)
        val body = if (page == Page.REQUESTS) object : FrameLayout(context) {
            private var startX = 0f
            private var startY = 0f
            private var startedAtTop = false
            private var pulling = false
            private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
            private val refreshDistance = dp(48)

            override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        startX = event.x
                        startY = event.y
                        startedAtTop = !loading && !list.canScrollVertically(-1)
                        pulling = false
                        if (!loading) requestsRefresh?.setBusy(false)
                    }
                    MotionEvent.ACTION_MOVE -> {
                        if (!pulling && startedAtTop && !loading && !list.canScrollVertically(-1) && event.y - startY > touchSlop &&
                            event.y - startY > kotlin.math.abs(event.x - startX)) {
                            // AbsListView can disallow parent interception before
                            // a pull reaches our threshold. Cancel its gesture
                            // explicitly so a refresh never also clicks a row.
                            val cancel = MotionEvent.obtain(event)
                            cancel.action = MotionEvent.ACTION_CANCEL
                            super.dispatchTouchEvent(cancel)
                            cancel.recycle()
                            pulling = true
                        }
                        if (pulling) requestsRefresh?.setPullProgress((event.y - startY) / refreshDistance)
                    }
                    MotionEvent.ACTION_UP -> if (pulling) {
                        pulling = false
                        if (!loading && event.y - startY > refreshDistance) refresh(fromPull = true)
                        else if (!loading) requestsRefresh?.setBusy(false)
                        return true
                    }
                    MotionEvent.ACTION_CANCEL -> if (pulling) {
                        pulling = false
                        if (!loading) requestsRefresh?.setBusy(false)
                        return true
                    }
                }
                return if (pulling) true else super.dispatchTouchEvent(event)
            }
        } else FrameLayout(context)
        body.setBackgroundColor(CONTACTS_BACKGROUND)
        list = TapResponsiveListView(context).apply {
            id = R.id.contacts_list
            divider = ColorDrawable(if (isConversationPage) CONTACTS_BACKGROUND else 0xFFF0EFF6.toInt())
            dividerHeight = if (isConversationPage) px(12) else 1
            setSelector(ColorDrawable(Color.TRANSPARENT))
            isVerticalScrollBarEnabled = true
            scrollBarSize = dp(2)
            if (isConversationPage) { setPadding(px(24), px(22), px(24), px(24)); clipToPadding = false }
        }
        more = label("加载更多", 14f, CONTACTS_BLUE).apply {
            id = R.id.contacts_load_more
            gravity = Gravity.CENTER
            layoutParams = AbsListView.LayoutParams(-1, dp(48))
            visibility = GONE
        }
        moreIndicator = listLoadingIndicator(context).apply { visibility = GONE }
        list.addFooterView(FrameLayout(context).apply {
            addView(more, FrameLayout.LayoutParams(-1, dp(48)))
            addView(moreIndicator, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER))
        }, null, false)
        list.adapter = adapter
        list.setOnItemClickListener { _, _, position, _ ->
            val shown = displayedItems.getOrNull(position) ?: return@setOnItemClickListener
            val item = items.firstOrNull { itemKey(it) == itemKey(shown) } ?: return@setOnItemClickListener
            when (page) {
                Page.CONTACTS -> onContact(item)
                Page.GROUPS, Page.CHANNELS -> onConversation(item)
                else -> Unit
            }
        }
        body.addView(list, FrameLayout.LayoutParams(-1, -1))
        if (page == Page.REQUESTS) {
            val state = NewFriendsEmptyState(context)
            requestsEmpty = state
            empty = state.caption
            body.addView(state, FrameLayout.LayoutParams(-1, -1))
            val refreshIndicator = NewFriendsRefreshView(context)
            requestsRefresh = refreshIndicator
            body.addView(refreshIndicator, FrameLayout.LayoutParams(px(100), px(100), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = px(17) })
        } else if (page == Page.CHANNELS) {
            val state = ChannelEmptyState(context)
            channelsEmpty = state
            empty = state.caption
            body.addView(state, FrameLayout.LayoutParams(-1, -1))
        } else {
            empty = label("", 15.5f, CONTACTS_MUTED).apply {
                id = R.id.contacts_empty
                gravity = Gravity.CENTER
                setPadding(dp(28), 0, dp(28), 0)
                translationY = if (page == Page.CONTACTS) -px(125).toFloat() else -dp(20).toFloat()
            }
            body.addView(empty, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        }
        loadingIndicator = listLoadingIndicator(context).apply { visibility = GONE }
        body.addView(loadingIndicator, FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER))
        addView(body, LayoutParams(-1, 0, 1f))
        if (page != Page.REQUESTS && !isConversationPage) addView(ContactsNavigation(context, "contacts", onNavigate))
    }

    private fun header() = FrameLayout(context).apply {
        setBackgroundColor(Color.WHITE)
        addView(label(when (page) {
            Page.CONTACTS -> "联系人"
            Page.SEARCH -> "添加好友"
            Page.REQUESTS -> "新的朋友"
            Page.GROUPS -> "我的群组"
            Page.CHANNELS -> "我的频道"
        }, 19f, CONTACTS_INK).apply { id = R.id.contacts_title; gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }, FrameLayout.LayoutParams(-1, -1))
        if (page != Page.CONTACTS) addView(ContactIconView(context, "back", CONTACTS_INK).apply {
            id = R.id.contacts_back
            contentDescription = "返回联系人"
            if (page == Page.REQUESTS || isConversationPage) setPadding(px(41), px(35), px(41), px(35))
            else setPadding(px(27), px(30), px(27), px(30))
            setOnClickListener { showPage(Page.CONTACTS) }
        }, FrameLayout.LayoutParams(px(if (page == Page.REQUESTS || isConversationPage) 140 else 112), -1, Gravity.START))
        if (page != Page.REQUESTS && !isConversationPage) addView(ContactIconView(context, "plus", CONTACTS_INK).apply {
            id = R.id.contacts_add
            contentDescription = "添加联系人、群组或频道"
            setPadding(px(32), px(32), px(32), px(32))
            setOnClickListener { onMenu(this, page) }
        }, FrameLayout.LayoutParams(px(112), -1, Gravity.END))
    }

    private fun searchBar() = LinearLayout(context).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(px(35), 0, px(30), 0)
        setBackgroundColor(CONTACTS_BACKGROUND)
        addView(ContactIconView(context, "search", CONTACTS_MUTED), LayoutParams(px(42), px(42)))
        if (page == Page.CONTACTS) {
            id = R.id.contacts_search
            contentDescription = "搜索用户"
            addView(label("搜索用户", 16f, CONTACTS_MUTED), LayoutParams(0, -2, 1f).apply { leftMargin = px(21) })
            setOnClickListener { showPage(Page.SEARCH) }
        } else {
            val edit = EditText(context).apply {
                id = R.id.contacts_search
                hint = "输入完整用户名"
                textSize = 16f
                setTextColor(CONTACTS_INK)
                setHintTextColor(CONTACTS_MUTED)
                background = null
                isSingleLine = true
                inputType = InputType.TYPE_CLASS_TEXT
                imeOptions = EditorInfo.IME_ACTION_SEARCH
                setOnEditorActionListener { _, action, _ ->
                    if (action == EditorInfo.IME_ACTION_SEARCH) { submitSearch(); true } else false
                }
            }
            searchInput = edit
            addView(edit, LayoutParams(0, -1, 1f).apply { leftMargin = px(14) })
            addView(action("搜索", R.id.contacts_search_submit) { submitSearch() })
        }
    }

    private fun submitSearch() {
        val next = searchInput?.text?.toString()?.trim().orEmpty()
        if (next.isBlank()) { showMessage("请输入完整用户名", true); return }
        if (next != query) {
            loading = false; refreshQueued = false; loadState.reset()
            items.clear(); currentPage = 0; hasMore = false; adapter.notifyDataSetChanged()
        }
        query = next
        hideKeyboard()
        refresh()
    }

    private fun shortcuts() = LinearLayout(context).apply {
        orientation = VERTICAL
        setBackgroundColor(Color.WHITE)
        val entries = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(px(20), px(40), px(20), px(12))
        }
        val definitions = listOf(
            Triple("新的朋友", "new_friend", R.id.contacts_new_friends),
            Triple("我的群组", "group", R.id.contacts_groups),
            Triple("我的频道", "channel", R.id.contacts_channels)
        )
        definitions.forEachIndexed { index, (title, icon, resource) ->
            entries.addView(LinearLayout(context).apply {
                id = resource
                contentDescription = title
                orientation = VERTICAL
                gravity = Gravity.CENTER
                addView(FrameLayout(context).apply {
                    clipChildren = false; clipToPadding = false
                    addView(ContactIconView(context, icon, Color.WHITE), FrameLayout.LayoutParams(-1, -1))
                    if (icon == "new_friend") addView(UnreadBadgeView(context, true).apply {
                        id = R.id.contacts_new_friends_badge
                    }, FrameLayout.LayoutParams(-2, dp(18), Gravity.TOP or Gravity.END))
                }, LayoutParams(px(118), px(118)))
                addView(label(title, 14.5f, CONTACTS_INK), LayoutParams(-2, -2).apply { topMargin = px(16) })
                setOnClickListener { showPage(listOf(Page.REQUESTS, Page.GROUPS, Page.CHANNELS)[index]) }
            }, LayoutParams(0, -1, 1f))
        }
        addView(entries, LayoutParams(-1, 0, 1f))
        addView(View(context).apply { setBackgroundColor(0xFFF1F0F6.toInt()) }, LayoutParams(-1, 1))
        addView(View(context), LayoutParams(-1, px(31)))
    }

    private fun label(value: String, size: Float, color: Int) = TextView(context).apply {
        text = value; textSize = size; setTextColor(color); includeFontPadding = false
    }

    private fun action(value: String, resource: Int = View.NO_ID, callback: () -> Unit) = label(value, 13f, CONTACTS_BLUE).apply {
        id = resource
        gravity = Gravity.CENTER
        setPadding(dp(12), 0, dp(12), 0)
        minHeight = dp(44)
        setOnClickListener { callback() }
    }

    private fun clean(item: JSONObject, field: String) = if (item.isNull(field)) "" else item.optString(field).trim()
    private var displayedItems: List<JSONObject> = emptyList()
    private val adapter = object : BaseAdapter() {
        override fun hasStableIds() = true
        override fun notifyDataSetChanged() { list.publishRows { displayedItems = items.toList(); super.notifyDataSetChanged() } }
        override fun getCount() = displayedItems.size
        override fun getItem(position: Int) = displayedItems[position]
        override fun getItemId(position: Int) = itemKey(displayedItems[position]).toLong()
        override fun getViewTypeCount() = 2
        override fun getItemViewType(position: Int) = if (isConversationPage) 1 else 0
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val item = displayedItems[position]
            if (isConversationPage) {
                val group = (convertView?.tag as? GroupHolder) ?: GroupHolder()
                group.bind(item)
                return group.row
            }
            val holder = (convertView?.tag as? ContactHolder) ?: ContactHolder()
            holder.bind(item)
            return holder.row
        }
    }

    private inner class GroupHolder {
        val row = LinearLayout(context).apply {
            id = R.id.groups_row; gravity = Gravity.CENTER_VERTICAL
            setPadding(px(34), px(26), px(34), px(26))
            setBackgroundColor(Color.WHITE)
            minimumHeight = maxOf(px(174), dp(78))
            tag = this@GroupHolder
        }
        private val avatar = FrameLayout(context).apply {
            id = R.id.groups_avatar
            background = GradientDrawable().apply { setColor(0xFFF68A42.toInt()); cornerRadius = px(24).toFloat() }
            clipToOutline = true
        }
        private val initial = label("", 19f, Color.WHITE).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }
        private val picture = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        private val name = label("", 17f, Color.BLACK).apply { id = R.id.groups_name; maxLines = 1; ellipsize = TextUtils.TruncateAt.END; typeface = Typeface.DEFAULT_BOLD }
        private val summary = label("", 14.5f, CONTACTS_MUTED).apply { id = R.id.groups_summary; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        private val time = label("", 14f, CONTACTS_MUTED).apply { id = R.id.groups_time; gravity = Gravity.END; maxLines = 1 }
        init {
            avatar.addView(initial, FrameLayout.LayoutParams(-1, -1))
            avatar.addView(picture, FrameLayout.LayoutParams(-1, -1))
            row.addView(avatar, LayoutParams(px(116), px(116)))
            row.addView(LinearLayout(context).apply {
                orientation = VERTICAL; gravity = Gravity.CENTER_VERTICAL
                addView(LinearLayout(context).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(name, LayoutParams(0, -2, 1f))
                    addView(time, LayoutParams(px(104), -2).apply { leftMargin = px(18) })
                }, LayoutParams(-1, -2))
                addView(summary, LayoutParams(-1, -2).apply { topMargin = px(26) })
            }, LayoutParams(0, -2, 1f).apply { leftMargin = px(31) })
        }
        fun bind(item: JSONObject) {
            val channel = page == Page.CHANNELS
            row.id = if (channel) R.id.channels_row else R.id.groups_row
            avatar.id = if (channel) R.id.channels_avatar else R.id.groups_avatar
            name.id = if (channel) R.id.channels_name else R.id.groups_name
            summary.id = if (channel) R.id.channels_summary else R.id.groups_summary
            time.id = if (channel) R.id.channels_time else R.id.groups_time
            (avatar.background as GradientDrawable).setColor(if (channel) CONTACTS_BLUE else 0xFFF68A42.toInt())
            val appName = context.getString(R.string.app_name)
            name.text = clean(item, "name").ifBlank { if (channel) "频道" else "群组" }
            initial.text = name.text.take(1)
            val url = clean(item, "avatar_url").let { if (it.isBlank()) "" else resolveAvatar(it) }
            ChatAvatars.bind(picture, url)
            val last = item.optJSONObject("last_message")
            val value = if (last != null) messageSummary(last, selfId, appName)
                else if (item.optInt("cleared_before_message_id") > 0) "您:历史聊天记录已被清除" else "暂无消息"
            summary.text = SpannableString(value).apply {
                if (value.startsWith("您:")) setSpan(ForegroundColorSpan(0xFF79A8B4.toInt()), 0, 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            val date = last?.optString("created_at").orEmpty().ifBlank { clean(item, "updated_at").ifBlank { clean(item, "created_at") } }
            time.text = Regex("[ T](\\d{2}:\\d{2})").find(date)?.groupValues?.get(1).orEmpty()
        }
    }

    private inner class ContactHolder {
        val row = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.WHITE)
            minimumHeight = dp(78)
        }
        private val avatar = FrameLayout(context).apply {
            background = GradientDrawable().apply { setColor(0xFFE5ECFF.toInt()); cornerRadius = dp(12).toFloat() }
            clipToOutline = true
        }
        private val initial = label("", 19f, CONTACTS_BLUE).apply { gravity = Gravity.CENTER }
        private val picture = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        private val name = label("", 16f, CONTACTS_INK).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        private val subtitle = label("", 12f, CONTACTS_MUTED).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }
        private val buttons = LinearLayout(context)
        init {
            row.tag = this
            avatar.addView(initial, FrameLayout.LayoutParams(-1, -1))
            avatar.addView(picture, FrameLayout.LayoutParams(-1, -1))
            row.addView(avatar, LayoutParams(dp(46), dp(46)))
            row.addView(LinearLayout(context).apply {
                orientation = VERTICAL
                gravity = Gravity.CENTER_VERTICAL
                addView(name)
                addView(subtitle, LayoutParams(-1, -2).apply { topMargin = dp(7) })
            }, LayoutParams(0, -2, 1f).apply { leftMargin = dp(12) })
            row.addView(buttons)
        }
        fun bind(item: JSONObject) {
            name.text = clean(item, "remark").ifBlank { clean(item, if (page in listOf(Page.GROUPS, Page.CHANNELS)) "name" else "nickname").ifBlank { "用户" } }
            subtitle.text = when (page) {
                Page.REQUESTS -> clean(item, "message").ifBlank { "请求添加您为好友" }
                Page.GROUPS, Page.CHANNELS -> if (showMemberCount()) "${item.optInt("member_count")} 位成员" else ""
                else -> "用户 ID：${PublicUserId.display(item.opt("public_id"))}" + clean(item, "username").let { if (it.isNotBlank()) "\n@$it" else "" }
            }
            subtitle.visibility = if (subtitle.text.isBlank()) GONE else VISIBLE
            initial.text = name.text.take(1)
            picture.setImageDrawable(null)
            val url = clean(item, "avatar_url").let { if (it.isBlank()) "" else resolveAvatar(it) }
            picture.tag = url
            ChatAvatars.bind(picture, url)
            buttons.removeAllViews()
            if (page == Page.SEARCH) {
                val mine = item.optInt("id") == selfId
                val sent = clean(item, "_sent")
                val busy = item.optBoolean("_busy")
                buttons.addView(action(when { mine -> "本人"; busy -> "发送中"; sent == "accepted" -> "已添加"; sent == "pending" -> "已发送"; else -> "添加" }, R.id.contacts_friend_add) {
                    if (sent == "pending") { showMessage("已发送过好友申请，请等待对方验证", false); return@action }
                    item.put("_busy", true)
                    adapter.notifyDataSetChanged()
                    onAdd(item)
                }.apply { isEnabled = !mine && !busy && sent != "accepted" })
            } else if (page == Page.REQUESTS) {
                val status = item.optString("status")
                if (status == "pending") {
                    for ((title, verb, resource) in listOf(Triple("拒绝", "reject", R.id.contacts_request_reject), Triple("同意", "accept", R.id.contacts_request_accept))) {
                        buttons.addView(action(title, resource) {
                            item.put("_busy", true)
                            adapter.notifyDataSetChanged()
                            onRequest(item, verb)
                        }.apply { isEnabled = !item.optBoolean("_busy") })
                    }
                } else buttons.addView(label(when (status) { "accepted" -> "已同意"; "rejected" -> "已拒绝"; else -> "已失效" }, 13f, CONTACTS_MUTED))
            }
        }
    }

    private fun hideKeyboard() {
        searchInput?.let { (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
    }

    init {
        id = R.id.contacts_screen
        orientation = VERTICAL
        setWillNotDraw(false)
        setBackgroundColor(Color.WHITE)
        setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            } else setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        render()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (isConversationPage) canvas.drawRect(0f, 0f, width.toFloat(), paddingTop.toFloat(), chromePaint)
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(conversationRefresh); conversationRefreshPosted = false
        super.onDetachedFromWindow()
    }
}

/** The five reference tabs use drawn flat icons rather than emoji or duplicated text. */
class ContactsNavigation(context: Context, selected: String, navigate: (String) -> Unit) : LinearLayout(context) {
    init {
        orientation = HORIZONTAL
        setBackgroundColor(Color.WHITE)
        elevation = 0f
        clipChildren = false; clipToPadding = false
        val unit = resources.displayMetrics.widthPixels / 873f
        layoutParams = LinearLayout.LayoutParams(-1, (100 * unit).roundToInt())
        val definitions = listOf(
            Triple("chat", "聊天", R.id.nav_chat), Triple("contacts", "联系人", R.id.nav_contacts),
            Triple("explore", "探索", R.id.nav_explore), Triple("tasks", "任务", R.id.nav_tasks),
            Triple("me", "我的", R.id.nav_me)
        )
        definitions.forEach { (key, title, resource) ->
            val tint = if (key == selected) CONTACTS_BLUE else CONTACTS_MUTED
            addView(LinearLayout(context).apply {
                id = resource
                contentDescription = title
                isSelected = key == selected
                orientation = VERTICAL
                gravity = Gravity.CENTER
                clipChildren = false; clipToPadding = false
                addView(FrameLayout(context).apply {
                    clipChildren = false; clipToPadding = false
                    addView(ContactIconView(context, key, tint), FrameLayout.LayoutParams(-1, -1))
                    if (key == "chat" || key == "contacts") addView(UnreadBadgeView(context, key == "contacts").apply {
                        id = if (key == "chat") R.id.nav_chat_badge else R.id.nav_contacts_badge
                    }, FrameLayout.LayoutParams(-2, (16 * resources.displayMetrics.density).roundToInt(), Gravity.TOP or Gravity.END).apply {
                        rightMargin = -(7 * resources.displayMetrics.density).roundToInt()
                        topMargin = -(2 * resources.displayMetrics.density).roundToInt()
                    })
                }, LayoutParams((53 * unit).roundToInt(), (53 * unit).roundToInt()))
                addView(TextView(context).apply {
                    text = title; textSize = 11f; setTextColor(tint); includeFontPadding = false
                    gravity = Gravity.CENTER
                }, LayoutParams(-1, -2).apply { topMargin = (9 * unit).roundToInt() })
                setOnClickListener { navigate(key) }
            }, LayoutParams(0, -1, 1f))
        }
    }
}

internal class ContactIconView(context: Context, private val kind: String, private val tint: Int) : View(context) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val drawableWidth = width - paddingLeft - paddingRight
        val drawableHeight = height - paddingTop - paddingBottom
        val side = minOf(drawableWidth, drawableHeight).toFloat()
        canvas.save()
        canvas.translate(paddingLeft + (drawableWidth - side) / 2f, paddingTop + (drawableHeight - side) / 2f)
        canvas.scale(side / 100f, side / 100f)
        p.color = AppAppearance.ink(tint); p.strokeWidth = 6f; p.strokeCap = Paint.Cap.ROUND; p.strokeJoin = Paint.Join.ROUND
        p.style = Paint.Style.STROKE; p.shader = null
        when (kind) {
            "plus" -> { canvas.drawLine(50f, 12f, 50f, 88f, p); canvas.drawLine(12f, 50f, 88f, 50f, p) }
            "back" -> { canvas.drawLine(62f, 17f, 30f, 50f, p); canvas.drawLine(30f, 50f, 62f, 83f, p) }
            "search" -> { p.strokeWidth = 5f; canvas.drawCircle(41f, 41f, 26f, p); canvas.drawLine(61f, 61f, 86f, 86f, p) }
            "new_friend", "group", "channel" -> {
                p.style = Paint.Style.FILL
                val colors = when (kind) {
                    "new_friend" -> intArrayOf(0xFFFFC764.toInt(), 0xFFFFBD55.toInt())
                    "group" -> intArrayOf(0xFF7DABFF.toInt(), 0xFF5485F8.toInt())
                    else -> intArrayOf(0xFF56DAB8.toInt(), 0xFF2CC69D.toInt())
                }
                p.shader = LinearGradient(0f, 0f, 100f, 100f, colors, null, Shader.TileMode.CLAMP)
                canvas.drawRoundRect(0f, 0f, 100f, 100f, 19f, 19f, p)
                p.shader = null; p.color = Color.WHITE
                if (kind == "new_friend") {
                    canvas.drawCircle(50f, 34f, 13f, p)
                    canvas.drawRoundRect(29f, 53f, 71f, 82f, 13f, 13f, p)
                } else if (kind == "group") {
                    p.alpha = 180; canvas.drawOval(42f, 29f, 86f, 68f, p)
                    canvas.drawPath(Path().apply { moveTo(75f, 59f); lineTo(82f, 76f); lineTo(59f, 64f); close() }, p)
                    p.alpha = 255; canvas.drawOval(15f, 36f, 66f, 76f, p)
                    canvas.drawPath(Path().apply { moveTo(21f, 63f); lineTo(18f, 83f); lineTo(41f, 72f); close() }, p)
                } else {
                    for ((x, y) in listOf(37f to 37f, 63f to 37f, 37f to 63f, 63f to 63f)) canvas.drawCircle(x, y, 14f, p)
                }
            }
            "link", "group_link" -> {
                p.strokeWidth = if (kind == "group_link") 6f else 7f
                canvas.rotate(-42f, 50f, 50f)
                canvas.drawPath(Path().apply { moveTo(46f, 30f); lineTo(31f, 30f); cubicTo(6f, 30f, 6f, 70f, 31f, 70f); lineTo(46f, 70f) }, p)
                canvas.drawPath(Path().apply { moveTo(54f, 30f); lineTo(69f, 30f); cubicTo(94f, 30f, 94f, 70f, 69f, 70f); lineTo(54f, 70f) }, p)
                canvas.drawLine(38f, 49f, 62f, 49f, p)
            }
            "chat" -> {
                p.style = Paint.Style.FILL
                canvas.drawRoundRect(9f, 15f, 91f, 79f, 20f, 20f, p)
                canvas.drawPath(Path().apply { moveTo(20f, 67f); lineTo(17f, 92f); lineTo(44f, 77f); close() }, p)
                p.color = Color.WHITE
                for (x in listOf(29f, 50f, 71f)) canvas.drawCircle(x, 47f, 4.5f, p)
            }
            "contacts" -> {
                p.style = Paint.Style.FILL
                canvas.drawCircle(40f, 29f, 18f, p)
                canvas.drawRoundRect(10f, 53f, 67f, 91f, 17f, 17f, p)
                p.alpha = 150
                canvas.drawCircle(73f, 36f, 13f, p)
                canvas.drawRoundRect(68f, 56f, 96f, 88f, 12f, 12f, p)
                p.alpha = 255
            }
            "explore" -> {
                p.style = Paint.Style.FILL
                canvas.drawRoundRect(18f, 27f, 82f, 82f, 8f, 8f, p)
                p.style = Paint.Style.STROKE; p.strokeWidth = 6f
                canvas.drawLine(32f, 27f, 37f, 15f, p); canvas.drawLine(68f, 27f, 63f, 15f, p)
                canvas.drawLine(18f, 42f, 82f, 42f, p)
            }
            "tasks" -> {
                p.style = Paint.Style.STROKE; p.strokeWidth = 6f
                canvas.drawRoundRect(22f, 13f, 78f, 87f, 8f, 8f, p)
                canvas.drawLine(35f, 34f, 41f, 40f, p); canvas.drawLine(41f, 40f, 52f, 27f, p)
                canvas.drawLine(35f, 57f, 41f, 63f, p); canvas.drawLine(41f, 63f, 52f, 50f, p)
                canvas.drawLine(58f, 35f, 68f, 35f, p); canvas.drawLine(58f, 58f, 68f, 58f, p)
            }
            "me" -> {
                p.style = Paint.Style.FILL
                canvas.drawCircle(50f, 28f, 20f, p)
                canvas.drawRoundRect(14f, 54f, 86f, 93f, 23f, 23f, p)
            }
        }
        p.alpha = 255; p.shader = null
        canvas.restore()
    }
}
