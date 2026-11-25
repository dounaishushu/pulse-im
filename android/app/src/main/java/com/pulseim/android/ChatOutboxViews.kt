package com.pulseim.android

import android.os.Bundle
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.graphics.Color
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.media.MediaRecorder
import android.os.Build
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.*
import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.provider.MediaStore
import android.text.InputType
import android.view.animation.Animation
import android.view.animation.TranslateAnimation
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.Executors
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import com.google.zxing.common.BitMatrix
import com.google.zxing.integration.android.IntentIntegrator
import com.google.zxing.integration.android.IntentResult
import com.pulseim.android.MainActivity.PhotoBatch
import com.pulseim.android.MainActivity.PhotoBatchItem
import com.pulseim.android.MainActivity.PendingVoice
import com.pulseim.android.MainActivity.PickedMedia
import com.pulseim.android.MainActivity.LocalPhotoSource
import com.pulseim.android.MainActivity.SendPhase

/** Activity-owned UI collaborator; never stored in the ViewModel. */
internal class ChatOutboxViews(private val host: MainActivity) {
    private val foregroundOwner get() = MainActivity.foregroundOwner
    fun renderPendingTextMessages(container: LinearLayout) { with(host) {
        if (container !== currentMessages) return
        publishChatOutbox()
        if (BuildConfig.CHAT_V2) { chatRecycler?.requestRender(); return }
        val queue = textSends
        val pending = queue?.pending(api.token, currentUserId, apiBaseUrl, activeConversationId).orEmpty()
        val tags = pending.map { "pending-text:" + it.requestId }.toSet()
        (0 until container.childCount).map { container.getChildAt(it) }.filter { (it.tag as? String)?.startsWith("pending-text:") == true && it.tag !in tags }.forEach { container.removeView(it) }
        pending.forEach { entry ->
            val tag = "pending-text:" + entry.requestId
            var pendingRow = container.findViewWithTag<LinearLayout>(tag)
            if (pendingRow == null) {
                pendingRow = row().apply {
                    this.tag = tag; gravity = Gravity.END; setPadding(dp(8), dp(4), dp(8), dp(4))
                    addView(column(0).apply {
                        addView(text(entry.text, AppAppearance.messageSize.toFloat()).apply {
                            setTag(R.id.appearance_user_content, true); setTag(R.id.appearance_message, true)
                            maxWidth = resources.displayMetrics.widthPixels - dp(78)
                            setPadding(dp(12), dp(9), dp(12), dp(9)); background = rounded(AppAppearance.background(PulseColors.accentSoft), 9)
                        })
                        addView(text("", 11f, PulseColors.muted).apply { this.tag = "text-send-status"; gravity = Gravity.END; setPadding(dp(4), dp(3), dp(4), dp(2)); minHeight = dp(24); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE })
                        addView(text("移除", 11f, PulseColors.muted).apply { this.tag = "text-send-remove"; gravity = Gravity.END; minHeight = dp(24); contentDescription = "移除待发送消息" })
                    })
                }
                container.addView(pendingRow)
            }
            pendingRow.findViewWithTag<TextView>("text-send-status").apply {
                val failed = entry.phase == TextSendQueue.Phase.FAILED
                text = if (failed) "发送未确认 · 点击重试" else if (entry.phase == TextSendQueue.Phase.SENDING) "发送中…" else "等待发送…"
                setTextColor(if (failed) PulseColors.danger else PulseColors.muted)
                contentDescription = if (failed) "发送未确认：" + entry.error + "，点击重试" else text
                isClickable = failed
                setOnClickListener { if (chatCanSend && queue != null) retryTextOutbox(queue, entry) }
                isClickable = failed
            }
            pendingRow.findViewWithTag<TextView>("text-send-remove").apply {
                visibility = if (entry.phase == TextSendQueue.Phase.FAILED) View.VISIBLE else View.GONE
                setOnClickListener { if (queue != null) changeTextOutbox(queue) { queue.discard(entry, entry.token, entry.userId, entry.endpoint) } }
            }
        }
        renderPendingMediaMessages(container)
        } }

