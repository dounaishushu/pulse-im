package com.pulseim.android

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView

/** The host keeps existing account/view ownership checks independent of the row layout. */
internal class ChatRecyclerHost(context: Context) : LinearLayout(context) {
    var list: ChatRecyclerList? = null
    override fun removeAllViews() { list?.clear() ?: super.removeAllViews() }
    override fun removeView(view: View?) { if (list == null) super.removeView(view) else list?.requestRender() }
    override fun onDetachedFromWindow() { list?.dispose(); super.onDetachedFromWindow() }
}

internal class ChatRecyclerList(
    context: Context, val host: LinearLayout,
    private val rows: () -> List<ChatListRow>,
    private val bind: (View?, ChatListRow) -> View,
    private val select: (View) -> Unit,
    private val current: () -> Boolean,
    private val positionRevision: () -> Long,
    private val shouldFollow: () -> Boolean,
    private val touch: (MotionEvent) -> Unit,
    private val attached: (View, ChatListRow) -> Unit = { _, _ -> }
) {
    data class Anchor(val key: String, val offset: Int, val revision: Long)
    private enum class Payload { CONTENT, SELECTION }
    private class Holder(val frame: FrameLayout) : RecyclerView.ViewHolder(frame) { var row: View? = null }
    private val listeners = mutableSetOf<() -> Unit>()
    var onOlder: (() -> Unit)? = null
    var header: View? = null
    var binds = 0; private set
    var creates = 0; private set
    private var scheduled = false
    private var disposed = false
    private val selectionUpdates = ChatSelectionUpdates()
    private var selectionRevision = 0L
    private var anchor: Anchor? = null
    private var following = false
    private var revision = 0L
    private var locate: Pair<Int, (View?) -> Unit>? = null
    private var revealDraw: ViewTreeObserver.OnPreDrawListener? = null
    private val recalledRows = linkedMapOf<Int, ChatListRow>()
    private val voiceStates = mutableMapOf<Int, GroupMessageMedia.VoiceState>()
    val manager = LinearLayoutManager(context).apply { stackFromEnd = true; reverseLayout = false }
    val view = object : RecyclerView(context) {
        override fun dispatchTouchEvent(event: MotionEvent): Boolean { touch(event); return super.dispatchTouchEvent(event) }
    }.apply {
        id = R.id.chat_message_scroll; layoutManager = manager; itemAnimator = null
        isVerticalScrollBarEnabled = false; clipToPadding = false
    }
    val adapter = object : ListAdapter<ChatListRow, RecyclerView.ViewHolder>(object : DiffUtil.ItemCallback<ChatListRow>() {
        override fun areItemsTheSame(a: ChatListRow, b: ChatListRow) = ChatListRows.sameItem(a, b)
        override fun areContentsTheSame(a: ChatListRow, b: ChatListRow) = ChatListRows.sameContent(a, b)
        override fun getChangePayload(a: ChatListRow, b: ChatListRow): Any = Payload.CONTENT
    }) {
        override fun getItemViewType(position: Int) = getItem(position).kind.ordinal
        override fun onCreateViewHolder(parent: ViewGroup, type: Int): RecyclerView.ViewHolder {
            creates++
            return Holder(FrameLayout(context).apply { layoutParams = RecyclerView.LayoutParams(-1, -2) })
        }
        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) = onBindViewHolder(holder, position, mutableListOf())
        override fun onViewAttachedToWindow(holder: RecyclerView.ViewHolder) {
            val position = holder.bindingAdapterPosition
            if (disposed || !current() || position < 0 || position >= itemCount) return
            val content = (holder as Holder).row ?: return
            val item = getItem(position)
            applyVoice(content, item); attached(content, item)
        }
        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
            binds++; val target = holder as Holder; val item = getItem(position)
            if (payloads.isNotEmpty() && payloads.all { it == Payload.SELECTION } && target.row != null) { select(target.row!!); return }
            val content = if (item.kind == ChatRowKind.OLDER_LOADING) header ?: View(context) else bind(target.row, item)
            if (content !== target.row) {
                (content.parent as? ViewGroup)?.removeView(content)
                target.frame.removeAllViews()
                val margins = content.layoutParams as? ViewGroup.MarginLayoutParams
                target.frame.addView(content, FrameLayout.LayoutParams(-1, -2).apply {
                    topMargin = margins?.topMargin ?: 0; bottomMargin = margins?.bottomMargin ?: 0
                })
                target.row = content
            }
            applyVoice(content, item)
            select(content)
        }
    }
    private fun applyVoice(content: View, item: ChatListRow) {
        if (item.kind == ChatRowKind.MESSAGE) content.findViewById<VoiceMessageView>(R.id.chat_message_voice)?.let { bar ->
            bar.render(voiceStates[item.id] ?: GroupMessageMedia.VoiceState(item.id, loading = false, playing = false, durationSeconds = bar.durationSeconds))
        }
    }
    private val render = Runnable {
        scheduled = false
        if (!disposed && current()) {
            val saved = anchor; val follow = following; val capturedRevision = revision; anchor = null; following = false
            val snapshot = rows()
            val next = ChatListRows.ordered(snapshot.firstOrNull { it.kind == ChatRowKind.OLDER_LOADING },
                snapshot.filter { it.kind == ChatRowKind.MESSAGE } + recalledRows.values,
                snapshot.filter { it.kind == ChatRowKind.PENDING_TEXT || it.kind == ChatRowKind.PENDING_MEDIA })
            adapter.submitList(next) {
                if (!disposed && current()) {
                    view.visibility = View.VISIBLE
                    if (capturedRevision == positionRevision()) {
                        if (follow) followLatest() else if (saved != null) restore(saved)
                    }
                    locate?.let { (id, done) ->
                        locate = null; val index = adapter.currentList.indexOfFirst { it.id == id && it.kind == ChatRowKind.MESSAGE }
                        if (index < 0) done(null) else {
                            manager.scrollToPositionWithOffset(index, 12)
                            revealDraw = ViewTreeObserver.OnPreDrawListener {
                                clearRevealDraw()
                                if (!disposed && current()) done(bound(id))
                                true
                            }.also { view.viewTreeObserver.addOnPreDrawListener(it) }
                            view.requestLayout()
                        }
                    }
                    changed()
                }
            }
        }
    }
    init {
        view.adapter = adapter
        view.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                changed(); if (dy < 0 && manager.findFirstVisibleItemPosition() <= 1) onOlder?.invoke()
            }
        })
        host.addView(view, LinearLayout.LayoutParams(-1, -1)); (host as? ChatRecyclerHost)?.list = this
    }
    fun addChanged(listener: () -> Unit) { listeners.add(listener) }
    fun removeChanged(listener: () -> Unit) { listeners.remove(listener) }
    private fun changed() { listeners.toList().forEach { it() } }
    fun atBottom() = !view.canScrollVertically(1)
    fun remaining() = (view.computeVerticalScrollRange() - view.computeVerticalScrollOffset() - view.computeVerticalScrollExtent()).coerceAtLeast(0)
    fun capture(): Anchor? {
        val index = manager.findFirstVisibleItemPosition(); val row = adapter.currentList.getOrNull(index) ?: return null
        return Anchor(row.key, (manager.findViewByPosition(index)?.top ?: 0) - view.paddingTop, positionRevision())
    }
    fun restore(saved: Anchor) {
        val index = ChatListRows.anchorPosition(adapter.currentList, saved.key)
        if (index >= 0) manager.scrollToPositionWithOffset(index, saved.offset)
    }
    fun requestRender() {
        if (disposed || scheduled) return
        scheduled = true; following = shouldFollow(); anchor = capture(); revision = positionRevision()
        host.postOnAnimation(render)
    }
    fun followLatest() { if (!disposed && current() && adapter.itemCount > 0 && !atBottom()) view.scrollToPosition(adapter.itemCount - 1) }
    fun selectionChanged(active: Boolean, selected: Set<Int>) {
        if (disposed) return
        val request = ++selectionRevision
        val snapshot = selected.toSet()
        fun apply() {
            if (disposed || request != selectionRevision) return
            if (view.isComputingLayout) { view.post { apply() }; return }
            val positions = selectionUpdates.positions(adapter.currentList, active, snapshot)
            if (positions.isEmpty()) return
            val saved = if (shouldFollow()) null else capture()
            positions.forEach { adapter.notifyItemChanged(it, Payload.SELECTION) }
            // Entering/leaving selection changes text width; retain the top reader anchor.
            if (saved != null) restore(saved)
        }
        apply()
    }
    fun bound(id: Int): View? {
        val index = adapter.currentList.indexOfFirst { it.id == id && it.kind == ChatRowKind.MESSAGE }
        if (index < 0) return null
        return (view.findViewHolderForAdapterPosition(index) as? Holder)?.row
    }
    fun bound(requestId: String): View? {
        val index = adapter.currentList.indexOfFirst { it.requestId == requestId && it.kind != ChatRowKind.MESSAGE }
        if (index < 0) return null
        return (view.findViewHolderForAdapterPosition(index) as? Holder)?.row
    }
    private fun clearRevealDraw() {
        revealDraw?.let { if (view.viewTreeObserver.isAlive) view.viewTreeObserver.removeOnPreDrawListener(it) }
        revealDraw = null
    }
    fun reveal(id: Int, done: (View?) -> Unit) { clearRevealDraw(); locate = id to done; requestRender() }
    fun voice(state: GroupMessageMedia.VoiceState) {
        if (disposed || !current()) return
        voiceStates[state.messageId] = state
        bound(state.messageId)?.findViewById<VoiceMessageView>(R.id.chat_message_voice)?.render(state)
    }
    fun recalled(row: ChatListRow) { voiceStates.remove(row.id); recalledRows[row.id] = row; requestRender() }
    fun removeRecalled(id: Int) { voiceStates.remove(id); if (recalledRows.remove(id) != null) requestRender() }
    fun clearRecalledThrough(id: Int) { voiceStates.keys.removeAll { it <= id }; if (recalledRows.keys.removeAll { it <= id }) requestRender() }
    fun clear() { if (!disposed) { clearRevealDraw(); locate = null; voiceStates.clear(); recalledRows.clear(); view.visibility = View.INVISIBLE; adapter.submitList(null); requestRender() } }
    fun dispose() {
        if (disposed) return
        disposed = true; host.removeCallbacks(render); listeners.clear(); clearRevealDraw(); view.adapter = null; locate = null; voiceStates.clear(); recalledRows.clear()
    }
}
