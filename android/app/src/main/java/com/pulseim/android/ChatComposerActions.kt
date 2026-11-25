package com.pulseim.android

import android.content.Context.INPUT_METHOD_SERVICE

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
internal class ChatComposerActions(private val host: MainActivity) {
    private val foregroundOwner get() = MainActivity.foregroundOwner
    fun renderChatSendPermission(permission: ChatSendPermission, previousAllowed: Boolean) { with(host) {
        val disablingSend = !permission.allowed && previousAllowed
        val enablingSend = permission.allowed && !previousAllowed
        if (enablingSend) window.decorView.post { drainTextOutbox() }
        val input = findViewById<EditText>(R.id.chat_message_input) ?: return
        val editable = permission.allowed || permission.reason == "loading"
        val disabling = !editable && !chatComposerRestricted
        chatDraftChanging = true
        try { if (disabling) {
            // Keep rich mention spans and cursor locally while the disabled field
            // shows the mute notice. Re-enabling never submits this draft.
            chatComposerDraft = GroupAvatarMention.copy(input.text)
            chatComposerSelection = input.selectionStart.coerceAtLeast(0)
            chatComposerSelectionEnd = input.selectionEnd.coerceAtLeast(0)
            input.setText("")
        } else if (editable && chatComposerRestricted) {
            val retained = chatComposerDraft ?: ""
            GroupAvatarMention.restore(input, retained.toString(), GroupAvatarMention.snapshot(retained))
            input.setSelection(chatComposerSelection.coerceIn(0, input.length()), chatComposerSelectionEnd.coerceIn(0, input.length()))
            chatComposerDraft = null
        }
        chatComposerRestricted = !editable
        } finally { chatDraftChanging = false }
        queueChatDraftSave()
        input.hint = permission.hint
        input.isEnabled = editable
        input.isFocusable = editable; input.isFocusableInTouchMode = editable
        input.isCursorVisible = editable; input.showSoftInputOnFocus = editable
        for (id in listOf(R.id.chat_record, R.id.chat_emoji, R.id.chat_attach)) findViewById<View>(id)?.apply {
            isEnabled = permission.allowed; alpha = if (permission.allowed) 1f else 0.4f
        }
        findViewById<View>(R.id.chat_message_send)?.apply {
            val typing = permission.allowed && !input.text.isNullOrBlank() && recorder == null
            isEnabled = typing; visibility = if (typing) View.VISIBLE else View.GONE
        }
        groupMentionPicker?.refreshPermission()
        groupMentionPicker?.action?.isEnabled = permission.allowed
        if (!permission.allowed) {
            if (!editable) {
                input.clearFocus()
                (getSystemService(INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)?.hideSoftInputFromWindow(input.windowToken, 0)
            }
            closeChatAttachments(); groupMentionPicker?.dismiss(); chatEmojiPopup?.dismiss()
            if (disabling || disablingSend) {
                cancelVoiceRecording()
                // Opening an album/camera also pauses this Activity. A temporary
                // permission refresh must retain that selection until resume.
                if (permission.reason != "loading") { pendingMediaTarget = null; pendingMessages = null }
                photoBatch?.let { finishPhotoBatch(it) }
                contactCardPicker?.dismiss(); contactCardSendCancel?.invoke()
            }
        }
        renderPendingVoice()
        if (permission.allowed) window.decorView.post { drainPickedMedia() }
        } }

    fun sendCaptured(target: SendTarget, operation: (ApiClient) -> JSONObject, settled: () -> Unit = {}, state: (SendPhase) -> Unit = {}, keepLabel: String = "保留草稿", valid: () -> Boolean = { true }, captureCancel: ((() -> Unit) -> Unit)? = null, done: (JSONObject) -> Unit) { with(host) {
        if (!target.matches(activeConversationId, currentUserId, api.token) || !valid()) { settled(); toast("会话或账号已切换，发送已取消"); return }
        chatLocateTarget = 0; chatNavigationRevision++
        currentMessages?.let { postChatBottom(it, it.parent as? ScrollView) }
        val base = apiBaseUrl
        val client = ApiClient(base).apply { token = target.token }
        val lifecycle = chatViewModel.capturedAttempt(target.requestId)
        var failureDialog: android.app.AlertDialog? = null
        lateinit var acknowledge: (JSONObject) -> Unit
        fun current() = target.matches(activeConversationId, currentUserId, api.token) && apiBaseUrl == base && !isFinishing && !isDestroyed && valid()
        fun settleOnce() { if (lifecycle.settle()) { chatViewModel.releaseCapturedAttempt(target.requestId, lifecycle); settled() } }
        fun closeFailure() { failureDialog?.setOnCancelListener(null); failureDialog?.dismiss(); failureDialog = null }
        fun cancelAttempt() {
            lifecycle.stop(); closeFailure(); settleOnce()
            // An uncertain response can still be confirmed by realtime later.
            // The text composer also retains this request ID when retrying it.
            if (!current() && pendingSendAcks[target.requestId] === acknowledge) pendingSendAcks.remove(target.requestId)
        }
        captureCancel?.invoke { cancelAttempt() }
        acknowledge = { sent ->
            if (lifecycle.acknowledge()) {
                if (pendingSendAcks[target.requestId] === acknowledge) pendingSendAcks.remove(target.requestId)
                closeFailure()
                try {
                    if (current()) {
                        state(SendPhase.ACCEPTED)
                        if (target.replyToId > 0 && replyRevision == target.replyRevision && replyMessage?.optInt("id") == target.replyToId) { replyMessage = null; replyRevision++; renderReplyPreview() }
                        done(sent)
                    }
                } finally { settleOnce() }
            }
        }
        pendingSendAcks[target.requestId] = acknowledge
        fun dispatchAttempt() {
            if (!current()) { cancelAttempt(); return }
            if (!chatCanSend) { cancelAttempt(); return }
            val attempt = lifecycle.begin()
            state(SendPhase.SENDING)
            sendExecutor.execute {
                if (!lifecycle.current(attempt)) return@execute
                if (!target.matches(activeConversationId, currentUserId, api.token) || apiBaseUrl != base || !chatCanSend || !valid()) { runOnUiThread { if (lifecycle.current(attempt)) cancelAttempt() }; return@execute }
                try {
                    val sent = operation(client)
                    runOnUiThread { if (lifecycle.current(attempt)) acknowledge(sent) }
                } catch (error: Exception) {
                    runOnUiThread {
                        if (!lifecycle.current(attempt)) return@runOnUiThread
                        if (!current()) { cancelAttempt(); return@runOnUiThread }
                        val known = currentMessageData.values.firstOrNull {
                            it.optInt("id") > 0 && it.optInt("sender_id") == target.userId && it.optInt("conversation_id") == target.conversationId && it.optJSONObject("body")?.optString("request_id") == target.requestId
                        }
                        if (known != null) { acknowledge(known); return@runOnUiThread }
                        val retryDelay = if (temporarySendError(error)) lifecycle.retryDelay(attempt) else null
                        if (retryDelay != null) {
                            window.decorView.postDelayed({ if (lifecycle.current(attempt) && current()) dispatchAttempt() }, retryDelay)
                            return@runOnUiThread
                        }
                        state(SendPhase.FAILED)
                        failureDialog = android.app.AlertDialog.Builder(this).setTitle("发送未确认").setMessage("${error.message ?: "网络异常"}\n重试会使用同一请求编号，避免重复发送。")
                            .setNegativeButton(keepLabel) { _, _ -> cancelAttempt() }.setOnCancelListener { cancelAttempt() }
                            .setPositiveButton("重试") { _, _ -> closeFailure(); lifecycle.manualRetry(); dispatchAttempt() }.create().also { it.show() }
                    }
                }
            }
        }
        val known = currentMessageData.values.firstOrNull {
            it.optInt("id") > 0 && it.optInt("sender_id") == target.userId && it.optInt("conversation_id") == target.conversationId && it.optJSONObject("body")?.optString("request_id") == target.requestId
        }
        if (known != null) acknowledge(known) else dispatchAttempt()
        } }

    fun photoBatchCurrent(batch: PhotoBatch): Boolean = with(host) {
        photoBatch === batch && batch.items.first().target.matches(activeConversationId, currentUserId, api.token) &&
        apiBaseUrl == batch.base && !isFinishing && !isDestroyed
    }

    fun finishPhotoBatch(batch: PhotoBatch, feedback: String? = null) { with(host) {
        if (photoBatch !== batch) return
        photoBatch = null
        batch.uploadCalls.values.forEach { it.cancel() }; batch.uploadCalls.clear()
        batch.items.forEach { it.uploading?.cancel(true) }
        groupUploads.remove(batch.items.first().target.requestId)
        batch.failure?.setOnCancelListener(null); batch.failure?.dismiss(); batch.failure = null
        val cancel = batch.cancelSend; batch.cancelSend = null; cancel?.invoke()
        (batch.progress.parent as? ViewGroup)?.removeView(batch.progress)
        if (feedback != null && !isFinishing && !isDestroyed) toast(feedback)
        } }

    fun uploadChatImages(uris: List<Uri>, messages: LinearLayout?, original: Boolean = false) { with(host) {
        val captured = pendingMediaTarget ?: return
        pendingMediaTarget = null; pendingMessages = null
        if (!captured.matches(activeConversationId, currentUserId, api.token) || !chatCanSend) { toast("会话或账号已切换，图片发送已取消"); return }
        val ordered = uris.filter { it.scheme == "content" }.distinct().take(PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS)
        if (ordered.isEmpty()) return
        stageDurableMedia(captured, ordered, "image", messages, original)
        } }

    fun prefetchPhotoUpload(batch: PhotoBatch, index: Int) { with(host) {
        val item = batch.items.getOrNull(index) ?: return
        if (item.upload != null || item.uploading != null || !photoBatchCurrent(batch)) return
        item.uploading = photoUploadExecutor.submit<JSONObject> {
            check(photoBatchCurrent(batch)) { "会话或账号已切换" }
            try {
                MediaUploadFiles.prepare(this, item.uri, "image").use { prepared ->
                    check(photoBatchCurrent(batch)) { "会话或账号已切换" }
                    ApiClient(batch.base).apply { token = item.target.token }.uploadMedia(prepared.file, "image", prepared.mime) { call ->
                        batch.uploadCalls[item.target.requestId] = call
                        if (!photoBatchCurrent(batch)) call.cancel()
                    }.put("name", prepared.displayName).also { uploaded ->
                        // Cache work is best effort and cannot turn a successful
                        // upload into a failed/duplicate send. The acknowledged
                        // user media grant is shared by HTTP/history/socket DTOs.
                        runCatching {
                            ChatImageCache.seedUploaded(this, batch.base + "|" + item.target.token.orEmpty(),
                                RouteManager.media(uploaded.getString("url"), batch.base), prepared.file) { photoBatchCurrent(batch) }
                        }
                    }
                }
            } finally { batch.uploadCalls.remove(item.target.requestId) }
        }
        } }

    fun drainPhotoBatch(batch: PhotoBatch) { with(host) {
        if (!photoBatchCurrent(batch)) { finishPhotoBatch(batch); return }
        if (batch.index >= batch.items.size) { finishPhotoBatch(batch, "${batch.items.size}张图片已发送"); return }
        val item = batch.items[batch.index]
        batch.progress.text = "正在发送第${batch.index + 1}/${batch.items.size}张图片 · 点击停止后续发送"
        batch.progress.contentDescription = batch.progress.text
        // Preparation/upload may overlap; message commits and acknowledgements
        // remain ordered, with each photo's original idempotency key.
        prefetchPhotoUpload(batch, batch.index)
        prefetchPhotoUpload(batch, batch.index + 1)
        mediaExecutor.execute {
            try {
                if (!photoBatchCurrent(batch)) { runOnUiThread { finishPhotoBatch(batch) }; return@execute }
                val uploaded = item.upload ?: requireNotNull(item.uploading).get().also { item.upload = it }
                runOnUiThread {
                    if (!photoBatchCurrent(batch)) { finishPhotoBatch(batch); return@runOnUiThread }
                    var accepted = false
                    sendCaptured(item.target, { client ->
                        client.sendMediaMessage(item.target.conversationId, "image", uploaded, item.target.requestId, item.target.replyToId).also { sent ->
                            check(sent.optInt("id") > 0 && sent.optInt("conversation_id") == item.target.conversationId && sent.optInt("sender_id") == item.target.userId) { "图片消息回执无效，请重试" }
                        }
                    }, settled = { if (!accepted) finishPhotoBatch(batch) }, state = { phase -> if (phase == SendPhase.ACCEPTED) accepted = true },
                        keepLabel = "停止后续发送", valid = { photoBatchCurrent(batch) }, captureCancel = { batch.cancelSend = it }) { sent ->
                        batch.cancelSend = null
                        batch.messages?.let { if (currentMessages === it) { addMessage(it, sent); postChatBottom(it, it.parent as? ScrollView) } }
                        batch.index++
                        drainPhotoBatch(batch)
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    if (!photoBatchCurrent(batch)) { finishPhotoBatch(batch); return@runOnUiThread }
                    if (item.upload == null) item.uploading = null
                    val failure = (error as? java.util.concurrent.ExecutionException)?.cause ?: error
                    val diagnosticCode = if (failure is ClientApiException) "ANDROID_PHOTO_UPLOAD_HTTP_${failure.status}" else "ANDROID_PHOTO_UPLOAD"
                    diagnostics.fault(diagnosticCode, failure.cause ?: failure)
                    batch.progress.text = "第${batch.index + 1}张图片上传失败，已发送${batch.index}张"
                    batch.failure = android.app.AlertDialog.Builder(this).setTitle("图片上传失败")
                        .setMessage("${error.cause?.message ?: error.message ?: "网络异常"}\n已发送${batch.index}张，重试会从当前图片继续。")
                        .setPositiveButton("重试当前图片") { _, _ -> batch.failure = null; drainPhotoBatch(batch) }
                        .setNegativeButton("停止后续发送") { _, _ -> finishPhotoBatch(batch) }
                        .setOnCancelListener { finishPhotoBatch(batch) }.create().also { it.show() }
                }
            }
        }
        } }

    fun stageDurableMedia(target: SendTarget, uris: List<Uri>, kind: String, messages: LinearLayout?, original: Boolean = false) { with(host) {
        val queue = mediaOutbox
        if (queue == null) { bindLocalOutboxes(retryMedia = true); toast("正在恢复本地待发附件，请稍后重新选择"); return }
        val base = apiBaseUrl
        if (target.matches(activeConversationId, currentUserId, api.token)) {
            chatLocateTarget = 0; chatNavigationRevision++
            currentMessages?.let { postChatBottom(it, it.parent as? ScrollView, force = true) }
        }
        if(kind=="image")rememberLocalPhotos(target,uris)
        val progress = text("正在保存待发附件…", 13f, PulseColors.muted).apply { gravity = Gravity.CENTER }
        if (kind != "image") messages?.addView(progress)
        groupUploads.add(target.requestId)
        outboxStageExecutor.execute {
            var saved = 0
            val staged = mutableListOf<DurableMediaOutbox.Entry>()
            try {
                uris.forEachIndexed { index, uri ->
                    check(api.token == target.token && currentUserId == target.userId && apiBaseUrl == base) { "账号已切换，已保存的附件会保留在原账号" }
                    val requestId = if(kind=="image")photoRequestId(target,index) else if (index == 0) target.requestId else "android-${java.util.UUID.randomUUID()}"
                    MediaUploadFiles.prepare(this, uri, kind, original = original).use { prepared ->
                        staged.add(queue.enqueue(requestId, target.conversationId, kind, prepared.mime, prepared.displayName, prepared.file,
                            if (index == 0) target.replyToId else 0, 0L, original))
                    }
                    saved++
                    runOnUiThread {
                        if (api.token == target.token && currentUserId == target.userId && apiBaseUrl == base) {
                            if (index == 0) durableReplyRevisions[requestId] = target.replyRevision
                            currentMessages?.let { renderPendingMediaMessages(it) }
                        }
                    }
                }
            } catch (error: Exception) {
                diagnostics.fault("ANDROID_LOCAL_MEDIA_STAGE", error)
                runOnUiThread { if (api.token == target.token && currentUserId == target.userId) toast("已保存${saved}个附件，其余未入队：${error.message ?: "请检查存储空间"}") }
            } finally {
                if (!target.matches(activeConversationId, currentUserId, api.token) || apiBaseUrl != base || !appForeground || !chatCanSend) {
                    staged.forEach { entry -> runCatching { queue.fail(entry, "附件已保存，请确认后重试", 0L) } }
                }
                runOnUiThread {
                    if(kind=="image") {
                        val savedIds=staged.map{it.requestId}.toSet()
                        localPhotoSources.entries.removeAll{it.value.batch==target.requestId && it.key !in savedIds}
                    }
                    (progress.parent as? ViewGroup)?.removeView(progress); groupUploads.remove(target.requestId)
                    if (queue === mediaOutbox) { currentMessages?.let { renderPendingMediaMessages(it) }; drainMediaOutbox() }
                }
            }
        }
        } }

    fun uploadChatMedia(uri: Uri, kind: String, messages: LinearLayout?) { with(host) {
        val target = pendingMediaTarget ?: return
        pendingMediaTarget = null; pendingMessages = null
        if (!target.matches(activeConversationId, currentUserId, api.token)) { toast("会话或账号已切换，文件发送已取消"); return }
        stageDurableMedia(target, listOf(uri), kind, messages)
        } }

    fun recordingAppearance(button: View, active: Boolean) { with(host) {
        if (button is TextView) button.text = if (active) "停止" else "录音"
        else if (button is ViewGroup) {
            (button.getChildAt(0) as? ChatStyleIconView)?.iconColor = if (active) PulseColors.danger else Color.BLACK
            (button.getChildAt(0) as? IOSGroupGlyph)?.let { glyph -> glyph.kind = if (active) "stop" else "mic"; glyph.tint = if (active) PulseColors.danger else IOSGroupChatStyle.blue; glyph.invalidate() }
        }
        button.contentDescription = if (active) "停止录音并发送" else "录制语音"
        run {
            val typing = !findViewById<EditText>(R.id.chat_message_input)?.text.isNullOrBlank() && !active
            findViewById<View>(R.id.chat_message_send)?.visibility = if (typing) View.VISIBLE else View.GONE
            button.visibility = View.VISIBLE
        }
        } }

    fun toggleRecording(button: View) { with(host) {
        if (recorder != null) { stopRecording(button); return }
        if (mediaOutbox == null) { bindLocalOutboxes(retryMedia = true); toast("正在恢复本地待发附件，请稍后再录音"); return }
        if (!appForeground || appLock.locked || !chatCanSend || recordingReleasePending || pendingVoice != null || groupUploads.isNotEmpty() || pendingSendAcks.isNotEmpty() || pendingMediaTarget != null || textSends?.pending(api.token, currentUserId, apiBaseUrl, activeConversationId)?.isNotEmpty() == true) { toast("请先完成当前发送或重试"); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 40); toast("请允许麦克风权限，然后再次点击录音"); return }
        val target = captureSendTarget() ?: return
        val messages = currentMessages ?: return
        try {
            recordingTarget = target; recordingFile = File(cacheDir, "pulse-voice-${java.util.UUID.randomUUID()}.m4a")
            recordingBase = apiBaseUrl; recordingMessages = messages; recordingButton = button
            val created = VoiceRecording.create(this)
            recorder = created
            created.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC); setOutputFormat(MediaRecorder.OutputFormat.MPEG_4); setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(1); setAudioEncodingBitRate(64000); setAudioSamplingRate(44100); setOutputFile(recordingFile!!.absolutePath)
                setMaxDuration((VoiceRecording.MAX_DURATION_MS + 1000).toInt())
                setOnErrorListener { source, _, _ -> if (recorder === source) cancelVoiceRecording("录音中断，请重新录制") }
                setOnInfoListener { source, what, _ -> if (recorder === source && what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) stopRecording(button, holdForConfirmation = true) }
                prepare(); start()
            }
            recordingStartedAt = android.os.SystemClock.elapsedRealtime(); recordingAppearance(button, true)
            recordingTimeout = Runnable { if (recorder === created) stopRecording(button, holdForConfirmation = true) }.also { messageHandler.postDelayed(it, VoiceRecording.MAX_DURATION_MS) }
        } catch (e: Exception) { cancelVoiceRecording(); toast(e.message ?: "无法开始录音") }
        } }

    fun cancelVoiceRecording(message: String? = null) { with(host) {
        val captured = recorder; val file = recordingFile; recorder = null
        recordingTimeout?.let { messageHandler.removeCallbacks(it) }; recordingTimeout = null
        file?.delete(); recordingFile = null; recordingTarget = null; recordingMessages = null; recordingBase = ""; recordingStartedAt = 0
        recordingButton?.let { if (it.isAttachedToWindow) recordingAppearance(it, false) }; recordingButton = null
        if (captured != null) releaseVoiceRecorder(captured, file, stopFirst = true)
        if (message != null && appForeground && !appLock.locked) toast(message)
        } }

    fun releaseVoiceRecorder(captured: MediaRecorder, cancelledFile: File? = null, stopFirst: Boolean = false) { with(host) {
        recordingReleasePending = true
        // Scope is already invalid or stop completed. This serial queue never holds
        // the UI lifecycle on device audio-service Binder cleanup.
        voiceCleanupExecutor.execute {
            try { if (stopFirst) runCatching { captured.stop() }; runCatching { captured.release() } }
            finally { cancelledFile?.delete(); recordingReleasePending = false }
        }
        } }

    fun stopRecording(button: View, holdForConfirmation: Boolean = false) { with(host) {
        val captured = recorder ?: return
        val target = recordingTarget; val elapsed = android.os.SystemClock.elapsedRealtime() - recordingStartedAt
        val file = recordingFile; val messages = recordingMessages; val base = recordingBase
        recorder = null; recordingFile = null; recordingTarget = null; recordingMessages = null; recordingBase = ""; recordingStartedAt = 0; recordingButton = null
        recordingTimeout?.let { messageHandler.removeCallbacks(it) }; recordingTimeout = null
        val stopped = try { captured.stop(); true } catch (_: Exception) { false } finally { releaseVoiceRecorder(captured); recordingAppearance(button, false) }
        if (!stopped || file == null || target == null || messages == null) { file?.delete(); toast("录音未完成，请重新录制"); return }
        if (!target.matches(activeConversationId, currentUserId, api.token) || apiBaseUrl != base || currentMessages !== messages || !appForeground || appLock.locked) { file.delete(); return }
        val duration = try { VoiceRecording.checkedDuration(file, elapsed) } catch (error: Exception) { file.delete(); toast(error.message ?: "录音内容无效，请重新录制"); return }
        val pending = PendingVoice(target, base, messages, file, duration, needsConfirmation = holdForConfirmation)
        pendingVoice = pending
        uploadPendingVoice(pending)
        } }

    fun pendingVoiceCurrent(pending: PendingVoice): Boolean = with(host) {
        pendingVoice === pending && pending.target.matches(activeConversationId, currentUserId, api.token) &&
        apiBaseUrl == pending.base && currentMessages === pending.messages && pending.messages.isAttachedToWindow && appForeground && !appLock.locked && !isFinishing && !isDestroyed
    }

    fun discardPendingVoice(explicit: Boolean = false) { with(host) {
        val pending = pendingVoice ?: return
        if (explicit) pending.cancelRequested = true
        pendingVoice = null; pending.cancelSend?.invoke(); pending.cancelSend = null
        if (!pending.busy) pending.file.delete()
        groupUploads.remove(pending.target.requestId); renderPendingVoice()
        } }

    fun renderPendingVoice() { with(host) {
        val bar = voicePendingBar ?: return
        bar.removeAllViews()
        val pending = pendingVoice?.takeIf { pendingVoiceCurrent(it) }
        bar.visibility = if (pending == null) View.GONE else View.VISIBLE
        if (pending == null) return
        bar.addView(row().apply {
            setPadding(dp(10), dp(5), dp(8), dp(5)); setBackgroundColor(IOSGroupChatStyle.surface())
            addView(text(if (pending.busy) { if (pending.uploaded == null) "正在上传语音…" else "正在发送语音…" } else pending.error.ifBlank { "语音待发送" }, 13f, PulseColors.muted).apply { id = R.id.voice_pending_status; maxLines = 2 }, LinearLayout.LayoutParams(0, -2, 1f))
            if (!pending.busy) addView(smallAction(if (pending.needsConfirmation) "发送" else "重试") { if (chatCanSend && pendingVoiceCurrent(pending)) { pending.needsConfirmation = false; uploadPendingVoice(pending) } }.apply { id = R.id.voice_pending_retry; isEnabled = chatCanSend; contentDescription = if (pending.needsConfirmation) "发送已完成的语音" else "重试发送同一语音" })
            addView(smallAction("取消") { if (pendingVoice === pending) discardPendingVoice(explicit = true) }.apply { id = R.id.voice_pending_cancel; contentDescription = "取消待发送语音" })
        })
        } }

    fun uploadPendingVoice(pending: PendingVoice) { with(host) {
        if (!chatCanSend || !pendingVoiceCurrent(pending) || pending.busy) return
        val queue = mediaOutbox
        if (queue == null) { bindLocalOutboxes(retryMedia = true); pending.error = "正在恢复本地附件队列，请稍后重试"; renderPendingVoice(); return }
        chatLocateTarget = 0; chatNavigationRevision++
        currentMessages?.let { postChatBottom(it, it.parent as? ScrollView, force = true) }
        pending.busy = true; pending.error = ""; renderPendingVoice()
        groupUploads.add(pending.target.requestId)
        outboxStageExecutor.execute {
            try {
                val entry = queue.enqueue(pending.target.requestId, pending.target.conversationId, "voice", "audio/mp4", "语音.m4a", pending.file, pending.target.replyToId, pending.durationMs)
                if (pending.cancelRequested) { queue.discard(entry); pending.file.delete(); return@execute }
                if (pending.needsConfirmation || !pendingVoiceCurrent(pending)) queue.fail(entry, if (pending.needsConfirmation) "录音已达上限，请确认后发送" else "语音已保存，请确认后重试")
                pending.file.delete()
                runOnUiThread {
                    if (pending.cancelRequested) { AndroidOutboxStorage.mediaDisk.execute { runCatching { queue.discard(entry) } }; return@runOnUiThread }
                    if (pendingVoice === pending) { pendingVoice = null; renderPendingVoice() }
                    if (queue === mediaOutbox) {
                        durableReplyRevisions[entry.requestId] = pending.target.replyRevision
                        currentMessages?.let { renderPendingMediaMessages(it) }
                        drainMediaOutbox()
                    }
                }
            } catch (error: Exception) { runOnUiThread { pending.busy = false; pending.error = "语音本地保存失败，请检查存储空间后重试"; if (pendingVoice === pending) renderPendingVoice(); diagnostics.fault("ANDROID_LOCAL_VOICE_STAGE", error) } }
            finally { runOnUiThread { groupUploads.remove(pending.target.requestId) } }
        }
        } }

    fun sendPendingVoice(pending: PendingVoice) { with(host) {
        if (!pendingVoiceCurrent(pending)) return
        if (!chatCanSend) { pending.busy = false; pending.error = "已禁止发言"; renderPendingVoice(); return }
        val upload = pending.uploaded ?: return
        renderPendingVoice()
        sendCaptured(pending.target, { frozen -> frozen.sendVoice(pending.target.conversationId, upload.getString("url"), pending.durationMs, pending.file.length(), pending.target.requestId, pending.target.replyToId) }, settled = {
            pending.busy = false; pending.cancelSend = null
            if (pendingVoice === pending) { if (pendingVoiceCurrent(pending)) { pending.error = "语音尚未发送，点击重试"; renderPendingVoice() } else discardPendingVoice() }
        }, keepLabel = "保留语音", valid = { pendingVoiceCurrent(pending) }, captureCancel = { pending.cancelSend = it }) { sent ->
            if (pendingVoiceCurrent(pending)) { addMessage(pending.messages, sent); pendingVoice = null; pending.file.delete(); renderPendingVoice() }
        }
        } }

    fun acceptPickedMedia(uris: List<Uri>, kind: String, original: Boolean) { with(host) {
        val target = pendingMediaTarget
        if (target == null || !target.matches(activeConversationId, currentUserId, api.token) || pendingMediaBase != apiBaseUrl) {
            pendingMediaTarget = null; pendingMessages = null
            toast("会话或账号已变化，请重新选择附件")
            return
        }
        // onActivityResult arrives before onResume. Refresh the conversation
        // first, then stage exactly once using the original account and target.
        pickedMedia = PickedMedia(target, pendingMediaBase, uris.toList(), kind, original)
        if(kind=="image")rememberLocalPhotos(target,uris)
        drainPickedMedia()
        } }

    fun drainPickedMedia() { with(host) {
        val picked = pickedMedia ?: return
        if (pendingMediaTarget !== picked.target || picked.base != apiBaseUrl || !picked.target.matches(activeConversationId, currentUserId, api.token)) {
            pendingMediaTarget = null; pendingMessages = null
            toast("会话或账号已变化，附件发送已取消")
            return
        }
        if (!appForeground || foregroundOwner !== this || appLock.locked || isFinishing || isDestroyed ||
            (BuildConfig.GO_BACKEND && (goChatInvalidated || goChatRevalidate || goRefreshRunning))) return
        if (!chatCanSend) {
            if (chatSendDisabledReason != "loading") {
                pendingMediaTarget = null; pendingMessages = null
                toast("当前会话没有发送权限，附件发送已取消")
            }
            return
        }
        if (mediaOutbox == null) return
        pickedMedia = null
        if (picked.kind == "image") uploadChatImages(picked.uris, currentMessages, picked.original)
        else uploadChatMedia(picked.uris.first(), picked.kind, currentMessages)
        } }
}