    fun renderPendingMediaMessages(container: LinearLayout) { with(host) {
        if (container === currentMessages) publishChatOutbox()
        if (container !== currentMessages) return
        if (BuildConfig.CHAT_V2) { chatRecycler?.requestRender(); return }
        val queue = mediaOutbox
        val entries = queue?.pending(activeConversationId).orEmpty().filter{it.userId==currentUserId&&it.token==api.token&&it.endpoint==apiBaseUrl}
        val local=localPhotoSources.values.filter{it.base==apiBaseUrl&&it.target.matches(activeConversationId,currentUserId,api.token)}
        val tags=(entries.map{"pending-media:${it.requestId}"}+local.map{"pending-media:${it.target.requestId}"}).toSet()
        (0 until container.childCount).map { container.getChildAt(it) }.filter { (it.tag as? String)?.startsWith("pending-media:") == true && it.tag !in tags }.forEach { container.removeView(it) }
        fun photo(target:SendTarget,source:LocalPhotoSource?,entry:DurableMediaOutbox.Entry?) {
            val tag="pending-media:${target.requestId}";val key=photoPreviewKey(apiBaseUrl,target)
            val view=container.findViewWithTag<PendingPhotoPreview>(tag)?:PendingPhotoPreview(this).also{it.tag=tag;container.addView(it)}
            fun current()=container===currentMessages&&target.matches(activeConversationId,currentUserId,api.token)&&key==photoPreviewKey(apiBaseUrl,target)&&!appLock.locked&&!isFinishing&&!isDestroyed
            pendingPhotoThumbnails.bind(view.image,key,::current){
                if(entry!=null&&queue!=null)queue.openPreview(entry).use{ChatImageCache.localPreview(this,it.file)}
                else PendingPhotoThumbnails.decode(this,requireNotNull(source).uri)
            }
            val unreadable = entry?.phase == DurableMediaOutbox.Phase.UNREADABLE
            val failed = unreadable || entry?.phase == DurableMediaOutbox.Phase.FAILED
            view.update(failed,entry?.error.orEmpty(),retry={
                if(!chatCanSend||localSessionOnly){toast("当前无法发送，请联网后确认发言权限");return@update}
                if (entry != null && queue != null) retryMediaOutbox(queue, entry)
            },discard={
                if (entry != null && queue != null) changeMediaOutbox(queue, after = {
                    localPhotoSources.remove(target.requestId); pendingPhotoThumbnails.forget(key)
                }) { queue.discard(entry) }
            }, canRetry = !unreadable)
        }
        entries.forEach { entry ->
            val phase = entry.phase
            val canRetry = phase == DurableMediaOutbox.Phase.FAILED
            val failed = canRetry || phase == DurableMediaOutbox.Phase.UNREADABLE
            if(entry.kind=="image") {
                photo(SendTarget(entry.conversationId,entry.userId,entry.token,entry.requestId,entry.replyToId),localPhotoSources[entry.requestId],entry)
                return@forEach
            }
            container.findViewWithTag<View>("pending-media:${entry.requestId}")?.let{container.removeView(it)}
            val kind = when (entry.kind) { "image" -> "图片"; "video" -> "视频"; "voice" -> "语音"; else -> "文件" }
            val status = when (phase) {
                DurableMediaOutbox.Phase.QUEUED -> "等待发送"
                DurableMediaOutbox.Phase.UPLOADING -> "正在上传"
                DurableMediaOutbox.Phase.COMMITTING -> "正在发送"
                DurableMediaOutbox.Phase.FAILED -> "${entry.error.ifBlank { "发送未确认" }} · 点击重试"
                DurableMediaOutbox.Phase.UNREADABLE -> entry.error
            }
            container.addView(column(0).apply {
                tag = "pending-media:${entry.requestId}"; gravity = Gravity.END; setPadding(dp(12), dp(6), dp(12), dp(6))
                addView(text("[$kind] ${entry.displayName}", 14f).apply { maxWidth = resources.displayMetrics.widthPixels - dp(70); setTag(R.id.appearance_user_content, true) })
                addView(text(status, 12f, if (failed) PulseColors.danger else PulseColors.muted).apply {
                    minHeight = dp(30)
                    if (canRetry) setOnClickListener {
                        if (!chatCanSend || localSessionOnly) { toast("当前无法发送，请联网后确认发言权限"); return@setOnClickListener }
                        if (queue != null) retryMediaOutbox(queue, entry)
                    }
                })
                if (failed || phase == DurableMediaOutbox.Phase.QUEUED) addView(text("移除", 12f, PulseColors.muted).apply {
                    minHeight = dp(30); contentDescription = "移除待发送$kind"
                    setOnClickListener { if (queue != null) changeMediaOutbox(queue) { queue.discard(entry) } }
                })
            })
        }
        val queuedIds=entries.map{it.requestId}.toSet()
        local.filter{it.target.requestId !in queuedIds}.forEach{photo(it.target,it,null)}
        } }

    fun photoRequestId(target:SendTarget,index:Int) = with(host) {
        if(index==0)target.requestId else "${target.requestId}-photo-$index"
    }

    fun photoPreviewKey(base:String,target:SendTarget) = with(host) {
        "$base|${target.userId}|${target.token}|${target.conversationId}|${target.requestId}"
    }

    fun rememberLocalPhotos(target:SendTarget,uris:List<Uri>) { with(host) {
        uris.filter{it.scheme=="content"}.distinct().take(PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS).forEachIndexed{index,uri->
            val item=target.copy(requestId=photoRequestId(target,index),replyToId=if(index==0)target.replyToId else 0)
            localPhotoSources.putIfAbsent(item.requestId,LocalPhotoSource(apiBaseUrl,target.requestId,item,uri))
        }
        currentMessages?.let{renderPendingMediaMessages(it);postChatBottom(it,it.parent as? ScrollView)}
        } }

    fun completeLocalPhoto(message:JSONObject,requestId:String) { with(host) {
        val token=api.token?:return
        val target=SendTarget(message.optInt("conversation_id"),currentUserId,token,requestId)
        val key=photoPreviewKey(apiBaseUrl,target)
        val url=message.optJSONObject("body")?.optString("url").orEmpty()
        if(message.optString("type")=="image"&&url.isNotBlank())pendingPhotoThumbnails.cached(key)?.let{bitmap->
            runCatching{ChatImageCache.seedPreview(apiBaseUrl+"|"+token,RouteManager.media(url,apiBaseUrl),bitmap)}
        }
        localPhotoSources[requestId]?.takeIf{photoPreviewKey(it.base,it.target)==key}?.let{localPhotoSources.remove(requestId)}
        if(target.conversationId==activeConversationId)currentMessages?.let{container->
            if (BuildConfig.CHAT_V2) chatRecycler?.requestRender() else container.findViewWithTag<View>("pending-media:$requestId")?.let{container.removeView(it)}
        }
        pendingPhotoThumbnails.forget(key)
        } }

    fun recyclerRows(): List<ChatListRow> { with(host) {
        val header = recyclerHeader?.let { ChatListRow(ChatRowKind.OLDER_LOADING, version = "${it.text}|${it.visibility}|${it.isEnabled}") }
        val messages = currentChatState()?.messages.orEmpty().map { value -> ChatListRow(ChatRowKind.MESSAGE, id = value.id, version = value.version, snapshot = value.snapshot) }
        val text = textSends?.pending(api.token, currentUserId, apiBaseUrl, activeConversationId).orEmpty().map { entry ->
            ChatListRow(ChatRowKind.PENDING_TEXT, requestId = entry.requestId, version = "${entry.phase}|${entry.error}", snapshot = entry.text)
        }
        val media = mediaOutbox?.pending(activeConversationId).orEmpty().filter { it.userId == currentUserId && it.token == api.token && it.endpoint == apiBaseUrl }.map { entry ->
            ChatListRow(ChatRowKind.PENDING_MEDIA, requestId = entry.requestId, version = "${entry.phase}|${entry.error}|${entry.kind}")
        }
        val ids = media.map { it.requestId }.toSet()
        val local = localPhotoSources.values.filter { it.base == apiBaseUrl && it.target.matches(activeConversationId, currentUserId, api.token) && it.target.requestId !in ids }
            .map { ChatListRow(ChatRowKind.PENDING_MEDIA, requestId = it.target.requestId, version = "local") }
        val pending = text + media + local
        pending.forEach { recyclerPendingOrder.getOrPut(it.key) { ++recyclerPendingSequence } }
        recyclerPendingOrder.keys.retainAll(pending.map { it.key }.toSet())
        return ChatListRows.ordered(header, messages, pending.sortedBy { recyclerPendingOrder[it.key] })
        } }

    fun bindRecyclerRow(container: LinearLayout, previous: View?, item: ChatListRow): View = with(host) {
        when (item.kind) {
        ChatRowKind.MESSAGE -> recyclerMessageBinding.bind(previous, item)
        ChatRowKind.PENDING_TEXT -> {
            val queue = textSends
            val entry = queue?.pending(api.token, currentUserId, apiBaseUrl, activeConversationId)?.firstOrNull { it.requestId == item.requestId }
            if (entry == null) View(this) else {
                val view = previous as? LinearLayout ?: row().apply {
                    gravity = Gravity.END; setPadding(dp(8), dp(4), dp(8), dp(4))
                    addView(column(0).apply {
                        addView(text("", AppAppearance.messageSize.toFloat()).apply {
                            setTag(R.id.appearance_user_content, true); setTag(R.id.appearance_message, true)
                            maxWidth = resources.displayMetrics.widthPixels - dp(78)
                            setPadding(dp(12), dp(9), dp(12), dp(9)); background = rounded(AppAppearance.background(PulseColors.accentSoft), 9)
                        })
                        addView(text("", 11f, PulseColors.muted).apply { id = R.id.chat_pending_status; gravity = Gravity.END; setPadding(dp(4), dp(3), dp(4), dp(2)); minHeight = dp(24); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE })
                        addView(text("移除", 11f, PulseColors.muted).apply { id = R.id.chat_pending_remove; gravity = Gravity.END; minHeight = dp(24); contentDescription = "移除待发送消息" })
                    })
                }
                ((view.getChildAt(0) as LinearLayout).getChildAt(0) as TextView).text = entry.text
                val failed = entry.phase == TextSendQueue.Phase.FAILED
                view.findViewById<TextView>(R.id.chat_pending_status).apply {
                    text = if (failed) "发送未确认 · 点击重试" else if (entry.phase == TextSendQueue.Phase.SENDING) "发送中…" else "等待发送…"
                    setTextColor(if (failed) PulseColors.danger else PulseColors.muted)
                    contentDescription = if (failed) "发送未确认：" + entry.error + "，点击重试" else text
                    setOnClickListener { if (chatCanSend && queue != null) retryTextOutbox(queue, entry) }; isClickable = failed
                }
                view.findViewById<TextView>(R.id.chat_pending_remove).apply {
                    visibility = if (failed) View.VISIBLE else View.GONE
                    setOnClickListener { if (queue != null) changeTextOutbox(queue) { queue.discard(entry, entry.token, entry.userId, entry.endpoint) } }
                }
                view
            }
        }
        ChatRowKind.PENDING_MEDIA -> bindRecyclerMedia(container, previous, item.requestId)
        ChatRowKind.OLDER_LOADING -> recyclerHeader ?: View(this)
    }
    }

    fun bindRecyclerMedia(container: LinearLayout, previous: View?, requestId: String): View { with(host) {
        val queue = mediaOutbox
        val entry = queue?.pending(activeConversationId)?.firstOrNull { it.requestId == requestId && it.userId == currentUserId && it.token == api.token && it.endpoint == apiBaseUrl }
        val source = localPhotoSources[requestId]?.takeIf { it.base == apiBaseUrl && it.target.matches(activeConversationId, currentUserId, api.token) }
        if (entry == null && source == null) return View(this)
        val unreadable = entry?.phase == DurableMediaOutbox.Phase.UNREADABLE
        val failed = unreadable || entry?.phase == DurableMediaOutbox.Phase.FAILED
        if (entry?.kind == "image" || entry == null) {
            val target = source?.target ?: SendTarget(entry!!.conversationId, entry.userId, entry.token, entry.requestId, entry.replyToId)
            val key = photoPreviewKey(apiBaseUrl, target)
            val view = previous as? PendingPhotoPreview ?: PendingPhotoPreview(this)
            fun current() = currentMessages === container && target.matches(activeConversationId, currentUserId, api.token) && key == photoPreviewKey(apiBaseUrl, target) && !appLock.locked && !isFinishing && !isDestroyed
            pendingPhotoThumbnails.bind(view.image, key, ::current) {
                if (entry != null && queue != null) queue.openPreview(entry).use { ChatImageCache.localPreview(this, it.file) }
                else PendingPhotoThumbnails.decode(this, requireNotNull(source).uri)
            }
            view.update(failed, entry?.error.orEmpty(), retry = {
                if (!chatCanSend || localSessionOnly) { toast("当前无法发送，请联网后确认发言权限"); return@update }
                if (entry != null && queue != null) retryMediaOutbox(queue, entry)
            }, discard = {
                if (entry != null && queue != null) changeMediaOutbox(queue, after = { localPhotoSources.remove(requestId); pendingPhotoThumbnails.forget(key) }) { queue.discard(entry) }
            }, canRetry = !unreadable)
            return view
        }
        val view = (previous as? LinearLayout)?.takeUnless { it is PendingPhotoPreview } ?: column(0).apply {
            gravity = Gravity.END; setPadding(dp(12), dp(6), dp(12), dp(6))
            addView(text("", 14f).apply { maxWidth = resources.displayMetrics.widthPixels - dp(70); setTag(R.id.appearance_user_content, true) })
            addView(text("", 12f, PulseColors.muted).apply { id = R.id.chat_pending_status; minHeight = dp(30) })
            addView(text("移除", 12f, PulseColors.muted).apply { id = R.id.chat_pending_remove; minHeight = dp(30) })
        }
        val kind = when (entry.kind) { "video" -> "视频"; "voice" -> "语音"; else -> "文件" }
        (view.getChildAt(0) as TextView).text = "[$kind] ${entry.displayName}"
        val canRetry = entry.phase == DurableMediaOutbox.Phase.FAILED
        view.findViewById<TextView>(R.id.chat_pending_status).apply {
            text = when (entry.phase) {
                DurableMediaOutbox.Phase.QUEUED -> "等待发送"
                DurableMediaOutbox.Phase.UPLOADING -> "正在上传"
                DurableMediaOutbox.Phase.COMMITTING -> "正在发送"
                DurableMediaOutbox.Phase.FAILED -> "${entry.error.ifBlank { "发送未确认" }} · 点击重试"
                DurableMediaOutbox.Phase.UNREADABLE -> entry.error
            }
            setTextColor(if (failed) PulseColors.danger else PulseColors.muted)
            setOnClickListener {
                if (!chatCanSend || localSessionOnly) toast("当前无法发送，请联网后确认发言权限")
                else if (queue != null) retryMediaOutbox(queue, entry)
            }; isClickable = canRetry
        }
        view.findViewById<TextView>(R.id.chat_pending_remove).apply {
            visibility = if (failed || entry.phase == DurableMediaOutbox.Phase.QUEUED) View.VISIBLE else View.GONE
            contentDescription = "移除待发送$kind"; setOnClickListener { if (queue != null) changeMediaOutbox(queue) { queue.discard(entry) } }
        }
        return view
        } }
}
