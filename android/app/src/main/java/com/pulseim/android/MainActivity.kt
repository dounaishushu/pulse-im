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
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import com.google.zxing.common.BitMatrix
import com.google.zxing.integration.android.IntentIntegrator
import com.google.zxing.integration.android.IntentResult

private object PulseColors {
    const val background = 0xFFF5F7F8.toInt()
    const val surface = 0xFFFFFFFF.toInt()
    const val ink = 0xFF18242D.toInt()
    const val muted = 0xFF7B8790.toInt()
    const val accent = 0xFF159A78.toInt()
    const val accentSoft = 0xFFE3F5EE.toInt()
    const val line = 0xFFE7ECEE.toInt()
    const val danger = 0xFFE45A5A.toInt()
}

class MainActivity : Activity() {
    companion object { private var foregroundOwner: MainActivity? = null }
    private val executor = Executors.newSingleThreadExecutor()
    private val imageExecutor = Executors.newFixedThreadPool(3)
    private val chatImageViewport = ChatImageViewport()
    private val mediaExecutor = Executors.newSingleThreadExecutor()
    private val outboxStageExecutor = Executors.newSingleThreadExecutor()
    private val photoUploadExecutor = Executors.newFixedThreadPool(2)
    private val voiceCleanupExecutor = Executors.newSingleThreadExecutor { task -> Thread(task, "pulse-voice-release") }
    private val messageExecutor = Executors.newFixedThreadPool(2)
    // Interactive moderation must not queue behind account, route or history requests.
    private val messageActionExecutor = Executors.newFixedThreadPool(2)
    private val pendingMessageRecalls = mutableSetOf<Triple<String, Int, Int>>()
    private val contactsExecutor = Executors.newFixedThreadPool(2)
    private val chatLoadExecutor = Executors.newFixedThreadPool(2)
    private val sendExecutor = Executors.newSingleThreadExecutor()
    private val textExecutor = Executors.newFixedThreadPool(2)
    private val receiptExecutor = Executors.newSingleThreadExecutor()
    private val badgeExecutor = Executors.newSingleThreadExecutor()
    private var badgeRefreshRunning = false
    private var badgeRefreshQueued = false
    private var badgeRefreshGeneration = 0L
    private var lastBadgeRefreshAt = 0L
    private val badgeRefresh = Runnable { refreshNavigationBadges(force = true) }
    private val pageBackSwipe = PageBackTouchDispatcher()
    private val messageHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val conversationReads = ConversationReadState()
    private val receiptWork = Runnable { drainConversationReads() }
    private var receiptRetryAt = 0L
    private var receiptFailures = 0
    private val pendingSendAcks = mutableMapOf<String, (JSONObject) -> Unit>()
    private var textSends = TextSendQueue()
    private var mediaOutbox: DurableMediaOutbox? = null
    private var localOutboxOwner: String? = null
    private var failedOutboxOwner: String? = null
    private var nextOutboxRestoreAt = 0L
    private var localOutboxesReady = false
    private val pendingDurableAcks = linkedMapOf<String, JSONObject>()
    private val durableReplyRevisions = mutableMapOf<String, Long>()
    private val ownedMediaAttempts = mutableMapOf<String, Triple<DurableMediaOutbox, DurableMediaOutbox.Entry, Long>>()
    private val mediaSendRequests = java.util.concurrent.ConcurrentHashMap<String, ApiRequestScope>()
    private val ownedTextAttempts = mutableMapOf<String, Triple<TextSendQueue, TextSendQueue.Entry, Long>>()
    private var localSessionOnly = false
    private var localSessionCheck = false
    private var nextLocalSessionCheck = 0L
    private val directoryExecutor = Executors.newSingleThreadExecutor()
    private data class DirectoryViewCapture(val home: ChatHomeView?, val revision: Int, val contacts: ContactsView?, val version: Int)
    private val directoryViews = mutableMapOf<LocalAccountStore.Ticket, DirectoryViewCapture>()
    private fun localAccount(): LocalDirectorySync.Account? = if (::api.isInitialized && currentUserId > 0 && !api.token.isNullOrBlank() && !isDestroyed)
        LocalDirectorySync.Account(apiBaseUrl, currentUserId, api.token!!) else null
    private val localDirectories by lazy {
        LocalDirectorySync(this, directoryExecutor, ::localAccount,
            fetch = { owner, kind, page ->
                val client = ApiClient(owner.endpoint).apply { token = owner.token }
                when (kind) {
                    LocalDirectoryStore.Kind.CHATS -> client.chatPage(page)
                    LocalDirectoryStore.Kind.CONTACTS -> client.contactsPage(page)
                    LocalDirectoryStore.Kind.REQUESTS -> client.friendRequestsPage(page)
                    LocalDirectoryStore.Kind.GROUPS -> client.conversationsPage("group", page)
                    LocalDirectoryStore.Kind.CHANNELS -> client.conversationsPage("channel", page)
                }
            }, completed = { owner, kind, snapshot ->
                runOnUiThread {
                    val ticket = snapshot.requestTicket
                    val capture = directoryViews.remove(ticket)
                    if (localAccount() == owner && ticket != null && LocalAccountStore.current(ticket)) {
                        if (kind == LocalDirectoryStore.Kind.CHATS) snapshot.items.forEach { it.optJSONObject("last_message")?.let(::acknowledgeDurableMessage) }
                        if (kind == LocalDirectoryStore.Kind.CHATS) retainedChatHome?.takeIf { retains(it) }?.let { home ->
                            if (capture?.home === home) home.acceptCompleteSnapshot(snapshot.toResult(), capture.revision)
                            else home.restoreLocalSnapshot(snapshot.toResult())
                        }
                        retainedContacts?.takeIf { retains(it) && directoryKind(it.page) == kind }?.let { view ->
                            if (capture?.contacts === view) view.acceptCompleteSnapshot(snapshot.toResult(), capture.version)
                            else view.restoreLocalSnapshot(snapshot.toResult())
                        }
                        if (kind == LocalDirectoryStore.Kind.CONTACTS) contactNames.seed(ContactNameDirectory.Scope(owner.endpoint, owner.token, owner.userId), snapshot.items)
                    }
                }
            }, failed = { _, _, error -> diagnostics.fault("ANDROID_LOCAL_DIRECTORY_SYNC", error) },
            started = { _, kind, ticket ->
                directoryViews.keys.removeAll { it.scope == ticket.scope && it.namespace == ticket.namespace }
                val home = retainedChatHome?.takeIf { retains(it) }
                val contacts = retainedContacts?.takeIf { retains(it) && directoryKind(it.page) == kind }
                directoryViews[ticket] = DirectoryViewCapture(home, home?.realtimeRevision ?: 0, contacts, contacts?.version ?: 0)
            }, startOn = { action -> runOnUiThread { action() } })
    }
    private fun refreshLocalDirectories(force: Boolean = false) {
        if (!::api.isInitialized || currentUserId <= 0 || api.token.isNullOrBlank() || isDestroyed) return
        localDirectories.refresh(force)
    }
    private fun directoryKind(page: ContactsView.Page): LocalDirectoryStore.Kind? = when (page) {
        ContactsView.Page.CONTACTS -> LocalDirectoryStore.Kind.CONTACTS
        ContactsView.Page.REQUESTS -> LocalDirectoryStore.Kind.REQUESTS
        ContactsView.Page.GROUPS -> LocalDirectoryStore.Kind.GROUPS
        ContactsView.Page.CHANNELS -> LocalDirectoryStore.Kind.CHANNELS
        ContactsView.Page.SEARCH -> null
    }
    private data class InboxNotice(val token: String, val userId: Int, val base: String, var messageId: Int, var loading: Boolean = false)
    private val inboxNotices = mutableMapOf<Int, InboxNotice>()
    private data class FriendChatWork(val token: String, val actor: Int, val base: String)
    private var friendChatWork: FriendChatWork? = null
    private var friendChatQueued = false
    private var friendChatPending: Pair<FriendChatWork, JSONObject>? = null
    private val friendChatExecutor = Executors.newSingleThreadExecutor()
    private fun friendChatKey(work: FriendChatWork) = "friend_chat_v1:${Uri.encode(work.base)}:${work.actor}"
    private fun friendChatCurrent(work: FriendChatWork) = ::api.isInitialized && api.token == work.token && currentUserId == work.actor && apiBaseUrl == work.base && !isFinishing && !isDestroyed
    private fun friendChatCanSync() = appForeground && foregroundOwner === this && !appLock.locked
    private fun friendChatAllowed() = appForeground && foregroundOwner === this && !appLock.locked && recorder == null && photoBatch == null && pendingMediaTarget == null && groupUploads.isEmpty()

    // Socket hints and the foreground timer use one account-scoped, durable cursor.
    private fun refreshFriendChats(event: JSONObject? = null) {
        if (!::api.isInitialized) return
        val token = api.token ?: return
        if (currentUserId <= 0) return
        val owner = FriendChatWork(token, currentUserId, apiBaseUrl)
        if (event != null && event.optLong("id") > 0) {
            val old = friendChatPending
            if (old == null || old.first != owner || old.second.optLong("id") < event.optLong("id")) friendChatPending = owner to event
        }
        if (!friendChatCanSync()) return
        if (friendChatWork == owner) { friendChatQueued = true; return }
        friendChatWork = owner
        friendChatQueued = false
        val offered = friendChatPending?.takeIf { it.first == owner }?.second
        if (offered != null) friendChatPending = null
        val cursor = preferences.getLong(friendChatKey(owner), 0L)
        val home = chatHome
        val homeRevision = home?.realtimeRevision ?: 0
        friendChatExecutor.execute {
            var incoming: JSONObject? = null
            var conversation: JSONObject? = null
            var list: JSONObject? = null
            try {
                val client = ApiClient(owner.base).apply { this.token = owner.token }
                val rows = if (offered != null) JSONArray().put(offered) else client.friendChats(cursor)
                incoming = (0 until rows.length()).mapNotNull { rows.optJSONObject(it) }
                    .filter { it.optLong("id") > cursor && it.optInt("conversation_id") > 0 && it.optInt("peer_user_id") > 0 }
                    .maxByOrNull { it.optLong("id") }
                incoming?.let { hint ->
                    // Refresh every newly accepted friend, not only the newest
                    // chat selected for navigation. This also runs while busy.
                    list = client.chatPage(1)
                    conversation = client.conversationInfo(hint.getInt("conversation_id"))
                    check(conversation?.optString("type") == "direct" && conversation?.optInt("id") == hint.getInt("conversation_id") && conversation?.optInt("peer_user_id") == hint.getInt("peer_user_id")) { "Invalid friend conversation" }
                }
            } catch (_: Exception) { conversation = null }
            val hint = incoming; val chat = conversation; val refreshed = list
            runOnUiThread {
                if (friendChatWork !== owner) return@runOnUiThread
                friendChatWork = null
                if (!friendChatCurrent(owner)) { friendChatQueued = false; return@runOnUiThread }
                if (refreshed != null) {
                    if (home != null && chatHome === home && home.isAttachedToWindow) {
                        val rows = refreshed.optJSONArray("items") ?: JSONArray()
                        for (i in 0 until rows.length()) {
                            val row = rows.getJSONObject(i)
                            row.put("unread_count", conversationReads.unread(row.optInt("id"), row.optJSONObject("last_message")?.optInt("id") ?: 0, row.optInt("unread_count")))
                        }
                        home.mergeFriendConversations(refreshed, homeRevision)
                    } else chatHome?.takeIf { it.isAttachedToWindow }?.let { loadChatPage(it, 1) }
                }
                if (hint != null && chat != null && hint.optLong("id") > preferences.getLong(friendChatKey(owner), 0L)) {
                    if (friendChatAllowed()) {
                        if (activeConversationId != chat.optInt("id") || currentMessages == null) showChat(currentNickname, openConversation = chat)
                        preferences.edit().putLong(friendChatKey(owner), hint.getLong("id")).apply()
                        scheduleNavigationBadges()
                    } else friendChatPending = owner to hint
                }
                if (friendChatQueued) { friendChatQueued = false; refreshFriendChats() }
            }
        }
    }
    private val foregroundMessageCheck = object : Runnable {
        override fun run() {
            if (!appForeground || isFinishing || isDestroyed) return
            if (::api.isInitialized && api.token != null && !appLock.locked) {
                socket?.ensureConnected()
                bindLocalOutboxes()
                if (localSessionOnly) verifyLocalSession()
                refreshLocalDirectories()
                contactNames.refresh()
                drainConversationReads()
                refreshNavigationBadges()
                refreshFriendChats()
                // Group mute expiry has no socket event; refresh its authoritative
                // permission while the current chat is visible, even with WS alive.
                if (activeConversationType == "group") refreshGroupMetadata()
                if (socket?.authenticated != true) {
                    refreshCurrentMessages(allowUnsubscribed = true)
                    chatHome?.takeIf { it.isAttachedToWindow }?.let { loadChatPage(it, 1) }
                    contactsView?.scheduleConversationRefresh()
                }
            }
            messageHandler.postDelayed(this, 5000)
        }
    }
    private lateinit var api: ApiClient
    private lateinit var apiBaseUrl: String
    private val preferences by lazy { getSharedPreferences("pulse_im_session", MODE_PRIVATE) }
    private val accountSessions by lazy { AccountSessions(this, if(BuildConfig.GO_BACKEND) apiBaseUrl else null) }
    private val diagnostics by lazy { ClientDiagnostics.get(this) }
    private var myFeature: MyFeature? = null
    private var socket: SocketClient? = null
    private var routeObserver: (() -> Unit)? = null
    private lateinit var root: LinearLayout
    private lateinit var content: LinearLayout
    private class ChatEntry(val id: Int, val actor: Int, val token: String, val base: String) {
        val calls = ApiRequestScope()
        val page = java.util.concurrent.CompletableFuture<ChatHistoryPage>()
        lateinit var view: View
        var localVisible = false
        var transitioning = false
        @Volatile var cached: LocalChatStore.Page? = null
        @Volatile var failure: Throwable? = null
    }
    private var pendingChatEntry: ChatEntry? = null
    private var preparedChatHistory: ChatEntry? = null
    private var activeHistoryRequests: ApiRequestScope? = null
    private fun cancelPendingChatEntry() {
        pendingChatEntry?.let { it.calls.cancel(); it.page.cancel(false) }; pendingChatEntry = null
    }
    private fun cancelChatHistory() {
        activeHistoryRequests?.cancel(); activeHistoryRequests = null
        preparedChatHistory?.let { it.calls.cancel(); it.page.cancel(false) }; preparedChatHistory = null
    }
    private var activeConversationId = 0
        set(value) {
            if (field != value) {
                flushChatDraft(detach = true)
                activeHistoryRequests?.cancel(); activeHistoryRequests = null
                trimLiveMessages = null
                clearMessageSelection()
                messageSelectionBar = null
                endGroupAnnouncementEntry()
                pendingSendAcks.clear()
                contactProfileDialog?.dismiss()
                if (field > 0) socket?.unsubscribe(field)
                replyMessage = null; replyRevision++; replyPreview = null
                pinnedMessages.clear(); pinBar = null; pinRevision++; pinReadRequest++; pinIndex = 0
                chatCanPin = false
                chatLocateTarget = 0; chatNavigationRevision++
                directConversationModel = null; directMutation = null; shakeInFlight = null
            }
            field = value
        }
    private var replyMessage: JSONObject? = null
    private var replyRevision = 0L
    private var replyPreview: LinearLayout? = null
    private var pinBar: LinearLayout? = null
    private val pinnedMessages = mutableListOf<JSONObject>()
    private var pinRevision = 0L
    private var pinReadRequest = 0L
    private var pinIndex = 0
    @Volatile private var chatCanSend = true
    private var chatSendDisabledReason = ""
    private var chatComposerRestricted = false
    private var chatComposerDraft: CharSequence? = null
    private var chatComposerSelection = 0
    private var chatComposerSelectionEnd = 0
    private val chatDraftStore by lazy { ChatDraftStore(this) }
    private val chatDraftWorker = Executors.newSingleThreadExecutor()
    private class DraftEditor(val owner: ChatDraftStore.Owner, val input: EditText, var reference: JSONObject? = null) {
        var lastSaved: String? = null
        var revision = 0L
        var readable = true
        var warned = false
        var pending = false
    }
    private var chatDraftEditor: DraftEditor? = null
    private var chatDraftChanging = false
    private val saveChatDraft = Runnable { persistChatDraft(synchronous = false) }
    private var chatEmojiPopup: PopupWindow? = null
    private var chatCanPin = false
    private var groupInfoSheet: GroupInfoSheet? = null
    private var groupEditSheet: GroupProfileEditSheet? = null
    private var groupPickerSheet: GroupMemberPickerSheet? = null
    private var groupMedia: GroupMessageMedia? = null
    private var messageCardDialog: android.app.Dialog? = null
    private var messageCardRevision = 0L
    private var groupMetadataRequest = 0L
    private var groupMetadataInFlight: GroupProfileOrigin? = null
    private var groupMetadataQueued = false
    private var groupAnnouncement: GroupAnnouncementUi? = null
    private var groupForegroundRevision = 0L
    private var groupViewerCanManage = false
    private var groupViewerCanViewProfiles = false
    private var groupMentionPicker: GroupMentionPicker? = null
    private var groupMentionRole = ""
    private var groupProfileRequest = 0L
    private val groupUploads = mutableSetOf<String>()
    private data class GroupProfileOrigin(val groupId: Int, val userId: Int, val token: String, val base: String, val entry: GroupAnnouncementUi, val messages: LinearLayout, val foreground: Long)
    private data class GroupMemberProfileScope(val origin: GroupProfileOrigin, val peerId: Int, val client: ApiClient, val dialog: android.app.Dialog, val view: ContactProfileView, var revision: Long = 0, var pending: Boolean = false, var requestSent: Boolean = false)
    private var groupMemberProfileScope: GroupMemberProfileScope? = null
    private data class FavoriteKey(val userId: Int, val token: String, val endpoint: String, val messageId: Int)
    private val favoriteRequests = mutableMapOf<FavoriteKey, String>()
    private val favoriteInFlight = mutableMapOf<FavoriteKey, String>()
    private var chatLocateTarget = 0
    private var chatNavigationRevision = 0L
    private var chatAttachmentPanel: View? = null
    private var chatInputDock: LinearLayout? = null
    private var directPeerName = ""
    private val contactNames by lazy {
        ContactNameDirectory(
            context = { if (::api.isInitialized && currentUserId > 0 && !api.token.isNullOrBlank() && appForeground && !appLock.locked)
                ContactNameDirectory.Scope(apiBaseUrl, api.token!!, currentUserId) else null },
            executor = executor, ui = { work -> runOnUiThread { work() } },
            fetch = { scope, page -> ApiClient(scope.base).apply { token = scope.token }.contactNamePage(page) },
            changed = {
                ContactNameLabels.refresh(window.decorView, ::contactDisplayName)
                retainedChatHome?.takeIf { retains(it) }?.refreshContactNames()
                groupInfoSheet?.refreshContactNames()
                directConversationModel?.takeIf { activeConversationType == "direct" }?.let { model ->
                    directPeerName = contactDisplayName(model.optInt("peer_user_id"), jsonText(model, "name"))
                }
            })
    }
    private fun contactDisplayName(userId: Int, fallback: String): String =
        if (userId == currentUserId) currentNickname.ifBlank { fallback } else contactNames.resolve(userId, fallback)
    private var directPeerAvatar = ""
    private var directConversationModel: JSONObject? = null
    private var directMutation: SendTarget? = null
    private var shakeInFlight: SendTarget? = null
    private var contactCardPicker: ContactCardPicker? = null
    private var contactCardSendCancel: (() -> Unit)? = null
    private var contactCardForegroundRevision = 0L
    private data class NotificationSetting(val muted: Boolean, val revision: Long)
    private val notificationSettings = mutableMapOf<Int, NotificationSetting>()
    private var notificationSettingsToken: String? = null
    private var notificationSettingsRevision = 0L
    private var contactProfileDialog: android.app.Dialog? = null
    private data class ContactProfileScope(val dialog: android.app.Dialog, val view: ContactProfileView, val target: SendTarget, val base: String, val peerId: Int, val client: ApiClient, var profile: JSONObject, var notificationsEnabled: Boolean, var pending: Boolean = false, var revision: Long = 0)
    private var contactProfileScope: ContactProfileScope? = null
    private var contactGroupChild = false
    private var nestedContactChat = false
    private var activeConversationType = ""
    private var pendingOpenConversationId = 0
    private var conversationList: LinearLayout? = null
    private var currentNickname = "用户"
    private var currentUsername = ""
    private var currentUserId = 0
    private var currentInternalStaff = false
    private var messageMenuPermissionRevision = 0L
    private var exploreLinks = JSONArray()
    private var exploreVisible = false
    private var explorePanel: ExplorePanel? = null
    private data class ForceAddKey(val actor: Int, val token: String, val base: String, val peer: Int)
    private val forceAddInFlight = mutableSetOf<ForceAddKey>()
    private var forceAddRevision = 0L
    private var surfaceRevision = 0L
    private var forceAddedProfile: ForceAddedContactProfile? = null
    private var taskRoleBadge: TextView? = null
    private var taskVerificationDialog: android.app.Dialog? = null
    private var taskPageGeneration = 0
    private var taskChildActive = false
    private var workQuestionImagePanel: QuestionImagePanel? = null
    private var tasksVisible = false
    private var taskHeader: View? = null
    private var taskNavigation: View? = null
    private var taskSettlementDialog: android.app.Dialog? = null
    private var recorder: MediaRecorder? = null
    @Volatile private var recordingReleasePending = false
    private var recordingStartedAt = 0L
    private var recordingFile: File? = null
    private var recordingBase = ""
    private var recordingMessages: LinearLayout? = null
    private var recordingButton: View? = null
    private var recordingTimeout: Runnable? = null
    private data class PendingVoice(val target: SendTarget, val base: String, val messages: LinearLayout, val file: File, val durationMs: Long,
        var uploaded: JSONObject? = null, var busy: Boolean = false, var error: String = "", var cancelSend: (() -> Unit)? = null, var needsConfirmation: Boolean = false, @Volatile var cancelRequested: Boolean = false)
    private var pendingVoice: PendingVoice? = null
    private var voicePendingBar: LinearLayout? = null
    private var currentMessages: LinearLayout? = null
    private var trimLiveMessages: ((LinearLayout) -> Unit)? = null
    private val currentMessageData = sortedMapOf<Int, JSONObject>()
    private var choosingMessages = false
    private val selectedMessageIds = linkedSetOf<Int>()
    private var messageSelectionBar: LinearLayout? = null
    private var messageForwardDialog: android.app.Dialog? = null
    private var messageActionMenu: MessageActionMenu? = null
    private var messageDeleteDialog: android.app.AlertDialog? = null
    private val messageVersions = MessageVersionGuard<JSONObject>()
    private val replyVisibility = ReplyVisibilityState()
    private var messageVersionToken: String? = null
    private var chatHistoryReady = false
    private var retryInitialHistory: (() -> Unit)? = null
    private var chatLoadedFloor = 1
    private var chatClearedBefore = 0
    private var chatSocketEpoch = 0
    private var chatSubscribedEpoch = -1
    private var chatSynchronizedEpoch = -1
    @Volatile private var activeMessageRecovery: ChatRecovery? = null
    private data class ChatRecovery(val container: LinearLayout, val conversationId: Int, val userId: Int, val token: String, val socket: SocketClient?, val epoch: Int, val floor: Int, val accumulator: ConversationRecovery<JSONObject>)
    private var pendingMediaKind = "file"
    private var pendingMessages: LinearLayout? = null
    private var authView: AuthFlowView? = null
    private var contactsView: ContactsView? = null
    private var chatReturnPage: ContactsView.Page? = null
    private var chatHome: ChatHomeView? = null
    private data class HomeTabAccount(val userId: Int, val token: String?, val base: String)
    private var homeTabAccount: HomeTabAccount? = null
    private var retainedChatHome: ChatHomeView? = null
    private var retainedContacts: ContactsView? = null
    private fun currentHomeTabAccount() = HomeTabAccount(currentUserId, api.token, apiBaseUrl)
    private fun clearHomeTabs() {
        retainedChatHome = null; retainedContacts = null; homeTabAccount = null
    }
    private fun prepareHomeTabs() {
        val owner = currentHomeTabAccount()
        if (homeTabAccount != owner) { clearHomeTabs(); homeTabAccount = owner }
    }
    private fun retains(home: ChatHomeView) = homeTabAccount == currentHomeTabAccount() && retainedChatHome === home
    private fun retains(view: ContactsView) = homeTabAccount == currentHomeTabAccount() && retainedContacts === view
    private var chatChildActive = false
    private var leaveContactsOnBack = false
    private var groupCreate: GroupCreateView? = null
    private var contactPicker: ContactPickerView? = null
    private var addFriendView: AddFriendView? = null
    private var groupMemberLimit = 500
    private var showGroupMemberCount = true
    private val qrCameraPermissionRequest = 1907
    private data class QrAccountScope(val userId: Int, val token: String, val base: String, val revision: Int, val source: View)
    private var qrRevision = 0
    private var qrScannerAccount: QrAccountScope? = null
    private var userSearchRevision = 0
    private val chatCameraPermissionRequest = 1944
    private val chatCameraResult = 44
    private var pendingCameraFile: File? = null
    private var pendingCameraUri: Uri? = null
    private var suppressHomeBackUntil = 0L
    private var appForeground = false
    private var recordingTarget: SendTarget? = null
    private var pendingMediaTarget: SendTarget? = null
    private class PhotoBatchItem(val uri: Uri, val target: SendTarget, var upload: JSONObject? = null) {
        var uploading: java.util.concurrent.Future<JSONObject>? = null
    }
    private class PhotoBatch(val items: List<PhotoBatchItem>, val base: String, val messages: LinearLayout?, val progress: TextView) {
        var index = 0
        var cancelSend: (() -> Unit)? = null
        var failure: android.app.AlertDialog? = null
        val uploadCalls = java.util.concurrent.ConcurrentHashMap<String, okhttp3.Call>()
    }
    @Volatile private var photoBatch: PhotoBatch? = null
    private var announcementCycle = 0
    private var announcementRequest = 0
    private var currentAnnouncement: JSONObject? = null
    private var announcementDialog: AnnouncementDialog? = null
    private val appLock by lazy { AppLock(this) {
        myFeature?.resume(); refreshAnnouncement(true); resumeRealtimeMessaging()
        groupAnnouncement?.resume(); refreshGroupMetadata()
        restoreExplore()
    } }
    internal fun isAppLocked() = appLock.locked
    internal fun swipeAccountIdentity(): Any? = if (::api.isInitialized) listOf(currentUserId, api.token, apiBaseUrl) else null
    internal fun lockNow() { invalidateForceAdd(); clearExplore(); pauseGroupAnnouncement(); announcementDialog?.dismiss(); appLock.lock(); restoreExplore() }

    override fun onStart() {
        super.onStart()
        AppAppearance.load(this)
        if (appLock.locked) { appLock.enforce(); appForeground = true; MessageAlerts.clear(this); return }
        appForeground = true
        PushNotifications.foreground = true
        MessageAlerts.clear(this)
        announcementCycle++
        refreshAnnouncement(true)
        myFeature?.resume()
        contactsView?.takeIf { it.page in listOf(ContactsView.Page.GROUPS, ContactsView.Page.CHANNELS) }?.refresh()
        if (tasksVisible && !taskChildActive && ::content.isInitialized) showTasks()
        restoreExplore()
    }

    override fun onStop() {
        flushChatDraft()
        clearExplore()
        closeGroupChatOverlays()
        if (contactGroupChild) contactProfileDialog?.hide() else contactProfileDialog?.dismiss()
        myFeature?.pause()
        appLock.lock()
        appForeground = false
        if (foregroundOwner == null) PushNotifications.foreground = false
        announcementRequest++
        announcementDialog?.dismiss()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        RouteManager.refreshInBackground()
        RouteManager.setForeground(true)
        foregroundOwner = this
        appForeground = true
        PushNotifications.foreground = true
        PushNotifications.activeConversation = activeConversationId
        resumeRealtimeMessaging()
        drainMediaOutbox()
        if (activeConversationType == "group") refreshGroupMetadata()
        restoreExplore()
    }

    override fun onPause() {
        flushChatDraft()
        closeChatAttachments()
        contactCardForegroundRevision++
        contactCardPicker?.dismiss(); contactCardPicker = null
        contactCardSendCancel?.invoke(); contactCardSendCancel = null
        invalidateForceAdd()
        clearExplore()
        workQuestionImagePanel?.dismissPreview()
        pauseGroupAnnouncement()
        if (contactGroupChild) { socket?.close(); socket = null; activeMessageRecovery = null; inboxNotices.clear() }
        messageHandler.removeCallbacks(foregroundMessageCheck)
        messageHandler.removeCallbacks(badgeRefresh)
        appForeground = false
        if (foregroundOwner === this) { RouteManager.setForeground(false); foregroundOwner = null; PushNotifications.foreground = false }
        super.onPause()
    }

    private fun resumeRealtimeMessaging() {
        if (!::api.isInitialized || !appForeground || isFinishing || isDestroyed) return
        messageHandler.removeCallbacks(foregroundMessageCheck)
        if (api.token != null && !appLock.locked) {
            if (contactGroupChild) {
                contactGroupChild = false
                contactProfileScope?.let { scope ->
                    if (accountSessions.token() == scope.target.token && scope.target.matches(activeConversationId, currentUserId, api.token) && apiBaseUrl == scope.base) scope.dialog.show()
                    else { scope.dialog.dismiss(); api.token = null; showLogin(); return }
                }
            }
            connectSocket(); socket?.ensureConnected()
            contactNames.refresh(force = true)
            if (chatHistoryReady) markConversationRead(activeConversationId, currentMessageData.keys.maxOrNull() ?: 0, reopen = true)
            drainConversationReads()
            if (!chatHistoryReady) retryInitialHistory?.invoke()
            refreshCurrentMessages(allowUnsubscribed = true)
            refreshMessagePins()
            chatHome?.takeIf { it.isAttachedToWindow }?.let { loadChatPage(it, 1) }
            contactsView?.scheduleConversationRefresh()
        }
        messageHandler.postDelayed(foregroundMessageCheck, 5000)
    }

    private fun refreshAnnouncement(showPopup: Boolean, manual: Boolean = false) {
        val cycle = announcementCycle
        val request = ++announcementRequest
        val actor = currentUserId; val token = api.token; val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }
        executor.execute {
            try {
                val config = client.clientConfig()
                runOnUiThread {
                    if (!appForeground || appLock.locked || isFinishing || isDestroyed || cycle != announcementCycle || request != announcementRequest || currentUserId != actor || api.token != token || apiBaseUrl != base) return@runOnUiThread
                    ClientUpdates.apply(this, config)
                    groupMemberLimit = config.optInt("group_member_limit", 500)
                    showGroupMemberCount = config.optBoolean("show_group_member_count", true)
                    exploreLinks = JSONArray().apply {
                        val links = config.optJSONArray("explore_links") ?: JSONArray()
                        for (index in 0 until links.length()) put(links.optJSONObject(index))
                        val malls = config.optJSONArray("mall_links") ?: JSONArray()
                        for (index in 0 until malls.length()) {
                            val mall = malls.optJSONObject(index) ?: continue
                            val url = mall.optString("url")
                            if (url.isNotBlank() && (0 until length()).none { optJSONObject(it)?.optString("url") == url }) put(JSONObject().put("id", 10000 + index).put("name", mall.optString("name", "值得买${index + 1}")).put("url", url))
                        }
                    }
                    explorePanel?.updateLinks(exploreLinks)
                    currentAnnouncement = config.optJSONObject("announcement")?.takeIf { it.optBoolean("enabled") && it.optString("content").isNotBlank() }
                    chatHome?.setNotice(currentAnnouncement?.optString("content").orEmpty())
                    announcementDialog?.dismiss()
                    if (showPopup && currentAnnouncement != null) {
                        val dialog = AnnouncementDialog(this, requireNotNull(currentAnnouncement))
                        announcementDialog = dialog
                        dialog.setOnDismissListener { if (announcementDialog === dialog) { announcementDialog = null; groupAnnouncement?.resume() } }
                        groupAnnouncement?.pause()
                        dialog.show()
                    } else if (manual && currentAnnouncement == null) toast("当前没有启用的公告")
                }
            } catch (_: Exception) {
                // A failed announcement request must never prevent login, navigation or messaging.
                if (manual) runOnUiThread { if (appForeground && request == announcementRequest) toast("公告获取失败，请稍后重试") }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MobileDeviceIdentity.initialize(applicationContext)
        nestedContactChat = intent.getBooleanExtra("contact_nested_chat", false)
        AppAppearance.load(this)
        val restoreMyPage = savedInstanceState?.getString("my_page")
        val restoreContactsPage = savedInstanceState?.getString("contacts_page")?.let {
            runCatching { ContactsView.Page.valueOf(it) }.getOrNull()
        } ?: if (savedInstanceState?.getBoolean("restore_groups", false) == true) ContactsView.Page.GROUPS else null
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
                if (!consumePageBack("system")) finish()
            }
        }
        // Transport preferences are accepted only from a signed route policy.
        apiBaseUrl = (if(BuildConfig.GO_BACKEND&&BuildConfig.DEBUG) preferences.getString("go_api_base_url",null) else null)?.trimEnd('/') ?: getString(R.string.pulse_api_base_url).trimEnd('/')
        RouteManager.initialize(this, apiBaseUrl, getString(R.string.pulse_websocket_url))
        routeObserver?.invoke()
        routeObserver = RouteManager.forBase(apiBaseUrl)?.observe {
            if (!isFinishing && !isDestroyed) {
                socket?.close(); socket = null
                if (api.token != null) connectSocket()
            }
        }
        api = ApiClient(apiBaseUrl)
        ClientUpdates.bind(this, apiBaseUrl)
        val savedToken = accountSessions.token() ?: if(BuildConfig.GO_BACKEND) null else preferences.getString("access_token", null)
        if (savedToken.isNullOrBlank()) {
            showLogin()
        } else {
            api.token = savedToken
            showSessionRestore(savedToken, restoreMyPage, restoreContactsPage)
        }
    }

    private fun showSessionRestore(savedToken: String, restoreMyPage: String?, restoreContactsPage: ContactsView.Page?) {
        diagnostics.record("session.restore")
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(dp(24), dp(24), dp(24), dp(24)); setBackgroundColor(PulseColors.background) }
        val status = text("正在恢复连接…", 16f).apply { gravity = Gravity.CENTER }
        val progress = ProgressBar(this)
        val retry = Button(this).apply { text = "重新连接"; visibility = View.GONE }
        val route = Button(this).apply { text = "切换线路"; visibility = View.GONE; setOnClickListener { showRouteDialog() } }
        panel.addView(progress); panel.addView(status); panel.addView(retry); panel.addView(route)
        setContentView(panel)
        fun restore() {
            retry.visibility = View.GONE; route.visibility = View.GONE; progress.visibility = View.VISIBLE; status.text = "正在恢复连接…"
            val restoreBase = apiBaseUrl; val restoreId = accountSessions.activeId()
            val restoreClient = ApiClient(restoreBase).apply { token = savedToken }
            executor.execute {
                val cachedUser = runCatching { LocalSessionCache.read(this, restoreBase, restoreId) }.getOrNull()
                if (cachedUser != null) runOnUiThread {
                    if (isFinishing || isDestroyed || api.token != savedToken || apiBaseUrl != restoreBase || currentUserId > 0) return@runOnUiThread
                    currentUserId = restoreId; currentNickname = cachedUser.optString("nickname", "用户")
                    currentUsername = jsonText(cachedUser, "username"); currentInternalStaff = false
                    localSessionOnly = true
                    if (restoreContactsPage != null) showContacts(restoreContactsPage) else showChat(currentNickname)
                }
                try {
                    val user = restoreClient.me()
                    check(user.optInt("id") > 0 && (restoreId <= 0 || user.optInt("id") == restoreId)) { "个人资料账号不匹配" }
                    runCatching { LocalSessionCache.save(this, restoreBase, user) }.onFailure { diagnostics.fault("ANDROID_LOCAL_PROFILE", it) }
                    val nickname = user.optString("nickname", "用户")
                    runOnUiThread {
                        if (isFinishing || isDestroyed || api.token != savedToken || apiBaseUrl != restoreBase) return@runOnUiThread
                        currentUserId = user.optInt("id")
                        currentInternalStaff = user.optBoolean("internal_staff", false)
                        currentUsername = jsonText(user, "username")
                        val alreadyOpened = localSessionOnly && currentUserId == restoreId
                        localSessionOnly = false
                        accountSessions.save(user, savedToken)
                        preferences.edit().remove("access_token").apply()
                        if (alreadyOpened) { currentNickname = nickname; refreshLocalDirectories(force = true); chatHome?.let { loadChatPage(it, 1) }; contactsView?.refresh() }
                        else if (restoreMyPage != null) { currentNickname = nickname; showMyPage(restoreMyPage); connectSocket() }
                        else if (restoreContactsPage != null) { currentNickname = nickname; showContacts(restoreContactsPage); connectSocket() }
                        else showChat(nickname)
                        refreshAnnouncement(false)
                        openNotificationConversation()
                    }
                } catch (error: Exception) {
                    diagnostics.fault("ANDROID_SESSION_RESTORE", error)
                    runOnUiThread { if (!isFinishing && !isDestroyed && api.token == savedToken && apiBaseUrl == restoreBase) {
                        if (error is ClientApiException && error.authenticationRejected) {
                            accountSessions.invalidate(restoreId); preferences.edit().remove("access_token").apply(); api.token = null; showLogin()
                        } else if (localSessionOnly) {
                            toast("当前离线，已显示本地数据；联网后自动同步")
                        } else {
                            status.text = "连接暂时中断，请重试"; progress.visibility = View.GONE; retry.visibility = View.VISIBLE; route.visibility = View.VISIBLE
                        }
                    } }
                }
            }
        }
        retry.setOnClickListener { restore() }
        restore()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        myFeature?.takeIf { it.visible() }?.let { outState.putString("my_page", it.page) }
        contactsView?.let { outState.putString("contacts_page", it.page.name) }
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openNotificationConversation()
    }

    private fun openNotificationConversation() {
        val conversationId = intent.getIntExtra("notification_conversation_id", 0)
        val targetUser = intent.getIntExtra("notification_user_id", 0)
        val token = api.token ?: return
        if (conversationId <= 0) return
        intent.removeExtra("notification_conversation_id")
        if (targetUser != currentUserId) { toast("请先切换到收到通知的账号"); return }
        val requestedNotificationRevision = notificationRevision(); val base = apiBaseUrl
        executor.execute {
            try {
                val conversation = ApiClient(base).apply { this.token = token }.openConversation(conversationId)
                runOnUiThread { if (api.token == token && currentUserId == targetUser && apiBaseUrl == base) showChat(currentNickname, openConversation = notificationInfo(conversation, requestedNotificationRevision)) }
            } catch (e: Exception) { runOnUiThread { if (api.token == token) toast(contactError(e, "打开通知会话失败")) } }
        }
    }

    override fun setContentView(view: View) {
        flushChatDraft(detach = true)
        if (pendingChatEntry?.transitioning != true && pendingChatEntry?.view !== view) cancelPendingChatEntry()
        surfaceRevision++; invalidateForceAdd()
        super.setContentView(view)
        bindLocalization(view)
        AppAppearance.apply(view)
        appLock.enforce()
    }
    private fun showLogin() {
        directoryViews.clear()
        localDirectories.stop()
        localSessionOnly = false; localSessionCheck = false; localOutboxOwner = null; localOutboxesReady = false
        mediaOutbox = null
        LocalChatArchive.stop()
        cancelPendingChatEntry(); cancelChatHistory()
        clearHomeTabs()
        ChatAvatars.account("", 0, null)
        diagnostics.bind(apiBaseUrl, null, 0)
        ChatImageCache.clear(this)
        NavigationBadges.bind(0, null, "")
        badgeRefreshGeneration++; badgeRefreshRunning = false; badgeRefreshQueued = false
        lastBadgeRefreshAt = 0L; messageHandler.removeCallbacks(badgeRefresh)
        clearExplore(leave = true); exploreLinks = JSONArray()
        qrRevision++; qrScannerAccount = null
        pendingSendAcks.clear(); textSends = TextSendQueue()
        closeGroupChatOverlays()
        favoriteRequests.clear(); favoriteInFlight.clear()
        taskPageGeneration++
        tasksVisible = false; taskChildActive = false; taskRoleBadge = null
        taskVerificationDialog?.dismiss(); taskVerificationDialog = null
        taskSettlementDialog?.dismiss(); taskSettlementDialog = null
        executor.execute { runCatching { val config = ApiClient(apiBaseUrl).clientConfig(); runOnUiThread { if (!isFinishing && !isDestroyed) ClientUpdates.apply(this, config) } } }
        myFeature?.close()
        authView = null
        contactsView = null
        chatHome = null
        chatChildActive = false
        groupCreate = null
        contactPicker = null
        addFriendView = null
        chatReturnPage = null
        activeConversationId = 0
        currentMessages = null
        retryInitialHistory = null
        inboxNotices.clear()
        socket?.close()
        socket = null
        configureAuthChrome(true)
        val form = AuthFlowView(this,
            onLogin = { account, password -> authenticate(account, password) },
            onRegister = { account, password, nickname, captchaId, captchaCode, avatar -> authenticate(account, password, nickname, captchaId = captchaId, captchaCode = captchaCode, avatarDataURL = avatar) },
            loadRegisterChallenge = { complete ->
                val endpoint = apiBaseUrl
                executor.execute {
                    try { val challenge = ApiClient(endpoint).registerChallenge(); runOnUiThread { if (!isFinishing && !isDestroyed) complete(challenge, null) } }
                    catch (error: Exception) { runOnUiThread { if (!isFinishing && !isDestroyed) complete(null, error.message ?: "验证码加载失败，请重试") } }
                }
            },
            onRoute = { showRouteDialog() },
            rememberedLogins = RememberedLogins(this), loginServer = apiBaseUrl
        )
        authView = form
        setContentView(form)
    }

    private fun authenticate(account: String, password: String, nickname: String? = null, twoStepCode: String = "", captchaId: String = "", captchaCode: String = "", avatarDataURL: String = "") {
        val form = authView ?: return
        val loginBase = apiBaseUrl
        val rememberChoice = form.rememberPasswordRequested()
        val client = ApiClient(apiBaseUrl)
        executor.execute {
            try {
                val registration = nickname?.let { client.register(account, password, it, captchaId, captchaCode, avatarDataURL = avatarDataURL) }
                val token = registration?.getString("access_token") ?: client.login(account, password, twoStepCode)
                client.token = token
                // 注册响应已包含真实用户编号，避免创建成功后因额外资料请求失败而重复注册。
                val userId: Int
                val displayName: String
                val savedUser: JSONObject
                if (registration != null) {
                    userId = registration.getInt("user_id")
                    displayName = requireNotNull(nickname)
                    savedUser = JSONObject().put("id", userId).put("nickname", displayName).put("username", account).put("avatar_url", registration.optString("avatar_url")).apply {
                        PublicUserId.value(registration.opt("public_id"))?.let { put("public_id", it) }
                    }
                } else {
                    val user = client.me()
                    userId = user.getInt("id")
                    displayName = user.optString("nickname", "用户")
                    savedUser = user
                }
                runCatching { LocalSessionCache.save(this, loginBase, savedUser) }.onFailure { diagnostics.fault("ANDROID_LOCAL_PROFILE", it) }
                runOnUiThread {
                    if (isFinishing || isDestroyed || authView !== form || apiBaseUrl != loginBase) return@runOnUiThread
                    localSessionOnly = false
                    currentUserId = userId
                    currentUsername = jsonText(savedUser, "username")
                    currentInternalStaff = savedUser.optBoolean("internal_staff", false)
                    accountSessions.save(savedUser, token)
                    val rememberFailure = form.persistSuccessfulLogin(account,password,savedUser,rememberChoice)
                    api.token = token
                    preferences.edit().remove("access_token").apply()
                    form.clearCredentials()
                    authView = null
                    showChat(displayName)
                    refreshAnnouncement(false)
                    if (rememberFailure != null) android.widget.Toast.makeText(this,rememberFailure,android.widget.Toast.LENGTH_LONG).show()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    if (!isFinishing && !isDestroyed && authView === form) {
                        form.showError(error.message ?: if (nickname == null) "登录失败，请重试" else "注册失败，请重试")
                        if (nickname == null && TwoStepLogin.required(error) && !appLock.locked) TwoStepLogin.prompt(this) { authenticate(account, password, twoStepCode = it) }
                    }
                }
            }
        }
    }

    private fun configureAuthChrome(auth: Boolean) {
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        window.navigationBarColor = if (auth) Color.TRANSPARENT else PulseColors.background
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = !auth
        window.decorView.systemUiVisibility = if (auth) {
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        } else {
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let { controller ->
                if (auth) controller.hide(WindowInsets.Type.statusBars()) else controller.show(WindowInsets.Type.statusBars())
                controller.setSystemBarsAppearance(
                    if (auth) 0 else WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                )
            }
        } else if (auth) {
            window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        }
    }

    @Deprecated("Legacy back dispatch for the current native Activity")
    override fun onBackPressed() {
        if (Build.VERSION.SDK_INT >= 33) return
        if (!consumePageBack()) super.onBackPressed()
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        return pageBackSwipe.dispatch(event, window.decorView, swipeBackOwner(), { super.dispatchTouchEvent(it) }) {
            consumePageBack("swipe")
        }
    }

    private fun swipeBackOwner(): Any? {
        if (!::api.isInitialized || appLock.locked || recorder != null || recordingReleasePending || pendingVoice != null ||
            announcementDialog?.isShowing == true || isFinishing || isDestroyed) return null
        val authPage = authView?.swipeBackPage()
        if (activeConversationId == 0 && myFeature?.visible() != true && contactsView == null && !exploreVisible && !tasksVisible && !taskChildActive && !chatChildActive && authPage == null) return null
        val surface = window.decorView.findViewById<ViewGroup>(android.R.id.content)?.getChildAt(0) ?: return null
        val myPage = myFeature?.takeIf { it.visible() }
        // The displayed root can belong to Contacts/My rather than MainActivity.root.
        // Snapshot page + account, so a callback replacing either cancels this drag.
        return listOf(myPage ?: surface, currentUserId, api.token, apiBaseUrl, activeConversationId, contactsView?.page,
            myPage?.swipeBackIdentity(), authPage, taskPageGeneration, chatChildActive, chatNavigationRevision,
            if (myPage == null) surfaceRevision else null)
    }

    private fun keyboardVisible(): Boolean {
        if (Build.VERSION.SDK_INT >= 30) return window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
        val frame = android.graphics.Rect()
        window.decorView.getWindowVisibleDisplayFrame(frame)
        return window.decorView.rootView.height - frame.bottom > dp(100)
    }

    private fun consumePageBack(source: String = "legacy"): Boolean {
        val now = android.os.SystemClock.elapsedRealtime()
        if (appLock.locked) return true
        if (pendingChatEntry != null) { cancelPendingChatEntry(); returnFromChat(); return true }
        if (choosingMessages) { clearMessageSelection(); return true }
        contactProfileScope?.takeIf { it.dialog.isShowing }?.let { return it.view.handleBack() }
        if (chatAttachmentPanel != null) { closeChatAttachments(); return true }
        if (currentFocus is EditText && keyboardVisible()) {
            val focused = currentFocus
            (getSystemService(INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)
                ?.hideSoftInputFromWindow(focused?.windowToken, 0)
            focused?.clearFocus()
            if (source != "swipe") return true
        }
        // 仅保护聊天首页免受系统重复返回影响。联系人、群组等页面必须继续
        // 处理返回，否则从会话返回后第二次返回会被错误吞掉。
        if (activeConversationId == 0 && chatHome?.isAttachedToWindow == true && contactsView == null && now < suppressHomeBackUntil) return true
        if (myFeature?.back() == true) return true
        if (exploreVisible) {
            if (explorePanel?.back() == true) return true
            showChat(currentNickname); return true
        }
        if (taskChildActive) { showTasks(); return true }
        if (tasksVisible) { showChat(currentNickname); return true }
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            android.util.Log.d("PulseBack", "source=$source chat=${activeConversationId > 0} home=${chatHome != null} child=$chatChildActive contacts=${contactsView != null}")
        }
        if (chatHome?.handleBack() == true) return true
        if (authView?.handleBack() == true) return true
        if (contactsView != null && leaveContactsOnBack) {
            leaveContactsOnBack = false
            showChat(currentNickname)
            return true
        }
        if (contactsView?.handleBack() == true) return true
        if (contactsView != null) { showChat(currentNickname); return true }
        if (groupCreate?.isAttachedToWindow == true) { showContactPicker(true); return true }
        if (chatChildActive) { chatChildActive = false; showChat(currentNickname); return true }
        if (activeConversationId > 0) { if (nestedContactChat) finish() else returnFromChat(); suppressHomeBackUntil = now + 3000L; return true }
        return false
    }
    private fun showChat(nickname: String, tab: String = "chat", openConversation: JSONObject? = null) {
        prepareHomeTabs()
        ChatAvatars.account(apiBaseUrl, currentUserId, api.token)
        LocalChatArchive.bind(LocalChatStore.scope(apiBaseUrl, currentUserId, api.token))
        photoBatch?.takeIf { batch ->
            tab != "chat" || batch.items.first().target.token != api.token || batch.items.first().target.userId != currentUserId ||
                (openConversation != null && openConversation.optInt("id") != batch.items.first().target.conversationId)
        }?.let { finishPhotoBatch(it) }
        contactCardPicker?.dismiss(); contactCardPicker = null
        contactCardSendCancel?.invoke(); contactCardSendCancel = null
        clearExplore(leave = true)
        exploreVisible = tab == "explore" && openConversation == null
        closeGroupChatOverlays()
        taskPageGeneration++
        taskVerificationDialog?.dismiss(); taskVerificationDialog = null
        taskRoleBadge = null
        taskChildActive = false
        tasksVisible = tab == "tasks"
        if (tab == "me" && openConversation == null) { showMyPage(); return }
        myFeature?.close()
        authView = null
        configureAuthChrome(false)
        window.statusBarColor = Color.WHITE
        window.navigationBarColor = Color.WHITE
        currentNickname = nickname
        contactsView = null
        leaveContactsOnBack = false
        chatChildActive = false
        chatHome = null
        groupCreate = null
        contactPicker = null
        addFriendView = null
        activeConversationId = 0
        currentMessages = null
        val standaloneDirect = openConversation?.optString("type") == "direct"
        val standaloneChat = standaloneDirect || openConversation?.optString("type") == "group"
        root = column(0).apply {
            setBackgroundColor(Color.WHITE)
            setOnApplyWindowInsetsListener { _, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val bars = insets.getInsets(WindowInsets.Type.systemBars())
                    val keyboard = insets.getInsets(WindowInsets.Type.ime())
                    setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
                } else setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                if (standaloneDirect) background = android.graphics.drawable.LayerDrawable(arrayOf(ColorDrawable(AppAppearance.background(Color.WHITE)), ColorDrawable(AppAppearance.background(0xFFF5F4F9.toInt())))).apply {
                    setLayerGravity(1, Gravity.BOTTOM); setLayerHeight(1, paddingBottom)
                }
                insets
            }
        }
        if (openConversation == null && tab == "chat") {
            root.setOnApplyWindowInsetsListener { _, insets -> insets }
            lateinit var home: ChatHomeView
            home = retainedChatHome ?: ChatHomeView(this, currentUserId, { mediaUrl(it) },
                onOpen = { item ->
                    openExistingChat(item.optInt("id"), item)
                },
                onDelete = { ids -> hideChatConversations(ids) },
                onMenu = { anchor -> showChatMenu(anchor) },
                onLine = { showRouteDialog() },
                onSearch = { keyword -> searchChatMessages(keyword) },
                onNavigate = { navigateTab(it) },
                onMore = { page -> loadChatPage(home, page) },
                onNotice = { refreshAnnouncement(true, manual = true) }
            )
            retainedChatHome = home; chatHome = home
            home.contactName = ::contactDisplayName
            contactNames.refresh()
            (home.parent as? ViewGroup)?.removeView(home)
            home.refreshReadCounts { id, latest, count -> conversationReads.unread(id, latest, count) }
            root.addView(home, LinearLayout.LayoutParams(-1, 0, 1f))
            setContentView(root)
            connectSocket()
            if (home.loadState.needsRefresh(android.os.SystemClock.elapsedRealtime())) loadChatPage(home, 1)
            home.setNotice(currentAnnouncement?.optString("content").orEmpty())
            return
        }
        val header = row().apply {
            setPadding(dp(20), dp(18), dp(16), dp(12))
            setBackgroundColor(Color.WHITE)
            if (tab == "explore" || tab == "tasks") {
                addView(text(if (tab == "explore") "探索" else "任务", 27f, PulseColors.ink).apply { typeface = Typeface.DEFAULT_BOLD })
                addView(space())
                if (tab == "tasks") addView(TextView(this@MainActivity).apply {
                    id = R.id.work_employee_type
                    text = "身份加载中"; textSize = 13f; setTextColor(PulseColors.accent); gravity = Gravity.CENTER
                    contentDescription = "当前员工身份，正在从后台读取"
                    setPadding(dp(8), 0, 0, 0)
                    taskRoleBadge = this
                }, LinearLayout.LayoutParams(dp(92), dp(42)))
                if (tab == "tasks") addView(iconButton("↻") { showTasks() }.apply {
                    id = R.id.work_refresh_tasks; contentDescription = "刷新任务与员工身份"
                }, LinearLayout.LayoutParams(dp(38), dp(42)))
            } else {
                addView(column(0).apply {
                    addView(text(getString(R.string.app_name), 13f, PulseColors.accent).apply { typeface = Typeface.DEFAULT_BOLD })
                    addView(text("消息", 27f, PulseColors.ink).apply { typeface = Typeface.DEFAULT_BOLD })
                })
                addView(space())
                addView(iconButton("＋") { showContacts() })
            }
        }
        if (!standaloneChat && tab != "explore") root.addView(header)
        taskHeader = if (tab == "tasks") header else null
        content = column(if (exploreVisible) 0 else 12).apply {
            setBackgroundColor(PulseColors.background)
            layoutParams = LinearLayout.LayoutParams(-1, 0, 1f)
        }
        conversationList = content
        root.addView(content)
        val navigation = ContactsNavigation(this, tab) { navigateTab(it) }
        if (!standaloneChat) root.addView(navigation)
        taskNavigation = if (tab == "tasks") navigation else null
        setContentView(root)
        connectSocket()
        when {
            openConversation != null -> {
                activeConversationId = openConversation.getInt("id")
                activeConversationType = openConversation.optString("type")
                loadHistory(openConversation.optString("name", "会话"), openConversation)
            }
            tab == "me" -> showMe(nickname)
            tab == "explore" -> showExplore()
            tab == "tasks" -> showTasks()
            else -> loadConversations(content, nickname)
        }
    }

    private fun verifyLocalSession() {
        if (!localSessionOnly || localSessionCheck || android.os.SystemClock.elapsedRealtime() < nextLocalSessionCheck) return
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl
        localSessionCheck = true; nextLocalSessionCheck = android.os.SystemClock.elapsedRealtime() + 15000L
        messageExecutor.execute {
            try {
                val user = ApiClient(base).apply { this.token = token }.me()
                check(user.optInt("id") == actor) { "账号资料不匹配" }
                runCatching { LocalSessionCache.save(this, base, user) }
                runOnUiThread {
                    if (api.token == token && currentUserId == actor && apiBaseUrl == base) {
                        localSessionCheck = false; localSessionOnly = false
                        currentInternalStaff = user.optBoolean("internal_staff", false)
                        currentNickname = user.optString("nickname", currentNickname)
                        refreshLocalDirectories(force = true)
                        chatHome?.let { loadChatPage(it, 1) }; contactsView?.refresh()
                        val opening = pendingChatEntry?.takeIf { it.localVisible }
                        if (opening != null) { cancelPendingChatEntry(); openExistingChat(opening.id, opening.cached?.info) }
                        else retryInitialHistory?.invoke()
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    if (api.token == token && currentUserId == actor && apiBaseUrl == base) {
                        localSessionCheck = false
                        if (error is ClientApiException && error.authenticationRejected) {
                            accountSessions.invalidate(actor); api.token = null; showLogin()
                        }
                    }
                }
            }
        }
    }

    private fun bindLocalOutboxes(retryNow: Boolean = false) {
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl
        if (actor <= 0) return
        val owner = "$base|$actor|$token"
        if (localOutboxOwner == owner) return
        if (!retryNow && failedOutboxOwner == owner && android.os.SystemClock.elapsedRealtime() < nextOutboxRestoreAt) return
        localOutboxOwner = owner; localOutboxesReady = false; pendingDurableAcks.clear()
        textSends = TextSendQueue(); mediaOutbox = null
        LocalChatArchive.disk.execute {
            try {
                val texts = AndroidOutboxStorage.text(this, token, actor, base)
                val media = AndroidOutboxStorage.media(this, token, actor, base)
                runOnUiThread {
                    if (isDestroyed || api.token != token || currentUserId != actor || apiBaseUrl != base || localOutboxOwner != owner) return@runOnUiThread
                    textSends = texts; mediaOutbox = media; localOutboxesReady = true
                    failedOutboxOwner = null
                    val waitingAcks = pendingDurableAcks.values.toList(); pendingDurableAcks.clear()
                    waitingAcks.forEach(::acknowledgeDurableMessage)
                    if (currentMessages != null) currentMessageData.values.toList().forEach { acknowledgeDurableMessage(it) }
                    currentMessages?.let { renderPendingTextMessages(it) }
                    drainMediaOutbox()
                }
            } catch (error: Exception) {
                diagnostics.fault("ANDROID_LOCAL_OUTBOX", error)
                runOnUiThread {
                    if (localOutboxOwner == owner) { localOutboxOwner = null; failedOutboxOwner = owner; nextOutboxRestoreAt = android.os.SystemClock.elapsedRealtime() + 15000L; toast("本地待发消息恢复失败，请检查存储空间后重试") }
                }
            }
        }
    }

    private fun connectSocket() {
        if (currentUserId <= 0) return
        bindLocalOutboxes()
        refreshLocalDirectories()
        diagnostics.bind(apiBaseUrl, api.token, currentUserId)
        conversationReads.bind(currentUserId, api.token, apiBaseUrl)
        if (NavigationBadges.bind(currentUserId, api.token, apiBaseUrl)) {
            badgeRefreshGeneration++; badgeRefreshRunning = false; badgeRefreshQueued = false; lastBadgeRefreshAt = 0L
        }
        refreshNavigationBadges()
        PushNotifications.activeConversation = activeConversationId
        PushNotifications.bind(this)
        if (socket != null) return
        val sessionToken = api.token ?: return
        lateinit var connection: SocketClient
        val socketRouteApi = RouteManager.api(apiBaseUrl)
        connection = SocketClient(RouteManager.webSocket(apiBaseUrl, getString(R.string.pulse_websocket_url)), sessionToken, { connectionEpoch, packet ->
            runOnUiThread {
                val terminal = packet.optString("type") in listOf("auth.revoked", "client.update_required")
                if (api.token == sessionToken && socket === connection && (if (terminal) connection.isLatest(connectionEpoch) else connection.isCurrent(connectionEpoch))) handlePacket(packet)
            }
        }, { connectionEpoch, connected ->
            runOnUiThread { if (api.token == sessionToken && socket === connection && (if (connected) connection.isCurrent(connectionEpoch) else connection.isLatest(connectionEpoch))) {
                chatSocketEpoch++; chatSubscribedEpoch = -1; chatSynchronizedEpoch = -1; activeMessageRecovery = null
                if (connected) toast("实时连接已建立")
            } }
        }, endpointProvider = { RouteManager.webSocket(apiBaseUrl, getString(R.string.pulse_websocket_url)) }, diagnostic = { code, error -> diagnostics.fault(code, error) }, routeFailure = {
            RouteManager.failover(apiBaseUrl, socketRouteApi)
        })
        socket = connection
        connection.connect()
    }

    private fun scheduleNavigationBadges() {
        NavigationBadges.invalidate()
        if (!appForeground || appLock.locked || isFinishing || isDestroyed) return
        messageHandler.removeCallbacks(badgeRefresh)
        messageHandler.postDelayed(badgeRefresh, 200)
    }

    private fun refreshNavigationBadges(force: Boolean = false) {
        if (!appForeground || !::api.isInitialized || appLock.locked || isFinishing || isDestroyed) return
        val token = api.token ?: return
        val actor = currentUserId; val base = apiBaseUrl
        if (NavigationBadges.bind(actor, token, base)) {
            badgeRefreshGeneration++; badgeRefreshRunning = false; badgeRefreshQueued = false; lastBadgeRefreshAt = 0L
        }
        if (badgeRefreshRunning) { if (force) badgeRefreshQueued = true; return }
        val now = android.os.SystemClock.elapsedRealtime()
        if (!force && now - lastBadgeRefreshAt < 5000L) return
        lastBadgeRefreshAt = now
        badgeRefreshRunning = true; badgeRefreshQueued = false
        val generation = ++badgeRefreshGeneration
        val ticket = NavigationBadges.begin()
        val client = ApiClient(base).apply { this.token = token }
        fun current() = api.token == token && currentUserId == actor && apiBaseUrl == base && !isFinishing && !isDestroyed
        badgeExecutor.execute {
            var snapshot: NavigationBadgeSnapshot? = null
            try { snapshot = client.navigationBadgeSnapshot { current() && appForeground } }
            catch (_: Exception) { /* Keep confirmed counts during a transient network failure. */ }
            runOnUiThread {
                if (generation != badgeRefreshGeneration) return@runOnUiThread
                badgeRefreshRunning = false
                if (!current() || !appForeground) return@runOnUiThread
                snapshot?.let {
                    val adjusted = it.copy(conversations = it.conversations.mapValues { (id, count) -> conversationReads.unread(id, it.latestMessageIds[id] ?: 0, count) })
                    if (!NavigationBadges.accept(ticket, adjusted)) badgeRefreshQueued = true
                }
                if (badgeRefreshQueued) {
                    badgeRefreshQueued = false
                    messageHandler.removeCallbacks(badgeRefresh)
                    messageHandler.postDelayed(badgeRefresh, 200)
                }
            }
        }
    }

    private fun loadChatPage(home: ChatHomeView, page: Int) {
        if (!retains(home) || isFinishing || isDestroyed) return
        val token = api.token ?: return
        if (!home.refreshGate.begin(page == 1)) return
        val snapshotRevision = home.realtimeRevision
        val readRevision = conversationReads.revision
        val actor = currentUserId; val base = apiBaseUrl
        val localScope = LocalAccountStore.scope(base, actor)
        val restoreFirst = page == 1 && !home.loadState.hasSnapshot
        if (page == 1) localDirectories.refresh(kinds = setOf(LocalDirectoryStore.Kind.CHATS))
        val requestedNotificationRevision = notificationRevision()
        val client = ApiClient(base).apply { this.token = token }
        home.busy(page)
        fun fetchPage() {
            if (!retains(home) || api.token != token || currentUserId != actor || apiBaseUrl != base || isFinishing || isDestroyed) { home.refreshGate.finish(); return }
            messageExecutor.execute {
                try {
                    val result = client.chatPage(page)
                    runOnUiThread {
                        if (retains(home) && api.token == token && currentUserId == actor && apiBaseUrl == base) {
                            if (readRevision != conversationReads.revision) home.refreshGate.begin(true)
                            else {
                                result.optJSONArray("items")?.let { rows -> for (i in 0 until rows.length()) {
                                    val item = rows.getJSONObject(i)
                                    notificationInfo(item, requestedNotificationRevision)
                                    item.put("unread_count", conversationReads.unread(item.optInt("id"), item.optJSONObject("last_message")?.optInt("id") ?: 0, item.optInt("unread_count")))
                                } }
                                home.accept(result, page, snapshotRevision)
                                if (home.realtimeRevision != snapshotRevision) home.refreshGate.begin(true)
                            }
                        }
                        if (home.refreshGate.finish() && retains(home) && api.token == token) {
                            if (chatHome === home && home.isAttachedToWindow) loadChatPage(home, 1) else home.loadState.invalidate()
                        }
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        if (retains(home) && api.token == token && currentUserId == actor && apiBaseUrl == base) home.showError(contactError(e, "加载聊天失败，请重试"), snapshotRevision)
                        if (home.refreshGate.finish() && retains(home) && api.token == token) {
                            if (chatHome === home && home.isAttachedToWindow) loadChatPage(home, 1) else home.loadState.invalidate()
                        }
                    }
                }
            }
        }
        // Restore the complete local list before a fast network first page
        // claims the empty view; authoritative background sync stays independent.
        if (restoreFirst) LocalChatArchive.disk.execute {
            val snapshot = runCatching { LocalDirectoryStore.read(this, localScope, LocalDirectoryStore.Kind.CHATS) }.getOrNull()
            runOnUiThread {
                if (snapshot != null && retains(home) && api.token == token && currentUserId == actor && apiBaseUrl == base) home.restoreLocalSnapshot(snapshot.toResult())
                fetchPage()
            }
        } else fetchPage()
    }

    private fun hideChatConversations(ids: List<Int>) {
        val home = chatHome ?: return
        if (ids.isEmpty()) return
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }; val scope = LocalAccountStore.scope(base, actor)
        home.deleting()
        executor.execute {
            val hidden = mutableListOf<Int>()
            try {
                ids.forEach { client.hideConversation(it); hidden.add(it); LocalDirectoryStore.removeConversation(this, scope, it) }
                runOnUiThread { if (chatHome === home) home.finishDelete(ids); scheduleNavigationBadges() }
            } catch (e: Exception) {
                runOnUiThread { if (chatHome === home) home.finishDelete(hidden, contactError(e, "删除聊天窗口失败，请重试")); scheduleNavigationBadges() }
            }
        }
    }

    private fun showRouteDialog() {
        if(BuildConfig.GO_BACKEND){
            if(!BuildConfig.DEBUG){toast("服务地址由当前安装包配置");return}
            val address=input("服务地址，以 /api/v2 结尾").apply{setText(apiBaseUrl)}
            val dialog=android.app.AlertDialog.Builder(this).setTitle("服务地址").setView(address).setNegativeButton("取消",null).setPositiveButton("保存并重新登录",null).create()
            dialog.setOnShowListener{dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener{
                val value=address.text.toString().trim().trimEnd('/')
                val valid=runCatching{val uri=java.net.URI(value);ClientPolicy.secureEndpoint(value)&&uri.rawQuery==null&&uri.path.endsWith("/api/v2")}.getOrDefault(false)
                if(!valid){address.error="请填写完整的 Go 服务地址，例如 http://电脑局域网地址:18080/api/v2";return@setOnClickListener}
                preferences.edit().putString("go_api_base_url",value).commit();socket?.close();socket=null;dialog.dismiss();recreate()
            }};dialog.show();return
        }
        val manager = RouteManager.forBase(apiBaseUrl) ?: return
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(8), dp(22), dp(8)) }
        val state = TextView(this).apply { textSize = 12f; setTextColor(PulseColors.muted); text = "持续高延迟或连接异常时自动尝试更优线路，也可手动切换"; setPadding(0, 0, 0, dp(12)) }
        panel.addView(state)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; panel.addView(list)
        val feedback = TextView(this).apply { textSize = 12f; setPadding(0, dp(10), 0, 0); setTextColor(PulseColors.muted) }; panel.addView(feedback)
        val scroll = ScrollView(this).apply { addView(panel) }
        val dialog = android.app.AlertDialog.Builder(this).setTitle("选择线路").setView(scroll).setPositiveButton("完成", null).setNeutralButton("更新线路", null).create()
        var busy = false
        fun render() {
            list.removeAllViews()
            for (route in manager.routes) {
                val checked = route.id == manager.current.id
                val delay = manager.latencies[route.id]?.let { " · ${it} ms" }.orEmpty()
                val button = Button(this).apply { text = (if (checked) "✓ " else "○ ") + route.name + (if (checked) " · 正在使用" else "") + delay; isEnabled = !busy; textSize = 14f; isAllCaps = false }
                button.setOnClickListener {
                    if (!busy) { busy = true; render(); feedback.text = "正在检测并切换…"
                        executor.execute { val outcome = runCatching { manager.select(route.id) }; runOnUiThread { if (dialog.isShowing) { busy = false; feedback.text = outcome.fold({ "已切换到${route.name}" }, { it.message ?: "该线路暂不可用" }); render() } } }
                    }
                }
                list.addView(button)
            }
        }
        dialog.setOnShowListener {
            render()
            dialog.getButton(android.app.AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                if (!busy) { busy = true; render(); feedback.text = "正在更新线路…"
                    executor.execute { val updated = manager.refresh(); manager.routes.forEach { runCatching { manager.probe(it) } }; runOnUiThread { if (dialog.isShowing) { busy = false; feedback.text = if (updated) "线路已更新，延迟仅供当前网络参考" else "暂时无法更新，仍可选择已保存线路"; render() } } }
                }
            }
        }
        dialog.show()
    }

    private fun showChatMenu(anchor: View) {
        val popup = PopupWindow(this)
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(0, dp(8), 0, dp(8)); background = rounded(Color.WHITE, 18)
        }
        fun item(id: Int, icon: String, title: String, action: () -> Unit) {
            panel.addView(LinearLayout(this).apply {
                this.id = id; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(26), 0, dp(28), 0); minimumHeight = dp(62)
                addView(ChatGlyph(this@MainActivity, icon), LinearLayout.LayoutParams(dp(42), dp(42)))
                addView(text(title, 17f).apply { setPadding(dp(18), 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
                setOnClickListener { popup.dismiss(); action() }
            })
        }
        item(R.id.chat_menu_start, "start", "发起聊天") { showContactPicker(false) }
        item(R.id.chat_menu_group, "group", "新建群组") { showContactPicker(true) }
        item(R.id.chat_menu_friend, "friend", "添加朋友") { showAddFriend() }
        item(R.id.chat_menu_scan, "scan", "扫一扫") { startQrScanner() }
        popup.contentView = panel; popup.width = minOf(dp(230), resources.displayMetrics.widthPixels - dp(24)); popup.height = WindowManager.LayoutParams.WRAP_CONTENT
        popup.isFocusable = true; popup.isOutsideTouchable = true
        popup.elevation = dp(8).toFloat()
        popup.setBackgroundDrawable(GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(18).toFloat() })
        popup.showAsDropDown(anchor, anchor.width - popup.width, 0)
    }

    private fun showContactPicker(groupMode: Boolean) {
        chatChildActive = true
        chatHome = null
        groupCreate = null
        addFriendView = null
        val picker = ContactPickerView(this, groupMode, { mediaUrl(it) },
            back = { chatChildActive = false; showChat(currentNickname) },
            onPick = { item ->
                val userId = item.optInt("user_id")
                val token = api.token; val actorId = currentUserId; val base = apiBaseUrl; val requestedNotificationRevision = notificationRevision()
                val client = ApiClient(base).apply { this.token = token }
                executor.execute {
                    try {
                        val created = client.createDirectConversation(userId)
                        val conversation = client.openConversation(created.optInt("id")).put("name", item.optString("nickname", "私聊"))
                        runOnUiThread { if (api.token == token && currentUserId == actorId && apiBaseUrl == base) { chatChildActive = false; showChat(currentNickname, openConversation = notificationInfo(conversation, requestedNotificationRevision)) } }
                    } catch (e: Exception) { runOnUiThread { toast(contactError(e, "打开聊天失败")) } }
                }
            },
            onNext = { members -> showGroupCreate(members) }
        )
        contactPicker = picker
        setContentView(picker)
        executor.execute {
            try {
                val items = mutableListOf<JSONObject>()
                var page = 1
                while (true) {
                    val result = api.contactsPage(page++)
                    val rows = result.getJSONArray("items")
                    for (i in 0 until rows.length()) items.add(rows.getJSONObject(i))
                    val loaded = items.toList()
                    runOnUiThread { if (contactPicker === picker) picker.accept(loaded) }
                    if (rows.length() == 0 || items.size >= result.optInt("total")) break
                }
            } catch (e: Exception) { runOnUiThread { if (contactPicker === picker) picker.error(contactError(e, "加载联系人失败，请重试")) } }
        }
    }

    private fun showGroupCreate(members: List<JSONObject>) {
        val limit = groupMemberLimit
        contactPicker = null
        lateinit var create: GroupCreateView
        create = GroupCreateView(this, members, limit,
            back = { showContactPicker(true) }, onAvatar = { pickGroupAvatar() },
            onCreate = { name, selected, allow, avatarUrl ->
                executor.execute {
                    try {
                        val ids = JSONArray().apply { selected.forEach { put(it.optInt("user_id")) } }
                        val conversation = api.createGroup(name, ids, allow, avatarUrl)
                        runOnUiThread { chatChildActive = false; toast("群组已创建"); showChat(currentNickname, openConversation = conversation) }
                    } catch (e: Exception) { runOnUiThread { create.showError(contactError(e, "创建群组失败，请重试")) } }
                }
            }, resolveAvatar = { mediaUrl(it) })
        groupCreate = create; chatChildActive = true; setContentView(create)
    }

    private fun showAddFriend() {
        chatChildActive = true
        chatHome = null
        contactPicker = null
        groupCreate = null
        lateinit var view: AddFriendView
        view = AddFriendView(this, { chatChildActive = false; showChat(currentNickname) },
            onSearch = { keyword ->
                if (keyword.isBlank()) return@AddFriendView
                invalidateForceAdd()
                val token = api.token ?: return@AddFriendView; val actor = currentUserId; val base = apiBaseUrl; val revision = ++userSearchRevision
                val client = ApiClient(base).apply { this.token = token }
                fun current() = addFriendView === view && view.isAttachedToWindow && api.token == token && currentUserId == actor && apiBaseUrl == base && userSearchRevision == revision && view.query.text.toString().trim() == keyword.trim()
                executor.execute {
                    try {
                        val result = client.searchUsersPage(keyword, 1)
                        val items = result.getJSONArray("items")
                        runOnUiThread {
                            if (!current()) return@runOnUiThread
                            if (items.length() == 0) android.app.AlertDialog.Builder(this).setTitle("搜索结果").setMessage("用户不存在").setPositiveButton("知道了", null).show() else {
                                FriendSearchResultDialog(this, items, actor,
                                    loadAvatar = { image, raw -> ChatAvatars.bind(image, mediaUrl(raw)) },
                                    onAdd = { user -> if (current()) sendFriendFromSearch(user) },
                                    onMessage = if(BuildConfig.GO_BACKEND) ({ user:JSONObject -> if(current()) openTemporaryChat(user.optInt("id")) }) else null).show()
                            }
                        }
                    } catch (e: Exception) { runOnUiThread { if (current()) toast(contactError(e, "搜索用户失败")) } }
                }
            }, onQr = { showMyQr() }, onScan = { startQrScanner() })
        addFriendView = view
        setContentView(view)
    }

    private fun openTemporaryChat(peer:Int) {
        val token=api.token?:return;val actor=currentUserId;val base=apiBaseUrl
        executor.execute {
            try{val conversation=ApiClient(base).apply{this.token=token}.createDirectConversation(peer)
                runOnUiThread{if(api.token==token&&currentUserId==actor&&apiBaseUrl==base)showChat(currentNickname,openConversation=conversation)}
            }catch(e:Exception){runOnUiThread{if(api.token==token&&currentUserId==actor)toast(e.message?:"无法发起临时聊天")}}
        }
    }
    private fun sendFriendFromSearch(item: JSONObject, qrScope: QrAccountScope? = null, contactCard: JSONObject? = null, cardCurrent: (() -> Boolean)? = null) {
        val id = item.optInt("id"); val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl; val staff = currentInternalStaff
        if (id <= 0 || id == actor || (qrScope != null && !qrCurrent(qrScope)) || cardCurrent?.invoke() == false) return
        val source = findViewById<ViewGroup>(android.R.id.content).getChildAt(0) ?: return
        val surface = surfaceRevision; val search = userSearchRevision
        val query = (source as? AddFriendView)?.query?.text?.toString()
        val client = ApiClient(base).apply { this.token = token }
        fun current() = currentUserId == actor && api.token == token && apiBaseUrl == base && source.isAttachedToWindow && surfaceRevision == surface && userSearchRevision == search &&
            (query == null || (source as? AddFriendView)?.query?.text?.toString() == query) && (qrScope == null || qrCurrent(qrScope)) && cardCurrent?.invoke() != false
        if (staff) { forceAddAndShow(id, source, ::current) { result, error -> if (error != null) toast(error) else if (result != null) toast("已强制添加好友") }; return }
        executor.execute {
            if (!current()) return@execute
            try {
                val result = client.sendFriendRequest(id, cardConversationId = contactCard?.optInt("conversation_id"), cardMessageId = contactCard?.optInt("id"))
                runOnUiThread {
                    if (api.token == token && currentUserId == actor && apiBaseUrl == base && result.optString("status") == "accepted") refreshFriendChats(result.optJSONObject("friend_chat"))
                    else if (current()) toast(if (result.optBoolean("created", true)) "好友申请已发送" else "已发送过好友申请，请等待对方验证")
                }
            } catch (e: Exception) { runOnUiThread { if (current()) toast(contactError(e, "好友申请发送失败，请重试")) } }
        }
    }

    private fun invalidateForceAdd() {
        forceAddRevision++
        val old = forceAddedProfile; forceAddedProfile = null; old?.dispose()
    }

    private fun forceAddAndShow(peerId: Int, source: View, sourceCurrent: () -> Boolean, released: () -> Unit = {}, settled: (JSONObject?, String?) -> Unit) {
        val token = api.token ?: return
        val actor = currentUserId; val base = apiBaseUrl
        if (!currentInternalStaff || peerId <= 0 || peerId == actor || !sourceCurrent() || !source.isAttachedToWindow || !appForeground || appLock.locked) return
        val key = ForceAddKey(actor, token, base, peerId)
        if (!forceAddInFlight.add(key)) { released(); return }
        invalidateForceAdd()
        val request = forceAddRevision; val surface = surfaceRevision
        val client = ApiClient(base).apply { this.token = token }
        fun live() = forceAddRevision == request && surfaceRevision == surface && sourceCurrent() && source.isAttachedToWindow &&
            currentUserId == actor && api.token == token && apiBaseUrl == base && appForeground && !appLock.locked && !isFinishing && !isDestroyed
        executor.execute {
            try {
                if (!live()) { runOnUiThread { forceAddInFlight.remove(key); if (sourceCurrent()) released() }; return@execute }
                val result = client.forceAddContact(peerId)
                check(ForceAddedContactProfile.accepted(result, peerId)) { "强加好友回执无效，请刷新联系人核对" }
                runOnUiThread {
                    forceAddInFlight.remove(key)
                    if (sourceCurrent()) released()
                    if (!live()) return@runOnUiThread
                    settled(result, null)
                    lateinit var panel: ForceAddedContactProfile
                    panel = ForceAddedContactProfile(this, peerId, client, executor, { live() && forceAddedProfile === panel }, { mediaUrl(it) },
                        opened = { conversation -> if (forceAddRevision == request && surfaceRevision == surface && sourceCurrent()) showChat(currentNickname, openConversation = conversation) },
                        closed = { if (forceAddedProfile === panel) forceAddedProfile = null })
                    forceAddedProfile = panel; panel.show()
                }
            } catch (error: Exception) {
                runOnUiThread { forceAddInFlight.remove(key); if (sourceCurrent()) released(); if (live()) settled(null, contactError(error, "强加好友失败，请重试")) }
            }
        }
    }

    private fun pickGroupAvatar() {
        groupCreate?.setUploading(true)
        startActivityForResult(PhotoAlbumPickerActivity.intent(this), 42)
    }

    private fun showMyQr() {
        val profile = accountSessions.profile(currentUserId)
        val payload = if (accountSessions.activeId() == currentUserId && accountSessions.token(currentUserId) == api.token) PublicUserId.friendQr(profile?.opt("public_id")) else null
        if (payload == null) { toast("用户 ID 未就绪，请刷新个人资料后重试"); return }
        val image = try { qrBitmap(payload, dp(230)) } catch (_: Exception) { null }
        val view = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(dp(20), dp(10), dp(20), dp(10)); addView(text("用户 ID：${PublicUserId.display(profile?.opt("public_id"))}\n扫描二维码添加我为联系人", 14f, PulseColors.muted).apply { gravity = Gravity.CENTER }) }
        if (image != null) view.addView(ImageView(this).apply { id = R.id.chat_qr_image; contentDescription = "我的联系人二维码"; setImageBitmap(image); setPadding(dp(20), dp(20), dp(20), dp(20)) })
        android.app.AlertDialog.Builder(this).setTitle("我的二维码").setView(view).setPositiveButton("完成", null).show()
    }

    private fun qrBitmap(value: String, size: Int): Bitmap {
        val matrix: BitMatrix = MultiFormatWriter().encode(value, BarcodeFormat.QR_CODE, size, size)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val pixels = IntArray(size * size)
        for (y in 0 until size) for (x in 0 until size) pixels[y * size + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
        bitmap.setPixels(pixels, 0, size, 0, 0, size, size); return bitmap
    }

    private fun startQrScanner() {
        val token = api.token ?: return
        val source = findViewById<ViewGroup>(android.R.id.content).getChildAt(0) ?: return
        val scope = QrAccountScope(currentUserId, token, apiBaseUrl, ++qrRevision, source)
        qrScannerAccount = scope
        launchQrScanner(scope)
    }

    private fun qrCurrent(scope: QrAccountScope) = scope.userId > 0 && scope.revision == qrRevision &&
        currentUserId == scope.userId && api.token == scope.token && apiBaseUrl == scope.base &&
        accountSessions.activeId() == scope.userId && accountSessions.token(scope.userId) == scope.token &&
        scope.source.isAttachedToWindow && !appLock.locked && !isFinishing && !isDestroyed

    private fun launchQrScanner(scope: QrAccountScope) {
        if (!qrCurrent(scope)) return
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), qrCameraPermissionRequest)
            return
        }
        val integrator = IntentIntegrator(this)
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
        integrator.setPrompt("请对准需要识别的二维码")
        integrator.setCaptureActivity(PortraitCaptureActivity::class.java)
        integrator.setBeepEnabled(false); integrator.setOrientationLocked(true); integrator.initiateScan()
    }

    private fun handleQrContent(content: String, scope: QrAccountScope) {
        if (!qrCurrent(scope)) return
        val uri = try { Uri.parse(content).takeIf { it.isHierarchical } } catch (_: Exception) { null }
        if (uri != null && uri.scheme == "pulse" && uri.host == "add-friend") {
            val publicValues = if (uri.queryParameterNames.contains("public_id")) uri.getQueryParameters("public_id") else null
            when (val target = PublicUserId.scanned(publicValues, uri.getQueryParameter("user_id"))) {
                is PublicUserId.FriendTarget.Public -> resolveQrFriend(target.id, scope)
                is PublicUserId.FriendTarget.Legacy -> confirmQrFriend(JSONObject().put("id", target.id), scope)
                null -> toast(if (publicValues != null) "二维码中的用户 ID 无效" else "二维码中的用户信息无效")
            }
            return
        }
        val inviteCode = uri?.getQueryParameter("invite_code")
            ?: if (content.startsWith("G") && content.length >= 6) content else null
        if (inviteCode != null) {
            android.app.AlertDialog.Builder(this).setTitle("加入群组").setMessage("是否加入二维码对应的群组？")
                .setPositiveButton("加入") { _, _ -> executor.execute {
                if (!qrCurrent(scope)) return@execute
                try {
                    val joined = ApiClient(scope.base).apply { token = scope.token }.joinGroup(inviteCode)
                    runOnUiThread {
                        if (!qrCurrent(scope)) return@runOnUiThread
                        toast("已加入群组")
                        showChat(currentNickname)
                        loadConversationsAfterJoin(joined.optInt("conversation_id"))
                    }
                } catch (e: Exception) { runOnUiThread { if (qrCurrent(scope)) toast(contactError(e, "群组二维码无效或加入失败")) } }
            } }.setNegativeButton("取消", null).show()
            return
        }
        toast("无法识别此二维码")
    }

    private fun resolveQrFriend(publicId: String, scope: QrAccountScope) {
        val client = ApiClient(scope.base).apply { token = scope.token }
        executor.execute {
            if (!qrCurrent(scope)) return@execute
            try {
                val user = client.userByPublicId(publicId)
                runOnUiThread { if (qrCurrent(scope)) confirmQrFriend(user, scope) }
            } catch (e: Exception) { runOnUiThread { if (qrCurrent(scope)) toast(contactError(e, "用户 ID 查询失败，请重试")) } }
        }
    }

    private fun confirmQrFriend(user: JSONObject, scope: QrAccountScope) {
        if (!qrCurrent(scope)) return
        if (user.optInt("id") == scope.userId) { toast("这是您自己的二维码"); return }
        val publicId = PublicUserId.value(user.opt("public_id"))
        android.app.AlertDialog.Builder(this).setTitle("添加朋友")
            .setMessage("是否向此二维码对应的用户发送好友申请？" + (publicId?.let { "\n用户 ID：$it" } ?: ""))
            .setPositiveButton("添加朋友") { _, _ -> if (qrCurrent(scope)) sendFriendFromSearch(user, scope) }
            .setNegativeButton("取消", null).show()
    }

    private fun loadConversationsAfterJoin(conversationId: Int) {
        if (conversationId <= 0) return
        val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl; val revision = qrRevision
        val source = findViewById<ViewGroup>(android.R.id.content).getChildAt(0) ?: return
        val client = ApiClient(base).apply { this.token = token }
        fun current() = currentUserId == actor && api.token == token && apiBaseUrl == base && qrRevision == revision &&
            accountSessions.activeId() == actor && accountSessions.token(actor) == token && source.isAttachedToWindow && !appLock.locked
        executor.execute {
            try {
                if (!current()) return@execute
                val conversation = client.openConversation(conversationId)
                runOnUiThread { if (current()) showChat(currentNickname, openConversation = conversation) }
            } catch (e: Exception) {
                runOnUiThread { if (current()) toast(contactError(e, "已加入群组，打开会话失败，请在我的群组中重试")) }
            }
        }
    }

    private fun searchChatMessages(keyword: String) {
        suppressHomeBackUntil = android.os.SystemClock.elapsedRealtime() + 3000L
        val query = keyword.trim()
        if (query.isBlank()) {
            toast("请输入要搜索的内容")
            return
        }
        invalidateForceAdd()
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl; val revision = ++userSearchRevision
        val source = findViewById<ViewGroup>(android.R.id.content).getChildAt(0) ?: return
        val client = ApiClient(base).apply { this.token = token }
        fun current() = currentUserId == actor && api.token == token && apiBaseUrl == base && userSearchRevision == revision && source.isAttachedToWindow
        executor.execute {
            try {
                val result = client.searchMessages(query)
                val users = client.searchUsersPage(query, 1).getJSONArray("items")
                val items = result.optJSONArray("items") ?: JSONArray()
                val conversations = client.conversations()
                val names = mutableMapOf<Int, JSONObject>()
                for (i in 0 until conversations.length()) {
                    val conversation = conversations.getJSONObject(i)
                    names[conversation.optInt("id")] = conversation
                }
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    if (items.length() == 0 && users.length() == 0) {
                        toast("没有找到相关消息或用户")
                        return@runOnUiThread
                    }
                    val labels = Array(users.length() + items.length()) { index ->
                        if (index < users.length()) {
                            val user = users.getJSONObject(index)
                            "用户：${user.optString("nickname")}\n用户 ID：${PublicUserId.display(user.opt("public_id"))}"
                        } else {
                        val message = items.getJSONObject(index - users.length())
                        val text = messageSummary(message, currentUserId, getString(R.string.app_name))
                        val sender = message.optString("sender_nickname", "用户")
                        val conversationName = names[message.optInt("conversation_id")]?.optString("name").orEmpty().ifBlank { "聊天" }
                        "$conversationName  ·  $sender\n$text"
                        }
                    }
                    android.app.AlertDialog.Builder(this)
                        .setTitle("搜索结果")
                        .setItems(labels) { _, which ->
                            if (!current()) return@setItems
                            if (which < users.length()) sendFriendFromSearch(users.getJSONObject(which))
                            else openExistingChat(items.getJSONObject(which - users.length()).optInt("conversation_id"))
                        }
                        .setNegativeButton("关闭", null)
                        .show()
                }
            } catch (e: Exception) {
                runOnUiThread { if (current()) toast(contactError(e, "搜索聊天记录失败，请重试")) }
            }
        }
    }

    private fun openExistingChat(conversationId: Int) = openExistingChat(conversationId, null)
    private fun openExistingChat(conversationId: Int, summary: JSONObject?) {
        if (conversationId <= 0 || isFinishing || isDestroyed || appLock.locked) return
        val token = api.token ?: return
        pendingChatEntry?.takeIf { it.id == conversationId && it.actor == currentUserId && it.token == token && it.base == apiBaseUrl }?.let { return }
        val origin = contactsView
        val entry = ChatEntry(conversationId, currentUserId, token, apiBaseUrl)
        val requestedNotificationRevision = notificationRevision()
        cancelPendingChatEntry(); cancelChatHistory()
        if (origin != null) chatReturnPage = origin.page
        clearExplore(leave = true); myFeature?.close(); closeGroupChatOverlays()
        activeConversationId = 0; currentMessages = null; chatHome = null; contactsView = null
        tasksVisible = false; taskChildActive = false; chatChildActive = true
        entry.view = ChatOpeningView(this, summary?.optString("name").orEmpty(),
            back = { if (pendingChatEntry === entry) { cancelPendingChatEntry(); returnFromChat() } },
            retry = { if (pendingChatEntry === entry) { cancelPendingChatEntry(); openExistingChat(conversationId, summary) } })
        pendingChatEntry = entry
        configureAuthChrome(false)
        window.statusBarColor = Color.WHITE; window.navigationBarColor = Color.WHITE
        setContentView(entry.view)
        diagnostics.record("chat.open_start")
        fun current() = pendingChatEntry === entry && api.token == entry.token && currentUserId == entry.actor &&
            apiBaseUrl == entry.base && (entry.view.isAttachedToWindow || (entry.localVisible && activeConversationId == entry.id)) && !isFinishing && !isDestroyed
        val localScope = LocalChatStore.scope(entry.base, entry.actor, entry.token)
        LocalChatArchive.bind(localScope)
        LocalChatArchive.disk.execute {
            val cached = runCatching { LocalChatStore.read(this, localScope, entry.id, limit = 20) }.getOrNull()
            val cachedSummary = summary?.takeIf { it.optInt("id") == entry.id && it.optString("type") in listOf("direct", "group", "channel", "favorites") }
            val expectedMembership=cachedSummary?.optString("membership_version").orEmpty()
            val usable=if(BuildConfig.GO_BACKEND&&expectedMembership.isNotBlank()&&cached?.info?.optString("membership_version")!=expectedMembership) null else cached
            entry.cached = usable
            val localInfo = (usable?.info ?: cachedSummary)?.let { JSONObject(it.toString()) }
            // A newer directory can already know about a mute that predates the
            // last opened history page. Never loosen a known restriction offline.
            if (localInfo != null && cachedSummary != null) {
                val restriction = ChatSendPermission.from(cachedSummary, localInfo.optString("type"))
                if (!restriction.allowed) localInfo.put("can_send", false).put("send_disabled_reason", restriction.reason)
            }
            runOnUiThread {
                val denied = (entry.failure as? ClientApiException)?.status in listOf(401, 403)
                if (current() && !denied && localInfo != null) { entry.localVisible = true; entry.transitioning = true
                    preparedChatHistory = entry
                    showChat(currentNickname, openConversation = JSONObject(localInfo.toString()).put("_local_pending", true))
                    entry.transitioning = false
                    if (entry.failure != null) findViewById<TextView>(R.id.chat_history_error)?.apply {
                        text = "已显示本地记录，连接失败，点击重试"; visibility = View.VISIBLE
                        setOnClickListener { cancelPendingChatEntry(); openExistingChat(entry.id, summary) }
                    }
                }
            }
        }
        // The cached view is read-only until /open confirms current membership.
        chatLoadExecutor.execute {
            try {
                val ticket = runCatching { LocalChatStore.ticket(this, localScope, entry.id) }.getOrNull()
                val page = ApiClient(entry.base).apply { this.token = entry.token; requestScope = entry.calls }.historyPage(entry.id, size = 20)
                if (!entry.calls.cancelled && currentUserId == entry.actor && api.token == entry.token && apiBaseUrl == entry.base) {
                    if (ticket != null) runCatching { LocalChatArchive.save(this, ticket, page) }
                    entry.page.complete(page)
                }
            }
            catch (error: Exception) { entry.page.completeExceptionally(error) }
        }
        chatLoadExecutor.execute {
            try {
                val conversation = ApiClient(entry.base).apply { this.token = entry.token; requestScope = entry.calls }.openConversation(entry.id)
                require(conversation.optInt("id") == entry.id && conversation.optString("type") in listOf("direct", "group", "channel", "favorites")) { "会话响应无效" }
                LocalChatArchive.disk.execute {
                    if (!entry.calls.cancelled && api.token == entry.token && currentUserId == entry.actor && apiBaseUrl == entry.base) runCatching {
                        LocalChatStore.merge(this, LocalChatStore.ticket(this, localScope, entry.id), emptyList(), info = conversation)
                    }
                }
                runOnUiThread {
                    if (!current()) { entry.calls.cancel(); entry.page.cancel(false); return@runOnUiThread }
                    pendingChatEntry = null; preparedChatHistory = entry
                    if (entry.localVisible) activeHistoryRequests = null
                    showChat(currentNickname, openConversation = notificationInfo(conversation, requestedNotificationRevision))
                }
            } catch (error: Exception) {
                entry.failure = error
                entry.calls.cancel(); entry.page.cancel(false)
                if (error is ClientApiException && error.status in listOf(401, 403)) LocalChatArchive.disk.execute { LocalChatStore.clearConversation(this, localScope, entry.id); LocalMediaCache.purge(this, localScope, entry.id) }
                runOnUiThread { if (current()) {
                    diagnostics.fault("ANDROID_CHAT_OPEN", error)
                    if (entry.localVisible) {
                        if (error is ClientApiException && error.status in listOf(401, 403)) { cancelPendingChatEntry(); returnFromChat(); toast("当前会话不可访问") }
                        else findViewById<TextView>(R.id.chat_history_error)?.apply {
                            text = "已显示本地记录，连接失败，点击重试"; visibility = View.VISIBLE
                            setOnClickListener { cancelPendingChatEntry(); openExistingChat(entry.id, summary) }
                        }
                    } else (entry.view as? ChatOpeningView)?.showError(contactError(error, "打开聊天失败，请重试"))
                } }
            }
        }
    }

    private fun navigateTab(tab: String) {
        if (tab == "chat" && chatHome?.isAttachedToWindow == true) return
        if (tab == "contacts" && contactsView?.takeIf { it.page == ContactsView.Page.CONTACTS }?.isAttachedToWindow == true) return
        chatHome?.leaveTab()
        taskPageGeneration++
        tasksVisible = false
        taskChildActive = false
        when (tab) {
            "contacts" -> showContacts()
            else -> { chatReturnPage = null; showChat(currentNickname, tab) }
        }
    }

    private fun showExplore() {
        if (!exploreVisible || !appForeground || appLock.locked || !::content.isInitialized || api.token == null || isFinishing || isDestroyed) return
        explorePanel?.let { it.updateLinks(exploreLinks); return }
        val actor = currentUserId; val token = api.token; val base = apiBaseUrl
        lateinit var panel: ExplorePanel
        panel = ExplorePanel(this) {
            explorePanel === panel && exploreVisible && appForeground && !appLock.locked &&
                currentUserId == actor && api.token == token && apiBaseUrl == base && !isFinishing && !isDestroyed
        }
        explorePanel = panel
        content.removeAllViews(); content.addView(panel, LinearLayout.LayoutParams(-1, -1))
        // A newly attached panel must own the page before the WebView starts loading.
        panel.post { if (explorePanel === panel) panel.updateLinks(exploreLinks) }
    }

    private fun restoreExplore() {
        if (exploreVisible && explorePanel == null) showExplore()
    }

    private fun clearExplore(leave: Boolean = false) {
        val old = explorePanel; explorePanel = null; old?.dispose()
        if (leave) exploreVisible = false
    }

    private fun showTasks(openTaskId: Int = 0) {
        val token = api.token ?: return
        val actorId = currentUserId
        val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }
        taskVerificationDialog?.dismiss(); taskVerificationDialog = null
        taskChildActive = false
        taskHeader?.visibility = View.VISIBLE
        taskNavigation?.visibility = View.VISIBLE
        taskRoleBadge?.apply { text = "身份加载中"; contentDescription = "当前员工身份，正在从后台读取" }
        content.removeAllViews()
        val generation = ++taskPageGeneration
        val scroll = ScrollView(this).apply { setBackgroundColor(PulseColors.background) }
        val list = column(16)
        list.addView(text("正在加载任务…", 14f, PulseColors.muted).apply { setPadding(0, dp(25), 0, dp(25)); gravity = Gravity.CENTER })
        scroll.addView(list); content.addView(scroll, LinearLayout.LayoutParams(-1, -1))
        fun current() = generation == taskPageGeneration && api.token == token && currentUserId == actorId && apiBaseUrl == base && tasksVisible && list.isAttachedToWindow && !isFinishing && !isDestroyed
        executor.execute {
            try {
                val data = client.workTasks()
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    list.removeAllViews()
                    val employeeType = if (jsonText(data, "employee_type") == "formal") "formal" else "intern"
                    taskRoleBadge?.apply {
                        text = if (employeeType == "formal") "正式员工" else "实习员工"
                        contentDescription = "当前员工身份：$text，由后台设置"
                    }
                    val items = data.getJSONArray("items")
                    if (items.length() == 0) list.addView(text("暂无工作任务", 15f, PulseColors.muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(70), 0, 0) })
                    for (i in 0 until items.length()) {
                        val task = items.getJSONObject(i)
                        val unit = task.optDouble(if (employeeType == "formal") "formal_unit_price" else "intern_unit_price")
                        val record = task.optJSONObject("record")
                        val questionCount = record?.optInt("total_questions", task.optInt("question_count")) ?: task.optInt("question_count")
                        val expectedWage = (record?.optDouble("unit_price", unit) ?: unit) * questionCount
                        list.addView(column(0).apply {
                            setPadding(dp(16), dp(14), dp(16), dp(14)); background = rounded(Color.WHITE, 10)
                            addView(row().apply {
                                addView(text(task.optString("name"), 16f, PulseColors.ink).apply { typeface = Typeface.DEFAULT_BOLD }, LinearLayout.LayoutParams(0, -2, 1f))
                                addView(text(task.optString("status_label", "未开始"), 12f, if (task.optString("status") == "reviewed") PulseColors.accent else 0xFF6B7D9A.toInt()).apply { background = rounded(PulseColors.accentSoft, 12); setPadding(dp(9), dp(5), dp(9), dp(5)) })
                            })
                            addView(text("预计 ${task.optInt("estimated_minutes")} 分钟　开放时间 ${task.optString("open_time")}", 12f, PulseColors.muted).apply { setPadding(0, dp(10), 0, 0) })
                            val description = task.optString("description")
                            if (description.isNotBlank()) addView(text(description, 13f, PulseColors.muted).apply { setPadding(0, dp(8), 0, dp(8)) })
                            addView(row().apply {
                                addView(text("$questionCount 道题", 12f, PulseColors.muted), LinearLayout.LayoutParams(0, -2, 1f))
                                addView(text(if (record?.optString("status") == "reviewed") "工资收入 ¥${"%.2f".format(java.util.Locale.US, record.optDouble("wage"))}" else "预计工资 ¥${"%.3f".format(expectedWage)}", 14f, PulseColors.accent).apply { typeface = Typeface.DEFAULT_BOLD })
                            })
                            setOnClickListener { if (current()) showTasks(task.optInt("id")) }
                        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
                    }
                    if (openTaskId > 0) {
                        val task = (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull { it.optInt("id") == openTaskId }
                        if (task == null) toast("任务已更新，请重新选择")
                        else if (task.optString("status") == "not_started") toast("任务尚未开放，请在 ${task.optString("open_time")} 后开始")
                        else {
                            val record = task.optJSONObject("record")
                            val recordEmployeeType = record?.let { jsonText(it, "employee_type") }.takeIf { it == "formal" || it == "intern" }
                            showTaskVerificationDialog(task, generation, recordEmployeeType ?: employeeType, record != null, client, actorId, base)
                        }
                    }
                }
            } catch (e: Exception) { runOnUiThread { if (current()) { taskRoleBadge?.apply { text = "身份未加载"; contentDescription = "员工身份读取失败，请刷新任务" }; list.removeAllViews(); list.addView(text(contactError(e, "任务加载失败"), 14f, PulseColors.danger)); list.addView(Button(this).apply { text = "重新加载"; setOnClickListener { showTasks() } }) } } }
        }
    }

    private fun showTaskVerificationDialog(task: JSONObject, generation: Int, employeeType: String, existingRecord: Boolean, client: ApiClient, actorId: Int, base: String) {
        val token = client.token ?: return
        fun current() = generation == taskPageGeneration && api.token == token && currentUserId == actorId && apiBaseUrl == base && tasksVisible && !isFinishing && !isDestroyed
        if (!current()) return
        val dialog = BackSwipeDialog(this)
        taskVerificationDialog = dialog
        dialog.setOnDismissListener { if (taskVerificationDialog === dialog) taskVerificationDialog = null }
        val box = column(0).apply {
            setPadding(dp(22), dp(20), dp(22), dp(18))
            background = rounded(PulseColors.surface, 18)
        }
        box.addView(text("${task.optString("name")} 验证码", 19f, PulseColors.ink).apply { typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER })
        val role = if (employeeType == "formal") "正式员工" else "实习员工"
        box.addView(text(if (existingRecord) "本次作业：$role（开工时身份）" else "当前身份：$role（由后台设置）", 13f, PulseColors.muted).apply {
            id = R.id.work_verification_employee_type; gravity = Gravity.CENTER; setPadding(0, dp(8), 0, 0)
        })
        box.addView(text("请输入后台当天设置的 6 位验证码", 13f, PulseColors.muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(6), 0, dp(18)) })
        val fields = Array(6) { index ->
            EditText(this).apply {
                tag = index
                inputType = InputType.TYPE_CLASS_NUMBER
                filters = arrayOf(android.text.InputFilter.LengthFilter(1))
                textSize = 22f
                gravity = Gravity.CENTER
                contentDescription = "验证码第 ${index + 1} 位"
                setTextColor(PulseColors.ink)
                setPadding(0, 0, 0, 0)
                background = rounded(PulseColors.background, 10)
                layoutParams = LinearLayout.LayoutParams(0, dp(54), 1f).apply { if (index > 0) leftMargin = dp(7) }
            }
        }
        val codeRow = row().apply { gravity = Gravity.CENTER }
        fields.forEach { codeRow.addView(it) }
        box.addView(codeRow)
        val error = text("", 12f, PulseColors.danger).apply { gravity = Gravity.CENTER; setPadding(0, dp(10), 0, dp(4)) }
        box.addView(error)
        val verify = Button(this).apply { text = "验证进入"; isAllCaps = false; setTextColor(Color.WHITE); background = rounded(PulseColors.accent, 10) }
        box.addView(verify, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(8) })
        val cancel = Button(this).apply { text = "取消"; isAllCaps = false; setTextColor(PulseColors.muted); background = ColorDrawable(Color.TRANSPARENT) }
        box.addView(cancel, LinearLayout.LayoutParams(-1, dp(44)).apply { topMargin = dp(2) })
        var busy = false
        fun codeValue(): String = fields.joinToString("") { it.text?.toString().orEmpty() }
        fun verifyCode() {
            if (!current()) { dialog.dismiss(); return }
            if (busy) return
            val code = codeValue()
            if (code.length != 6) { error.text = "请输入完整的 6 位验证码"; return }
            busy = true
            fields.forEach { it.isEnabled = false }
            verify.isEnabled = false
            verify.text = "验证中…"
            error.text = ""
            executor.execute {
                try {
                    val payload = client.startWorkTask(task.optInt("id"), code)
                    if (payload.getJSONObject("record").optInt("user_id") != actorId) throw IllegalStateException("任务记录账号不一致，请刷新后重试")
                    runOnUiThread {
                        if (!current() || !dialog.isShowing) return@runOnUiThread
                        dialog.dismiss()
                        if (payload.getJSONObject("record").optString("status") == "in_progress") showWorkTaskAnswer(payload) else showWorkTaskSettlement(payload)
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        if (!current() || !dialog.isShowing) return@runOnUiThread
                        busy = false
                        fields.forEach { it.isEnabled = true }
                        verify.isEnabled = true
                        verify.text = "验证进入"
                        error.text = contactError(e, "验证码校验失败")
                        fields.forEach { it.setText("") }
                        fields.firstOrNull()?.requestFocus()
                    }
                }
            }
        }
        fields.forEachIndexed { index, field ->
            field.addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    if (s?.length == 1 && index < fields.lastIndex) fields[index + 1].requestFocus()
                    if (index == fields.lastIndex && codeValue().length == fields.size) verifyCode()
                }
                override fun afterTextChanged(s: android.text.Editable?) = Unit
            })
        }
        verify.setOnClickListener { verifyCode() }
        cancel.setOnClickListener { dialog.dismiss() }
        dialog.setContentView(box)
        dialog.setOnShowListener {
            dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            dialog.window?.setDimAmount(0.34f)
            dialog.window?.setLayout((resources.displayMetrics.widthPixels * 0.86f).toInt(), WindowManager.LayoutParams.WRAP_CONTENT)
            dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
            fields.firstOrNull()?.requestFocus()
        }
        dialog.show()
        dialog.window?.setLayout((resources.displayMetrics.widthPixels * 0.86f).toInt(), WindowManager.LayoutParams.WRAP_CONTENT)
    }

    private fun showWorkTaskAnswer(payload: JSONObject) {
        taskPageGeneration++
        val generation = taskPageGeneration
        taskChildActive = true
        taskHeader?.visibility = View.GONE
        taskNavigation?.visibility = View.GONE
        content.removeAllViews()
        val record = payload.getJSONObject("record")
        val questions = payload.getJSONArray("questions")
        val answers = JSONObject(payload.optJSONObject("answers")?.toString() ?: "{}")
        val saved = try { JSONObject(preferences.getString("work_answers_${currentUserId}_${record.optInt("id")}", "{}") ?: "{}") } catch (_: Exception) { JSONObject() }
        for (i in 0 until questions.length()) { val key = questions.getJSONObject(i).optString("question_uuid"); if (saved.has(key)) answers.put(key, saved.optBoolean(key)) }
        var index = 0
        var saving = false
        val wrapper = column(0)
        val imageActor = currentUserId; val imageToken = api.token; val imageBase = apiBaseUrl
        val top = row().apply { setPadding(dp(4), 0, dp(4), 0) }
        val title = text("工作任务", 17f, PulseColors.ink).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }
        val sheet = text("答题列表", 13f, PulseColors.accent).apply { id = R.id.work_answer_sheet; setPadding(dp(12), dp(14), dp(8), dp(14)) }
        top.addView(iconButton("‹") { showTasks() }, LinearLayout.LayoutParams(dp(38), dp(48)))
        top.addView(title, LinearLayout.LayoutParams(0, dp(48), 1f)); top.addView(sheet)
        wrapper.addView(top)
        val progress = text("", 13f, PulseColors.muted).apply { id = R.id.work_progress; gravity = Gravity.CENTER; setPadding(0, dp(14), 0, dp(14)) }
        wrapper.addView(progress)
        val image = QuestionImagePanel(this, imageExecutor, { resolveTaskImageUrl(it) }, {
            generation == taskPageGeneration && currentUserId == imageActor && api.token == imageToken && apiBaseUrl == imageBase &&
                tasksVisible && taskChildActive && wrapper.isAttachedToWindow && !isFinishing && !isDestroyed
        })
        workQuestionImagePanel = image
        wrapper.addView(image, LinearLayout.LayoutParams(-1, 0, 1f).apply { leftMargin = dp(8); rightMargin = dp(8) })
        val choices = row().apply { setPadding(dp(18), dp(18), dp(18), dp(12)) }
        val yes = Button(this).apply { id = R.id.work_answer_yes; text = "对"; textSize = 20f; isAllCaps = false }
        val no = Button(this).apply { id = R.id.work_answer_no; text = "错"; textSize = 20f; isAllCaps = false }
        choices.addView(yes, LinearLayout.LayoutParams(0, dp(58), 1f).apply { rightMargin = dp(8) }); choices.addView(no, LinearLayout.LayoutParams(0, dp(58), 1f).apply { leftMargin = dp(8) }); wrapper.addView(choices)
        val submit = Button(this).apply { id = R.id.work_submit; text = "提交结算"; setTextColor(Color.WHITE); background = rounded(PulseColors.accent, 10) }
        wrapper.addView(submit, LinearLayout.LayoutParams(-1, dp(50)).apply { leftMargin = dp(18); rightMargin = dp(18); bottomMargin = dp(14); topMargin = dp(4) })
        content.addView(wrapper, LinearLayout.LayoutParams(-1, -1))
        fun renderQuestion() {
            if (questions.length() == 0) return
            val question = questions.getJSONObject(index); val uuid = question.optString("question_uuid")
            progress.text = "第 ${index + 1} / ${questions.length()} 题　已答 ${answers.length()} 题"
            submit.visibility = if (answers.length() == questions.length()) View.VISIBLE else View.GONE
            val selected = if (answers.has(uuid)) answers.optBoolean(uuid) else null
            yes.setTextColor(if (selected == true) Color.WHITE else PulseColors.accent); yes.background = rounded(if (selected == true) PulseColors.accent else PulseColors.accentSoft, 10)
            no.setTextColor(if (selected == false) Color.WHITE else PulseColors.danger); no.background = rounded(if (selected == false) PulseColors.danger else 0xFFFFECEE.toInt(), 10)
            image.bind(uuid, question.optString("image_url"), "第 ${index + 1} / ${questions.length()} 题")
        }
        fun choose(value: Boolean) {
            if (saving || !submit.isEnabled) return
            val key = questions.getJSONObject(index).optString("question_uuid")
            answers.put(key, value); preferences.edit().putString("work_answers_${currentUserId}_${record.optInt("id")}", answers.toString()).apply()
            saving = true; yes.isEnabled = false; no.isEnabled = false; submit.isEnabled = false
            executor.execute {
                var error: String? = null
                try { api.saveWorkTaskAnswers(record.optInt("id"), JSONObject().put(key, value)) } catch (e: Exception) { error = contactError(e, "进度同步失败，已保存在本机") }
                runOnUiThread {
                    if (generation != taskPageGeneration || !wrapper.isAttachedToWindow) return@runOnUiThread
                    saving = false; yes.isEnabled = true; no.isEnabled = true; submit.isEnabled = true
                    if (error != null) toast(error)
                    if (index < questions.length() - 1) index++
                    renderQuestion()
                }
            }
        }
        yes.setOnClickListener { choose(true) }; no.setOnClickListener { choose(false) }
        sheet.setOnClickListener { showWorkAnswerSheet(questions, answers, index) { selected -> index = selected; renderQuestion() } }
        submit.setOnClickListener {
            if ((0 until questions.length()).any { !answers.has(questions.getJSONObject(it).optString("question_uuid")) }) { toast("请完成全部题目后再提交"); return@setOnClickListener }
            android.app.AlertDialog.Builder(this).setTitle("提交作业").setMessage("提交后无法继续修改答案，确定提交吗？").setPositiveButton("提交") { _, _ ->
                submit.isEnabled = false
                val submittedAnswers = JSONObject(answers.toString()); yes.isEnabled = false; no.isEnabled = false
                executor.execute { try { val result = api.submitWorkTask(record.optInt("id"), submittedAnswers); preferences.edit().remove("work_answers_${currentUserId}_${record.optInt("id")}").apply(); runOnUiThread { if (generation == taskPageGeneration && wrapper.isAttachedToWindow) showWorkTaskSettlement(result) } } catch (e: Exception) { runOnUiThread { if (generation == taskPageGeneration && wrapper.isAttachedToWindow) { submit.isEnabled = true; yes.isEnabled = true; no.isEnabled = true; toast(contactError(e, "提交失败，请重试")) } } } }
            }.setNegativeButton("继续答题", null).show()
        }
        renderQuestion()
    }

    private fun showWorkAnswerSheet(questions: JSONArray, answers: JSONObject, currentIndex: Int, onSelected: (Int) -> Unit) {
        val dialog = BackSwipeDialog(this)
        val sheet = column(0).apply {
            setPadding(dp(20), dp(16), dp(20), dp(18))
            background = rounded(PulseColors.surface, 20)
        }
        sheet.addView(row().apply {
            addView(text("答题列表", 18f, PulseColors.ink).apply { typeface = Typeface.DEFAULT_BOLD }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(text("${answers.length()}/${questions.length()}", 13f, PulseColors.accent).apply { gravity = Gravity.CENTER_VERTICAL })
        })
        sheet.addView(text("已答题目为蓝色，未答题目为灰色", 12f, PulseColors.muted).apply { setPadding(0, dp(2), 0, dp(14)) })
        val scroll = ScrollView(this)
        val grid = GridLayout(this).apply { columnCount = 5; alignmentMode = GridLayout.ALIGN_BOUNDS; useDefaultMargins = false }
        val answerBlue = 0xFF2F80ED.toInt()
        val answerBlueSoft = 0xFFE8F1FF.toInt()
        for (i in 0 until questions.length()) {
            val key = questions.getJSONObject(i).optString("question_uuid")
            val answered = answers.has(key)
            val cell = TextView(this).apply {
                text = "${i + 1}"
                textSize = 16f
                gravity = Gravity.CENTER
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (answered) answerBlue else PulseColors.muted)
                background = rounded(if (answered) answerBlueSoft else 0xFFF0F2F4.toInt(), 10).apply {
                    if (i == currentIndex) setStroke(dp(2), answerBlue)
                }
                contentDescription = "第 ${i + 1} 题，${if (answered) "已答" else "未答"}"
                setOnClickListener { dialog.dismiss(); onSelected(i) }
            }
            grid.addView(cell, GridLayout.LayoutParams().apply {
                width = 0; height = dp(54); columnSpec = GridLayout.spec(i % 5, 1f); rowSpec = GridLayout.spec(i / 5)
                setMargins(dp(4), dp(4), dp(4), dp(4))
            })
        }
        scroll.addView(grid)
        sheet.addView(scroll, LinearLayout.LayoutParams(-1, dp(260)))
        val close = Button(this).apply { text = "关闭"; isAllCaps = false; setTextColor(PulseColors.muted); background = ColorDrawable(Color.TRANSPARENT); setOnClickListener { dialog.dismiss() } }
        sheet.addView(close, LinearLayout.LayoutParams(-1, dp(44)).apply { topMargin = dp(4) })
        dialog.setContentView(sheet)
        dialog.setOnShowListener {
            dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            dialog.window?.setDimAmount(0.30f)
            dialog.window?.setGravity(Gravity.BOTTOM)
            dialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
        }
        dialog.show()
        dialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
    }

    private fun resolveTaskImageUrl(raw: String): String = mediaUrl(if (raw.startsWith("/")) URL(URL(apiBaseUrl), raw).toString() else raw)

    private fun showWorkTaskSettlement(payload: JSONObject) {
        if (!WorkTaskSettlement.complete(payload)) { toast("未能取得完整结算结果，请重新获取"); showTasks(); return }
        val token = api.token ?: return
        val actor = currentUserId; val base = apiBaseUrl
        taskPageGeneration++
        val generation = taskPageGeneration
        taskChildActive = true
        taskHeader?.visibility = View.GONE
        taskNavigation?.visibility = View.GONE
        taskSettlementDialog?.dismiss()
        val recordId = payload.getJSONObject("record").getInt("id")
        fun current() = taskPageGeneration == generation && api.token == token && currentUserId == actor && apiBaseUrl == base && tasksVisible && !isFinishing && !isDestroyed
        val dialog = WorkTaskSettlementDialog(this, payload, currentNickname,
            loadAvatar = { avatar, raw ->
                if (raw.isNotBlank()) {
                    val resolved = resolveTaskImageUrl(raw)
                    imageExecutor.execute {
                        try {
                            val connection = URL(resolved).openConnection().apply { connectTimeout = 8000; readTimeout = 12000 }
                            val bitmap = connection.getInputStream().use { BitmapFactory.decodeStream(it) }
                            runOnUiThread { if (current() && avatar.isAttachedToWindow) avatar.setImageBitmap(bitmap) }
                        } catch (_: Exception) { /* Keep the native nickname avatar. */ }
                    }
                }
            },
            onConfirm = { if (current()) showTasks() })
        taskSettlementDialog = dialog
        dialog.setOnDismissListener { if (taskSettlementDialog === dialog) taskSettlementDialog = null }
        dialog.show()
    }
    private fun loadConversations(list: LinearLayout, nickname: String) {
        activeConversationId = 0
        currentMessages = null
        executor.execute {
            try {
                val conversations = api.conversations()
                runOnUiThread {
                    if (!list.isAttachedToWindow || contactsView != null) return@runOnUiThread
                    list.removeAllViews()
                    var pendingView: View? = null
                    if (conversations.length() == 0) {
                        list.addView(text("还没有会话", 16f, PulseColors.muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(80), 0, 0) })
                    }
                    for (i in 0 until conversations.length()) {
                        val item = conversations.getJSONObject(i)
                        val id = item.getInt("id")
                        val type = item.optString("type")
                        val unread = item.optInt("unread_count")
                        val name = item.optString("name").ifBlank { if (type == "direct") "私聊" else "会话" }
                        val card = conversationCard(name, type, unread) {
                            chatReturnPage = null
                            activeConversationId = id
                            activeConversationType = type
                            loadHistory(name, item)
                        }
                        card.setOnLongClickListener {
                            if (type == "group") {
                                activeConversationId = id
                                activeConversationType = type
                                showGroupMembers()
                                true
                            } else false
                        }
                        list.addView(card)
                        if (id == pendingOpenConversationId) pendingView = card
                    }
                    if (pendingOpenConversationId > 0) {
                        pendingOpenConversationId = 0
                        pendingView?.performClick()
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { toast(e.message ?: "加载会话失败") }
            }
        }
    }

    private fun conversationCard(name: String, type: String, unread: Int, action: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14), dp(12), dp(14), dp(12))
        background = rounded(PulseColors.surface, 18)
        elevation = dp(1).toFloat()
        layoutParams = LinearLayout.LayoutParams(-1, dp(78)).apply { setMargins(dp(12), dp(6), dp(12), dp(2)) }
        val avatar = TextView(this@MainActivity).apply {
            text = name.take(1).uppercase()
            textSize = 18f
            gravity = Gravity.CENTER
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            background = rounded(if (type == "group") 0xFF7B74D8.toInt() else PulseColors.accent, 18)
            layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
        }
        addView(avatar)
        addView(column(0).apply {
            layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { setMargins(dp(12), 0, dp(8), 0) }
            addView(text(name, 16f, PulseColors.ink).apply { typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, dp(4)) })
            addView(text(if (type == "group") "群组会话" else if (type == "channel") "频道" else "最近消息", 12f, PulseColors.muted).apply { setPadding(0, 0, 0, 0) })
        })
        if (unread > 0) addView(text(if (unread > 99) "99+" else unread.toString(), 11f, Color.WHITE).apply { gravity = Gravity.CENTER; background = rounded(PulseColors.accent, 12); setPadding(dp(7), dp(3), dp(7), dp(3)) })
        setOnClickListener { action() }
    }
    private fun navButton(icon: String, label: String, action: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        layoutParams = LinearLayout.LayoutParams(0, dp(58), 1f)
        setPadding(0, dp(4), 0, 0)
        addView(text(icon, 18f, PulseColors.accent).apply { gravity = Gravity.CENTER; setPadding(0, 0, 0, 0) })
        addView(text(label, 11f, PulseColors.muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(2), 0, 0) })
        setOnClickListener { action() }
    }

    private fun iconButton(label: String, action: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 25f
        gravity = Gravity.CENTER
        setTextColor(PulseColors.ink)
        background = rounded(Color.WHITE, 18)
        layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
        setOnClickListener { action() }
    }
    private fun showContacts(initialPage: ContactsView.Page = ContactsView.Page.CONTACTS) {
        prepareHomeTabs()
        ChatAvatars.account(apiBaseUrl, currentUserId, api.token)
        LocalChatArchive.bind(LocalChatStore.scope(apiBaseUrl, currentUserId, api.token))
        clearExplore(leave = true)
        myFeature?.close()
        configureAuthChrome(false)
        window.statusBarColor = Color.WHITE
        window.navigationBarColor = Color.WHITE
        activeConversationId = 0
        leaveContactsOnBack = false
        currentMessages = null
        conversationList = null
        chatHome = null
        chatChildActive = false
        groupCreate = null
        contactPicker = null
        addFriendView = null
        lateinit var view: ContactsView
        view = retainedContacts ?: ContactsView(this, currentUserId,
            onLoad = { page, number, keyword, version -> loadContactsPage(view, page, number, keyword, version) },
            onAdd = { user -> sendContactRequest(user) },
            onRequest = { request, action -> handleContactRequest(request, action) },
            onContact = { user -> openDirectChat(user.getInt("user_id"), user.optString("nickname", "私聊")) },
            onConversation = { conversation ->
                chatReturnPage = contactsView?.page
                openExistingChat(conversation.optInt("id"), conversation)
            },
            onMenu = { anchor, page -> showContactsMenu(anchor, page) },
            onNavigate = { navigateTab(it) },
            showMemberCount = { showGroupMemberCount },
            resolveAvatar = { mediaUrl(it) }
        )
        retainedContacts = view; contactsView = view
        (view.parent as? ViewGroup)?.removeView(view)
        setContentView(view)
        connectSocket()
        if (view.page != initialPage) view.showPage(initialPage) else view.refreshIfNeeded()
    }

    private fun loadContactsPage(view: ContactsView, page: ContactsView.Page, number: Int, keyword: String, version: Int) {
        if (!retains(view) || isFinishing || isDestroyed) return
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }
        fun current() = retains(view) && view.version == version && api.token == token && currentUserId == actor && apiBaseUrl == base && !isFinishing && !isDestroyed
        val kind = directoryKind(page)
        val restoreFirst = kind != null && number == 1 && !view.loadState.hasSnapshot
        if (kind != null && number == 1) localDirectories.refresh(kinds = setOf(kind))
        if (contactsView === view && view.isAttachedToWindow) window.navigationBarColor = if (page in listOf(ContactsView.Page.GROUPS, ContactsView.Page.CHANNELS)) CHAT_BG else Color.WHITE
        fun fetchPage() {
            if (!current()) return
            contactsExecutor.execute {
                try {
                    val result = when (page) {
                        ContactsView.Page.CONTACTS -> client.contactsPage(number)
                        ContactsView.Page.SEARCH -> client.searchUsersPage(keyword, number)
                        ContactsView.Page.REQUESTS -> client.friendRequestsPage(number)
                        ContactsView.Page.GROUPS -> client.conversationsPage("group", number)
                        ContactsView.Page.CHANNELS -> client.conversationsPage("channel", number)
                    }
                    runOnUiThread {
                        if (current()) {
                            view.acceptPage(result, version)
                        }
                    }
                } catch (e: Exception) {
                    runOnUiThread { if (current()) view.showLoadError(contactError(e, "加载失败，请重试"), version) }
                }
            }
        }
        if (restoreFirst && kind != null) LocalChatArchive.disk.execute {
            val scope = LocalAccountStore.scope(base, actor)
            val snapshot = runCatching { LocalDirectoryStore.read(this, scope, kind) }.getOrNull()
            runOnUiThread {
                if (snapshot != null && current()) {
                    view.restoreLocalSnapshot(snapshot.toResult())
                    if (kind == LocalDirectoryStore.Kind.CONTACTS) contactNames.seed(ContactNameDirectory.Scope(base, token, actor), snapshot.items)
                }
                fetchPage()
            }
        } else fetchPage()
    }

    private fun sendContactRequest(user: JSONObject) {
        val view = contactsView ?: return
        val version = view.version
        val id = user.getInt("id")
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl; val staff = currentInternalStaff
        val client = ApiClient(base).apply { this.token = token }
        fun current() = contactsView === view && view.version == version && api.token == token && currentUserId == actor && apiBaseUrl == base
        if (staff) { forceAddAndShow(id, view, ::current, released = { view.finishAddPending(id) }) { result, error -> view.finishAdd(id, result, error) }; return }
        executor.execute {
            if (!current()) return@execute
            try {
                val result = client.sendFriendRequest(id)
                runOnUiThread {
                    if (current()) view.finishAdd(id, result)
                    if (api.token == token && currentUserId == actor && apiBaseUrl == base && result.optString("status") == "accepted") refreshFriendChats(result.optJSONObject("friend_chat"))
                }
            } catch (e: Exception) {
                runOnUiThread { if (current()) view.finishAdd(id, null, contactError(e, "好友申请发送失败，请重试")) }
            }
        }
    }

    private fun handleContactRequest(request: JSONObject, action: String) {
        val view = contactsView ?: return
        val version = view.version
        val id = request.getInt("id")
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }
        fun current() = api.token == token && currentUserId == actor && apiBaseUrl == base && !isFinishing && !isDestroyed
        executor.execute {
            try {
                val result = client.handleFriendRequest(id, action)
                val actualAction = if (result.optString("status") == "accepted") "accept" else "reject"
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    NavigationBadges.handledRequest(id); scheduleNavigationBadges()
                    if (contactsView === view && view.version == version) view.finishRequest(id, actualAction)
                    if (actualAction == "accept") refreshFriendChats(result.optJSONObject("friend_chat"))
                }
            } catch (e: Exception) {
                runOnUiThread { if (current() && contactsView === view && view.version == version) view.finishRequest(id, action, contactError(e, "处理好友申请失败，请重试")) }
            }
        }
    }

    private fun contactError(error: Exception, fallback: String): String = when (error.message) {
        "This user does not accept friend requests." -> "该用户不接受好友申请"
        "Contact already exists." -> "已经是好友，请返回联系人查看"
        "User not found." -> "用户不存在或已停用"
        "Invalid contact target." -> "无法向该用户发送好友申请"
        "Search keyword cannot be empty." -> "请输入搜索内容"
        "Contact request not found." -> "好友申请不存在或已失效"
        "Contact request already handled." -> "该好友申请已经处理"
        "Request failed" -> fallback
        else -> error.message?.takeIf { it.any { char -> char.code in 0x4E00..0x9FFF } } ?: fallback
    }

    private fun showContactsMenu(anchor: View, page: ContactsView.Page) {
        val options = when (page) {
            ContactsView.Page.GROUPS -> listOf("创建群组", "加入群组")
            ContactsView.Page.CHANNELS -> listOf("创建频道")
            else -> listOf("添加好友", "新的朋友", "创建群组", "加入群组", "创建频道")
        }
        PopupMenu(this, anchor).apply {
            options.forEach { menu.add(it) }
            setOnMenuItemClickListener { item ->
                when (item.title.toString()) {
                    "添加好友" -> contactsView?.showPage(ContactsView.Page.SEARCH)
                    "新的朋友" -> contactsView?.showPage(ContactsView.Page.REQUESTS)
                    "创建群组" -> showCreateGroupDialog()
                    "加入群组" -> showJoinGroupDialog()
                    "创建频道" -> showCreateContactChannelDialog()
                }
                true
            }
            show()
        }
    }

    private fun showJoinGroupDialog() {
        val invite = input(if(BuildConfig.GO_BACKEND) "输入邀请码或邀请链接" else "输入群号、群组编号或邀请链接")
        contactCreationDialog("加入群组", "加入", invite, ContactsView.Page.GROUPS) { value ->
            val uri = Uri.parse(value)
            val code = if (uri.isHierarchical && !uri.scheme.isNullOrBlank()) {
                uri.getQueryParameter("invite_code") ?: uri.getQueryParameter("code")
                    ?: uri.lastPathSegment.orEmpty()
            } else value
            require(code.isNotBlank()) { "请输入有效群号或邀请链接" }
            val result = if (code.all { it.isDigit() }) {
                api.requestJoinGroup(code.toIntOrNull() ?: throw IllegalArgumentException("群组编号无效"))
            } else api.joinGroup(code)
            if (result.optString("status") == "pending") "入群申请已发送，等待管理员审核" else "已加入群组"
        }
    }

    private fun showCreateGroupDialog() {
        contactCreationDialog("创建群组", "创建", input("群组名称"), ContactsView.Page.GROUPS) {
            api.createGroup(it)
            "群组已创建"
        }
    }

    private fun showFollowChannelDialog() {
        contactCreationDialog("关注频道", "关注", input("输入频道编号、邀请码或邀请链接"), ContactsView.Page.CHANNELS) { value ->
            val uri = Uri.parse(value)
            val code = if (uri.isHierarchical && !uri.scheme.isNullOrBlank()) {
                uri.getQueryParameter("invite_code") ?: uri.getQueryParameter("code")
                    ?: uri.getQueryParameter("conversation_id") ?: uri.lastPathSegment.orEmpty()
            } else value
            require(code.isNotBlank()) { "请输入有效频道编号或邀请链接" }
            val result = if (code.all { it.isDigit() }) {
                api.followChannel(code.toIntOrNull()?.takeIf { it > 0 } ?: throw IllegalArgumentException("频道编号无效"))
            } else api.followChannel(inviteCode = code)
            if (result.optString("status") == "already_followed") "您已关注该频道" else "已关注频道"
        }
    }

    private fun showCreateContactChannelDialog() {
        contactCreationDialog("创建频道", "创建", input("频道名称"), ContactsView.Page.CHANNELS) {
            api.createChannel(it)
            "频道已创建"
        }
    }

    private fun contactCreationDialog(title: String, verb: String, field: EditText, target: ContactsView.Page, operation: (String) -> String) {
        val view = contactsView
        val errorLabel = text("", 13f, PulseColors.danger).apply {
            id = R.id.contacts_dialog_error
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        val form = column(12).apply { addView(field); addView(errorLabel) }
        val dialog = android.app.AlertDialog.Builder(this).setTitle(title).setView(form)
            .setNegativeButton("取消", null).setPositiveButton(verb, null).create()
        dialog.setOnShowListener {
            val button = dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE)
            button.setOnClickListener {
                val value = field.text.toString().trim()
                if (value.isBlank()) {
                    errorLabel.text = "请输入${if (verb == "关注") "频道编号或邀请链接" else if (target == ContactsView.Page.CHANNELS) "频道名称" else if (verb == "加入") "群号或邀请链接" else "群组名称"}"
                    errorLabel.visibility = View.VISIBLE
                    return@setOnClickListener
                }
                errorLabel.visibility = View.GONE
                button.isEnabled = false
                executor.execute {
                    try {
                        val notice = operation(value)
                        runOnUiThread {
                            dialog.dismiss()
                            toast(notice)
                            if (view != null && contactsView === view) view.showPage(target)
                            else if (view == null && contactsView == null) showChatAfterRefresh()
                        }
                    } catch (e: Exception) {
                        runOnUiThread { if (dialog.isShowing) { button.isEnabled = true; errorLabel.text = contactError(e, "$title 失败，请重试"); errorLabel.visibility = View.VISIBLE } }
                    }
                }
            }
        }
        dialog.show()
    }
    private fun showChatAfterRefresh() { showChat(currentNickname) }

    private fun selectMedia(kind: String, messages: LinearLayout) {
        if (pendingVoice != null || recorder != null) { toast("请先完成或取消语音"); return }
        if (photoBatch != null) { toast("图片正在发送，请先完成或停止当前发送"); return }
        pendingMediaTarget = captureSendTarget() ?: return
        pendingMediaKind = kind
        pendingMessages = messages
        if (kind == "image" || kind == "video") {
            startActivityForResult(PhotoAlbumPickerActivity.intent(this, previewBeforeSend = true)
                .putExtra("max_selection", PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS)
                .putExtra(PhotoAlbumPickerActivity.START_VIDEO, kind == "video"), 41)
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (kind == "image") "image/*" else if (kind == "video") "video/*" else "*/*"
        }
        startActivityForResult(intent, 41)
    }

    private fun confirmInviteHistory(invite: (Boolean) -> Unit) {
        if(!BuildConfig.GO_BACKEND) { invite(false); return }
        val choice=CheckBox(this).apply { text="允许查看入群前的历史消息";isChecked=false;setPadding(dp(24),dp(12),dp(20),dp(12)) }
        android.app.AlertDialog.Builder(this).setTitle("邀请成员").setView(choice).setNegativeButton("取消",null)
            .setPositiveButton("邀请") { _,_-> invite(choice.isChecked) }.show()
    }
    private fun showAddMemberDialog() {
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl; val conversation = activeConversationId
        val source = findViewById<ViewGroup>(android.R.id.content).getChildAt(0) ?: return
        val client = ApiClient(base).apply { this.token = token }
        fun current() = currentUserId == actor && api.token == token && apiBaseUrl == base && activeConversationId == conversation && source.isAttachedToWindow
        val keyword = input("输入完整用户名")
        android.app.AlertDialog.Builder(this)
            .setTitle("添加成员")
            .setView(keyword)
            .setNegativeButton("取消", null)
            .setPositiveButton("搜索") { _, _ ->
                if (!current()) return@setPositiveButton
                val query = keyword.text.toString().trim()
                executor.execute {
                    try {
                        val users = client.searchUsers(query)
                        runOnUiThread {
                            if (!current()) return@runOnUiThread
                            if (users.length() == 0) {
                                toast("用户不存在")
                            } else {
                                val labels = Array(users.length()) { index ->
                                    val user = users.getJSONObject(index)
                                    "${user.optString("nickname", "用户")}\n用户 ID：${PublicUserId.display(user.opt("public_id"))}"
                                }
                                android.app.AlertDialog.Builder(this)
                                    .setTitle("选择成员")
                                    .setItems(labels) { _, which ->
                                        if (!current()) return@setItems
                                        val userId = users.getJSONObject(which).optInt("id")
                                        confirmInviteHistory { allowHistory ->
                                        if(!current())return@confirmInviteHistory
                                        executor.execute {
                                            try {
                                                if (!current()) return@execute
                                                client.addConversationMember(conversation, userId, allowHistory)
                                                runOnUiThread { if (current()) { toast("成员已添加"); showGroupMembers() } }
                                            } catch (e: Exception) {
                                                runOnUiThread { if (current()) toast(e.message ?: "添加成员失败") }
                                            }
                                        }
                                        }
                                    }
                                    .setNegativeButton("取消", null)
                                    .show()
                            }
                        }
                    } catch (e: Exception) {
                        runOnUiThread { if (current()) toast(e.message ?: "搜索用户失败") }
                    }
                }
            }
            .show()
    }
    private fun openDirectChat(userId: Int, name: String = "私聊") {
        if (userId <= 0 || userId == currentUserId || appLock.locked || isFinishing || isDestroyed) return
        val token = api.token ?: return
        val origin = contactsView?.page ?: chatReturnPage
        val title = contactDisplayName(userId, name)
        retainedChatHome?.takeIf { retains(it) }?.cachedDirectConversation(userId)?.let { known ->
            chatReturnPage = origin
            openExistingChat(known.optInt("id"), known.put("name", title)); return
        }
        pendingChatEntry?.takeIf { it.id == -userId && it.actor == currentUserId && it.token == token && it.base == apiBaseUrl }?.let { return }
        cancelPendingChatEntry(); cancelChatHistory()
        val entry = ChatEntry(-userId, currentUserId, token, apiBaseUrl)
        chatReturnPage = origin
        clearExplore(leave = true); myFeature?.close(); closeGroupChatOverlays()
        activeConversationId = 0; currentMessages = null; chatHome = null; contactsView = null
        tasksVisible = false; taskChildActive = false; chatChildActive = true
        entry.view = ChatOpeningView(this, title,
            back = { if (pendingChatEntry === entry) { cancelPendingChatEntry(); returnFromChat() } },
            retry = { if (pendingChatEntry === entry) { cancelPendingChatEntry(); openDirectChat(userId, name) } })
        pendingChatEntry = entry
        configureAuthChrome(false); window.statusBarColor = Color.WHITE; window.navigationBarColor = Color.WHITE
        setContentView(entry.view)
        fun current() = pendingChatEntry === entry && api.token == entry.token && currentUserId == entry.actor && apiBaseUrl == entry.base &&
            entry.view.isAttachedToWindow && !isFinishing && !isDestroyed
        diagnostics.record("chat.contact_open_start")
        chatLoadExecutor.execute {
            try {
                val local = runCatching { LocalDirectoryStore.read(this, LocalAccountStore.scope(entry.base, entry.actor), LocalDirectoryStore.Kind.CHATS)?.items
                    ?.firstOrNull { it.optString("type") == "direct" && it.optInt("peer_user_id") == userId } }.getOrNull()
                if (local != null) {
                    runOnUiThread { if (current()) { pendingChatEntry = null; entry.calls.cancel(); entry.page.cancel(false); openExistingChat(local.optInt("id"), local.put("name", title)) } }
                    return@execute
                }
                val created = ApiClient(entry.base).apply { this.token = entry.token; requestScope = entry.calls }.createDirectConversation(userId)
                require(created.optInt("id") > 0 && created.optString("type") == "direct" && (created.isNull("peer_user_id") || created.optInt("peer_user_id") == userId)) { "私聊响应无效" }
                runOnUiThread {
                    if (!current()) { entry.calls.cancel(); return@runOnUiThread }
                    pendingChatEntry = null; entry.calls.cancel(); entry.page.cancel(false)
                    openExistingChat(created.optInt("id"), created.put("name", title))
                }
            } catch (error: Exception) {
                entry.calls.cancel(); entry.page.cancel(false)
                runOnUiThread { if (current()) { diagnostics.fault("ANDROID_CONTACT_CHAT_OPEN", error); (entry.view as? ChatOpeningView)?.showError(contactError(error, "打开聊天失败，请重试")) } }
            }
        }
    }

    private fun returnFromChat() {
        if (choosingMessages) { clearMessageSelection(); return }
        endGroupAnnouncementEntry()
        closeGroupChatOverlays()
        if (nestedContactChat) { finish(); return }
        val origin = chatReturnPage
        chatReturnPage = null
        if (origin != null) {
            showContacts(origin)
            // 从联系人中的会话返回时，当前页面就是返回目标页；再次返回应离开
            // 联系人模块回到聊天首页，而不是额外经过一次联系人首页。
            leaveContactsOnBack = true
        } else showChat(currentNickname)
    }
    private fun showMyPage(page: String = "home") {
        clearExplore(leave = true)
        closeGroupChatOverlays()
        authView = null; contactsView = null; chatHome = null; chatChildActive = false
        groupCreate = null; contactPicker = null; addFriendView = null; activeConversationId = 0; currentMessages = null; chatReturnPage = null
        configureAuthChrome(false)
        if (myFeature == null) myFeature = MyFeature(this, apiBaseUrl, executor, accountSessions, diagnostics,
            activate = { user, token ->
                val profileBase = apiBaseUrl; val profile = JSONObject(user.toString())
                LocalChatArchive.disk.execute { runCatching { LocalSessionCache.save(this, profileBase, profile) }.onFailure { diagnostics.fault("ANDROID_LOCAL_PROFILE", it) } }
                localSessionOnly = false
                val changed = currentUserId != user.optInt("id") || api.token != token
                    currentUserId = user.optInt("id"); currentInternalStaff = user.optBoolean("internal_staff", false); currentUsername = jsonText(user, "username"); currentNickname = user.optString("nickname", "用户"); api.token = token
                if (changed) {
                    invalidateForceAdd()
                    clearHomeTabs()
                    clearExplore(leave = true); exploreLinks = JSONArray()
                    endGroupAnnouncementEntry()
                    socket?.close(); socket = null; announcementRequest++; announcementDialog?.dismiss(); currentAnnouncement = null
                    cancelVoiceRecording(); discardPendingVoice(); pendingMediaTarget = null
                    MessageAlerts.clear(this); connectSocket(); refreshAnnouncement(true)
                }
            }, loggedOut = {
                myFeature?.close(); api.token = null; preferences.edit().remove("access_token").apply(); MessageAlerts.clear(this); showLogin()
            }, navigate = { navigateTab(it) }, invite = { showJoinGroupDialog() }, resolveAvatar = { mediaUrl(it) })
        myFeature?.show(page)
        connectSocket()
    }

    private fun showMe(nickname: String) {
        content.removeAllViews()
        content.addView(text("我的", 24f))
        val name = input("昵称").apply { setText(currentNickname) }
        val avatar = input("头像地址")
        content.addView(name)
        content.addView(avatar)
        content.addView(Button(this).apply { text = "保存资料"; setOnClickListener { executor.execute { try { val user = api.updateProfile(name.text.toString().trim(), avatar.text.toString().trim()); currentNickname = user.optString("nickname", currentNickname); runOnUiThread { toast("资料已保存") } } catch (e: Exception) { runOnUiThread { toast(e.message ?: "保存资料失败") } } } } })
        content.addView(Button(this).apply { text = "登录设备与屏蔽联系人"; setOnClickListener { showSecuritySettings() } })
        content.addView(Button(this).apply { text = "退出登录"; setOnClickListener { socket?.close(); api.token = null; preferences.edit().remove("access_token").apply(); showLogin() } })
    }

    private fun showSecuritySettings() {
        content.removeAllViews()
        content.addView(text("安全设置", 24f))
        val current = input("当前密码", true)
        val next = input("新密码（至少 8 位）", true)
        content.addView(current)
        content.addView(next)
        content.addView(Button(this).apply { text = "修改密码"; setOnClickListener { executor.execute { try { api.changePassword(current.text.toString(), next.text.toString()); runOnUiThread { toast("密码已修改，请重新登录"); socket?.close(); api.token = null; preferences.edit().remove("access_token").apply(); showLogin() } } catch (e: Exception) { runOnUiThread { toast(e.message ?: "修改密码失败") } } } } })
        executor.execute {
            try {
                val sessions = api.sessions()
                val blocks = api.blocks()
                runOnUiThread {
                    content.addView(text("登录设备", 18f))
                    for (i in 0 until sessions.length()) {
                        val session = sessions.getJSONObject(i)
                        val row = row()
                        row.addView(text("${session.optString("device_type")}  ${session.optString("created_at")}", 14f), LinearLayout.LayoutParams(0, -2, 1f))
                        if (session.optBoolean("is_current")) row.addView(text("当前设备", 12f, Color.rgb(20, 125, 97))) else row.addView(Button(this).apply { text = "撤销"; setOnClickListener { executor.execute { try { api.revokeSession(session.optInt("id")); runOnUiThread { showSecuritySettings() } } catch (e: Exception) { runOnUiThread { toast(e.message ?: "撤销设备失败") } } } } })
                        content.addView(row)
                    }
                    content.addView(text("已屏蔽联系人", 18f))
                    for (i in 0 until blocks.length()) {
                        val block = blocks.getJSONObject(i)
                        val row = row()
                        row.addView(text(block.optString("nickname", block.optString("blocked_id")), 14f), LinearLayout.LayoutParams(0, -2, 1f))
                        row.addView(Button(this).apply { text = "取消屏蔽"; setOnClickListener { executor.execute { try { api.unblock(block.optInt("blocked_id")); runOnUiThread { showSecuritySettings() } } catch (e: Exception) { runOnUiThread { toast(e.message ?: "取消屏蔽失败") } } } } })
                        content.addView(row)
                    }
                }
            } catch (e: Exception) { runOnUiThread { toast(e.message ?: "加载安全设置失败") } }
        }
    }
    private fun queueChatDraftSave() {
        if (chatDraftChanging || chatDraftEditor == null) return
        messageHandler.removeCallbacks(saveChatDraft)
        messageHandler.postDelayed(saveChatDraft, 100)
    }

    private fun snapshotChatDraft(editor: DraftEditor): ChatDraft {
        val hidden = chatDraftEditor === editor && chatComposerRestricted
        val value = if (hidden) chatComposerDraft ?: "" else editor.input.text
        return ChatDraft(value.toString(), if (hidden) chatComposerSelection else editor.input.selectionStart,
            if (hidden) chatComposerSelectionEnd else editor.input.selectionEnd, GroupAvatarMention.snapshot(value), editor.reference)
    }

    private fun persistChatDraft(synchronous: Boolean) {
        val editor = chatDraftEditor ?: return
        if (!editor.readable || chatDraftChanging) return
        try {
            val draft = snapshotChatDraft(editor)
            val encoded = draft.toJSON().toString()
            if (encoded == editor.lastSaved && !editor.pending) return
            val write = chatDraftStore.prepare(editor.owner, draft)
            val revision = ++editor.revision
            editor.pending = true
            fun finished(saved: Boolean, error: Exception?) {
                if (editor.revision != revision) return
                editor.pending = false
                if (saved) { editor.lastSaved = encoded; editor.warned = false }
                else if (error != null) {
                    diagnostics.fault("ANDROID_DRAFT_SAVE", error)
                    if (!editor.warned && chatDraftEditor === editor && !isFinishing && !isDestroyed) {
                        editor.warned = true; toast("草稿保存失败，请保留当前输入并重试")
                    }
                }
            }
            if (synchronous) {
                try { finished(write.commit(), null) } catch (error: Exception) { finished(false, error) }
            } else chatDraftWorker.execute {
                var saved = false; var failure: Exception? = null
                try { saved = write.commit() } catch (error: Exception) { failure = error }
                runOnUiThread { finished(saved, failure) }
            }
        } catch (error: Exception) {
            diagnostics.fault("ANDROID_DRAFT_SAVE", error)
            if (!editor.warned) { editor.warned = true; toast("草稿保存失败，请保留当前输入并重试") }
        }
    }

    private fun flushChatDraft(detach: Boolean = false) {
        messageHandler.removeCallbacks(saveChatDraft)
        persistChatDraft(synchronous = true)
        if (detach) chatDraftEditor = null
    }

    private fun bindChatDraft(input: EditText) {
        if (currentUserId <= 0 || activeConversationId <= 0 || api.token.isNullOrBlank()) return
        val editor = DraftEditor(chatDraftStore.owner(apiBaseUrl, currentUserId, activeConversationId), input)
        chatDraftEditor = editor
        chatDraftChanging = true
        try {
            val draft = chatDraftStore.read(editor.owner) ?: ChatDraft("")
            editor.lastSaved = draft.toJSON().toString()
            editor.reference = draft.reply
            GroupAvatarMention.restore(input, draft.text, draft.mentions)
            input.setSelection(draft.selectionStart, draft.selectionEnd)
            replyMessage = draft.reply?.let { JSONObject().put("id", it.getInt("id")).put("_draft_pending", true) }
            replyRevision++; renderReplyPreview()
        } catch (error: Exception) {
            editor.readable = false
            diagnostics.fault("ANDROID_DRAFT_READ", error)
            toast("本地草稿暂时无法读取，重新输入后可保存新草稿")
        } finally { chatDraftChanging = false }
        restoreChatDraftReply(editor)
    }

    private fun restoreChatDraftReply(editor: DraftEditor) {
        val id = editor.reference?.optInt("id") ?: return
        val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl
        val conversation = activeConversationId; val revision = replyRevision
        fun current() = chatDraftEditor === editor && currentUserId == actor && api.token == token && apiBaseUrl == base &&
            activeConversationId == conversation && replyRevision == revision && replyMessage?.optInt("id") == id && !isFinishing && !isDestroyed
        messageActionExecutor.execute {
            try {
                val page = ApiClient(base).apply { this.token = token }.locateMessage(conversation, id)
                val items = page.optJSONArray("items") ?: JSONArray()
                val message = (0 until items.length()).mapNotNull { items.optJSONObject(it) }
                    .firstOrNull { it.optInt("id") == id && it.optInt("conversation_id") == conversation && RichMessageContent.available(it) }
                runOnUiThread { if (current()) {
                    replyMessage = message?.takeUnless { replyVisibility.hidden(id, false, chatClearedBefore) }?.let(::messageReference)
                    replyRevision++; renderReplyPreview(); flushChatDraft()
                } }
            } catch (error: Exception) {
                // A transient failure leaves an ID-only placeholder; it never resurrects old message content.
                if (error is ClientApiException && error.status in listOf(400, 403, 404)) runOnUiThread { if (current()) {
                    replyMessage = null; replyRevision++; renderReplyPreview(); flushChatDraft()
                } }
            }
        }
    }

    private fun loadHistory(title: String, conversation: JSONObject? = null) {
        flushChatDraft(detach = true)
        val localPending = conversation?.optBoolean("_local_pending", false) == true
        val prepared = preparedChatHistory?.takeIf { it.id == activeConversationId && it.actor == currentUserId && it.token == api.token && it.base == apiBaseUrl && (!it.calls.cancelled || localPending) }
        preparedChatHistory?.takeIf { it !== prepared }?.let { it.calls.cancel(); it.page.cancel(false) }
        preparedChatHistory = null
        activeHistoryRequests?.takeIf { it !== prepared?.calls }?.cancel()
        val historyCalls = prepared?.calls ?: ApiRequestScope()
        activeHistoryRequests = historyCalls
        var firstPage = prepared?.page
        val localScope = LocalChatStore.scope(apiBaseUrl, currentUserId, api.token)
        var historyPaintRevision = 0
        clearMessageSelection()
        endGroupAnnouncementEntry()
        closeChatAttachments()
        chatEmojiPopup?.dismiss(); chatEmojiPopup = null
        chatComposerRestricted = false; chatComposerDraft = null; chatComposerSelection = 0; chatComposerSelectionEnd = 0
        chatInputDock = null
        content.removeAllViews()
        content.setPadding(0, 0, 0, 0)
        val isPrivate = activeConversationType == "direct"
        val isGroup = activeConversationType == "group"
        directPeerName = if (isPrivate) title else ""
        directPeerAvatar = if (isPrivate) conversation?.let { jsonText(it, "avatar_url") }.orEmpty() else ""
        directConversationModel = if (isPrivate) conversation else null
        val historyStack = if (isPrivate) column(0).also { stack ->
            val surface = FrameLayout(this)
            surface.addView(stack, FrameLayout.LayoutParams(-1, -1))
            content.addView(surface, LinearLayout.LayoutParams(-1, 0, 1f))
            window.navigationBarColor = AppAppearance.background(0xFFF5F4F9.toInt())
            window.statusBarColor = AppAppearance.background(Color.WHITE)
            window.decorView.systemUiVisibility = if (AppAppearance.dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            if (Build.VERSION.SDK_INT >= 30) window.insetsController?.setSystemBarsAppearance(
                if (AppAppearance.dark) 0 else WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        } else content
        val subtitle = when {
            isPrivate && conversation?.optBoolean("temporary",false)==true -> "临时聊天"
            isPrivate && conversation?.optBoolean("peer_online", false) == true -> "在线"
            isPrivate && conversation?.optString("peer_last_seen_at").orEmpty().let { it.isNotBlank() && it != "null" } -> "最近在线 ${conversation?.optString("peer_last_seen_at")?.replace('T', ' ')?.take(16)}"
            isPrivate -> "最近在线时间不可见"
            isGroup -> if (conversation?.has("member_count") == true) "${conversation.optInt("member_count")} 位成员" else "成员数量加载中"
            activeConversationType == "channel" && showGroupMemberCount -> "${conversation?.optInt("member_count") ?: 0} 位关注者"
            activeConversationType == "favorites" -> "仅自己可见"
            else -> "消息实时同步"
        }
        val top = if (isGroup) IOSGroupChatStyle.header(this, title, subtitle, { returnFromChat() }, { showGroupMembers() }) else if (isPrivate) FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(-1, dp(84))
            addView(column(0).apply {
                gravity = Gravity.CENTER
                addView(text(title, 19f, Color.BLACK).apply { setTag(R.id.appearance_user_content, true); setPadding(0, 0, 0, dp(4)); typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                    ContactNameLabels.bind(this, conversation?.optInt("peer_user_id") ?: 0, title, ::contactDisplayName)
                })
                addView(text(subtitle, 13f, 0xFF999999.toInt()).apply { setPadding(0, 0, 0, 0); gravity = Gravity.CENTER; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
            }, FrameLayout.LayoutParams(-1, -1).apply { leftMargin = dp(58); rightMargin = dp(58) })
            addView(directChatButton("back", "返回") { returnFromChat() }, FrameLayout.LayoutParams(dp(52), dp(64), Gravity.START or Gravity.CENTER_VERTICAL))
            addView(directChatButton("more", "打开会话菜单") { showDirectChatMenu(this, conversation) }.apply { id = R.id.channel_details }, FrameLayout.LayoutParams(dp(52), dp(64), Gravity.END or Gravity.CENTER_VERTICAL))
        } else row().apply {
            setPadding(dp(8), dp(8), dp(8), dp(8))
            setBackgroundColor(Color.WHITE)
            minimumHeight = dp(64)
        }
        if (!isPrivate && !isGroup) {
        top.addView(iconButton("‹") { returnFromChat() })
        top.addView(column(0).apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
            addView(text(title, 18f, PulseColors.ink).apply { setTag(R.id.appearance_user_content, true); gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, dp(3)) })
            addView(text(subtitle, 12f, PulseColors.muted).apply { gravity = Gravity.CENTER; setPadding(0, 0, 0, 0) })
        })
        top.addView(iconButton("⋯") {
            when {
                isPrivate -> showDirectChatMenu(content, conversation)
                isGroup -> showGroupMembers()
                activeConversationType == "channel" -> showChannelDetails(activeConversationId)
                else -> showChatMenu(content)
            }
        }.apply { id = R.id.channel_details; contentDescription = "打开会话菜单" })
        }
        historyStack.addView(top)
        messageSelectionBar = row().apply {
            id = R.id.chat_selection_bar; visibility = View.GONE
            setPadding(dp(12), dp(10), dp(12), dp(10)); setBackgroundColor(AppAppearance.background(Color.WHITE))
            fun action(label: String, actionId: Int, blue: Boolean = true, block: () -> Unit) = TextView(this@MainActivity).apply {
                id = actionId; text = label; textSize = 13f; gravity = Gravity.CENTER; includeFontPadding = false
                setTypeface(null, android.graphics.Typeface.BOLD); setPadding(dp(16), 0, dp(16), 0)
                setTextColor(if (blue) Color.WHITE else 0xFF0099DB.toInt())
                if (blue) background = rounded(0xFF35A9E3.toInt(), 5)
                isFocusable = true; setOnClickListener { block() }
            }
            addView(action("转发", R.id.chat_selection_forward) {
                val selected = selectedMessageIds.mapNotNull { currentMessageData[it] }.filter { canForwardMessage(it) }
                if (selected.isNotEmpty()) openMessageForwardPicker(selected)
            }, LinearLayout.LayoutParams(-2, dp(34)))
            addView(action("删除", R.id.chat_selection_delete) { confirmDeleteMessages(selectedMessageIds.mapNotNull { currentMessageData[it] }) }, LinearLayout.LayoutParams(-2, dp(34)).apply { leftMargin = dp(10) })
            addView(text("", 14f).apply { id = R.id.chat_selection_count; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }, LinearLayout.LayoutParams(0, dp(34), 1f))
            addView(action("取消", R.id.chat_selection_cancel, false) { clearMessageSelection() }, LinearLayout.LayoutParams(-2, dp(34)))
        }
        historyStack.addView(messageSelectionBar)
        if (isGroup) {
            val actor = currentUserId; val token = api.token; val base = apiBaseUrl; val group = activeConversationId
            lateinit var notice: GroupAnnouncementUi
            notice = GroupAnnouncementUi(this,
                history = GroupAnnouncementHistory(this, base, actor, group),
                scroll = { findViewById<ScrollView>(R.id.chat_message_scroll) },
                current = { groupAnnouncement === notice && appForeground && !appLock.locked &&
                    currentUserId == actor && api.token == token && apiBaseUrl == base &&
                    activeConversationId == group && activeConversationType == "group" && !isFinishing && !isDestroyed },
                mayPresent = { window.decorView.hasWindowFocus() && announcementDialog?.isShowing != true &&
                    groupInfoSheet?.isShowing != true && groupEditSheet?.isShowing != true && groupPickerSheet?.isShowing != true })
            groupAnnouncement = notice
            historyStack.addView(notice.bar, LinearLayout.LayoutParams(-1, -2))
        }
        val initialPermission = ChatSendPermission.from(conversation, activeConversationType, localPending)
        chatCanSend = initialPermission.allowed; chatSendDisabledReason = initialPermission.reason
        chatCanPin = chatCanSend && (activeConversationType != "group" || conversation?.optString("my_role") in listOf("owner", "admin"))
        pinBar = column(0).apply { id = R.id.chat_pin_bar; visibility = View.GONE }
        historyStack.addView(pinBar)
        val messages = column(if (isPrivate) 2 else if (isGroup) 16 else 10).apply { setBackgroundColor(if (isPrivate) 0xFFEFEFEF.toInt() else if (isGroup) IOSGroupChatStyle.background() else PulseColors.background); if (isPrivate) gravity = Gravity.BOTTOM }
        currentMessages = messages
        currentMessageData.clear(); chatLoadedFloor = 1; goMembershipVersion = conversation?.optString("membership_version").orEmpty(); chatClearedBefore = conversation?.optInt("cleared_before_message_id", 0) ?: 0; chatHistoryReady = false; chatSynchronizedEpoch = -1; activeMessageRecovery = null
        val scroll = ScrollView(this).apply {
            id = R.id.chat_message_scroll
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            setOnTouchListener { _, event ->
                if (chatLocateTarget != 0 && event.actionMasked in listOf(android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_MOVE, android.view.MotionEvent.ACTION_SCROLL)) { chatLocateTarget = 0; chatNavigationRevision++ }
                false
            }
            addView(messages)
            addOnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
                val previousHeight = oldBottom - oldTop
                if (bottom - top != previousHeight && currentMessages === messages && chatLocateTarget == 0 &&
                    (previousHeight == 0 || scrollY >= (messages.height - previousHeight).coerceAtLeast(0) - dp(24))) {
                    // Pins, quotes and IME can resize the viewport after history
                    // was drawn; retain the bottom only if the reader was there.
                    postChatBottom(messages, this)
                }
            }
        }
        val conversationId = activeConversationId
        val historyToken = api.token; val historyBase = apiBaseUrl; val historyActor = currentUserId
        val viewport = FrameLayout(this).apply {
            addView(scroll, FrameLayout.LayoutParams(-1, -1))
            addView(ChatScrollBottom(this@MainActivity, scroll, messages, {
                currentMessages === messages && activeConversationId == conversationId && api.token == historyToken &&
                    currentUserId == historyActor && apiBaseUrl == historyBase && chatHistoryReady && appForeground && !appLock.locked && !isFinishing && !isDestroyed
            }, { button -> returnChatToBottom(messages, scroll, button) }), FrameLayout.LayoutParams(dp(48), dp(48), Gravity.BOTTOM or Gravity.END).apply {
                rightMargin = dp(14); bottomMargin = dp(14)
            })
        }
        val historyProgress = listLoadingIndicator(this).apply { id = R.id.chat_history_loading }
        val historyError = text("", 14f, PulseColors.muted).apply { id = R.id.chat_history_error; gravity = Gravity.CENTER; visibility = View.GONE }
        viewport.addView(historyProgress, FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER))
        viewport.addView(historyError, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        historyStack.addView(viewport, LinearLayout.LayoutParams(-1, 0, 1f))
        var historyLoading = false
        var historyFailures = 0
        var localOnlyReady = false
        var olderLoading = false
        var olderHasMore = true
        var olderCursor = 0
        val olderStatus = text("加载更早消息", 12f, PulseColors.muted).apply {
            id = R.id.chat_history_older; tag = Int.MIN_VALUE; gravity = Gravity.CENTER
            setPadding(dp(8), dp(10), dp(8), dp(10)); visibility = View.GONE
        }
        messages.addView(olderStatus, 0)
        trimLiveMessages = { owner ->
            // Reading older history/search/selection keeps its existing viewport.
            if (owner === messages && currentMessages === messages && !olderLoading && !choosingMessages && activeMessageRecovery == null && currentMessageData.size > 200) {
                val expired = currentMessageData.keys.take(currentMessageData.size - 150).toSet()
                for (i in messages.childCount - 1 downTo 0) if (messages.getChildAt(i).tag in expired) messages.removeViewAt(i)
                expired.forEach { currentMessageData.remove(it) }
                chatLoadedFloor = currentMessageData.keys.firstOrNull() ?: chatLoadedFloor
                messageVersions.releaseValuesBefore(chatLoadedFloor)
                olderCursor = (chatLoadedFloor - 1).coerceAtLeast(0); olderHasMore = olderCursor > chatClearedBefore
                olderStatus.visibility = View.VISIBLE; olderStatus.text = "加载更早消息"
                diagnostics.record("chat.window_trim")
            }
        }
        fun historyCurrent() = currentMessages === messages && activeConversationId == conversationId &&
            api.token == historyToken && currentUserId == historyActor && apiBaseUrl == historyBase &&
            appForeground && !appLock.locked && !isFinishing && !isDestroyed
        fun loadOlderHistory() {
            if (!historyCurrent() || (!chatHistoryReady && !localOnlyReady) || olderLoading || !olderHasMore || olderCursor <= 0) return
            olderLoading = true; olderStatus.text = "正在加载更早消息…"; olderStatus.isEnabled = false
            val maximum = olderCursor
            val historyWorker = if (localPending) LocalChatArchive.disk else chatLoadExecutor
            historyWorker.execute {
                try {
                    val disk = runCatching { LocalChatStore.read(this, localScope, conversationId, maximum, 51) }.getOrNull()
                    val page = if (disk != null && (localPending || disk.complete || disk.items.size >= 51)) ChatHistoryPage(disk.items.takeLast(50), disk.items.size > 50 || !disk.complete, ((disk.items.takeLast(50).minOfOrNull { it.optInt("id") } ?: 1) - 1).coerceAtLeast(0))
                    else {
                        val ticket = runCatching { LocalChatStore.ticket(this, localScope, conversationId) }.getOrNull()
                        ApiClient(historyBase).apply { token = historyToken; requestScope = historyCalls }.historyPage(conversationId, maximum).also { if (ticket != null) runCatching { LocalChatArchive.save(this, ticket, it, maximum, cleared = chatClearedBefore) } }
                    }
                    runOnUiThread {
                        if (!historyCurrent()) { olderLoading = false; olderStatus.isEnabled = true; return@runOnUiThread }
                        // Measure immediately before insertion: the reader may have scrolled during HTTP.
                        val anchor = (0 until messages.childCount).map { messages.getChildAt(it) }
                            .firstOrNull { (it.tag as? Int ?: 0) > 0 && it.bottom > scroll.scrollY }
                        val anchorId = anchor?.tag; val offset = (anchor?.top ?: 0) - scroll.scrollY
                        val revision = chatNavigationRevision
                        page.items.forEach { item -> if (!currentMessageData.containsKey(item.optInt("id"))) addMessage(messages, item, "snapshot") }
                        olderCursor = page.nextMaxId; olderHasMore = page.hasMore
                        chatSynchronizedEpoch = -1
                        chatLoadedFloor = minOf(chatLoadedFloor, currentMessageData.keys.minOrNull() ?: chatLoadedFloor)
                        olderLoading = false; olderStatus.isEnabled = true
                        recoverCurrentMessages(allowUnsubscribed = true)
                        olderStatus.text = if (olderHasMore) "加载更早消息" else "已到聊天记录开头"
                        messages.post {
                            if (historyCurrent() && chatNavigationRevision == revision && anchorId != null) {
                                (0 until messages.childCount).map { messages.getChildAt(it) }.firstOrNull { it.tag == anchorId }
                                    ?.let { scroll.scrollTo(0, (it.top - offset).coerceAtLeast(0)) }
                            }
                        }
                    }
                } catch (_: Exception) {
                    runOnUiThread {
                        olderLoading = false
                        if (historyCurrent()) { olderStatus.text = "加载失败，点击重试更早消息"; olderStatus.isEnabled = true }
                    }
                }
            }
        }
        olderStatus.setOnClickListener { loadOlderHistory() }
        scroll.setOnScrollChangeListener { _, _, y, _, oldY ->
            if (y < dp(96) && y < oldY) loadOlderHistory()
        }
        val tools = row().apply { setPadding(dp(if (isPrivate) 4 else if (isGroup) 12 else 10), dp(8), dp(if (isPrivate) 4 else if (isGroup) 12 else 10), dp(8)); setBackgroundColor(if (isPrivate) 0xFFF5F4F9.toInt() else IOSGroupChatStyle.surface()) }
        replyPreview = column(0).apply { id = R.id.chat_reply_preview; visibility = View.GONE }
        if (chatCanSend || isGroup) content.addView(replyPreview)
        renderReplyPreview()
        voicePendingBar = column(0).apply { id = R.id.voice_pending_bar; visibility = View.GONE }
        if (chatCanSend || isGroup) content.addView(voicePendingBar)
        val messageInput = input("输入消息").apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f)
            maxLines = 4
            setSingleLine(false)
            background = rounded(0xFFF1F3F5.toInt(), 22)
            setPadding(dp(16), dp(2), dp(16), dp(2))
            if (isPrivate) { textSize = 17f; background = rounded(Color.WHITE, 7); setPadding(dp(13), dp(7), dp(10), dp(7)); layoutParams = LinearLayout.LayoutParams(0, dp(46), 1f).apply { setMargins(0, 0, dp(8), 0) }; setOnFocusChangeListener { _, focused -> if (focused) closeChatAttachments() } }
            if (isGroup) { textSize = 16f; minimumHeight = 0; background = rounded(IOSGroupChatStyle.background(), 20); setTextColor(IOSGroupChatStyle.ink()); setPadding(dp(12), 0, dp(12), 0) }
        }
        messageInput.id = R.id.chat_message_input
        messageInput.setOnFocusChangeListener { _, focused -> if (focused) closeChatAttachments() }
        tools.isFocusableInTouchMode = true
        val recordButton = directChatButton("mic", "录制语音") { button -> closeChatAttachments(); toggleRecording(button) }.apply { id = R.id.chat_record }
        tools.addView(recordButton, LinearLayout.LayoutParams(dp(40), dp(44)))
        tools.addView(messageInput, LinearLayout.LayoutParams(0, dp(44), 1f).apply { setMargins(dp(4), 0, dp(4), 0) })
        tools.addView(directChatButton("smile", "打开表情") { closeChatAttachments(); showEmojiPanel(messageInput) }.apply { id = R.id.chat_emoji }, LinearLayout.LayoutParams(dp(40), dp(44)))
        tools.addView(directChatButton("plus", "打开聊天功能") { showAttachmentPanel(messages, isPrivate) }.apply { id = R.id.chat_attach }, LinearLayout.LayoutParams(dp(40), dp(44)))
        lateinit var sendButton: View
        fun updateSendState() {
            val typing = chatCanSend && !messageInput.text.isNullOrBlank() && recorder == null
            sendButton.isEnabled = typing
            sendButton.visibility = if (typing) View.VISIBLE else View.GONE
        }
        val sendAction: (View) -> Unit = {
            val value = messageInput.text.toString().trim()
            if (!localOutboxesReady) { bindLocalOutboxes(retryNow = true); toast("正在恢复本地待发消息，请稍后再试") }
            else if (pendingVoice != null || recorder != null) toast("请先完成或取消当前语音")
            else if (sendButton.isEnabled && messageInput.isEnabled && value.isNotEmpty()) captureSendTarget()?.let { target ->
                val mentions = if (activeConversationType == "group") GroupAvatarMention.targets(messageInput.text) else intArrayOf()
                try { textSends.enqueue(target.token, target.userId, apiBaseUrl, target.conversationId, value, target.replyToId, mentions) }
                catch (error: Exception) {
                    diagnostics.fault("ANDROID_TEXT_ENQUEUE", error)
                    toast("待发消息保存失败，请保留当前输入并重试")
                    return@let
                }
                messageInput.text.clear()
                if (target.replyToId > 0 && replyRevision == target.replyRevision) { replyMessage = null; replyRevision++; renderReplyPreview() }
                flushChatDraft()
                renderPendingTextMessages(messages); postChatBottom(messages, scroll)
                drainTextOutbox()
            }
        }
        sendButton = (if (isGroup) IOSGroupChatStyle.action(this, "send", "发送消息", 36, sendAction).apply {
            background = rounded(IOSGroupChatStyle.blue, 18); (getChildAt(0) as IOSGroupGlyph).tint = Color.WHITE
            layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
        } else if (isPrivate) directChatButton("send", "发送消息", sendAction) else smallAction("➤", true) { sendAction(it) }).apply { id = R.id.chat_message_send }
        tools.addView(sendButton, LinearLayout.LayoutParams(dp(36), dp(40)))
        messageInput.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { updateSendState() }
            override fun afterTextChanged(s: android.text.Editable?) {
                if (!chatDraftChanging && chatDraftEditor?.input === messageInput) {
                    chatDraftEditor?.readable = true
                    queueChatDraftSave()
                }
            }
        })
        updateSendState()
        if (isGroup) {
            groupMentionRole = conversation?.optString("my_role").orEmpty()
            val picker = GroupMentionPicker(this, messageInput, {
                currentMessages === messages && activeConversationId == conversationId && currentUserId == historyActor && api.token == historyToken && apiBaseUrl == historyBase && appForeground && !appLock.locked && chatCanSend && recorder == null && pendingVoice == null && !isFinishing && !isDestroyed
            }, { groupMentionsAllowed() }, { query, page ->
                ApiClient(historyBase).apply { token = historyToken }.groupMentionMembers(conversationId, query, page).also { require(it.optInt("conversation_id") == conversationId) }
            }, { image, fallback, raw -> loadChatImage(image, fallback, raw, messages, historyToken) })
            groupMentionPicker = picker; content.addView(picker)
            tools.addView(picker.action, 1, LinearLayout.LayoutParams(dp(32),dp(40)))
        }
        if (chatCanSend || isGroup || (localPending && initialPermission.reason == "loading")) {
            chatInputDock = column(0).apply {
                id = R.id.chat_input_dock
                addView(tools)
            }
            content.addView(chatInputDock)
        }
        else content.addView(text(initialPermission.hint, 13f, PulseColors.muted).apply {
            id = R.id.channel_read_only; gravity = Gravity.CENTER; setPadding(dp(16), dp(16), dp(16), dp(16))
        })
        bindChatDraft(messageInput)
        applyChatSendPermission(initialPermission)
        PushNotifications.activeConversation = activeConversationId
        socket?.subscribe(activeConversationId)
        fun fetchInitialHistory() {
            if (historyLoading || currentMessages !== messages || api.token != historyToken || historyCalls.cancelled || isFinishing || isDestroyed) return
            historyLoading = true; historyError.visibility = View.GONE
            historyProgress.visibility = if (currentMessageData.isEmpty()) View.VISIBLE else View.GONE
            fun received(page: ChatHistoryPage?, failure: Throwable?) {
                runOnUiThread {
                    if (currentMessages !== messages || api.token != historyToken || activeConversationId != conversationId || apiBaseUrl != historyBase || currentUserId != historyActor || isFinishing || isDestroyed) return@runOnUiThread
                    if (page == null || failure != null) {
                        val rejected = (failure?.cause ?: failure) as? ClientApiException
                        if (rejected?.status in listOf(401, 403)) {
                            LocalChatArchive.disk.execute { LocalChatStore.clearConversation(this, localScope, conversationId); LocalMediaCache.purge(this, localScope, conversationId) }
                            cancelPendingChatEntry(); returnFromChat(); toast("当前会话不可访问"); return@runOnUiThread
                        }
                        historyLoading = false; historyProgress.visibility = View.GONE
                        historyError.text = "消息加载失败，点击重试"; historyError.visibility = View.VISIBLE
                        if (historyFailures++ == 0) diagnostics.fault("ANDROID_CHAT_HISTORY", failure)
                        messages.postDelayed({ if (historyCurrent()) fetchInitialHistory() }, 2000)
                        return@runOnUiThread
                    }
                    val paint = ++historyPaintRevision
                    ChatHistoryRenderQueue(messages, { historyCurrent() && paint == historyPaintRevision },
                        row = { message -> addMessage(messages, message, "snapshot") },
                        painted = {
                            historyProgress.visibility = View.GONE
                            // Prepending an earlier batch must not flash a different message before drawing.
                            val observer = scroll.viewTreeObserver
                            if (observer.isAlive) observer.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
                                override fun onPreDraw(): Boolean {
                                    if (observer.isAlive) observer.removeOnPreDrawListener(this)
                                    if (historyCurrent() && chatLocateTarget == 0) scroll.scrollTo(0, messages.height)
                                    return true
                                }
                            })
                            postChatBottom(messages, scroll)
                        },
                        finished = {
                            historyLoading = false
                            chatLoadedFloor = currentMessageData.keys.firstOrNull() ?: 1; chatHistoryReady = true
                            olderCursor = page.nextMaxId; olderHasMore = page.hasMore
                            olderStatus.visibility = View.VISIBLE
                            olderStatus.text = if (olderHasMore) "加载更早消息" else "已到聊天记录开头"
                            markConversationRead(conversationId, currentMessageData.keys.maxOrNull() ?: 0, reopen = true)
                            retryInitialHistory = null; diagnostics.record("chat.first_page_ready")
                            LocalChatArchive.enqueue(this@MainActivity, historyBase, historyToken.orEmpty(), localScope, conversationId)
                            postChatBottom(messages, scroll); recoverCurrentMessages(allowUnsubscribed = true)
                        }, interrupted = { historyLoading = false }
                    ).render(page.items)
                }
            }
            val offered = firstPage; firstPage = null
            if (offered != null) offered.whenComplete { page, error -> received(page, error) }
            else chatLoadExecutor.execute {
                try {
                    val ticket = runCatching { LocalChatStore.ticket(this, localScope, conversationId) }.getOrNull()
                    val page = ApiClient(historyBase).apply { token = historyToken; requestScope = historyCalls }.historyPage(conversationId, size = 20)
                    if (!historyCalls.cancelled && ticket != null) runCatching { LocalChatArchive.save(this, ticket, page, info = conversation, cleared = chatClearedBefore) }
                    received(page, null)
                }
                catch (error: Exception) { received(null, error) }
            }
        }
        historyError.setOnClickListener { fetchInitialHistory() }
        renderPendingTextMessages(messages); drainTextOutbox(); drainMediaOutbox()
        retryInitialHistory = { fetchInitialHistory() }
        if (localPending) {
            historyProgress.visibility = View.GONE
            val cached = prepared?.cached
            ChatHistoryRenderQueue(messages, ::historyCurrent,
                row = { message -> addMessage(messages, message, "snapshot") },
                painted = { postChatBottom(messages, scroll) },
                finished = {
                    localOnlyReady = true; olderCursor = ((cached?.items?.minOfOrNull { it.optInt("id") } ?: 1) - 1).coerceAtLeast(0)
                    olderHasMore = olderCursor > chatClearedBefore; olderStatus.visibility = View.VISIBLE
                    olderStatus.text = if (olderHasMore) "查看更早的本地记录" else "已到聊天记录开头"
                    postChatBottom(messages, scroll)
                }, interrupted = { }
            ).render(cached?.items.orEmpty())
        } else {
            LocalChatArchive.disk.execute {
                val cached = runCatching { LocalChatStore.read(this, localScope, conversationId, limit = 20) }.getOrNull()
                runOnUiThread {
                    if (historyCurrent() && !chatHistoryReady && currentMessageData.isEmpty() && cached != null) {
                        val paint = historyPaintRevision
                        ChatHistoryRenderQueue(messages, { historyCurrent() && !chatHistoryReady && paint == historyPaintRevision },
                            row = { addMessage(messages, it, "snapshot") }, painted = { historyProgress.visibility = View.GONE; postChatBottom(messages, scroll) },
                            finished = { postChatBottom(messages, scroll) }, interrupted = { }
                        ).render(cached.items)
                    }
                }
            }
            fetchInitialHistory(); refreshMessagePins()
            if (isGroup) refreshGroupMetadata()
        }
    }

    private fun messageReference(message: JSONObject): JSONObject = JSONObject().apply {
        put("id", message.optInt("id")); put("sender_id", message.optInt("sender_id"))
        put("sender_name", if (message.optInt("sender_id") == currentUserId) currentNickname else message.optString("sender_nickname").takeUnless { it.isBlank() || it == "null" } ?: directPeerName.takeIf { activeConversationType == "direct" && it.isNotBlank() } ?: "用户")
        put("type", message.optString("type")); put("text", referenceSummary(message))
        if (message.optString("type") == "image") put("thumbnail_url", message.optJSONObject("body")?.optString("url").orEmpty())
    }
    private fun closeGroupChatOverlays() {
        groupMentionPicker?.dismiss(); groupMentionPicker = null
        messageCardRevision++; messageCardDialog?.dismiss(); messageCardDialog = null
        groupMemberProfileScope?.dialog?.dismiss()
        groupAnnouncement?.pause()
        groupMedia?.close(); groupMedia = null
        groupEditSheet?.dismiss(); groupEditSheet = null
        groupPickerSheet?.dismiss(); groupPickerSheet = null
        groupInfoSheet?.dismiss(); groupInfoSheet = null
    }
    private fun pauseGroupAnnouncement() {
        groupMentionPicker?.dismiss()
        cancelVoiceRecording(); discardPendingVoice()
        groupForegroundRevision++; groupMetadataRequest++
        groupViewerCanManage = false; groupViewerCanViewProfiles = false; groupProfileRequest++
        groupMemberProfileScope?.dialog?.dismiss()
        groupAnnouncement?.pause()
    }
    private fun endGroupAnnouncementEntry() {
        groupMentionPicker?.dismiss(); groupMentionPicker = null; groupMentionRole = ""
        cancelVoiceRecording(); discardPendingVoice()
        groupMetadataRequest++
        groupViewerCanManage = false; groupViewerCanViewProfiles = false; groupProfileRequest++
        groupMemberProfileScope?.dialog?.dismiss()
        groupAnnouncement?.destroy(); groupAnnouncement = null
    }
    private fun currentGroupMedia(): GroupMessageMedia {
        groupMedia?.let { return it }
        val conversation = activeConversationId; val actor = currentUserId; val token = api.token; val base = apiBaseUrl; val kind = activeConversationType
        return GroupMessageMedia(this, base + "|" + token.orEmpty(), { mediaUrl(it) }, {
            appForeground && !appLock.locked && activeConversationType == kind && activeConversationId == conversation && currentUserId == actor && api.token == token && apiBaseUrl == base && !isFinishing && !isDestroyed
        }, refreshImage = { message ->
            check(appForeground && !appLock.locked && activeConversationId == conversation && currentUserId == actor && api.token == token && apiBaseUrl == base && message.optInt("conversation_id") == conversation && message.optInt("id") > chatClearedBefore)
            val raw = ApiClient(base).apply { this.token = token }.freshImageUrl(conversation, message.getInt("id"))
            check(appForeground && !appLock.locked && activeConversationId == conversation && currentUserId == actor && api.token == token && apiBaseUrl == base)
            raw
        }, cacheConversationId = conversation, cacheScope = LocalChatStore.scope(base, actor, token)).also { groupMedia = it }
    }
    private fun referenceSummary(message: JSONObject): String {
        if (message.optBoolean("_draft_pending")) return "正在核对引用消息…"
        if (message.optBoolean("unavailable")) return "原消息已不可用"
        val body = message.optJSONObject("body")
        val value = body?.optString("text") ?: message.optString("text")
        return value.takeUnless { it.isBlank() || it == "null" }?.replace('\n', ' ')?.take(180)
            ?: when (message.optString("type")) { "image" -> "[图片]"; "video" -> "[视频]"; "voice" -> "[语音]"; "file" -> "[文件]"; else -> "[消息]" }
    }
    private fun selectReply(message: JSONObject) {
        if (!chatCanSend) { toast("当前会话没有发送权限"); return }
        replyMessage = messageReference(message); replyRevision++; renderReplyPreview()
        findViewById<EditText>(R.id.chat_message_input)?.requestFocus()
    }
    private fun renderReplyPreview() {
        if (!chatDraftChanging) chatDraftEditor?.let { editor ->
            if (replyMessage?.optBoolean("_draft_pending") != true || editor.reference?.optInt("id") != replyMessage?.optInt("id")) {
                editor.reference = ChatDraft.cleanReply(replyMessage)
            }
            queueChatDraftSave()
        }
        val box = replyPreview ?: return
        box.removeAllViews()
        val reply = replyMessage
        box.visibility = if (reply == null) View.GONE else View.VISIBLE
        if (reply != null) box.addView(referenceStrip(reply, "回复 ${reply.optString("sender_name", "用户")}").apply {
            close.id = R.id.chat_reply_cancel; close.visibility = View.VISIBLE; close.contentDescription = "取消引用回复"
            close.setOnClickListener { replyMessage = null; replyRevision++; renderReplyPreview() }
            setOnClickListener { locateChatMessage(reply.optInt("id")) }
        }, LinearLayout.LayoutParams(-1, -2))
    }
    private fun referenceStrip(reference: JSONObject, title: String, embeddedMine: Boolean? = null): MessageReferenceStrip {
        val strip = MessageReferenceStrip(this, if (reference.optBoolean("unavailable")) "原消息" else title, referenceSummary(reference), activeConversationType == "group", embeddedMine != null, embeddedMine == true)
        val thumb = reference.optString("thumbnail_url").takeUnless { it.isBlank() || it == "null" }
            ?: reference.optJSONObject("body")?.let { body -> if (reference.optString("type") == "image") body.optString("url").takeUnless { it.isBlank() || it == "null" } else null }
        if (thumb != null && !reference.optBoolean("unavailable")) currentMessages?.let { messages ->
            strip.imageBox.visibility = View.VISIBLE
            loadChatImage(strip.image, strip.imageStatus, thumb, messages, api.token)
        }
        return strip
    }
    private fun acceptMessagePins(snapshot: JSONObject) {
        if (snapshot.optInt("conversation_id") != activeConversationId) return
        ensureMessageScope()
        val selected = pinnedMessages.getOrNull(pinIndex)?.optInt("id")
        val items = snapshot.optJSONArray("items") ?: return
        pinnedMessages.clear()
        for (i in 0 until minOf(items.length(), 20)) {
            val message = items.getJSONObject(i)
            if (RichMessageContent.available(message) && !replyVisibility.hidden(message.optInt("id"), false, chatClearedBefore)) pinnedMessages.add(protectedReply(message))
        }
        pinIndex = pinnedMessages.indexOfFirst { it.optInt("id") == selected }.takeIf { it >= 0 } ?: 0
        pinRevision++; renderMessagePins()
    }
    private fun renderMessagePins() {
        val box = pinBar ?: return
        box.removeAllViews(); box.visibility = if (pinnedMessages.isEmpty()) View.GONE else View.VISIBLE
        val message = pinnedMessages.getOrNull(pinIndex) ?: return
        box.addView(referenceStrip(message, "置顶消息 ${pinIndex + 1}/${pinnedMessages.size}").apply {
            setOnClickListener { locateChatMessage(message.optInt("id")) }
            extra.id = R.id.chat_pin_list; extra.visibility = View.VISIBLE; extra.text = "${pinIndex + 1}/${pinnedMessages.size} ▾"; extra.contentDescription = "查看全部置顶消息"
            if (activeConversationType == "group") {
                extra.text = "☰"
                nextPin.id = R.id.group_pin_next; nextPin.visibility = if (pinnedMessages.size > 1) View.VISIBLE else View.GONE; nextPin.contentDescription = "切换下一条置顶消息"
                nextPin.setOnClickListener { pinIndex = (pinIndex + 1) % pinnedMessages.size; renderMessagePins() }
            }
            extra.setOnClickListener {
                val choices = pinnedMessages.toList(); val token = api.token; val conversation = activeConversationId
                android.app.AlertDialog.Builder(this@MainActivity).setTitle("置顶消息（最多20条）").setItems(choices.map { referenceSummary(it) }.toTypedArray()) { _, index ->
                    if (api.token == token && activeConversationId == conversation && pinBar === box) {
                        val chosen = choices[index].optInt("id")
                        pinIndex = pinnedMessages.indexOfFirst { it.optInt("id") == chosen }.takeIf { it >= 0 } ?: 0
                        renderMessagePins(); locateChatMessage(chosen)
                    }
                }.setNegativeButton("关闭", null).show()
            }
            if (chatCanPin) {
                close.id = R.id.chat_pin_close; close.visibility = View.VISIBLE; close.contentDescription = "取消当前置顶"
                close.setOnClickListener { changeMessagePin(message, false) }
            }
        }, LinearLayout.LayoutParams(-1, -2))
    }
    private fun refreshMessagePins() {
        // The old entry remains available for legacy builds. The Go service
        // advertises no pin capability yet; do not show a permanent retry banner.
        if(BuildConfig.GO_BACKEND) { pinnedMessages.clear();chatCanPin=false;renderMessagePins();return }
        val box = pinBar ?: return; val token = api.token ?: return
        val conversation = activeConversationId; if (conversation <= 0 || !box.isAttachedToWindow) return
        val revision = pinRevision; val request = ++pinReadRequest; val base = apiBaseUrl
        messageExecutor.execute {
            try {
                val snapshot = ApiClient(base).apply { this.token = token }.messagePins(conversation)
                runOnUiThread { if (api.token == token && activeConversationId == conversation && pinBar === box && pinRevision == revision && pinReadRequest == request) acceptMessagePins(snapshot) }
            } catch (_: Exception) {
                runOnUiThread { if (api.token == token && activeConversationId == conversation && pinBar === box && pinRevision == revision && pinReadRequest == request && pinnedMessages.isEmpty()) {
                    box.removeAllViews(); box.visibility = View.VISIBLE
                    box.addView(text("置顶消息同步失败，点按重试", 12f, 0xFF4285E8.toInt()).apply { setPadding(dp(16), dp(8), dp(16), dp(8)); setOnClickListener { refreshMessagePins() } })
                } }
            }
        }
    }
    private fun changeMessagePin(message: JSONObject, pinned: Boolean) {
        if (!chatCanPin) { toast("当前会话没有置顶权限"); return }
        val token = api.token ?: return; val conversation = activeConversationId; val box = pinBar ?: return
        val revision = pinRevision; val base = apiBaseUrl
        sendExecutor.execute {
            try {
                val snapshot = ApiClient(base).apply { this.token = token }.setMessagePin(conversation, message.optInt("id"), pinned)
                runOnUiThread { if (api.token == token && activeConversationId == conversation && pinBar === box) {
                    if (pinRevision == revision) acceptMessagePins(snapshot) else refreshMessagePins()
                } }
            } catch (error: Exception) { runOnUiThread { if (api.token == token && activeConversationId == conversation && pinBar === box) toast(error.message ?: "置顶操作失败，请重试") } }
        }
    }
    private fun locateChatMessage(messageId: Int) {
        val messages = currentMessages ?: return; val token = api.token ?: return
        val conversation = activeConversationId; val base = apiBaseUrl
        if (messageId <= 0) return
        val navigation = ++chatNavigationRevision; chatLocateTarget = messageId
        fun current() = currentMessages === messages && api.token == token && activeConversationId == conversation && chatNavigationRevision == navigation && chatLocateTarget == messageId
        fun reveal() {
            val target = (0 until messages.childCount).map { messages.getChildAt(it) }.firstOrNull { it.tag == messageId }
            if (target == null) { chatLocateTarget = 0; toast("原消息已不可用"); return }
            // A posted runnable can run before newly inserted history is laid out.
            // Pre-draw gives the actual measured target position in this viewport.
            messages.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
                override fun onPreDraw(): Boolean {
                    if (messages.viewTreeObserver.isAlive) messages.viewTreeObserver.removeOnPreDrawListener(this)
                    if (current() && target.parent === messages) {
                        (messages.parent as? ScrollView)?.scrollTo(0, (target.top - dp(12)).coerceAtLeast(0))
                        val before = target.background; val highlight = rounded(AppAppearance.background(0xFFE1EEFF.toInt()), 10)
                        target.background = highlight; target.isSelected = true; target.announceForAccessibility("已定位原消息")
                        target.postDelayed({ if (target.background === highlight) { target.background = before; target.isSelected = false } }, 2000)
                    }
                    return true
                }
            })
            messages.requestLayout(); messages.invalidate()
        }
        // Revalidate with the server even when a stale copy is present locally.
        messageExecutor.execute {
            try {
                val result = ApiClient(base).apply { this.token = token }.locateMessage(conversation, messageId)
                runOnUiThread { if (current()) {
                    val items = result.optJSONArray("items") ?: JSONArray()
                    for (i in items.length() - 1 downTo 0) addMessage(messages, items.getJSONObject(i), "snapshot")
                    reveal()
                } }
            } catch (error: Exception) { runOnUiThread { if (current()) { chatLocateTarget = 0; toast(error.message ?: "原消息已不可用") } } }
        }
    }
    private fun returnChatToBottom(messages: LinearLayout, scroll: ScrollView, button: ChatScrollBottom) {
        val token = api.token ?: return
        if (currentMessages !== messages || !appForeground || appLock.locked) return
        val refresh = chatLocateTarget != 0 || button.retryRequired
        chatLocateTarget = 0; val navigation = ++chatNavigationRevision
        val conversation = activeConversationId; val actor = currentUserId; val base = apiBaseUrl
        fun current() = currentMessages === messages && api.token == token && currentUserId == actor && apiBaseUrl == base &&
            activeConversationId == conversation && chatNavigationRevision == navigation && appForeground && !appLock.locked && button.isAttachedToWindow
        scroll.scrollTo(0, messages.height); postChatBottom(messages, scroll)
        if (!refresh) return
        button.begin()
        messageExecutor.execute {
            try {
                val rows = ApiClient(base).apply { this.token = token }.history(conversation)
                runOnUiThread { if (!current()) { if (button.isAttachedToWindow) button.complete(true); return@runOnUiThread }
                    val follow = messages.height - scroll.scrollY - scroll.height < dp(64)
                    for (i in rows.length() - 1 downTo 0) addMessage(messages, rows.getJSONObject(i), "snapshot")
                    markConversationRead(conversation, currentMessageData.keys.maxOrNull() ?: 0)
                    if (follow) postChatBottom(messages, scroll)
                    button.complete(true)
                }
            } catch (error: Exception) { runOnUiThread { if (current()) { button.complete(false); toast("加载最新消息失败，点击箭头重试") } else if (button.isAttachedToWindow) button.complete(true) } }
        }
    }
    private fun postChatBottom(messages: LinearLayout, scroll: ScrollView?) {
        val navigation = chatNavigationRevision
        messages.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                if (messages.viewTreeObserver.isAlive) messages.viewTreeObserver.removeOnPreDrawListener(this)
                if (currentMessages === messages && navigation == chatNavigationRevision && chatLocateTarget == 0) scroll?.scrollTo(0, messages.height)
                return true
            }
        })
        messages.requestLayout(); messages.invalidate()
    }

    private fun showChannelDetails(conversationId: Int) {
        executor.execute {
            try {
                val info = api.openConversation(conversationId)
                runOnUiThread {
                    if (activeConversationId != conversationId || activeConversationType != "channel") return@runOnUiThread
                    val description = jsonText(info, "description")
                    val details = text("${info.optString("name")}\n频道编号：$conversationId\n关注人数：${info.optInt("member_count")}\n${description}", 16f).apply {
                        setPadding(dp(24), dp(16), dp(24), dp(16)); setTextIsSelectable(true)
                    }
                    val builder = android.app.AlertDialog.Builder(this).setTitle("频道资料").setView(details).setPositiveButton("关闭", null)
                    val code = jsonText(info, "invite_code")
                    if (info.optBoolean("can_manage") && (code.isNotBlank() || info.optString("join_method") == "free")) {
                        builder.setNeutralButton("复制邀请链接") { _, _ ->
                            val link = if (code.isNotBlank()) "pulse://follow-channel?invite_code=$code" else "pulse://follow-channel?conversation_id=$conversationId"
                            (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("频道邀请链接", link))
                            toast("频道邀请链接已复制")
                        }
                    }
                    if (info.optInt("owner_id") != currentUserId) builder.setNegativeButton("取消关注") { _, _ ->
                        val confirm = android.app.AlertDialog.Builder(this).setTitle("取消关注频道")
                            .setMessage("取消关注后，该频道会从我的频道列表中移除。")
                            .setNegativeButton("保留关注", null).setPositiveButton("取消关注", null).create()
                        confirm.setOnShowListener {
                            val button = confirm.getButton(android.app.AlertDialog.BUTTON_POSITIVE)
                            button.setOnClickListener {
                                button.isEnabled = false
                                executor.execute {
                                    try {
                                        api.leaveConversation(conversationId)
                                        runOnUiThread {
                                            confirm.dismiss(); toast("已取消关注频道")
                                            if (activeConversationId == conversationId) { chatReturnPage = null; showContacts(ContactsView.Page.CHANNELS) }
                                        }
                                    } catch (e: Exception) {
                                        runOnUiThread { if (confirm.isShowing) { button.isEnabled = true; toast(contactError(e, "取消关注失败，请重试")) } }
                                    }
                                }
                            }
                        }
                        confirm.show()
                    }
                    builder.show()
                }
            } catch (e: Exception) {
                runOnUiThread { if (activeConversationId == conversationId) toast(contactError(e, "获取频道资料失败，请重试")) }
            }
        }
    }

    private fun notificationRevision(): Long {
        if (notificationSettingsToken != api.token) { notificationSettingsToken = api.token; notificationSettings.clear(); notificationSettingsRevision = 0 }
        return notificationSettingsRevision
    }
    private fun notificationInfo(info: JSONObject, requestedRevision: Long): JSONObject {
        notificationRevision()
        val changed = notificationSettings[info.optInt("id")]
        if (changed != null && changed.revision > requestedRevision) info.put("notifications_muted", changed.muted)
        else if (directConversationModel?.optInt("id") == info.optInt("id")) directConversationModel?.put("notifications_muted", info.optBoolean("notifications_muted"))
        return info
    }
    private fun showDirectChatMenu(anchor: View, conversation: JSONObject?) {
        val messages = currentMessages ?: return; val token = api.token ?: return
        val target = SendTarget(activeConversationId, currentUserId, token)
        val base = apiBaseUrl
        fun current() = target.matches(activeConversationId, currentUserId, api.token) && currentMessages === messages && apiBaseUrl == base
        val model = directConversationModel ?: conversation ?: return
        val popup = PopupWindow(this)
        val panel = column(0).apply {
            id = R.id.chat_direct_menu; setPadding(0, dp(8), 0, dp(8))
            background = rounded(Color.WHITE, 14); elevation = dp(7).toFloat()
        }
        fun item(icon: String, title: String, itemId: Int, action: () -> Unit) {
            panel.addView(row().apply {
                id = itemId; setPadding(dp(16), 0, dp(12), 0)
                addView(ChatStyleIconView(this@MainActivity, icon, 0xFF474747.toInt()), LinearLayout.LayoutParams(dp(23), dp(23)))
                addView(text(title, 16f, Color.BLACK).apply { setPadding(dp(13), 0, 0, 0); maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
                setOnClickListener { popup.dismiss(); if (current()) action() }
            }, LinearLayout.LayoutParams(-1, dp(48)))
        }
        val muted = model.optBoolean("notifications_muted", false)
        item(if (muted) "bell" else "bell_off", if (muted) "开启通知" else "关闭通知", R.id.chat_direct_mute) {
            if (directMutation != null) { toast("操作处理中，请稍候"); return@item }
            directMutation = target
            val client = ApiClient(base).apply { this.token = token }
            sendExecutor.execute {
                try {
                    val updated = client.updateConversationSettings(target.conversationId, notificationsMuted = !muted)
                    require(updated.optInt("id") == target.conversationId) { "通知设置未返回有效会话，请重试" }
                    runOnUiThread {
                        val value = updated.optBoolean("notifications_muted", !muted)
                        if (api.token == token && currentUserId == target.userId && apiBaseUrl == base) {
                            notificationRevision(); notificationSettingsRevision++
                            notificationSettings[target.conversationId] = NotificationSetting(value, notificationSettingsRevision)
                        }
                        if (current()) { model.put("notifications_muted", value); directConversationModel?.put("notifications_muted", value); toast(if (value) "已关闭通知" else "已开启通知") }
                        if (directMutation === target) directMutation = null
                    }
                } catch (error: Exception) { runOnUiThread { if (current()) toast(error.message ?: "通知设置失败，请重试"); if (directMutation === target) directMutation = null } }
            }
        }
        fun confirm(title: String, detail: String, clear: Boolean) {
            if (directMutation != null) { toast("操作处理中，请稍候"); return }
            val dialog = android.app.AlertDialog.Builder(this).setTitle(title).setMessage(detail).setNegativeButton("取消", null).setPositiveButton("确认", null).create()
            dialog.setOnShowListener {
                dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    if (!current() || directMutation != null) { dialog.dismiss(); return@setOnClickListener }
                    directMutation = target
                    dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).isEnabled = false
                    dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).isEnabled = false
                    dialog.setCancelable(false)
                    val client = ApiClient(base).apply { this.token = token }
                    sendExecutor.execute {
                        try {
                            val result = if (clear) client.clearHistory(target.conversationId) else client.hideConversation(target.conversationId)
                            require(result.optInt("conversation_id") == target.conversationId && (if (clear) result.has("cleared_before_message_id") else result.optString("status") == "hidden")) { "服务器未确认操作结果，请重试" }
                            val localScope = LocalAccountStore.scope(base, target.userId)
                            if (clear) LocalDirectoryStore.clearConversationMessages(this, localScope, target.conversationId, result.optInt("cleared_before_message_id"))
                            else LocalDirectoryStore.removeConversation(this, localScope, target.conversationId)
                            runOnUiThread {
                                dialog.dismiss()
                                if (current()) {
                                    if (clear) { applyPersonalHistoryClear(result.optInt("cleared_before_message_id")); toast("历史记录已清空") }
                                    else { chatReturnPage = null; showChat(currentNickname); toast("对话已从你的列表移除") }
                                }
                                if (directMutation === target) directMutation = null
                            }
                        } catch (error: Exception) { runOnUiThread { dialog.dismiss(); if (current()) toast(error.message ?: "操作失败，请重试"); if (directMutation === target) directMutation = null } }
                    }
                }
            }
            dialog.show()
        }
        item("broom", "清空历史记录", R.id.chat_direct_clear) { confirm("清空历史记录", "仅清空你在该对话中的历史记录，不影响对方。确认清空？", true) }
        item("trash", "删除对话", R.id.chat_direct_hide) { confirm("删除对话", "仅从你的聊天列表移除，对方的记录会保留。收到新消息后会再次显示。", false) }
        bindLocalization(panel); AppAppearance.apply(panel)
        popup.contentView = panel; popup.width = minOf(dp(190), resources.displayMetrics.widthPixels - dp(16))
        popup.height = WindowManager.LayoutParams.WRAP_CONTENT; popup.isFocusable = true; popup.isOutsideTouchable = true
        popup.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        val position = IntArray(2); anchor.getLocationOnScreen(position)
        popup.showAtLocation(anchor, Gravity.TOP or Gravity.END, dp(9), position[1] + anchor.height + dp(4))
    }
    private fun applyPersonalHistoryClear(watermark: Int) {
        val scope = LocalChatStore.scope(apiBaseUrl, currentUserId, api.token); val cid = activeConversationId
        LocalChatArchive.disk.execute { LocalChatStore.clearConversation(this, scope, cid, watermark); LocalMediaCache.purge(this, scope, cid) }

        chatClearedBefore = maxOf(chatClearedBefore, watermark)
        directConversationModel?.put("cleared_before_message_id", chatClearedBefore)
        chatLocateTarget = 0; chatNavigationRevision++
        pinRevision++; pinReadRequest++
        activeMessageRecovery = null; chatSynchronizedEpoch = -1; chatLoadedFloor = chatClearedBefore + 1
        val container = currentMessages ?: return
        currentMessageData.keys.filter { it <= chatClearedBefore }.forEach { id ->
            replyVisibility.removed(id); messageVersions.accept(id, "", true, null, "snapshot"); currentMessageData.remove(id)
            (0 until container.childCount).map { container.getChildAt(it) }.firstOrNull { it.tag == id }?.let { container.removeView(it) }
        }
        replyMessage = null; replyRevision++; renderReplyPreview()
        pinnedMessages.removeAll { it.optInt("id") <= chatClearedBefore }; pinIndex = 0; renderMessagePins()
        renderMessageSelection()
        refreshMessagePins(); refreshCurrentMessages(allowUnsubscribed = true)
    }
    private fun showConversationSearch() {
        val field = input("搜索当前会话")
        val loading = text("", 13f, PulseColors.muted)
        val dialog = android.app.AlertDialog.Builder(this).setTitle("搜索聊天记录").setView(column(6).apply { addView(field); addView(loading) })
            .setNegativeButton("取消", null).setPositiveButton("搜索", null).create()
        dialog.setOnShowListener {
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val keyword = field.text.toString().trim()
                if (keyword.isBlank()) { loading.text = "请输入搜索内容"; return@setOnClickListener }
                loading.text = "正在搜索…"
                executor.execute {
                    try {
                        val items = api.searchMessages(keyword, 1, activeConversationId).optJSONArray("items") ?: JSONArray()
                        runOnUiThread {
                            if (!dialog.isShowing) return@runOnUiThread
                            dialog.dismiss()
                            val results = column(4)
                            if (items.length() == 0) results.addView(text("没有找到匹配的聊天记录", 15f, PulseColors.muted))
                            for (i in 0 until items.length()) {
                                val message = items.getJSONObject(i)
                                results.addView(text(messageSummary(message, currentUserId, getString(R.string.app_name)), 15f, PulseColors.ink).apply {
                                    setPadding(dp(14), dp(12), dp(14), dp(12)); background = rounded(PulseColors.background, 12)
                                })
                            }
                            android.app.AlertDialog.Builder(this).setTitle("搜索结果").setView(ScrollView(this).apply { addView(results) }).setPositiveButton("关闭", null).show()
                        }
                    } catch (e: Exception) { runOnUiThread { if (dialog.isShowing) loading.text = e.message ?: "搜索失败，请重试" } }
                }
            }
        }
        dialog.show()
    }

    private fun showContactInfo(userId: Int) {
        val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl; val staff = currentInternalStaff
        val client = ApiClient(base).apply { this.token = token }
        fun current() = currentUserId == actor && api.token == token && apiBaseUrl == base && !isFinishing && !isDestroyed
        executor.execute {
            try {
                val profile = if (staff) client.internalProfile(userId) else client.contactProfile(userId)
                check(profile.optInt("user_id") == userId) { "联系人资料不匹配" }
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    val status = if (profile.optBoolean("online")) "在线" else "离线"
                    val detail = buildString {
                        append(profile.optString("nickname", "用户"))
                        append("\n用户 ID：${PublicUserId.display(profile.opt("public_id"))}")
                        profile.optString("remark").takeIf { it.isNotBlank() }?.let { append("\n备注：$it") }
                        append("\n状态：$status")
                        profile.optString("last_seen_at").takeIf { it.isNotBlank() }?.let { append("\n最近在线：$it") }
                        profile.optString("last_login_device").takeIf { it.isNotBlank() }?.let { append("\n设备：$it") }
                        profile.optString("phone").takeIf { it.isNotBlank() }?.let { append("\n手机号：$it") }
                        profile.optString(if (staff) "last_login_location" else "ip_location").takeIf { it.isNotBlank() }?.let { append("\n归属地：$it") }
                        if (staff) {
                            profile.optString("register_ip").takeIf { it.isNotBlank() }?.let { append("\n注册 IP：$it") }
                            profile.optString("last_login_ip").takeIf { it.isNotBlank() }?.let { append("\n最近登录 IP：$it") }
                        }
                    }
                    android.app.AlertDialog.Builder(this).setTitle("联系人信息").setMessage(detail).setPositiveButton("关闭", null).show()
                }
            } catch (e: Exception) { runOnUiThread { if (current()) toast(e.message ?: "获取联系人信息失败") } }
        }
    }

    private fun showAttachmentPanel(messages: LinearLayout, isPrivate: Boolean) {
        if (chatAttachmentPanel != null) { closeChatAttachments(); return }
        val dock = chatInputDock ?: return
        val conversation = activeConversationId; val token = api.token; val actor = currentUserId; val base = apiBaseUrl
        fun current() = currentMessages === messages && activeConversationId == conversation && api.token == token &&
            currentUserId == actor && apiBaseUrl == base && appForeground && !appLock.locked && chatCanSend &&
            recorder == null && pendingVoice == null && !isFinishing && !isDestroyed
        if (!current()) return
        groupMentionPicker?.dismiss()
        (getSystemService(INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)?.hideSoftInputFromWindow(currentFocus?.windowToken, 0)
        currentFocus?.clearFocus()
        dock.getChildAt(0)?.requestFocus()
        val gridContent = column(0).apply {
            setPadding(dp(12), dp(14), dp(12), dp(14))
            setBackgroundColor(if (AppAppearance.dark) 0xFF171A21.toInt() else 0xFFF5F5F5.toInt())
        }
        var grid = row()
        val items = mutableListOf(
            Triple("photo", "照片", R.id.chat_attachment_photo), Triple("camera", "拍摄", R.id.chat_attachment_camera))
        if (activeConversationType != "group") {
            items += Triple("file", "文件", R.id.chat_attachment_file)
            items += Triple("video", "视频文件", R.id.chat_attachment_video)
        }
                if (isPrivate && currentInternalStaff) items += Triple("shake", "窗口抖动", R.id.chat_attachment_shake)
        items += Triple("card", "名片", R.id.chat_attachment_contact_card)
        if (!isPrivate) items += Triple("star", "收藏", R.id.chat_attachment_favorite)
        items.forEachIndexed { index, (kind, label, actionId) ->
            if (index % 4 == 0) { grid = row(); gridContent.addView(grid) }
            grid.addView(column(0).apply {
                id = actionId; gravity = Gravity.CENTER; contentDescription = label; isFocusable = true
                addView(FrameLayout(this@MainActivity).apply {
                    background = rounded(AppAppearance.background(Color.WHITE), 15)
                    addView(ChatStyleIconView(this@MainActivity, kind, 0xFF4A4A4A.toInt()), FrameLayout.LayoutParams(dp(30), dp(30), Gravity.CENTER))
                }, LinearLayout.LayoutParams(dp(60), dp(60)))
                addView(text(label, 13f, PulseColors.muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(8), 0, 0) })
                setOnClickListener {
                    closeChatAttachments()
                    if (current()) when (kind) {
                        "camera" -> openChatCamera(messages)
                        "shake" -> sendShake(messages)
                        "card" -> showContactCardPicker(messages)
                        "star" -> openFavoritesChat()
                        else -> selectMedia(if (kind == "photo") "image" else kind, messages)
                    }
                }
            }, LinearLayout.LayoutParams(0, dp(96), 1f))
        }
        repeat((4 - items.size % 4) % 4) { grid.addView(View(this), LinearLayout.LayoutParams(0, dp(96), 1f)) }
        val panel = ScrollView(this).apply {
            id = R.id.chat_attachment_panel; contentDescription = "聊天功能面板"
            isVerticalScrollBarEnabled = false
            setBackgroundColor(if (AppAppearance.dark) 0xFF171A21.toInt() else 0xFFF5F5F5.toInt())
            addView(gridContent)
        }
        val available = content.height.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels
        val panelHeight = dp(((items.size + 3) / 4) * 96 + 28)
        dock.addView(panel, LinearLayout.LayoutParams(-1, minOf(panelHeight, (available * 0.38f).toInt()).coerceAtLeast(dp(96))))
        chatAttachmentPanel = panel
        findViewById<View>(R.id.chat_attach)?.apply {
            contentDescription = "关闭聊天功能"
            if (Build.VERSION.SDK_INT >= 30) stateDescription = "已展开"
        }
    }

    private fun directChatButton(kind: String, description: String, action: (View) -> Unit): FrameLayout = FrameLayout(this).apply {
        layoutParams = LinearLayout.LayoutParams(dp(44), dp(46))
        contentDescription = description; isClickable = true; isFocusable = true
        addView(ChatStyleIconView(this@MainActivity, kind), FrameLayout.LayoutParams(dp(if (kind in listOf("plus", "smile", "mic")) 27 else 24), dp(if (kind in listOf("plus", "smile", "mic")) 27 else 24), Gravity.CENTER))
        setOnClickListener { action(this) }
    }

    private fun captureGroupOrigin(requireForeground: Boolean = true): GroupProfileOrigin? {
        if (activeConversationType != "group" || (requireForeground && (!appForeground || appLock.locked))) return null
        return GroupProfileOrigin(activeConversationId, currentUserId, api.token ?: return null, apiBaseUrl,
            groupAnnouncement ?: return null, currentMessages ?: return null, groupForegroundRevision)
    }
    private fun groupOriginIdentityCurrent(origin: GroupProfileOrigin): Boolean = activeConversationType == "group" && activeConversationId == origin.groupId &&
        currentUserId == origin.userId && api.token == origin.token && apiBaseUrl == origin.base && groupAnnouncement === origin.entry &&
        currentMessages === origin.messages && origin.messages.isAttachedToWindow && appForeground && !appLock.locked && !isFinishing && !isDestroyed
    private fun groupOriginCurrent(origin: GroupProfileOrigin): Boolean = groupOriginIdentityCurrent(origin) && groupForegroundRevision == origin.foreground
    private fun groupMemberProfileCurrent(scope: GroupMemberProfileScope) = groupMemberProfileScope === scope && scope.dialog.isShowing && groupOriginCurrent(scope.origin)
    private class SilentGroupFriendRestriction : IllegalStateException()
    private fun silentGroupFriendRestriction(error: Exception): Boolean = error is SilentGroupFriendRestriction ||
        (error is ClientApiException && error.message?.trim()?.trimEnd('。') in setOf(
            "该群已禁止群成员互加好友", "该群已禁止群成员互相添加好友", "无权查看该群成员资料"))
    private fun freshGroupProfileAccess(origin: GroupProfileOrigin, client: ApiClient): JSONObject {
        check(groupOriginCurrent(origin)) { "群会话已切换" }
        val profile = client.groupProfile(origin.groupId)
        check(profile.optInt("id") == origin.groupId && profile.optString("type") == "group") { "群成员资料响应无效" }
        if (!((profile.optBoolean("can_manage") && profile.optString("my_role") in listOf("owner", "admin")) || profile.optBoolean("allow_member_add_friend"))) throw SilentGroupFriendRestriction()
        check(groupOriginCurrent(origin)) { "群会话已切换" }
        return profile
    }
    private fun showGroupMemberProfile(peerId: Int) {
        // Refresh policy on each tap, including immediately after a ban is lifted.
        val origin = captureGroupOrigin() ?: return
        if (peerId <= 0 || peerId == origin.userId) return
        val request = ++groupProfileRequest
        val client = ApiClient(origin.base).apply { token = origin.token }
        groupMemberProfileScope?.dialog?.dismiss()
        executor.execute {
            try {
                freshGroupProfileAccess(origin, client)
                val profile = client.contactProfile(peerId, origin.groupId)
                check(profile.optInt("user_id") == peerId) { "群成员资料响应无效" }
                runOnUiThread {
                    if (!groupOriginCurrent(origin) || request != groupProfileRequest) return@runOnUiThread
                    val dialog = BackSwipeDialog(this, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme)
                    lateinit var scope: GroupMemberProfileScope
                    val view = ContactProfileView(this, { mediaUrl(it) }, close = { dialog.dismiss() }, share = {}, edit = {}, notifications = {}, block = {}, remove = { addFromGroupMemberProfile(scope) },
                        send = { sendFromGroupMemberProfile(scope) }, loadMedia = {}, loadGroups = { page -> loadGroupMemberCommonGroups(scope, page) }, openMedia = {}, openGroup = {},
                        pageChanged = { page -> dialog.window?.statusBarColor = if (page == ContactProfileView.Page.PROFILE) 0xFFA7ABB5.toInt() else AppAppearance.background(Color.WHITE) }, groupContext = true)
                    scope = GroupMemberProfileScope(origin, peerId, client, dialog, view)
                    groupMemberProfileScope = scope
                    dialog.setContentView(view)
                    dialog.setOnDismissListener { if (groupMemberProfileScope === scope) { groupMemberProfileScope = null; groupAnnouncement?.resume() } }
                    dialog.setOnKeyListener { _, key, event -> if (key == android.view.KeyEvent.KEYCODE_BACK && event.action == android.view.KeyEvent.ACTION_UP) { view.handleBack(); true } else false }
                    dialog.onSwipeBack = { view.handleBack() }
                    dialog.swipePageIdentity = { view.page }
                    dialog.show()
                    dialog.window?.apply { setLayout(-1, -1); setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); statusBarColor = 0xFFA7ABB5.toInt(); navigationBarColor = AppAppearance.background(0xFFF7F7F7.toInt()) }
                    view.accept(profile, false)
                }
            } catch (error: Exception) { runOnUiThread { if (groupOriginCurrent(origin) && request == groupProfileRequest) { groupViewerCanViewProfiles = false; if (!silentGroupFriendRestriction(error)) toast(error.message ?: "群成员资料加载失败，请重新打开群资料") } } }
        }
    }
    private fun loadGroupMemberCommonGroups(scope: GroupMemberProfileScope, page: Int) {
        if (!groupMemberProfileCurrent(scope)) return
        val generation = scope.view.generation; val revision = ++scope.revision
        executor.execute {
            try {
                freshGroupProfileAccess(scope.origin, scope.client)
                val result = scope.client.commonContactGroups(scope.peerId, page, scope.origin.groupId)
                runOnUiThread { if (groupMemberProfileCurrent(scope) && scope.revision == revision && scope.view.generation == generation) scope.view.acceptRows(ContactProfileView.Page.GROUPS, page, result) }
            } catch (error: Exception) { runOnUiThread { if (groupMemberProfileCurrent(scope) && scope.revision == revision) { scope.dialog.dismiss(); groupViewerCanViewProfiles = false; if (!silentGroupFriendRestriction(error)) toast(error.message ?: "群成员资料权限已变更") } } }
        }
    }
    private fun sendFromGroupMemberProfile(scope: GroupMemberProfileScope) {
        if (!groupMemberProfileCurrent(scope) || scope.pending) return
        scope.pending = true; scope.view.pending(true)
        executor.execute {
            try {
                freshGroupProfileAccess(scope.origin, scope.client)
                // Only this explicit action may obtain a private conversation.
                val profile = scope.client.contactProfile(scope.peerId, scope.origin.groupId)
                check(groupMemberProfileCurrent(scope)) { "群会话已切换" }
                if (!profile.optBoolean("is_contact")) {
                    runOnUiThread { if (groupMemberProfileCurrent(scope)) { scope.pending = false; addFromGroupMemberProfile(scope) } }
                    return@execute
                }
                val created = scope.client.createDirectConversation(scope.peerId)
                check(created.optInt("id") > 0 && created.optString("type") == "direct") { "私聊响应无效" }
                val conversation = scope.client.openConversation(created.getInt("id"))
                runOnUiThread { if (groupMemberProfileCurrent(scope)) { scope.dialog.dismiss(); showChat(currentNickname, openConversation = conversation) } }
            } catch (error: Exception) { runOnUiThread { if (groupMemberProfileCurrent(scope)) { scope.dialog.dismiss(); if (!silentGroupFriendRestriction(error)) toast(error.message ?: "打开私聊失败") } } }
        }
    }
    private fun addFromGroupMemberProfile(scope: GroupMemberProfileScope) {
        if (!groupMemberProfileCurrent(scope) || scope.pending || scope.requestSent) return
        scope.pending = true; scope.view.pending(true)
        executor.execute {
            try {
                val source = freshGroupProfileAccess(scope.origin, scope.client)
                val before = scope.client.contactProfile(scope.peerId, scope.origin.groupId)
                check(groupMemberProfileCurrent(scope)) { "群会话已切换" }
                val result = if (before.optBoolean("is_contact")) null else {
                    if (!source.optBoolean("allow_member_add_friend")) throw SilentGroupFriendRestriction()
                    check(before.optBoolean("can_add_friend")) { "当前无法从该群添加好友" }
                    scope.client.sendFriendRequest(scope.peerId, contextConversationId = scope.origin.groupId)
                }
                val updated = scope.client.contactProfile(scope.peerId, scope.origin.groupId)
                runOnUiThread {
                    if (!groupMemberProfileCurrent(scope)) return@runOnUiThread
                    scope.pending = false; scope.requestSent = result?.optString("status") == "pending"
                    updated.put("request_sent", scope.requestSent); scope.view.accept(updated, false)
                    if (scope.requestSent) toast("好友申请已发送")
                    if (result?.optString("status") == "accepted") refreshFriendChats(result.optJSONObject("friend_chat"))
                }
            } catch (error: Exception) { runOnUiThread {
                if (groupMemberProfileCurrent(scope)) {
                    scope.pending = false
                    if (silentGroupFriendRestriction(error)) scope.dialog.dismiss()
                    else { scope.view.showError(error.message ?: "好友申请发送失败，请重试"); toast(error.message ?: "好友申请发送失败，请重试") }
                }
            } }
        }
    }
    private fun bindGroupAvatar(wrapper: View, container: LinearLayout, message: JSONObject) {
        val avatar = wrapper.findViewById<View>(R.id.group_message_avatar) ?: return
        val origin = captureGroupOrigin(requireForeground = false) ?: return
        if (origin.messages !== container || message.optInt("conversation_id") != origin.groupId) return
        val sender = message.optInt("sender_id")
        if (sender <= 0 || sender == origin.userId) return
        avatar.contentDescription = if (groupAvatarMentionsAllowed()) "群成员头像，长按@昵称" else "群成员头像"
        avatar.isFocusable = true
        avatar.setOnClickListener { if (groupOriginIdentityCurrent(origin)) showGroupMemberProfile(sender) }
        avatar.setOnLongClickListener {
            if (!groupAvatarMentionsAllowed()) return@setOnLongClickListener false
            if (groupOriginIdentityCurrent(origin)) captureGroupOrigin()?.let { insertGroupMention(it, message) }
            true
        }
        avatar.isLongClickable = groupAvatarMentionsAllowed()
        avatar.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                if (groupAvatarMentionsAllowed()) info.addAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_LONG_CLICK, "@此成员"))
                else info.removeAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_LONG_CLICK)
            }
        }
    }
    private fun groupMentionsAllowed(): Boolean = activeConversationType == "group" && groupMentionRole in listOf("owner", "admin")
    private fun groupAvatarMentionsAllowed(): Boolean = activeConversationType == "group" && groupMentionRole in listOf("owner", "admin", "member")

    private fun refreshGroupMentionAvatars(view: View? = currentMessages) {
        if (view == null) return
        if (view.id == R.id.group_message_avatar) {
            view.isLongClickable = groupAvatarMentionsAllowed()
            view.contentDescription = if (groupAvatarMentionsAllowed()) "群成员头像，长按@昵称" else "群成员头像"
        }
        if (view is android.view.ViewGroup) for (i in 0 until view.childCount) refreshGroupMentionAvatars(view.getChildAt(i))
    }

    private fun insertGroupMention(origin: GroupProfileOrigin, message: JSONObject) {
        if (!groupAvatarMentionsAllowed() || !groupOriginCurrent(origin) || !chatCanSend || message.optInt("conversation_id") != origin.groupId || message.optInt("sender_id") <= 0 || message.optInt("sender_id") == origin.userId) return
        val input = findViewById<EditText>(R.id.chat_message_input) ?: return
        val pendingText = textSends.pending(origin.token, origin.userId, origin.base, origin.groupId).isNotEmpty()
        if (!input.isEnabled || recorder != null || recordingTarget != null || pendingVoice != null || pendingMediaTarget != null || groupUploads.isNotEmpty() || pendingSendAcks.isNotEmpty() || pendingText) { toast("请先完成当前发送或重试"); return }
        val name = GroupAvatarMention.authorName(message)
        if (name.isBlank()) { toast("消息缺少有效昵称，暂时无法@该成员"); return }
        if (!GroupAvatarMention.insert(input, message.optInt("sender_id"), name)) { toast("消息过长或@成员过多，请减少内容后再试"); return }
        input.requestFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)?.showSoftInput(input, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
    }
    private fun contactProfileCurrent(scope: ContactProfileScope): Boolean = contactProfileScope === scope && scope.dialog.isShowing && scope.target.matches(activeConversationId, currentUserId, api.token) && apiBaseUrl == scope.base && !isFinishing && !isDestroyed

    private fun showDirectContactProfile(peerId: Int) {
        val target = captureSendTarget() ?: return
        if (peerId <= 0 || peerId == target.userId || activeConversationType != "direct") return
        closeChatAttachments()
        (getSystemService(INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)?.hideSoftInputFromWindow(currentFocus?.windowToken, 0)
        currentFocus?.clearFocus()
        contactProfileDialog?.dismiss()
        val base = apiBaseUrl
        val client = ApiClient(base).apply { token = target.token }
        val dialog = BackSwipeDialog(this, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme)
        lateinit var scope: ContactProfileScope
        lateinit var view: ContactProfileView
        view = ContactProfileView(this, { mediaUrl(it) }, close = { dialog.dismiss() },
            share = { profile ->
                if (contactProfileCurrent(scope)) {
                    val account = "用户 ID：${PublicUserId.display(profile.opt("public_id"))}"
                    startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, "${getString(R.string.app_name)}联系人：${jsonText(profile, "nickname")}\n$account") }, "分享联系人"))
                }
            }, edit = { editContactProfile(scope) },
            notifications = { enabled ->
                mutateContactProfile(scope, { frozen -> frozen.updateConversationSettings(target.conversationId, !enabled) }) { result ->
                    require(result.optInt("id") == target.conversationId)
                    scope.notificationsEnabled = !result.optBoolean("notifications_muted")
                    notificationRevision(); notificationSettingsRevision++
                    notificationSettings[target.conversationId] = NotificationSetting(!scope.notificationsEnabled, notificationSettingsRevision)
                    directConversationModel?.takeIf { it.optInt("id") == target.conversationId }?.put("notifications_muted", !scope.notificationsEnabled)
                }
            }, block = { blocked ->
                mutateContactProfile(scope, { frozen -> if (blocked) frozen.blockUser(peerId) else frozen.unblock(peerId) }) { result ->
                    require(result.optInt("blocked_id") == peerId); scope.profile.put("blocked_by_me", result.optString("status") == "blocked")
                }
            }, remove = { removeProfileContact(scope) }, send = { if (contactProfileCurrent(scope)) dialog.dismiss() },
            loadMedia = { page -> loadContactProfileRows(scope, ContactProfileView.Page.MEDIA, page) },
            loadGroups = { page -> loadContactProfileRows(scope, ContactProfileView.Page.GROUPS, page) },
            openMedia = { item ->
                if (contactProfileCurrent(scope)) {
                    val url = item.optJSONObject("body")?.let { jsonText(it, "url") }.orEmpty()
                    if (url.isNotBlank()) try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(mediaUrl(url)))) } catch (_: Exception) { toast("没有可打开此文件的应用") }
                }
            }, openGroup = { group ->
                if (contactProfileCurrent(scope) && group.optInt("id") > 0) {
                    contactGroupChild = true
                    startActivity(Intent(this, MainActivity::class.java).putExtra("notification_conversation_id", group.optInt("id")).putExtra("notification_user_id", target.userId).putExtra("contact_nested_chat", true))
                }
            }, pageChanged = { page ->
                dialog.window?.apply {
                    val white = page != ContactProfileView.Page.PROFILE
                    statusBarColor = if (white) AppAppearance.background(Color.WHITE) else 0xFFA7ABB5.toInt()
                    decorView.systemUiVisibility = if (AppAppearance.dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR or if (white) View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR else 0
                }
            })
        scope = ContactProfileScope(dialog, view, target, base, peerId, client, JSONObject().put("nickname", directPeerName).put("avatar_url", directPeerAvatar), !(directConversationModel?.optBoolean("notifications_muted") ?: false))
        contactProfileDialog = dialog; contactProfileScope = scope
        dialog.setContentView(view)
        dialog.setOnDismissListener { if (contactProfileDialog === dialog) { contactProfileDialog = null; contactProfileScope = null } }
        dialog.setOnKeyListener { _, key, event -> if (key == android.view.KeyEvent.KEYCODE_BACK && event.action == android.view.KeyEvent.ACTION_UP) { view.handleBack(); true } else false }
        dialog.onSwipeBack = { view.handleBack() }
        dialog.swipePageIdentity = { view.page }
        dialog.show()
        dialog.window?.apply {
            setLayout(-1, -1); setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            statusBarColor = 0xFFA7ABB5.toInt(); navigationBarColor = AppAppearance.background(0xFFF7F7F7.toInt())
            decorView.systemUiVisibility = if (AppAppearance.dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        view.accept(scope.profile, scope.notificationsEnabled); view.pending(true)
        reloadContactProfile(scope)
    }

    private fun reloadContactProfile(scope: ContactProfileScope) {
        val revision = notificationRevision()
        val request = ++scope.revision
        executor.execute {
            try {
                val profile = scope.client.contactProfile(scope.peerId)
                val conversation = scope.client.conversationInfo(scope.target.conversationId)
                runOnUiThread {
                    if (!contactProfileCurrent(scope) || request != scope.revision) return@runOnUiThread
                    if (profile.optInt("user_id") != scope.peerId || conversation.optInt("id") != scope.target.conversationId) { scope.view.showError("个人信息响应无效"); return@runOnUiThread }
                    scope.profile = profile; scope.notificationsEnabled = !notificationInfo(conversation, revision).optBoolean("notifications_muted")
                    scope.view.accept(profile, scope.notificationsEnabled)
                }
            } catch (error: Exception) { runOnUiThread { if (contactProfileCurrent(scope) && request == scope.revision) scope.view.showError(error.message ?: "个人信息加载失败，请返回后重试") } }
        }
    }

    private fun mutateContactProfile(scope: ContactProfileScope, operation: (ApiClient) -> JSONObject, accepted: (JSONObject) -> Unit) {
        if (!contactProfileCurrent(scope) || scope.pending) return
        scope.pending = true; scope.revision++; scope.view.pending(true)
        sendExecutor.execute {
            try {
                if (!scope.target.matches(activeConversationId, currentUserId, api.token) || apiBaseUrl != scope.base) return@execute
                val result = operation(scope.client)
                runOnUiThread {
                    // Account-scoped notification revisions must survive leaving the profile.
                    if (api.token != scope.target.token || currentUserId != scope.target.userId || apiBaseUrl != scope.base) return@runOnUiThread
                    try { accepted(result) } catch (_: Exception) { if (contactProfileCurrent(scope)) scope.view.showError("服务器返回的个人信息无效"); return@runOnUiThread }
                    scope.pending = false
                    if (contactProfileCurrent(scope)) scope.view.accept(scope.profile, scope.notificationsEnabled)
                }
            } catch (error: Exception) {
                runOnUiThread { scope.pending = false; if (contactProfileCurrent(scope)) { scope.view.showError(error.message ?: "修改失败，请重试"); reloadContactProfile(scope) } }
            }
        }
    }

    private fun editContactProfile(scope: ContactProfileScope) {
        if (!contactProfileCurrent(scope) || scope.pending) return
        if (!scope.profile.optBoolean("is_contact")) { toast("仅联系人可设置分组和备注"); return }
        val remark = input("备注").apply { id = R.id.contact_remark_input; setText(jsonText(scope.profile, "remark")); filters = arrayOf(android.text.InputFilter.LengthFilter(64)) }
        val group = input("分组").apply { id = R.id.contact_group_input; setText(jsonText(scope.profile, "group_name")); filters = arrayOf(android.text.InputFilter.LengthFilter(64)) }
        val panel = column(12).apply { addView(remark); addView(group) }
        val editor = android.app.AlertDialog.Builder(this).setTitle("分组和备注").setView(panel).setNegativeButton("取消", null).setPositiveButton("保存", null).create()
        editor.setOnShowListener { editor.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            if (!contactProfileCurrent(scope)) { editor.dismiss(); return@setOnClickListener }
            val name = remark.text.toString().trim(); val category = group.text.toString().trim(); editor.dismiss()
            mutateContactProfile(scope, { frozen -> frozen.updateContactRemark(scope.peerId, name, category) }) { result ->
                require(result.optInt("user_id") == scope.peerId)
                scope.profile.put("remark", result.opt("remark")).put("group_name", result.opt("group_name"))
                contactNames.remember(scope.profile.optInt("user_id"), jsonText(result, "remark"), jsonText(scope.profile, "nickname"))
            }
        } }
        editor.show()
    }

    private fun removeProfileContact(scope: ContactProfileScope) {
        if (!contactProfileCurrent(scope) || scope.pending) return
        if (!scope.profile.optBoolean("is_contact")) {
            mutateContactProfile(scope, { frozen -> frozen.sendFriendRequest(scope.peerId) }) { result ->
                if (result.optString("status") in listOf("accepted", "already_contact")) { scope.profile.put("is_contact", true).put("request_sent", false); reloadContactProfile(scope) }
                else scope.profile.put("request_sent", true)
            }; return
        }
        android.app.AlertDialog.Builder(this).setTitle("删除联系人").setMessage("删除后将解除双方的好友关系，聊天记录会保留。确定删除吗？").setNegativeButton("取消", null).setPositiveButton("删除") { _, _ ->
            mutateContactProfile(scope, { frozen -> frozen.removeContact(scope.peerId) }) { result ->
                require(result.optInt("user_id") == scope.peerId && result.optString("status") == "removed")
                val owner = LocalAccountStore.scope(scope.base, scope.target.userId)
                LocalChatArchive.disk.execute { runCatching { LocalDirectoryStore.removeContact(this, owner, scope.peerId) } }
                scope.profile.put("is_contact", false).put("remark", "").put("group_name", JSONObject.NULL).put("friend_source_label", "非联系人")
            }
        }.show()
    }

    private fun loadContactProfileRows(scope: ContactProfileScope, page: ContactProfileView.Page, number: Int) {
        if (!contactProfileCurrent(scope)) return
        val generation = scope.view.generation
        executor.execute {
            try {
                val result = if (page == ContactProfileView.Page.MEDIA) scope.client.sharedMedia(scope.target.conversationId, number) else scope.client.commonContactGroups(scope.peerId, number)
                runOnUiThread { if (contactProfileCurrent(scope) && scope.view.generation == generation) scope.view.acceptRows(page, number, result) }
            } catch (error: Exception) { runOnUiThread { if (contactProfileCurrent(scope) && scope.view.page == page && scope.view.generation == generation) scope.view.showError(error.message ?: "加载失败，请返回后重试") } }
        }
    }
    private fun closeChatAttachments() {
        chatAttachmentPanel?.let { (it.parent as? ViewGroup)?.removeView(it) }
        chatAttachmentPanel = null
        findViewById<View>(R.id.chat_attach)?.apply {
            contentDescription = "打开聊天功能"
            if (Build.VERSION.SDK_INT >= 30) stateDescription = "已收起"
        }
    }

    private fun attachmentIcon(kind: String): View = when (kind) {
        "card" -> ChatStyleIconView(this, "card", PulseColors.accent)
        "photo" -> ChatGlyph(this, "photo", PulseColors.accent).apply { setPadding(dp(4), dp(4), dp(4), dp(4)) }
        "camera" -> ChatGlyph(this, "camera", PulseColors.accent).apply { setPadding(dp(4), dp(4), dp(4), dp(4)) }
        "shake" -> text("⌁", 30f, PulseColors.accent).apply { gravity = Gravity.CENTER }
        else -> text("☆", 30f, PulseColors.accent).apply { gravity = Gravity.CENTER }
    }

    private fun showEmojiPanel(input: EditText) {
        if (!chatCanSend || !input.isEnabled) return
        chatEmojiPopup?.dismiss()
        val popup = PopupWindow(this)
        chatEmojiPopup = popup
        val panel = column(8).apply { background = rounded(Color.WHITE, 18); elevation = dp(8).toFloat() }
        val emojis = listOf("😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "🙂", "🙃", "😉", "😍", "😘", "😎", "🤔", "😮", "😢", "😭", "😡", "👍", "👏", "🙏", "❤️", "🎉", "🔥", "✅", "⭐")
        var line: LinearLayout? = null
        emojis.forEachIndexed { index, emoji ->
            if (index % 7 == 0) { line = row(); panel.addView(line) }
            line?.addView(text(emoji, 25f).apply { gravity = Gravity.CENTER; setOnClickListener { if (chatCanSend && input.isEnabled) input.text.insert(input.selectionStart.coerceAtLeast(0), emoji); popup.dismiss() } }, LinearLayout.LayoutParams(0, dp(48), 1f))
        }
        popup.contentView = panel
        popup.width = resources.displayMetrics.widthPixels
        popup.height = WindowManager.LayoutParams.WRAP_CONTENT
        popup.isFocusable = true
        popup.isOutsideTouchable = true
        popup.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        popup.setOnDismissListener { if (chatEmojiPopup === popup) chatEmojiPopup = null }
        popup.showAtLocation(content, Gravity.BOTTOM, 0, dp(70))
    }

    private fun openFavoritesChat() {
        executor.execute {
            try {
                val favorite = api.favoritesConversation()
                runOnUiThread { showChat(currentNickname, openConversation = favorite) }
            } catch (e: Exception) { runOnUiThread { toast(e.message ?: "打开收藏失败") } }
        }
    }

    private fun sendShake(messages: LinearLayout) {
        if (!currentInternalStaff) { toast("窗口抖动仅限内部人员使用"); return }
        if (activeConversationType != "direct") { toast("窗口抖动仅支持私聊"); return }
        val target = captureSendTarget() ?: return
        if (shakeInFlight?.matches(target.conversationId, target.userId, target.token) == true) { toast("窗口抖动正在发送"); return }
        shakeInFlight = target
        sendCaptured(target, { frozen -> frozen.sendShake(target.conversationId, target.requestId, target.replyToId) }, { if (shakeInFlight === target) shakeInFlight = null }) { sent ->
            if (currentMessages === messages && activeConversationType == "direct") addMessage(messages, sent)
        }
    }

    private fun showContactCardPicker(messages: LinearLayout) {
        if (!chatCanSend || !appForeground || appLock.locked || recorder != null || pendingVoice != null || currentMessages !== messages) return
        if (contactCardSendCancel != null) { toast("请先处理正在发送的名片"); return }
        val origin = captureSendTarget() ?: return
        val base = apiBaseUrl; val foreground = contactCardForegroundRevision
        fun current() = origin.matches(activeConversationId, currentUserId, api.token) && apiBaseUrl == base && currentMessages === messages &&
            messages.isAttachedToWindow && chatCanSend && appForeground && !appLock.locked && foreground == contactCardForegroundRevision && !isFinishing && !isDestroyed
        contactCardPicker?.dismiss()
        val client = ApiClient(base).apply { token = origin.token }
        lateinit var picker: ContactCardPicker
        picker = ContactCardPicker(this, origin.userId, executor, ::current, { client.contactsPage(it) },
            { image, label, url -> if (current()) loadChatImage(image, label, mediaUrl(url), messages, origin.token) }, { userId ->
                if (contactCardPicker === picker && current() && userId > 0) {
                    val target = origin.copy(requestId = "android-card-${java.util.UUID.randomUUID()}")
                    val body = JSONObject().put("user_id", userId).apply { if (target.replyToId > 0) put("reply_to_id", target.replyToId) }
                    sendCaptured(target, { frozen -> frozen.sendRawMessage(target.conversationId, "contact_card", body, target.requestId).also { sent ->
                            check(sent.optInt("id") > 0 && sent.optInt("conversation_id") == target.conversationId && sent.optInt("sender_id") == target.userId && sent.optString("type") == "contact_card" && sent.optJSONObject("body")?.optInt("user_id") == userId) { "名片发送响应无效，请重试" }
                        } },
                        settled = { contactCardSendCancel = null }, keepLabel = "取消发送", valid = ::current,
                        captureCancel = { contactCardSendCancel = it }) { sent ->
                            if (current() && sent.optInt("conversation_id") == target.conversationId && sent.optString("type") == "contact_card") {
                                addMessage(messages, sent); postChatBottom(messages, messages.parent as? ScrollView); toast("名片已发送")
                            }
                        }
                }
            })
        contactCardPicker = picker
        picker.setOnDismissListener { if (contactCardPicker === picker) contactCardPicker = null }
        picker.show()
    }

    private fun openChatCamera(messages: LinearLayout) {
        if (pendingVoice != null || recorder != null) { toast("请先完成或取消语音"); return }
        if (photoBatch != null) { toast("图片正在发送，请先完成或停止当前发送"); return }
        pendingMediaTarget = captureSendTarget() ?: return
        pendingMessages = messages
        pendingMediaKind = "image"
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), chatCameraPermissionRequest)
            toast("请允许相机权限，然后再次点击拍摄")
            return
        }
        launchChatCamera()
    }

    private fun launchChatCamera() {
        val file = File(cacheDir, "chat-camera-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
        pendingCameraFile = file
        pendingCameraUri = uri
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try { startActivityForResult(intent, chatCameraResult) }
        catch (e: Exception) { pendingCameraFile?.delete(); pendingCameraFile = null; pendingCameraUri = null; toast("当前设备没有可用的相机") }
    }

    private fun smallAction(label: String, primary: Boolean = false, action: (TextView) -> Unit) = TextView(this).apply {
        text = label
        textSize = if (primary) 12f else 18f
        gravity = Gravity.CENTER
        typeface = if (primary) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        setTextColor(if (primary) Color.WHITE else PulseColors.accent)
        background = rounded(if (primary) PulseColors.accent else PulseColors.accentSoft, 14)
        layoutParams = LinearLayout.LayoutParams(if (primary) dp(54) else dp(44), dp(44)).apply { setMargins(dp(4), 0, 0, 0) }
        setOnClickListener { action(this) }
    }
    private fun showGroupMembers() {
        if (activeConversationType != "group") return
        val conversation = activeConversationId; val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl
        val notice = groupAnnouncement; val entryForeground = groupForegroundRevision; val metadataRequest = ++groupMetadataRequest
        val client = ApiClient(base).apply { this.token = token }
        fun current() = groupAnnouncement === notice && groupForegroundRevision == entryForeground && appForeground && activeConversationType == "group" && activeConversationId == conversation && currentUserId == actor && api.token == token && apiBaseUrl == base && !appLock.locked && !isFinishing && !isDestroyed
        groupInfoSheet?.setBusy(true)
        executor.execute {
            try {
                val profile = client.groupProfile(conversation); val members = client.conversationMembers(conversation)
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    val restricted = !(profile.optBoolean("can_manage") || profile.optBoolean("allow_member_add_friend")) || profile.optString("members_visibility") == "managers"
                    if (restricted && (0 until members.length()).any {
                            val row = members.optJSONObject(it)
                            row?.optString("role") !in listOf("owner", "admin") || row?.optInt("user_id") == actor
                        }) {
                        groupInfoSheet?.dismiss(); groupInfoSheet = null
                        toast("成员权限已变更，请重新打开群资料重试")
                        return@runOnUiThread
                    }
                    if (metadataRequest == groupMetadataRequest) renderGroupMetadata(profile)
                    groupInfoSheet?.takeIf { it.isShowing }?.let { it.updateProfile(profile); it.updateMembers(members); it.setBusy(false); return@runOnUiThread }
                    lateinit var sheet: GroupInfoSheet
                    sheet = GroupInfoSheet(this, profile, members, actor,
                        loadAvatar = { image, fallback, raw ->
                            currentMessages?.let { messages -> if (current()) loadChatImage(image, fallback, raw, messages, token) }
                        },
                        onSettings = { muted, pinned ->
                            executor.execute {
                                try {
                                    val updated = client.updateGroupSettings(conversation, muted, pinned)
                                    runOnUiThread {
                                        if (api.token == token && currentUserId == actor && apiBaseUrl == base) {
                                            notificationRevision(); notificationSettingsRevision++
                                            notificationSettings[conversation] = NotificationSetting(updated.optBoolean("notifications_muted", muted), notificationSettingsRevision)
                                        }
                                        if (current() && groupInfoSheet === sheet && sheet.isShowing) { sheet.updateProfile(updated); sheet.setBusy(false) }
                                    }
                                } catch (error: Exception) { runOnUiThread { if (current() && groupInfoSheet === sheet) { sheet.setBusy(false); sheet.showError(contactError(error, "群设置保存失败")) } } }
                            }
                        },
                        onEdit = { if (current()) showEditGroupProfile(sheet.profileSnapshot()) },
                        onAdd = { if (current()) showGroupMemberPicker(sheet.membersSnapshot()) },
                        onMember = { member -> if (current()) showGroupMemberActions(member.optInt("user_id"), member.optString("role"), sheet.profileSnapshot().optBoolean("is_owner"), jsonText(member, "muted_until").isNotBlank()) },
                        onProfile = { peer -> if (current()) { sheet.dismiss(); showGroupMemberProfile(peer) } },
                        onDissolve = { if (current()) confirmDissolveGroup() })
                    groupInfoSheet = sheet
                    sheet.contactName = ::contactDisplayName
                    sheet.setOnDismissListener { if (groupInfoSheet === sheet) { groupInfoSheet = null; groupAnnouncement?.resume() } }
                    sheet.show()
                }
            } catch (error: Exception) { runOnUiThread { if (current()) { groupInfoSheet?.setBusy(false); toast(contactError(error, "加载群组失败")) } } }
        }
    }
    private fun applyChatSendPermission(permission: ChatSendPermission) {
        val disablingSend = !permission.allowed && chatCanSend
        chatCanSend = permission.allowed; chatSendDisabledReason = permission.reason
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
                pendingMediaTarget = null; pendingMessages = null
                photoBatch?.let { finishPhotoBatch(it) }
                contactCardPicker?.dismiss(); contactCardSendCancel?.invoke()
            }
        }
        renderPendingVoice()
    }

    private fun renderGroupMetadata(profile: JSONObject) {
        if (profile.optInt("id") != activeConversationId || activeConversationType != "group") return
        persistGroupPermission(profile)
        applyChatSendPermission(ChatSendPermission.from(profile, "group"))
        groupMentionRole = if (profile.optInt("id") == activeConversationId) profile.optString("my_role") else ""
        groupMentionPicker?.refreshPermission()
        refreshGroupMentionAvatars()
        groupViewerCanManage = profile.optInt("id") == activeConversationId && profile.optBoolean("can_manage") && profile.optString("my_role") in listOf("owner", "admin")
        groupViewerCanViewProfiles = profile.optInt("id") == activeConversationId && (groupViewerCanManage || profile.optBoolean("allow_member_add_friend"))
        if (chatCanPin != groupViewerCanManage) { chatCanPin = groupViewerCanManage; messageActionMenu?.dismiss(); renderMessagePins() }
        if (!groupViewerCanViewProfiles) { groupProfileRequest++; groupMemberProfileScope?.dialog?.dismiss() }
        findViewById<TextView>(R.id.group_chat_title)?.text = profile.optString("name", "群组")
        findViewById<TextView>(R.id.group_chat_members)?.text = "${profile.optInt("member_count")} 位成员"
        groupAnnouncement?.accept(if (profile.isNull("announcement")) "" else profile.optString("announcement", ""))
    }
    private fun persistGroupPermission(profile: JSONObject) {
        val owner = localAccount() ?: return
        val cid = profile.optInt("id"); if (cid <= 0) return
        val copy = JSONObject(profile.toString())
        val scope = LocalChatStore.scope(owner.endpoint, owner.userId, owner.token)
        LocalChatArchive.disk.execute {
            runCatching {
                LocalDirectoryStore.updateConversationInfo(this, owner.scope, cid, copy)
                val previous = LocalChatStore.read(this, scope, cid, limit = 1).info
                val merged = JSONObject((previous ?: copy).toString())
                for (key in listOf("can_send", "send_disabled_reason", "my_muted_until", "all_muted", "my_role", "status", "frozen_at", "can_manage", "allow_member_add_friend")) {
                    if (copy.has(key)) merged.put(key, copy.get(key))
                }
                if (previous?.toString() != merged.toString()) LocalChatStore.merge(this, LocalChatStore.ticket(this, scope, cid), emptyList(), info = merged)
            }.onFailure { diagnostics.fault("ANDROID_LOCAL_GROUP_PERMISSION", it) }
        }
    }
    private fun refreshGroupMetadata() {
        if (activeConversationType != "group" || !::api.isInitialized || activeConversationId <= 0 || !appForeground || appLock.locked) return
        val origin = captureGroupOrigin() ?: return
        if (groupMetadataInFlight == origin) { groupMetadataQueued = true; return }
        groupMetadataInFlight = origin; groupMetadataQueued = false
        origin.entry.resume()
        val request = ++groupMetadataRequest
        val client = ApiClient(origin.base).apply { token = origin.token }
        messageActionExecutor.execute {
            try {
                val profile = client.groupProfile(origin.groupId)
                runOnUiThread { if (groupOriginCurrent(origin) && request == groupMetadataRequest) renderGroupMetadata(profile) }
            } catch (_: Exception) { /* Keep the last authoritative group title and count. */ }
            finally { runOnUiThread {
                if (groupMetadataInFlight == origin) {
                    groupMetadataInFlight = null
                    val again = groupMetadataQueued; groupMetadataQueued = false
                    if (again && groupOriginCurrent(origin)) refreshGroupMetadata()
                }
            } }
        }
    }
    private fun showEditGroupProfile(profile: JSONObject) {
        val conversation = activeConversationId; val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl
        val notice = groupAnnouncement; val entryForeground = groupForegroundRevision
        val client = ApiClient(base).apply { this.token = token }
        fun current() = groupAnnouncement === notice && groupForegroundRevision == entryForeground && appForeground && activeConversationId == conversation && activeConversationType == "group" && currentUserId == actor && api.token == token && apiBaseUrl == base && !appLock.locked && !isFinishing && !isDestroyed
        lateinit var sheet: GroupProfileEditSheet
        sheet = GroupProfileEditSheet(this, profile) { name, description, announcement, allowFriends ->
            val metadataRequest = ++groupMetadataRequest
            executor.execute {
                try {
                    val updated = client.updateGroupProfile(conversation, name, description, announcement, allowMemberAddFriend = allowFriends)
                    runOnUiThread { if (current() && groupEditSheet === sheet && sheet.isShowing) { sheet.dismiss(); if (metadataRequest == groupMetadataRequest) renderGroupMetadata(updated); groupInfoSheet?.updateProfile(updated); toast("群资料已保存") } }
                } catch (error: Exception) { runOnUiThread { if (current() && groupEditSheet === sheet) sheet.showError(contactError(error, "保存失败")) } }
            }
        }
        groupEditSheet?.dismiss(); groupEditSheet = sheet
        sheet.setOnDismissListener { if (groupEditSheet === sheet) { groupEditSheet = null; groupAnnouncement?.resume() } }
        sheet.show()
    }
    private fun showGroupMemberPicker(members: JSONArray) {
        val conversation = activeConversationId; val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }
        fun current() = appForeground && activeConversationId == conversation && activeConversationType == "group" && currentUserId == actor && api.token == token && apiBaseUrl == base && !appLock.locked && !isFinishing && !isDestroyed
        executor.execute {
            try {
                val profile = client.groupProfile(conversation)
                if (!profile.optBoolean("can_manage") || profile.optString("my_role") !in listOf("owner", "admin") || !profile.optBoolean("can_invite", true)) throw IllegalStateException("只有群主或管理员可以邀请新成员。")
                val contacts = JSONArray(); val seen = mutableSetOf<Int>(); var page = 1
                while (true) {
                    val result = client.contactsPage(page); val items = result.getJSONArray("items"); var added = 0
                    for (i in 0 until items.length()) { val item = items.getJSONObject(i); if (seen.add(item.optInt("user_id", item.optInt("id")))) { contacts.put(item); added++ } }
                    if (added == 0 || items.length() < 50 || page * 50 >= result.optInt("total", Int.MAX_VALUE)) break
                    page++
                }
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    val existing = (0 until members.length()).map { members.getJSONObject(it).optInt("user_id") }.toSet()
                    lateinit var sheet: GroupMemberPickerSheet
                    sheet = GroupMemberPickerSheet(this, contacts, { userId ->
                        confirmInviteHistory { allowHistory ->
                                        if(!current())return@confirmInviteHistory
                        executor.execute {
                            try { client.addConversationMember(conversation, userId, allowHistory); runOnUiThread { if (current() && groupPickerSheet === sheet) { sheet.dismiss(); showGroupMembers(); toast("成员已添加") } } }
                            catch (error: Exception) { runOnUiThread { if (current() && groupPickerSheet === sheet) sheet.showError(contactError(error, "添加成员失败")) } }
                        }
                        }
                    }, existing)
                    groupPickerSheet?.dismiss(); groupPickerSheet = sheet
                    sheet.setOnDismissListener { if (groupPickerSheet === sheet) groupPickerSheet = null }
                    sheet.show()
                }
            } catch (error: Exception) { runOnUiThread { if (current()) toast(contactError(error, "加载联系人失败")) } }
        }
    }
    private fun showGroupMemberActions(userId: Int, role: String, isOwner: Boolean, muted: Boolean = false) {
        val conversation = activeConversationId; val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }
        fun current() = appForeground && activeConversationType == "group" && activeConversationId == conversation && currentUserId == actor && api.token == token && apiBaseUrl == base && !appLock.locked && !isFinishing && !isDestroyed
        val options = mutableListOf<String>()
        if (isOwner) options.add(if (role == "admin") "取消管理员" else "设为管理员")
        options.add(if (muted) "解除禁言" else if(BuildConfig.GO_BACKEND) "永久禁言" else "禁言10分钟"); options.add("移出群组")
        if (isOwner) options.add("转让群主")
        android.app.AlertDialog.Builder(this).setTitle("成员管理").setItems(options.toTypedArray()) { _, which ->
            if (!current()) return@setItems
            groupInfoSheet?.setBusy(true)
            executor.execute {
                try {
                    when (options[which]) {
                        "禁言10分钟" -> client.muteConversationMember(conversation, userId, 10)
                        "永久禁言" -> client.muteConversationMember(conversation, userId, -1)
                        "解除禁言" -> client.muteConversationMember(conversation, userId, 0)
                        "移出群组" -> client.removeConversationMember(conversation, userId)
                        "设为管理员" -> client.setConversationRole(conversation, userId, "admin")
                        "取消管理员" -> client.setConversationRole(conversation, userId, "member")
                        "转让群主" -> client.transferGroup(conversation, userId)
                    }
                    runOnUiThread { if (current()) { toast("群成员设置已更新"); showGroupMembers() } }
                } catch (error: Exception) { runOnUiThread { if (current()) { groupInfoSheet?.setBusy(false); groupInfoSheet?.showError(contactError(error, "群成员操作失败")) } } }
            }
        }.setNegativeButton("取消", null).show()
    }
    private fun confirmDissolveGroup() {
        val conversation = activeConversationId; val actor = currentUserId; val token = api.token ?: return; val base = apiBaseUrl
        val client = ApiClient(base).apply { this.token = token }
        fun current() = appForeground && activeConversationType == "group" && activeConversationId == conversation && currentUserId == actor && api.token == token && apiBaseUrl == base && !appLock.locked && !isFinishing && !isDestroyed
        android.app.AlertDialog.Builder(this).setMessage("解散后群成员和聊天记录都会被删除，确定继续吗？")
            .setNegativeButton("取消", null).setPositiveButton("解散") { _, _ ->
                if (!current()) return@setPositiveButton
                groupInfoSheet?.setBusy(true)
                executor.execute {
                    try {
                        client.dissolveGroup(conversation)
                        runOnUiThread { if (current()) { closeGroupChatOverlays(); toast("群组已解散"); showChat(currentNickname) } }
                    } catch (error: Exception) { runOnUiThread { if (current()) { groupInfoSheet?.setBusy(false); groupInfoSheet?.showError(contactError(error, "操作失败")) } } }
                }
            }.show()
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (authView?.registrationAvatarResult(requestCode, resultCode, data) == true) return
        if (myFeature?.activityResult(requestCode, resultCode, data) == true) return
        val scan: IntentResult? = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan != null) {
            val scope = qrScannerAccount; qrScannerAccount = null
            if (scope == null || !qrCurrent(scope)) return
            if (scan.contents.isNullOrBlank()) toast("已取消扫码") else handleQrContent(scan.contents, scope)
            return
        }
        if (requestCode == 42 && resultCode == RESULT_OK && data?.data != null) {
            val uri = data.data!!
            val target = groupCreate ?: return
            val token = api.token ?: return; val actor = currentUserId
            val client = ApiClient(apiBaseUrl).apply { this.token = token }
            mediaExecutor.execute {
                try {
                    MediaUploadFiles.prepare(this, uri, "image", avatar = true).use { prepared ->
                        if (api.token != token || currentUserId != actor) return@execute
                        val upload = client.uploadMedia(prepared.file, "image", prepared.mime)
                        runOnUiThread { if (groupCreate === target && api.token == token && currentUserId == actor) target.avatarUploaded(upload.optString("url")) }
                    }
                } catch (e: Exception) {
                    runOnUiThread { if (groupCreate === target && api.token == token && currentUserId == actor) target.showError(contactError(e, "群组头像上传失败，请重试")) }
                }
            }
            return
        }
        if (requestCode == 42) {
            groupCreate?.setUploading(false)
            return
        }
        if (requestCode == chatCameraResult) {
            val uri = pendingCameraUri
            val cameraFile = pendingCameraFile
            pendingCameraUri = null
            pendingCameraFile = null
            if (resultCode == RESULT_OK && uri != null) {
                uploadChatMedia(uri, "image", pendingMessages)
            } else {
                cameraFile?.delete()
                pendingMediaTarget = null; pendingMessages = null
            }
            return
        }
        if (requestCode != 41) return
        val selected = PhotoAlbumPickerActivity.selectedUris(data)
        if (resultCode != RESULT_OK || selected.isEmpty()) {
            pendingMediaTarget = null; pendingMessages = null
            return
        }
        val selectedKind = if (pendingMediaKind in listOf("image", "video"))
            data?.getStringExtra(PhotoAlbumPickerActivity.RESULT_MEDIA_KIND)?.takeIf { it in listOf("image", "video") } ?: pendingMediaKind else pendingMediaKind
        if (selectedKind == "image") uploadChatImages(selected, pendingMessages)
        else uploadChatMedia(selected.first(), selectedKind, pendingMessages)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (myFeature?.permissionResult(requestCode, grantResults) == true) return
        if (requestCode == qrCameraPermissionRequest) {
            val scope = qrScannerAccount
            if (scope == null || !qrCurrent(scope)) { qrScannerAccount = null; return }
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) launchQrScanner(scope)
            else { qrScannerAccount = null; toast("需要相机权限才能扫一扫") }
        }
        if (requestCode == chatCameraPermissionRequest) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) launchChatCamera()
            else toast("需要相机权限才能拍摄")
        }
    }
    private fun queryFileName(uri: Uri, sanitize: Boolean = true): String { var name = "file"; contentResolver.query(uri, null, null, null, null)?.use { cursor -> val index = cursor.getColumnIndex("_display_name"); if (index >= 0 && cursor.moveToFirst()) name = cursor.getString(index) }; return if (sanitize) name.replace(Regex("[^A-Za-z0-9._-]"), "_") else name.replace('/', '_').replace('\\', '_').filter { it.code >= 32 }.take(160) }

    private fun renderPendingTextMessages(container: LinearLayout) {
        if (container !== currentMessages) return
        val pending = textSends.pending(api.token, currentUserId, apiBaseUrl, activeConversationId)
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
                setOnClickListener { runCatching { if (chatCanSend && textSends.retry(entry, api.token, currentUserId, apiBaseUrl)) { renderPendingTextMessages(container); drainTextOutbox() } }.onFailure { toast("本地状态保存失败，请检查存储空间") } }
                isClickable = failed
            }
            pendingRow.findViewWithTag<TextView>("text-send-remove").apply {
                visibility = if (entry.phase == TextSendQueue.Phase.FAILED) View.VISIBLE else View.GONE
                setOnClickListener { runCatching { if (textSends.discard(entry, api.token, currentUserId, apiBaseUrl)) { renderPendingTextMessages(container); drainTextOutbox() } }.onFailure { toast("本地状态保存失败，请重试") } }
            }
        }
        renderPendingMediaMessages(container)
    }
    private fun drainTextOutbox() {
        if (isFinishing || isDestroyed || api.token == null || !localOutboxesReady || localSessionOnly || !appForeground || appLock.locked) return
        val queue = textSends
        val claimed = runCatching { queue.claim(api.token, currentUserId, apiBaseUrl) }.getOrElse { toast("本地待发状态保存失败，请检查存储空间"); return }
        claimed.forEach { entry ->
            val attempt = entry.attempt
            ownedTextAttempts[entry.requestId] = Triple(queue, entry, attempt)
            currentMessages?.let { renderPendingTextMessages(it) }
            val client = ApiClient(entry.endpoint).apply { token = entry.token }
            textExecutor.execute {
                try {
                    if (api.token != entry.token || currentUserId != entry.userId || apiBaseUrl != entry.endpoint) throw IllegalStateException("账号已切换，请返回原账号重试")
                    if (entry.conversationId == activeConversationId && !chatCanSend) throw IllegalStateException("已禁止发言")
                    val sent = client.sendText(entry.conversationId, entry.text, entry.requestId, entry.replyToId, entry.mentionUserIds())
                    if (sent.optInt("id") <= 0 || sent.optInt("conversation_id") != entry.conversationId || sent.optInt("sender_id") != entry.userId) throw IllegalStateException("消息回执无效，请重试")
                    val acknowledged = queue.acknowledge(entry.requestId, entry.token, entry.userId, entry.endpoint, entry.conversationId)
                    runOnUiThread {
                        ownedTextAttempts.remove(entry.requestId)
                        if (acknowledged != null && api.token == entry.token && currentUserId == entry.userId && apiBaseUrl == entry.endpoint && !isDestroyed) {
                            if (activeConversationId == entry.conversationId) currentMessages?.let { messages -> renderPendingTextMessages(messages); addMessage(messages, sent); postChatBottom(messages, messages.parent as? ScrollView) }
                        }
                        drainTextOutbox()
                    }
                } catch (error: Exception) {
                    val failed = runCatching { queue.fail(entry, error.message ?: "网络异常", attempt) }.getOrElse { diagnostics.fault("ANDROID_LOCAL_TEXT_STATE", it); false }
                    runOnUiThread {
                        ownedTextAttempts.remove(entry.requestId)
                        if (failed && queue === textSends && !isDestroyed) currentMessages?.let { renderPendingTextMessages(it) }
                        drainTextOutbox()
                    }
                }
            }
        }
    }

    private fun captureSendTarget(): SendTarget? {
        val token = api.token ?: return null
        if (activeConversationId <= 0 || currentUserId <= 0 || !chatCanSend) return null
        return SendTarget(activeConversationId, currentUserId, token, replyToId = replyMessage?.optInt("id") ?: 0, replyRevision = replyRevision)
    }
    private enum class SendPhase { SENDING, FAILED, ACCEPTED }
    private fun sendCaptured(target: SendTarget, operation: (ApiClient) -> JSONObject, settled: () -> Unit = {}, state: (SendPhase) -> Unit = {}, keepLabel: String = "保留草稿", valid: () -> Boolean = { true }, captureCancel: ((() -> Unit) -> Unit)? = null, done: (JSONObject) -> Unit) {
        if (!target.matches(activeConversationId, currentUserId, api.token) || !valid()) { settled(); toast("会话或账号已切换，发送已取消"); return }
        chatLocateTarget = 0; chatNavigationRevision++
        val base = apiBaseUrl
        val client = ApiClient(base).apply { token = target.token }
        val lifecycle = SendAttemptState()
        var failureDialog: android.app.AlertDialog? = null
        lateinit var acknowledge: (JSONObject) -> Unit
        fun current() = target.matches(activeConversationId, currentUserId, api.token) && apiBaseUrl == base && !isFinishing && !isDestroyed && valid()
        fun settleOnce() { if (lifecycle.settle()) settled() }
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
                        state(SendPhase.FAILED)
                        failureDialog = android.app.AlertDialog.Builder(this).setTitle("发送未确认").setMessage("${error.message ?: "网络异常"}\n重试会使用同一请求编号，避免重复发送。")
                            .setNegativeButton(keepLabel) { _, _ -> cancelAttempt() }.setOnCancelListener { cancelAttempt() }
                            .setPositiveButton("重试") { _, _ -> closeFailure(); dispatchAttempt() }.create().also { it.show() }
                    }
                }
            }
        }
        val known = currentMessageData.values.firstOrNull {
            it.optInt("id") > 0 && it.optInt("sender_id") == target.userId && it.optInt("conversation_id") == target.conversationId && it.optJSONObject("body")?.optString("request_id") == target.requestId
        }
        if (known != null) acknowledge(known) else dispatchAttempt()
    }
    private fun photoBatchCurrent(batch: PhotoBatch): Boolean = photoBatch === batch && batch.items.first().target.matches(activeConversationId, currentUserId, api.token) &&
        apiBaseUrl == batch.base && !isFinishing && !isDestroyed

    private fun finishPhotoBatch(batch: PhotoBatch, feedback: String? = null) {
        if (photoBatch !== batch) return
        photoBatch = null
        batch.uploadCalls.values.forEach { it.cancel() }; batch.uploadCalls.clear()
        batch.items.forEach { it.uploading?.cancel(true) }
        groupUploads.remove(batch.items.first().target.requestId)
        batch.failure?.setOnCancelListener(null); batch.failure?.dismiss(); batch.failure = null
        val cancel = batch.cancelSend; batch.cancelSend = null; cancel?.invoke()
        (batch.progress.parent as? ViewGroup)?.removeView(batch.progress)
        if (feedback != null && !isFinishing && !isDestroyed) toast(feedback)
    }

    private fun uploadChatImages(uris: List<Uri>, messages: LinearLayout?) {
        val captured = pendingMediaTarget ?: return
        pendingMediaTarget = null; pendingMessages = null
        if (!captured.matches(activeConversationId, currentUserId, api.token) || !chatCanSend) { toast("会话或账号已切换，图片发送已取消"); return }
        val ordered = uris.filter { it.scheme == "content" }.distinct().take(PhotoAlbumPickerActivity.MAX_CHAT_PHOTOS)
        if (ordered.isEmpty()) return
        stageDurableMedia(captured, ordered, "image", messages)
    }

    private fun prefetchPhotoUpload(batch: PhotoBatch, index: Int) {
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
    }

    private fun drainPhotoBatch(batch: PhotoBatch) {
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
    }

    private fun stageDurableMedia(target: SendTarget, uris: List<Uri>, kind: String, messages: LinearLayout?) {
        val queue = mediaOutbox
        if (!localOutboxesReady || queue == null) { bindLocalOutboxes(retryNow = true); toast("正在恢复本地待发消息，请稍后重新选择"); return }
        val base = apiBaseUrl
        val progress = text("正在保存待发附件…", 13f, PulseColors.muted).apply { gravity = Gravity.CENTER }
        messages?.addView(progress); groupUploads.add(target.requestId)
        outboxStageExecutor.execute {
            var saved = 0
            val staged = mutableListOf<DurableMediaOutbox.Entry>()
            try {
                uris.forEachIndexed { index, uri ->
                    check(api.token == target.token && currentUserId == target.userId && apiBaseUrl == base) { "账号已切换，已保存的附件会保留在原账号" }
                    val requestId = if (index == 0) target.requestId else "android-${java.util.UUID.randomUUID()}"
                    MediaUploadFiles.prepare(this, uri, kind).use { prepared ->
                        staged.add(queue.enqueue(requestId, target.conversationId, kind, prepared.mime, prepared.displayName, prepared.file,
                            if (index == 0) target.replyToId else 0, 0L))
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
                    (progress.parent as? ViewGroup)?.removeView(progress); groupUploads.remove(target.requestId)
                    if (queue === mediaOutbox) { currentMessages?.let { renderPendingMediaMessages(it) }; drainMediaOutbox() }
                }
            }
        }
    }

    private fun renderPendingMediaMessages(container: LinearLayout) {
        if (container !== currentMessages) return
        val queue = mediaOutbox ?: return
        val entries = queue.pending(activeConversationId)
        (0 until container.childCount).map { container.getChildAt(it) }.filter { (it.tag as? String)?.startsWith("pending-media:") == true }.forEach { container.removeView(it) }
        entries.forEach { entry ->
            val kind = when (entry.kind) { "image" -> "图片"; "video" -> "视频"; "voice" -> "语音"; else -> "文件" }
            val failed = entry.phase == DurableMediaOutbox.Phase.FAILED
            val status = when (entry.phase) {
                DurableMediaOutbox.Phase.QUEUED -> "等待发送"
                DurableMediaOutbox.Phase.UPLOADING -> "正在上传"
                DurableMediaOutbox.Phase.COMMITTING -> "正在发送"
                else -> "${entry.error.ifBlank { "发送未确认" }} · 点击重试"
            }
            container.addView(column(0).apply {
                tag = "pending-media:${entry.requestId}"; gravity = Gravity.END; setPadding(dp(12), dp(6), dp(12), dp(6))
                addView(text("[$kind] ${entry.displayName}", 14f).apply { maxWidth = resources.displayMetrics.widthPixels - dp(70); setTag(R.id.appearance_user_content, true) })
                addView(text(status, 12f, if (failed) PulseColors.danger else PulseColors.muted).apply {
                    minHeight = dp(30)
                    if (failed) setOnClickListener {
                        if (!chatCanSend || localSessionOnly) { toast("当前无法发送，请联网后确认发言权限"); return@setOnClickListener }
                        runCatching { if (queue.retry(entry)) { renderPendingMediaMessages(container); drainMediaOutbox() } }.onFailure { toast("本地状态保存失败，请检查存储空间") }
                    }
                })
                if (failed || entry.phase == DurableMediaOutbox.Phase.QUEUED) addView(text("移除", 12f, PulseColors.muted).apply {
                    minHeight = dp(30); contentDescription = "移除待发送$kind"
                    setOnClickListener { runCatching { if (queue.discard(entry)) { renderPendingMediaMessages(container); drainMediaOutbox() } }.onFailure { toast("本地状态保存失败，请重试") } }
                })
            })
        }
    }

    private fun drainMediaOutbox() {
        val queue = mediaOutbox ?: return
        if (!localOutboxesReady || localSessionOnly || !appForeground || appLock.locked || !chatCanSend || activeConversationId <= 0 || isDestroyed || isFinishing) return
        val entry = runCatching { queue.claim(activeConversationId) }.getOrElse { toast("本地待发状态保存失败，请检查存储空间"); return } ?: return
        val attempt = entry.attempt
        ownedMediaAttempts[entry.requestId] = Triple(queue, entry, attempt)
        val calls = ApiRequestScope()
        mediaSendRequests[entry.requestId] = calls
        currentMessages?.let { renderPendingMediaMessages(it) }
        fun current() = queue === mediaOutbox && entry.token == api.token && entry.userId == currentUserId && entry.endpoint == apiBaseUrl && entry.conversationId == activeConversationId && appForeground && !appLock.locked && chatCanSend && !isDestroyed && !isFinishing
        photoUploadExecutor.execute {
            try {
                check(current()) { "发送已暂停，请返回原会话重试" }
                val client = ApiClient(entry.endpoint).apply { token = entry.token; requestScope = calls }
                val upload = if (entry.uploadJson.isNotBlank()) JSONObject(entry.uploadJson) else queue.openFile(entry).use { opened ->
                    val result = client.uploadMedia(opened.file, entry.kind, entry.mime).put("name", entry.displayName)
                    check(queue.uploaded(entry, result.toString(), attempt)) { "附件发送已停止" }
                    if (entry.kind == "image") runCatching {
                        ChatImageCache.seedUploaded(this, entry.endpoint + "|" + entry.token, RouteManager.media(result.getString("url"), entry.endpoint), opened.file) { current() }
                    }
                    result
                }
                check(current()) { "附件已保存，请返回原会话重试" }
                check(queue.committing(entry, attempt)) { "发送已暂停" }
                val sent = if (entry.kind == "voice") client.sendVoice(entry.conversationId, upload.getString("url"), entry.durationMs, entry.size, entry.requestId, entry.replyToId)
                    else client.sendMediaMessage(entry.conversationId, entry.kind, upload, entry.requestId, entry.replyToId)
                check(sent.optInt("id") > 0 && sent.optInt("conversation_id") == entry.conversationId && sent.optInt("sender_id") == entry.userId) { "消息回执无效，请重试" }
                queue.acknowledge(entry.requestId, entry.conversationId)
                runOnUiThread {
                    if (queue === mediaOutbox && entry.token == api.token && currentUserId == entry.userId && entry.conversationId == activeConversationId) {
                        completeDurableReply(entry.requestId, entry.replyToId)
                        currentMessages?.let { addMessage(it, sent); renderPendingMediaMessages(it); postChatBottom(it, it.parent as? ScrollView) }
                    }
                }
            } catch (error: Exception) {
                runCatching { queue.fail(entry, error.message ?: "发送未确认，请重试", attempt) }.onFailure { diagnostics.fault("ANDROID_LOCAL_MEDIA_STATE", it) }
                diagnostics.fault("ANDROID_DURABLE_MEDIA_SEND", error)
            } finally {
                mediaSendRequests.remove(entry.requestId, calls)
                runOnUiThread {
                    if (ownedMediaAttempts[entry.requestId]?.third == attempt) ownedMediaAttempts.remove(entry.requestId)
                    if (queue === mediaOutbox) { currentMessages?.let { renderPendingMediaMessages(it) }; drainMediaOutbox() }
                }
            }
        }
    }

    private fun completeDurableReply(requestId: String, replyId: Int) {
        val revision = durableReplyRevisions.remove(requestId) ?: return
        if (replyId > 0 && replyRevision == revision && replyMessage?.optInt("id") == replyId) { replyMessage = null; replyRevision++; renderReplyPreview() }
    }

    private fun acknowledgeDurableMessage(message: JSONObject) {
        if (message.optInt("id") <= 0 || message.optInt("sender_id") != currentUserId) return
        val requestId = message.optJSONObject("body")?.optString("request_id").orEmpty()
        if (requestId.isBlank()) return
        if (!localOutboxesReady) { pendingDurableAcks["${message.optInt("conversation_id")}|$requestId"] = JSONObject(message.toString()); return }
        runCatching {
            val text = textSends.acknowledge(requestId, api.token, currentUserId, apiBaseUrl, message.optInt("conversation_id"))
            val media = mediaOutbox?.acknowledge(requestId, message.optInt("conversation_id"))
            media?.let { entry ->
                if (entry.conversationId == activeConversationId) completeDurableReply(entry.requestId, entry.replyToId)
            }
            if (media != null) mediaSendRequests.remove(requestId)?.cancel()
            if (text != null || media != null) { currentMessages?.let { renderPendingTextMessages(it) }; drainTextOutbox(); drainMediaOutbox() }
        }.onFailure { diagnostics.fault("ANDROID_LOCAL_MEDIA_ACK", it) }
    }

    private fun persistDirectoryMessage(message: JSONObject) {
        val account = localAccount() ?: return
        if (message.optInt("id") <= 0 || message.optInt("conversation_id") <= 0) return
        val copy = JSONObject(message.toString())
        LocalChatArchive.disk.execute { runCatching { LocalDirectoryStore.updateMessage(this, account.scope, copy) }.onFailure { diagnostics.fault("ANDROID_LOCAL_DIRECTORY_EVENT", it) } }
    }

    private fun uploadChatMedia(uri: Uri, kind: String, messages: LinearLayout?) {
        val target = pendingMediaTarget ?: return
        pendingMediaTarget = null; pendingMessages = null
        if (!target.matches(activeConversationId, currentUserId, api.token)) { toast("会话或账号已切换，文件发送已取消"); return }
        stageDurableMedia(target, listOf(uri), kind, messages)
    }
    private var goRefreshRunning = false
    private var goRefreshAgain = false
    private var goMembershipVersion = ""
    private fun refreshGoConversation() {
        val cid=activeConversationId;val actor=currentUserId;val session=api.token?:return;val base=apiBaseUrl
        if(cid<=0)return
        if(goRefreshRunning){goRefreshAgain=true;return};goRefreshRunning=true
        messageExecutor.execute {
            try {
                val value=ApiClient(base).apply{token=session}.conversationInfo(cid)
                runOnUiThread {
                    if(api.token!=session||activeConversationId!=cid||currentUserId!=actor||apiBaseUrl!=base)return@runOnUiThread
                    val version=value.optString("membership_version")
                    val changed=value.optBoolean("_membership_reset")||(goMembershipVersion.isNotEmpty()&&goMembershipVersion!=version)
                    goMembershipVersion=version
                    if(changed){showChat(currentNickname,openConversation=value)} else {
                        applyChatSendPermission(ChatSendPermission.from(value,activeConversationType))
                        val boundary=value.optInt("cleared_before_message_id")
                        if(boundary>chatClearedBefore)applyPersonalHistoryClear(boundary)
                        refreshCurrentMessages(allowUnsubscribed=true)
                        if(activeConversationType=="group")refreshGroupMetadata()
                    }
                }
            }catch(e:Exception){
                runOnUiThread{if(api.token==session&&activeConversationId==cid&&e is ClientApiException&&e.status in listOf(401,403,404)){
                    currentMessages?.removeAllViews();chatHistoryReady=false;activeMessageRecovery=null
                    localAccount()?.let { LocalChatStore.clearConversation(this,it.scope,cid) }
                    toast("会话权限已变化，请重新打开")
                }}
            }finally{runOnUiThread{goRefreshRunning=false;if(goRefreshAgain){goRefreshAgain=false;refreshGoConversation()}}}
        }
    }
    private fun handlePacket(packet: JSONObject) {
        if(packet.optString("type")=="go.changed"){
            scheduleNavigationBadges()
            chatHome?.takeIf{it.isAttachedToWindow}?.let{loadChatPage(it,1)}
            if(packet.optInt("conversation_id")==activeConversationId)refreshGoConversation()
            return
        }
        if (packet.optString("type") == "auth.revoked") {
            socket?.close(); socket = null; accountSessions.invalidate(currentUserId)
            api.token = null; currentMessages = null; activeConversationId = 0
            cancelVoiceRecording(); discardPendingVoice(); pendingMediaTarget = null; MessageAlerts.clear(this)
            preferences.edit().remove("access_token").apply(); myFeature?.close(); showLogin()
            toast("登录状态已失效，请重新登录"); return
        }
        if (packet.optString("type") == "client.update_required") {
            socket?.close(); socket = null
            executor.execute { runCatching { val config = ApiClient(apiBaseUrl).clientConfig(); runOnUiThread { ClientUpdates.apply(this, config.put("force_update", true)) } } }
            toast("请更新客户端后继续使用"); return
        }
        if (packet.optString("type") == "auth.ok") {
            scheduleNavigationBadges()
            socket?.subscribeInbox()
            if(BuildConfig.GO_BACKEND&&activeConversationId>0)refreshGoConversation()
            if (activeConversationId > 0) socket?.subscribe(activeConversationId)
            runOnUiThread {
                chatHome?.let { if (it.isAttachedToWindow) loadChatPage(it, 1) }
            }
            return
        }
        val packetType = packet.optString("type")
        if (packetType in listOf("notification.updated", "inbox.subscribe.ok", "conversation.updated", "message.updated", "message.recalled", "message.deleted")) {
            retainedChatHome?.takeIf { retains(it) }?.loadState?.invalidate()
            retainedContacts?.takeIf { retains(it) }?.loadState?.invalidate()
        }
        if (packetType == "notification.updated") {
            scheduleNavigationBadges(); refreshFriendChats(); contactNames.refresh(force = true)
            chatHome?.takeIf { it.isAttachedToWindow }?.let { loadChatPage(it, 1) }
            contactsView?.takeIf { it.page == ContactsView.Page.CONTACTS }?.refresh()
            return
        }
        if (packetType == "inbox.subscribe.ok") {
            contactNames.refresh(force = true)
            refreshFriendChats()
            scheduleNavigationBadges()
            chatHome?.takeIf { it.isAttachedToWindow }?.let { loadChatPage(it, 1) }
            contactsView?.takeIf { it.page in listOf(ContactsView.Page.GROUPS, ContactsView.Page.CHANNELS) }?.refresh()
            return
        }
        if (packetType == "conversation.updated") {
            scheduleNavigationBadges()
            val hint = packet.optJSONObject("data") ?: return
            val id = hint.optInt("conversation_id")
            chatHome?.takeIf { it.isAttachedToWindow }?.let { loadChatPage(it, 1) }
            if (id > 0 && id == activeConversationId) refreshCurrentMessages(allowUnsubscribed = true)
            if (id > 0 && id == activeConversationId && activeConversationType == "group") refreshGroupMetadata()
            contactsView?.invalidateConversation(id)
            if (hint.optString("event_type") == "message.new" && (!appForeground || appLock.locked || id != activeConversationId)) refreshInboxNotice(id, hint.optInt("message_id"))
            return
        }
        if (packetType == "subscribe.ok" && packet.optInt("conversation_id") == activeConversationId) {
            chatSubscribedEpoch = chatSocketEpoch; recoverCurrentMessages(); refreshMessagePins(); if (activeConversationType == "group") refreshGroupMetadata(); return
        }
        if (packetType == "message.deleted") { packet.optJSONObject("data")?.let { applyPersonalMessageDeletion(it) }; return }
        if (packetType == "conversation.pins") { packet.optJSONObject("data")?.let { acceptMessagePins(it) }; return }
        if (packetType == "message.updated" || packetType == "message.recalled") {
            scheduleNavigationBadges()
            packet.optJSONObject("data")?.let { applyCurrentMessageEvent(packetType, it) }
            val id = packet.optJSONObject("data")?.optInt("conversation_id") ?: 0
            if (id == activeConversationId && packetType == "message.updated") refreshMessagePins()
            retainedChatHome?.takeIf { retains(it) }?.let { home ->
                home.invalidateConversation(id, packet.optJSONObject("data"))
                if (home.isAttachedToWindow) loadChatPage(home, 1)
            }
            contactsView?.invalidateConversation(id)
            return
        }
        if (packetType != "message.new") return
        val message = packet.optJSONObject("data") ?: return
        acknowledgeDurableMessage(message)
        persistDirectoryMessage(message)
        scheduleNavigationBadges()
        if (message.optInt("conversation_id") == activeConversationId) {
            if (!acceptCurrentMessage(message, "event")) return
            activeMessageRecovery?.accumulator?.event(message.optInt("id"), message)
        }
        if (BuildConfig.DEBUG) android.util.Log.d("PulseAlerts", "message received; current=$currentUserId sender=${message.optInt("sender_id")} conversation=${message.optInt("conversation_id")} active=$activeConversationId foreground=$appForeground")
        if (message.optInt("sender_id") != currentUserId && (!appForeground || message.optInt("conversation_id") != activeConversationId)) {
            val token = api.token; val userId = currentUserId
            val requestedNotificationRevision = notificationRevision()
            executor.execute {
                try {
                    val info = ApiClient(apiBaseUrl).apply { this.token = token }.conversationInfo(message.optInt("conversation_id"))
                    runOnUiThread { if (api.token == token && currentUserId == userId && !contactGroupChild) MessageAlerts.show(this, userId, notificationInfo(info, requestedNotificationRevision), message, appForeground) }
                } catch (e: Exception) { if (BuildConfig.DEBUG) android.util.Log.w("PulseAlerts", "notification metadata failed", e) }
            }
        }
        runOnUiThread {
            retainedContacts?.takeIf { retains(it) }?.updateConversationMessage(message)
            val home = retainedChatHome?.takeIf { retains(it) }
            if (home != null && !home.updateConversationMessage(message)) {
                home.loadState.invalidate()
                if (home.isAttachedToWindow) loadChatPage(home, 1)
            }
            if (message.optInt("conversation_id") == activeConversationId) {
                currentMessages?.let { addMessage(it, message, "event") }
                markConversationRead(activeConversationId, message.optInt("id"))
            }
        }
    }
    private fun markConversationRead(conversationId: Int, throughMessageId: Int, reopen: Boolean = false) {
        if (conversationId <= 0 || conversationId != activeConversationId || currentMessages == null || !appForeground || appLock.locked || isFinishing || isDestroyed) return
        conversationReads.bind(currentUserId, api.token, apiBaseUrl)
        if (!conversationReads.record(conversationId, throughMessageId, reopen)) return
        localAccount()?.let { owner -> LocalChatArchive.disk.execute { runCatching { LocalDirectoryStore.updateUnread(this, owner.scope, conversationId, 0) } } }
        scheduleNavigationBadges()
        messageHandler.removeCallbacks(receiptWork)
        messageHandler.post(receiptWork)
    }

    private fun drainConversationReads() {
        if (!::api.isInitialized || !appForeground || appLock.locked || isFinishing || isDestroyed) return
        conversationReads.bind(currentUserId, api.token, apiBaseUrl)
        val delay = receiptRetryAt - android.os.SystemClock.elapsedRealtime()
        if (delay > 0) { messageHandler.removeCallbacks(receiptWork); messageHandler.postDelayed(receiptWork, delay); return }
        val request = conversationReads.next() ?: return
        val actor = request.account
        fun current() = api.token == actor.token && currentUserId == actor.userId && apiBaseUrl == actor.endpoint && !isFinishing && !isDestroyed
        receiptExecutor.execute {
            var success = false
            try {
                if (current()) {
                    val result = ApiClient(actor.endpoint).apply { token = actor.token }.readConversation(request.conversationId, request.through)
                    success = result.optInt("conversation_id") == request.conversationId && result.optInt("through_message_id") == request.through && result.optString("status") == "read"
                }
            } catch (_: Exception) { /* Retain the bounded request for a foreground retry. */ }
            runOnUiThread {
                if (!current() || !conversationReads.finish(request, success)) return@runOnUiThread
                if (success) {
                    receiptFailures = 0; receiptRetryAt = 0L
                    scheduleNavigationBadges()
                    chatHome?.takeIf { it.isAttachedToWindow }?.let { loadChatPage(it, 1) }
                } else {
                    receiptFailures = minOf(receiptFailures + 1, 5)
                    receiptRetryAt = android.os.SystemClock.elapsedRealtime() + minOf(30000L, 1000L shl receiptFailures)
                }
                messageHandler.removeCallbacks(receiptWork)
                if (appForeground && !appLock.locked) messageHandler.postDelayed(receiptWork, maxOf(0L, receiptRetryAt - android.os.SystemClock.elapsedRealtime()))
            }
        }
    }
    private fun refreshInboxNotice(conversationId: Int, messageId: Int) {
        val token = api.token ?: return
        if (conversationId <= 0 || messageId <= 0) return
        val notice = inboxNotices[conversationId]?.takeIf { it.token == token }
            ?: InboxNotice(token, currentUserId, apiBaseUrl, messageId).also { inboxNotices[conversationId] = it }
        notice.messageId = maxOf(notice.messageId, messageId)
        if (notice.loading) return
        notice.loading = true; val requestedId = notice.messageId
        val requestedNotificationRevision = notificationRevision()
        executor.execute {
            try {
                val client = ApiClient(notice.base).apply { this.token = notice.token }
                val rows = client.history(conversationId)
                val message = (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optInt("id") == requestedId }
                val info = if (message != null && message.optInt("sender_id") != notice.userId) client.conversationInfo(conversationId) else null
                runOnUiThread {
                    if (inboxNotices[conversationId] !== notice || api.token != notice.token || currentUserId != notice.userId || apiBaseUrl != notice.base) return@runOnUiThread
                    for (index in 0 until rows.length()) rows.getJSONObject(index).takeIf { it.optInt("conversation_id") == conversationId }?.let(::acknowledgeDurableMessage)
                    message?.let(::persistDirectoryMessage)
                    if (!contactGroupChild && info != null && message != null && (!appForeground || appLock.locked || activeConversationId != conversationId)) MessageAlerts.show(this, notice.userId, notificationInfo(info, requestedNotificationRevision), message, appForeground)
                    notice.loading = false
                    if (notice.messageId > requestedId) refreshInboxNotice(conversationId, notice.messageId) else inboxNotices.remove(conversationId)
                }
            } catch (_: Exception) {
                runOnUiThread { if (inboxNotices[conversationId] === notice) inboxNotices.remove(conversationId) }
            }
        }
    }
    private fun currentRecoveryMatches(context: ChatRecovery): Boolean = activeMessageRecovery === context && currentMessages === context.container && activeConversationId == context.conversationId && currentUserId == context.userId && api.token == context.token && socket === context.socket && chatSocketEpoch == context.epoch
    private fun ensureMessageScope() {
        val scope=if(BuildConfig.GO_BACKEND) "${api.token}|$activeConversationId" else api.token
        if (messageVersionToken != scope) { messageVersionToken = scope; messageVersions.clear(); replyVisibility.clear() }
    }
    private fun protectedReply(message: JSONObject): JSONObject {
        ensureMessageScope()
        val reference = message.optJSONObject("body")?.optJSONObject("reply_to") ?: return message
        val sourceId = reference.optInt("id")
        if (!replyVisibility.hidden(sourceId, reference.optBoolean("unavailable"), chatClearedBefore)) return message
        return JSONObject(message.toString()).apply { getJSONObject("body").put("reply_to", JSONObject().put("id", sourceId).put("unavailable", true)) }
    }
    private fun acceptCurrentMessage(message: JSONObject, source: String, removed: Boolean = !message.isNull("recalled_at") || message.optString("status") in listOf("recalled", "deleted")): Boolean {
        ensureMessageScope()
        if (removed) replyVisibility.removed(message.optInt("id"))
        val accepted = messageVersions.accept(message.optInt("id"), message.messageAuthority(), removed, if (removed) null else message, source)
        if (accepted && source != "snapshot") {
            val scope = LocalChatStore.scope(apiBaseUrl, currentUserId, api.token); val cid = message.optInt("conversation_id"); val copy = JSONObject(message.toString())
            if (removed) copy.put("status", "deleted")
            val generation = LocalChatStore.generation()
            LocalChatArchive.disk.execute {
                if (generation == LocalChatStore.generation() && scope == LocalChatStore.scope(apiBaseUrl, currentUserId, api.token)) runCatching {
                    LocalChatStore.merge(this, LocalChatStore.ticket(this, scope, cid), listOf(copy), event = true)
                    if (removed) LocalMediaCache.purge(this, scope, cid)
                }
            }
        }
        return accepted
    }
    private fun applyCurrentMessageEvent(type: String, message: JSONObject) {
        persistDirectoryMessage(if (type in listOf("message.recalled", "message.deleted")) JSONObject(message.toString()).put("status", "deleted") else message)
        val conversation = message.optInt("conversation_id")
        val id = message.optInt("id"); if (id <= 0 || conversation <= 0) return
        val removed = type in listOf("message.recalled", "message.deleted") || !message.isNull("recalled_at") || message.optString("status") in listOf("recalled", "deleted")
        if (!acceptCurrentMessage(message, "event", removed)) return
        // Retain account-scoped tombstones even when another conversation is open.
        if (conversation != activeConversationId) return
        activeMessageRecovery?.accumulator?.event(id, if (removed) null else message)
        if (removed && pinnedMessages.removeAll { it.optInt("id") == id }) {
            pinRevision++; pinIndex = pinIndex.coerceAtMost((pinnedMessages.size - 1).coerceAtLeast(0)); renderMessagePins()
        }
        val container = currentMessages ?: return
        if (removed) {
            currentMessageData.remove(id)
            (0 until container.childCount).map { container.getChildAt(it) }.firstOrNull { it.tag == id }?.let { container.removeView(it) }
        } else addMessage(container, message, "event")
        if (replyMessage?.optInt("id") == id) {
            replyMessage = if (removed) null else messageReference(message)
            replyRevision++; renderReplyPreview()
        }
        for (row in currentMessageData.values.toList()) {
            val reference = row.optJSONObject("body")?.optJSONObject("reply_to") ?: continue
            if (reference.optInt("id") != id) continue
            val updated = JSONObject(row.toString())
            val next = if (removed) JSONObject().put("id", id).put("unavailable", true) else JSONObject(reference.toString()).put("text", referenceSummary(message))
            updated.getJSONObject("body").put("reply_to", next)
            addMessage(container, updated, "event")
        }
        renderMessageSelection()
    }
    private fun recoverCurrentMessages(allowUnsubscribed: Boolean = false) {
        val container = currentMessages ?: return; val token = api.token ?: return
        if (!chatHistoryReady || activeConversationId <= 0 || (!allowUnsubscribed && chatSubscribedEpoch != chatSocketEpoch) || chatSynchronizedEpoch == chatSocketEpoch || activeMessageRecovery != null) return
        val floor = currentMessageData.keys.firstOrNull() ?: chatLoadedFloor
        val context = ChatRecovery(container, activeConversationId, currentUserId, token, socket, chatSocketEpoch, floor, ConversationRecovery(floor))
        activeMessageRecovery = context; val base = apiBaseUrl
        messageExecutor.execute {
            try {
                val client = ApiClient(base).apply { this.token = token }
                val localScope = LocalChatStore.scope(base, context.userId, token)
                val localTicket = runCatching { LocalChatStore.ticket(this, localScope, context.conversationId) }.getOrNull()
                do {
                    if (!currentRecoveryMatches(context)) return@execute
                    val page = client.syncMessages(context.conversationId, floor, context.accumulator.after, context.accumulator.maximum)
                    val items = page.getJSONArray("items")
                    val rows = (0 until items.length()).map { val item = items.getJSONObject(it); require(item.optInt("conversation_id") == context.conversationId); item.getInt("id") to item }
                    context.accumulator.page(page.getInt("snapshot_max_id"), page.getInt("next_after_id"), page.getBoolean("has_more"), page.optInt("cleared_before_message_id"), rows)
                } while (page.getBoolean("has_more"))
                if (currentRecoveryMatches(context) && localTicket != null) runCatching { LocalChatStore.merge(this, localTicket, context.accumulator.result(), cleared = context.accumulator.clearedBefore(), floor = context.floor, maximum = Int.MAX_VALUE) }
                runOnUiThread {
                    if (!currentRecoveryMatches(context)) return@runOnUiThread
                    val scroll = container.parent as? ScrollView
                    val atBottom = scroll == null || container.height - scroll.scrollY - scroll.height < dp(40)
                    val oldY = scroll?.scrollY ?: 0
                    val scrollNavigation = chatNavigationRevision
                    val anchors = (0 until container.childCount).map { container.getChildAt(it) }.filter { it.bottom >= oldY }.map { (it.tag as? Int) to (it.top - oldY) }
                    val authoritative = context.accumulator.result()
                    chatClearedBefore = maxOf(chatClearedBefore, context.accumulator.clearedBefore())
                    if (pinnedMessages.removeAll { it.optInt("id") <= chatClearedBefore }) { pinRevision++; pinIndex = 0; renderMessagePins() }
                    if ((replyMessage?.optInt("id") ?: Int.MAX_VALUE) <= chatClearedBefore) { replyMessage = null; replyRevision++; renderReplyPreview() }
                    activeMessageRecovery = null; chatSynchronizedEpoch = chatSocketEpoch; chatLoadedFloor = minOf(chatLoadedFloor, context.floor)
                    val authoritativeIds = authoritative.map { it.optInt("id") }.toSet()
                    // A locate request may have inserted older rows after this
                    // recovery began; its snapshot has no authority below floor.
                    currentMessageData.keys.filter { it <= chatClearedBefore || (it >= context.floor && it !in authoritativeIds) }.forEach { id ->
                        replyVisibility.removed(id)
                        if (replyMessage?.optInt("id") == id) { replyMessage = null; replyRevision++; renderReplyPreview() }
                        messageVersions.accept(id, "", true, null, "snapshot"); currentMessageData.remove(id)
                        (0 until container.childCount).map { container.getChildAt(it) }.firstOrNull { it.tag == id }?.let { container.removeView(it) }
                    }
                    authoritative.forEach {
                        val id = it.optInt("id"); val previous = currentMessageData[id]
                        if (previous == null || !sameRenderedMessage(previous, it)) addMessage(container, it, "snapshot")
                        else if (acceptCurrentMessage(it, "snapshot")) currentMessageData[id] = it
                    }
                    markConversationRead(activeConversationId, currentMessageData.keys.maxOrNull() ?: 0)
                    renderMessageSelection()
                    container.post {
                        if (currentMessages !== container || api.token != token || chatLocateTarget != 0 || chatNavigationRevision != scrollNavigation) return@post
                        if (atBottom) postChatBottom(container, scroll)
                        else {
                            val anchored = anchors.firstNotNullOfOrNull { (id, offset) -> (0 until container.childCount).map { container.getChildAt(it) }.firstOrNull { it.tag == id }?.let { it.top - offset } }
                            scroll?.scrollTo(0, anchored ?: oldY)
                        }
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    if (!currentRecoveryMatches(context)) return@runOnUiThread
                    activeMessageRecovery = null
                    if(BuildConfig.GO_BACKEND&&error is ClientApiException&&error.errorCode=="membership_changed"){refreshGoConversation();return@runOnUiThread}
                    container.postDelayed({ if (currentMessages === container && api.token == token && chatSocketEpoch == context.epoch && appForeground) recoverCurrentMessages(allowUnsubscribed) }, 2000)
                }
            }
        }
    }
    private fun refreshCurrentMessages(allowUnsubscribed: Boolean = false) { chatSynchronizedEpoch = -1; recoverCurrentMessages(allowUnsubscribed) }
    private fun sameRenderedMessage(first: JSONObject, second: JSONObject): Boolean {
        if (listOf("type", "sender_id", "sender_name", "sender_nickname", "edited_at", "recalled_at", "status").any { jsonText(first, it) != jsonText(second, it) }) return false
        if (ChatAvatars.identity(jsonText(first, "sender_avatar_url")) != ChatAvatars.identity(jsonText(second, "sender_avatar_url"))) return false
        val a = first.optJSONObject("body") ?: JSONObject(); val b = second.optJSONObject("body") ?: JSONObject()
        val keys = (a.keys().asSequence().toSet() + b.keys().asSequence().toSet())
        return keys.all { key ->
            if (key != "url") a.opt(key)?.toString() == b.opt(key)?.toString()
            else {
                fun contentUrl(value: String): String {
                    val uri = Uri.parse(value)
                    if (!uri.isHierarchical || uri.getQueryParameter("media_signature") == null) return value
                    val builder = uri.buildUpon().clearQuery()
                    uri.queryParameterNames.filterNot { it in setOf("media_expires", "media_session", "media_kind", "media_signature") }.forEach { name -> uri.getQueryParameters(name).forEach { builder.appendQueryParameter(name, it) } }
                    return builder.build().toString()
                }
                contentUrl(jsonText(a, key)) == contentUrl(jsonText(b, key))
            }
        }
    }
    private fun recordingAppearance(button: View, active: Boolean) {
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
    }
    private fun toggleRecording(button: View) {
        if (recorder != null) { stopRecording(button); return }
        if (!localOutboxesReady || mediaOutbox == null) { bindLocalOutboxes(retryNow = true); toast("正在恢复本地待发消息，请稍后再录音"); return }
        if (!appForeground || appLock.locked || !chatCanSend || recordingReleasePending || pendingVoice != null || groupUploads.isNotEmpty() || pendingSendAcks.isNotEmpty() || pendingMediaTarget != null || textSends.pending(api.token, currentUserId, apiBaseUrl, activeConversationId).isNotEmpty()) { toast("请先完成当前发送或重试"); return }
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
    }
    private fun cancelVoiceRecording(message: String? = null) {
        val captured = recorder; val file = recordingFile; recorder = null
        recordingTimeout?.let { messageHandler.removeCallbacks(it) }; recordingTimeout = null
        file?.delete(); recordingFile = null; recordingTarget = null; recordingMessages = null; recordingBase = ""; recordingStartedAt = 0
        recordingButton?.let { if (it.isAttachedToWindow) recordingAppearance(it, false) }; recordingButton = null
        if (captured != null) releaseVoiceRecorder(captured, file, stopFirst = true)
        if (message != null && appForeground && !appLock.locked) toast(message)
    }
    private fun releaseVoiceRecorder(captured: MediaRecorder, cancelledFile: File? = null, stopFirst: Boolean = false) {
        recordingReleasePending = true
        // Scope is already invalid or stop completed. This serial queue never holds
        // the UI lifecycle on device audio-service Binder cleanup.
        voiceCleanupExecutor.execute {
            try { if (stopFirst) runCatching { captured.stop() }; runCatching { captured.release() } }
            finally { cancelledFile?.delete(); recordingReleasePending = false }
        }
    }
    private fun stopRecording(button: View, holdForConfirmation: Boolean = false) {
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
    }
    private fun pendingVoiceCurrent(pending: PendingVoice): Boolean = pendingVoice === pending && pending.target.matches(activeConversationId, currentUserId, api.token) &&
        apiBaseUrl == pending.base && currentMessages === pending.messages && pending.messages.isAttachedToWindow && appForeground && !appLock.locked && !isFinishing && !isDestroyed
    private fun discardPendingVoice(explicit: Boolean = false) {
        val pending = pendingVoice ?: return
        if (explicit) pending.cancelRequested = true
        pendingVoice = null; pending.cancelSend?.invoke(); pending.cancelSend = null
        if (!pending.busy) pending.file.delete()
        groupUploads.remove(pending.target.requestId); renderPendingVoice()
    }
    private fun renderPendingVoice() {
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
    }
    private fun uploadPendingVoice(pending: PendingVoice) {
        if (!chatCanSend || !pendingVoiceCurrent(pending) || pending.busy) return
        val queue = mediaOutbox
        if (!localOutboxesReady || queue == null) { bindLocalOutboxes(retryNow = true); pending.error = "正在恢复本地队列，请稍后重试"; renderPendingVoice(); return }
        pending.busy = true; pending.error = ""; renderPendingVoice()
        groupUploads.add(pending.target.requestId)
        outboxStageExecutor.execute {
            try {
                val entry = queue.enqueue(pending.target.requestId, pending.target.conversationId, "voice", "audio/mp4", "语音.m4a", pending.file, pending.target.replyToId, pending.durationMs)
                if (pending.cancelRequested) { queue.discard(entry); pending.file.delete(); return@execute }
                if (pending.needsConfirmation || !pendingVoiceCurrent(pending)) queue.fail(entry, if (pending.needsConfirmation) "录音已达上限，请确认后发送" else "语音已保存，请确认后重试")
                pending.file.delete()
                runOnUiThread {
                    if (pending.cancelRequested) { runCatching { queue.discard(entry) }; return@runOnUiThread }
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
    }
    private fun sendPendingVoice(pending: PendingVoice) {
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
    }
    private fun addMessage(container: LinearLayout, incoming: org.json.JSONObject, source: String = "ack") {
        acknowledgeDurableMessage(incoming)
        if (source == "ack") persistDirectoryMessage(incoming)
        val message = protectedReply(incoming)
        val messageId = message.optInt("id")
        if (messageId > 0 && message.optInt("sender_id") == currentUserId) {
            val requestId = message.optJSONObject("body")?.optString("request_id").orEmpty()
            if (requestId.isNotBlank()) {
                // A durable WS event has the same completion authority as HTTP.
                // Complete first, so the callback's addMessage cannot recurse.
                pendingSendAcks[requestId]?.invoke(message)
                (0 until container.childCount).map { container.getChildAt(it) }.firstOrNull { it.tag == "pending:$requestId" }?.let { container.removeView(it) }
            }
        }
        val scroll = container.parent as? ScrollView
        val newMessage = !currentMessageData.containsKey(messageId)
        val followBottom = container === currentMessages && chatLocateTarget == 0 && source != "snapshot" && newMessage &&
            (message.optInt("sender_id") == currentUserId || scroll == null || container.height - scroll.scrollY - scroll.height < dp(48))
        if (container === currentMessages && messageId <= chatClearedBefore) return
        if (container === currentMessages && !acceptCurrentMessage(message, source)) {
            if (source == "snapshot") messageVersions.value(messageId)?.let { addMessage(container, it, "snapshot") }
            return
        }
        if (container === currentMessages && messageId > 0) {
            activeMessageRecovery?.accumulator?.event(messageId, message)
            currentMessageData[messageId] = message
            (0 until container.childCount).map { container.getChildAt(it) }.firstOrNull { it.tag == messageId }?.let { container.removeView(it) }
        }
        val mine = message.optInt("sender_id") == currentUserId
        if (activeConversationType == "group") {
            val wrapper = IOSGroupChatStyle.message(this, message, mine,
                loadImage = { image, status, raw -> loadChatImage(image, status, raw, container, api.token, message.takeIf { image.tag == "ios-group-image" }) },
                openMedia = { value -> currentGroupMedia().openAttachment(value) },
                voice = { value, bar -> playMessageVoice(value, bar, container) },
                loadVideo = { value, image, status, duration -> loadMessageVideoPreview(value, image, status, duration, container) },
                openContact = { value -> openMessageContactCard(value, container) },
                quote = { original, outgoing ->
                    val reference = if (original.optInt("id") in 1..chatClearedBefore) JSONObject().put("id", original.optInt("id")).put("unavailable", true) else original
                    referenceStrip(reference, reference.optString("sender_name", "用户"), outgoing).apply {
                        id = R.id.chat_reply_block
                        setOnClickListener { if (reference.optBoolean("unavailable")) toast("原消息已不可用") else locateChatMessage(reference.optInt("id")) }
                    }
                })
            wrapper.findViewById<TextView>(R.id.group_message_sender)?.let { name ->
                ContactNameLabels.bind(name, message.optInt("sender_id"), IOSGroupChatStyle.senderName(message) ?: "群成员", ::contactDisplayName)
            }
            attachInternalActions(wrapper, container, message)
            bindGroupAvatar(wrapper, container, message)
            val selectableRow = selectableMessageRow(wrapper, container, message)
            val next = (0 until container.childCount).firstOrNull { (container.getChildAt(it).tag as? Int ?: Int.MAX_VALUE) > messageId }
            if (next == null) container.addView(selectableRow) else container.addView(selectableRow, next)
            renderMessageSelection()
            if (message.optString("type") == "shake" && source != "snapshot" && newMessage) animateWindowShake(container)
            if (followBottom) { trimLiveMessages?.invoke(container); postChatBottom(container, scroll) }
            return
        }
        val wrapper = row().apply {
            gravity = if (mine) Gravity.END else Gravity.START
            layoutParams = LinearLayout.LayoutParams(-1, -2)
            setPadding(dp(8), dp(2), dp(8), dp(2))
        }
        val type = message.optString("type")
        val body = message.optJSONObject("body")
        val url = body?.optString("url", "") ?: ""
        val transparent = RichMessageContent.transparentBubble(message) || VoiceMessageView.supported(message)
        val hasImageCaption = RichMessageContent.imageCaption(message).isNotEmpty()
        val imageCaptionSize = if (hasImageCaption) RichMessageContent.captionSize(this, message, resources.displayMetrics.widthPixels - dp(if (mine) 66 else 88)) else null
        if (type == "shake") {
            val card = text("窗口抖动", 14f, if (mine) PulseColors.accent else PulseColors.muted).apply {
                setPadding(dp(16), dp(10), dp(16), dp(10))
                background = rounded(if (mine) PulseColors.accentSoft else Color.WHITE, 18)
                gravity = Gravity.CENTER
            }
            wrapper.addView(card)
            if (source != "snapshot" && newMessage) container.post { if (currentMessages === container) animateWindowShake(container) }
        } else if (type == "red_packet") {
            wrapper.addView(text("历史红包（已停用）", 15f, Color.GRAY))
        } else if (type == "image" && url.isNotEmpty()) {
            val imageBox = FrameLayout(this).apply { layoutParams = LinearLayout.LayoutParams(imageCaptionSize?.first ?: dp(220), imageCaptionSize?.second ?: dp(220)); background = rounded(Color.TRANSPARENT, 16) }
            val preview = ImageView(this).apply { scaleType = if (hasImageCaption) ImageView.ScaleType.FIT_CENTER else ImageView.ScaleType.CENTER_CROP }
            val status = text("图片加载中…", 13f, PulseColors.muted).apply { gravity = Gravity.CENTER }
            imageBox.addView(preview, FrameLayout.LayoutParams(-1, -1)); imageBox.addView(status, FrameLayout.LayoutParams(-1, -1))
            wrapper.addView(imageBox)
            if (hasImageCaption) wrapper.addView(RichMessageContent.caption(this, message, imageCaptionSize!!.first, IOSGroupChatStyle.ink()))
            val token = api.token
            imageBox.setOnClickListener { currentGroupMedia().openAttachment(message) }
            loadChatImage(preview, status, url, container, token, message)
        } else if (RichMessageContent.available(message) && RichMessageContent.isVideo(message) && url.isNotEmpty()) {
            wrapper.addView(RichMessageContent.video(this, message, false, resources.displayMetrics.widthPixels - dp(98),
                load = { value, image, status, duration -> loadMessageVideoPreview(value, image, status, duration, container) },
                open = { value -> currentGroupMedia().openAttachment(value) }))
        } else if (VoiceMessageView.supported(message)) {
            wrapper.addView(VoiceMessageView(this, body ?: JSONObject(), mine, resources.displayMetrics.widthPixels - dp(98)).apply {
                setOnClickListener { playMessageVoice(message, this, container) }
            })
        } else if (type == "voice") {
            wrapper.addView(text(if (RichMessageContent.available(message)) "语音暂不可用" else "消息已撤回", 14f, PulseColors.muted))
        } else if ((type == "file" || type == "video") && url.isNotEmpty()) {
            wrapper.addView(Button(this).apply { text = if (type == "video") "播放视频消息" else "打开文件"; setOnClickListener { try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(mediaUrl(url)))) } catch (e: Exception) { toast("没有可打开此文件的应用") } } })
        } else if (type == "contact_card" && RichMessageContent.available(message) && (body?.optInt("user_id") ?: 0) > 0) {
            wrapper.addView(RichMessageContent.contact(this, message, false, resources.displayMetrics.widthPixels - dp(98),
                loadImage = { image, status, raw -> loadChatImage(image, status, raw, container, api.token) },
                open = { value -> openMessageContactCard(value, container) }))
        } else {
            wrapper.addView(text(body?.optString("text")?.takeUnless { it.isBlank() || it == "null" } ?: "[$type]", AppAppearance.messageSize.toFloat()).apply { id = R.id.chat_message_text; setTag(R.id.appearance_message, true); setTag(R.id.appearance_user_content, true); setPadding(dp(14), dp(10), dp(14), dp(10)); background = rounded(AppAppearance.background(if (mine) PulseColors.accentSoft else PulseColors.surface), 16) })
        }
        body?.optJSONObject("reply_to")?.let { original ->
            val reference = if (original.optInt("id") in 1..chatClearedBefore) JSONObject().put("id", original.optInt("id")).put("unavailable", true) else original
            val quoted = column(0).apply {
                gravity = if (mine) Gravity.END else Gravity.START
                if (!transparent) background = rounded(AppAppearance.background(if (mine) PulseColors.accentSoft else PulseColors.surface), 16)
                setPadding(dp(4), dp(4), dp(4), dp(4))
            }
            quoted.addView(referenceStrip(reference, reference.optString("sender_name", "用户")).apply {
                id = R.id.chat_reply_block
                setOnClickListener { if (reference.optBoolean("unavailable")) toast("原消息已不可用") else locateChatMessage(reference.optInt("id")) }
            }, LinearLayout.LayoutParams(imageCaptionSize?.first ?: dp(260), -2).apply { bottomMargin = dp(3) })
            val existing = (0 until wrapper.childCount).map { wrapper.getChildAt(it) }
            wrapper.removeAllViews(); existing.forEach { quoted.addView(it) }; wrapper.addView(quoted)
        }
        if (activeConversationType == "direct") {
            val children = (0 until wrapper.childCount).map { wrapper.getChildAt(it) }
            wrapper.removeAllViews(); wrapper.setPadding(dp(8), dp(4), dp(8), dp(4)); wrapper.gravity = (if (mine) Gravity.END else Gravity.START) or Gravity.BOTTOM
            val bubble = column(0).apply {
                if (!transparent || hasImageCaption) background = rounded(AppAppearance.background(if (mine) 0xFFE3F5EE.toInt() else Color.WHITE), 8)
                if (hasImageCaption) clipToOutline = true
            }
            children.forEach { child ->
                if (child is TextView && child.id == R.id.chat_message_text) { child.maxWidth = resources.displayMetrics.widthPixels - dp(if (mine) 66 else 88); child.setPadding(dp(10), dp(8), dp(10), dp(2)); child.background = null; child.setTextColor(Color.BLACK) }
                bubble.addView(child)
            }
            val timestamp = jsonText(message, "created_at").let { Regex("[T ](\\d{2}:\\d{2})").find(it)?.groupValues?.get(1).orEmpty() }
            // A wrap-content timestamp contributes its full width even when the message is one character.
            if (timestamp.isNotBlank()) bubble.addView(text(timestamp, 10f, 0xFF999999.toInt()).apply { gravity = Gravity.END; setSingleLine(true); setPadding(dp(10), 0, dp(10), dp(5)) }, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.END })
            if (!mine) wrapper.addView(FrameLayout(this).apply {
                id = R.id.chat_peer_avatar; contentDescription = "查看对方个人信息"
                val peerId = message.optInt("sender_id"); val conversationId = activeConversationId; val accountToken = api.token; val accountId = currentUserId
                setOnClickListener { if (currentMessages === container && activeConversationId == conversationId && api.token == accountToken && currentUserId == accountId) showDirectContactProfile(peerId) }
                background = rounded(0xFF78C54A.toInt(), 9); clipToOutline = true
                addView(text(directPeerName.take(1).ifBlank { "友" }, 18f, Color.WHITE).apply { gravity = Gravity.CENTER; setPadding(0, 0, 0, 0); typeface = Typeface.DEFAULT_BOLD; setTag(R.id.appearance_user_content, true) }, FrameLayout.LayoutParams(-1, -1))
                if (directPeerAvatar.isNotBlank()) addView(ImageView(this@MainActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, mediaUrl(directPeerAvatar)) }, FrameLayout.LayoutParams(-1, -1))
            }, LinearLayout.LayoutParams(dp(42), dp(42)).apply { rightMargin = dp(8); bottomMargin = dp(8) })
            wrapper.addView(bubble, LinearLayout.LayoutParams(-2, -2))
        }
        attachInternalActions(wrapper, container, message)
        val selectableRow = selectableMessageRow(wrapper, container, message)
        val next = (0 until container.childCount).firstOrNull { (container.getChildAt(it).tag as? Int ?: Int.MAX_VALUE) > messageId }
        if (next == null) container.addView(selectableRow) else container.addView(selectableRow, next)
        renderMessageSelection()
        if (followBottom) { trimLiveMessages?.invoke(container); postChatBottom(container, scroll) }
    }
    private fun playMessageVoice(message: JSONObject, bar: VoiceMessageView, container: LinearLayout) {
        if (currentMessages !== container || !bar.isAttachedToWindow || !VoiceMessageView.supported(message)) return
        currentGroupMedia().toggleVoice(message.optInt("id"), message.optJSONObject("body")?.optString("url").orEmpty()) { state ->
            if (currentMessages === container && bar.isAttachedToWindow) {
                bar.render(state)
                state.error?.takeIf { it.isNotBlank() }?.let { toast(it) }
            }
        }
    }
    private fun loadMessageVideoPreview(message: JSONObject, image: ImageView, status: TextView, duration: TextView, container: LinearLayout) {
        val thumbnail = RichMessageContent.string(message.optJSONObject("body") ?: JSONObject(), "thumbnail_url")
        if (thumbnail.isNotBlank()) loadChatImage(image, status, thumbnail, container, api.token)
        else currentGroupMedia().loadVideoPreview(message, image, status, duration)
    }
    private fun openMessageContactCard(message: JSONObject, container: LinearLayout) {
        val userId = message.optJSONObject("body")?.optInt("user_id") ?: return
        val token = api.token ?: return
        val actor = currentUserId; val base = apiBaseUrl; val conversation = activeConversationId; val navigation = chatNavigationRevision
        if (userId <= 0 || currentMessages !== container || !RichMessageContent.available(message)) return
        val request = ++messageCardRevision
        messageCardDialog?.dismiss(); messageCardDialog = null
        val client = ApiClient(base).apply { this.token = token }
        fun current() = messageCardRevision == request && api.token == token && currentUserId == actor && apiBaseUrl == base &&
            activeConversationId == conversation && chatNavigationRevision == navigation && currentMessages === container &&
            container.isAttachedToWindow && appForeground && !appLock.locked && !isFinishing && !isDestroyed &&
            currentMessageData[message.optInt("id")]?.let { RichMessageContent.available(it) && it.optString("type") == "contact_card" && it.optJSONObject("body")?.optInt("user_id") == userId } == true
        if (!current()) return
        toast("正在加载名片…")
        executor.execute {
            if (!current()) return@execute
            try {
                val user = client.receivedContactCardUser(message)
                runOnUiThread {
                    if (!current()) return@runOnUiThread
                    val dialog = FriendSearchResultDialog(this, JSONArray().put(user), actor,
                        loadAvatar = { image, raw -> ChatAvatars.bind(image, mediaUrl(raw)) },
                        onAdd = { if (current()) sendFriendFromSearch(it, contactCard = message, cardCurrent = ::current) }, title = "联系人名片",
                        onRequest = { _, complete ->
                            val staff = currentInternalStaff
                            if (current()) executor.execute {
                                if (!current()) return@execute
                                try {
                                    val fresh = client.receivedContactCardUser(message)
                                    check(current()) { "名片已关闭" }
                                    val added = if (fresh.optBoolean("is_contact")) true else {
                                        check(fresh.optBoolean("can_add_friend")) { fresh.optString("add_friend_restriction", "当前无法添加该好友") }
                                        if (staff) {
                                            check(ForceAddedContactProfile.accepted(client.forceAddContact(userId), userId)) { "强加好友回执无效，请重试" }
                                            true
                                        } else {
                                            val result = client.sendFriendRequest(userId, cardConversationId = message.optInt("conversation_id"), cardMessageId = message.optInt("id"))
                                            val status = result.optString("status")
                                            check(status == "accepted" || status == "pending") { "好友申请回执无效，请重试" }
                                            status == "accepted"
                                        }
                                    }
                                    runOnUiThread { if (current()) complete(added, null) }
                                } catch (error: Exception) { runOnUiThread { if (current()) complete(false, contactError(error, "添加好友失败，请重试")) } }
                            }
                        },
                        onMessage = {
                            if (current()) executor.execute {
                                if (!current()) return@execute
                                try {
                                    val direct = client.createDirectConversation(userId)
                                    check(direct.optInt("id") > 0 && direct.optString("type") == "direct" && direct.optInt("peer_user_id") == userId) { "会话响应无效" }
                                    if (!current()) return@execute
                                    val opened = client.openConversation(direct.getInt("id"))
                                    runOnUiThread { if (current()) showChat(currentNickname, openConversation = opened) }
                                } catch (error: Exception) { runOnUiThread { if (current()) toast(error.message ?: "打开聊天失败，请重试") } }
                            }
                        })
                    messageCardDialog = dialog
                    dialog.setOnDismissListener { if (messageCardDialog === dialog) messageCardDialog = null }
                    dialog.show()
                }
            } catch (error: Exception) { runOnUiThread { if (current()) toast(error.message ?: "名片加载失败，请重试") } }
        }
    }
    private fun loadChatImage(preview: ImageView, status: TextView, url: String, container: LinearLayout, token: String?, message: JSONObject? = null) {
        if (preview.tag == "ios-group-avatar") { ChatAvatars.bind(preview, mediaUrl(url)); return }
        if (status.tag == true || imageExecutor.isShutdown) return
        val base = apiBaseUrl; val actor = currentUserId; val scope = base + "|" + token.orEmpty()
        val original = mediaUrl(url)
        val resolved = ChatImagePreview.url(original)
        fun current() = currentMessages === container && api.token == token && apiBaseUrl == base && currentUserId == actor && !isFinishing && !isDestroyed &&
            (message == null || (message.optInt("id") > chatClearedBefore && RichMessageContent.available(message)))
        fun display(bitmap: android.graphics.Bitmap) {
            if (!current() || !preview.isAttachedToWindow) return
            preview.setImageBitmap(bitmap); status.tag = false; status.visibility = View.GONE
            if (preview.tag == "ios-group-image") {
                val limit = dp(230).coerceAtMost(resources.displayMetrics.widthPixels - dp(110))
                val ratio = bitmap.width.toFloat() / bitmap.height.coerceAtLeast(1)
                (preview.parent as? FrameLayout)?.let { box -> box.layoutParams = box.layoutParams.apply { width = if (ratio >= 1) limit else (limit * ratio).roundToInt(); height = if (ratio >= 1) (limit / ratio).roundToInt() else limit } }
            }
        }
        val cached = runCatching { ChatImageCache.cached(scope, original) ?: ChatImageCache.cached(scope, resolved) }.getOrNull()
        cached?.let { bitmap ->
            // Newly built rows can be populated before attachment; the async path handles first loads.
            preview.setImageBitmap(bitmap); status.visibility = View.GONE
        }
        status.text = "图片加载中…"; if (cached == null) status.visibility = View.VISIBLE
        chatImageViewport.enqueue(preview, container, ::current, loaded = cached != null, release = { preview.setImageDrawable(null); status.tag = false }) { eligible, complete ->
          val available = ChatImageCache.cached(scope, original) ?: ChatImageCache.cached(scope, resolved)
          if (available != null) { display(available); complete(); return@enqueue }
          if (imageExecutor.isShutdown) { status.tag = false; complete(); return@enqueue }
          status.tag = true
          imageExecutor.execute {
            try {
                val bitmap = try { ChatImageCache.load(this, scope, resolved, 1024) { eligible() } }
                catch (error: Exception) {
                    if (!ChatImageCache.authorizationExpired(error) || message == null || !eligible()) throw error
                    val raw = ApiClient(base).apply { this.token = token }.freshImageUrl(message.getInt("conversation_id"), message.getInt("id"))
                    if (!eligible()) throw java.io.IOException("已取消")
                    ChatImageCache.load(this, scope, ChatImagePreview.url(RouteManager.media(raw, base)), 1024) { eligible() }
                }
                runOnUiThread { if (eligible()) display(bitmap) }
            } catch (_: Exception) {
                runOnUiThread {
                    if (eligible() && preview.isAttachedToWindow) { status.text = "图片加载失败\n点击重试"; status.visibility = View.VISIBLE }
                }
            } finally { runOnUiThread { status.tag = false; complete() } }
          }
        }
    }
    private fun animateWindowShake(view: View) {
        val animation = TranslateAnimation(-dp(5).toFloat(), dp(5).toFloat(), 0f, 0f).apply {
            duration = 70L
            repeatCount = 5
            repeatMode = Animation.REVERSE
        }
        view.startAnimation(animation)
        if (Build.VERSION.SDK_INT >= 26) {
            (getSystemService(VIBRATOR_SERVICE) as? android.os.Vibrator)?.vibrate(android.os.VibrationEffect.createOneShot(120L, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            (getSystemService(VIBRATOR_SERVICE) as? android.os.Vibrator)?.vibrate(120L)
        }
    }
    private fun canForwardMessage(message: JSONObject): Boolean =
        MessageForwarding.supported(message) && message.optInt("conversation_id") == activeConversationId &&
            message.optInt("id") > chatClearedBefore && currentMessageData.containsKey(message.optInt("id")) &&
            currentMessageData[message.optInt("id")]?.let { MessageForwarding.supported(it) } == true

    private fun clearMessageSelection() {
        messageForwardDialog?.dismiss(); messageForwardDialog = null
        messageActionMenu?.dismiss(); messageActionMenu = null; messageDeleteDialog?.dismiss(); messageDeleteDialog = null
        choosingMessages = false; selectedMessageIds.clear(); renderMessageSelection()
    }

    private fun toggleMessageSelection(id: Int) {
        val message = currentMessageData[id] ?: return
        if (!canForwardMessage(message)) return
        if (id in selectedMessageIds) selectedMessageIds.remove(id)
        else if (selectedMessageIds.size < 100) selectedMessageIds.add(id)
        else { toast("一次最多选择 100 条消息"); return }
        choosingMessages = true; closeChatAttachments(); renderMessageSelection()
    }

    private fun renderMessageSelection() {
        selectedMessageIds.removeAll { id -> currentMessageData[id]?.let { canForwardMessage(it) } != true }
        messageSelectionBar?.let { bar ->
            bar.visibility = if (choosingMessages) View.VISIBLE else View.GONE
            bar.findViewById<TextView>(R.id.chat_selection_count)?.contentDescription = "已选择 ${selectedMessageIds.size} 条"
            bar.findViewById<TextView>(R.id.chat_selection_forward)?.apply { text = "转发 ${selectedMessageIds.size}"; isEnabled = selectedMessageIds.isNotEmpty(); alpha = if (isEnabled) 1f else .45f }
            bar.findViewById<TextView>(R.id.chat_selection_delete)?.apply { text = "删除 ${selectedMessageIds.size}"; isEnabled = selectedMessageIds.isNotEmpty(); alpha = if (isEnabled) 1f else .45f }
        }
        currentMessages?.let { messages -> for (index in 0 until messages.childCount) {
            (messages.getChildAt(index) as? SelectableMessageRow)?.let { row ->
                val message = currentMessageData[row.messageId]
                row.update(choosingMessages && message?.let { canForwardMessage(it) } == true, row.messageId in selectedMessageIds, message?.let { referenceSummary(it) }.orEmpty())
            }
        } }
    }

    private fun selectableMessageRow(view: View, container: LinearLayout, message: JSONObject): View =
        SelectableMessageRow(this, message.optInt("id"), view, onMenu = { anchor -> showMessageActionMenu(anchor, container, message) }) {
            if (currentMessages === container) toggleMessageSelection(message.optInt("id"))
        }

    private fun openMessageForwardPicker(messages: List<JSONObject>) {
        val openingMessages = currentMessages ?: return
        val token = api.token ?: return
        val actor = currentUserId; val sourceId = activeConversationId; val base = apiBaseUrl
        val sources = messages.distinctBy { it.optInt("id") }.sortedBy { it.optInt("id") }
        if (sources.isEmpty() || sources.size > 100 || sources.any { !canForwardMessage(it) }) return
        val batch = MessageForwardBatch(sources.map { MessageForwarding.snapshot(it) })
        val client = ApiClient(base).apply { this.token = token }
        messageForwardDialog?.dismiss()
        val targets = linkedMapOf<Int, JSONObject>()
        var targetId = 0; var lockedKey = ""; var page = 0; var hasMore = true; var loading = false; var busy = false
        var feedback = ""; var failed = false; var loadError = false
        val dialog = ForwardRecipientDialog(this) { mediaUrl(it) }.apply { setOwnerActivity(this@MainActivity) }
        messageForwardDialog = dialog
        fun current() = messageForwardDialog === dialog && dialog.isShowing && currentMessages === openingMessages &&
            activeConversationId == sourceId && currentUserId == actor && api.token == token && apiBaseUrl == base && !appLock.locked && !isFinishing && !isDestroyed
        fun render() {
            if (!current()) return
            dialog.render(targets.values.toList(), hasMore, loading, busy, lockedKey, feedback, failed, batch.completed, batch.items.size, loadError)
        }
        fun load() {
            if (!current() || loading || busy || lockedKey.isNotEmpty() || !hasMore) return
            loading = true; loadError = false; render()
            executor.execute {
                try {
                    val result = client.chatPage(page + 1)
                    runOnUiThread {
                        if (!current()) return@runOnUiThread
                        loading = false; page++
                        val rows = result.optJSONArray("items") ?: JSONArray()
                        for (i in 0 until rows.length()) { val target = rows.getJSONObject(i); if (MessageForwarding.targetAllowed(target)) targets[target.optInt("id")] = target }
                        val size = result.optInt("size", 50).coerceAtLeast(1)
                        hasMore = rows.length() > 0 && if (result.has("total")) page.toLong() * size < result.optInt("total") else rows.length() >= size
                        if (lockedKey.isEmpty()) feedback = ""; render()
                        if (hasMore && dialog.query.isNotEmpty()) load()
                    }
                } catch (error: Exception) { runOnUiThread { if (current()) { loading = false; loadError = true; if (lockedKey.isEmpty()) feedback = error.message ?: "会话加载失败，请重试"; render() } } }
            }
        }
        fun sendNext() {
            if (!current()) return
            val item = batch.pending()
            if (item == null) {
                dialog.dismiss(); clearMessageSelection(); toast("已转发 ${batch.items.size} 条消息"); refreshNavigationBadges(force = true)
                return
            }
            val live = currentMessageData[item.sourceId]
            if (live == null || !canForwardMessage(live)) { busy = false; failed = false; feedback = "已转发 ${batch.completed}/${batch.items.size} 条。原消息已不可转发，请取消后重新选择。"; render(); return }
            feedback = "正在转发 ${batch.completed + 1}/${batch.items.size}…"; render()
            val destination = targetId
            sendExecutor.execute {
                try {
                    val sent = client.sendRawMessage(destination, item.type, JSONObject(item.bodyJson).apply { if(BuildConfig.GO_BACKEND) put("_source_wire_id",live.getString("wire_id")) }, item.requestId)
                    runOnUiThread {
                        if (!current()) return@runOnUiThread
                        batch.acknowledge(item.requestId)
                        if (destination == sourceId) addMessage(openingMessages, sent)
                        sendNext()
                    }
                } catch (error: Exception) { runOnUiThread { if (current()) {
                    busy = false; failed = true; feedback = "已转发 ${batch.completed}/${batch.items.size} 条。${error.message ?: "发送失败，请重试"}"; render()
                } } }
            }
        }
        fun pick(key: String) {
            if (!current() || busy || (lockedKey.isNotEmpty() && lockedKey != key)) return
            val favorite = targets.values.firstOrNull { it.optString("type") == "favorites" }
            val target = if (key == "favorites") favorite else key.toIntOrNull()?.let { targets[it] }
            if (key != "favorites" && target == null) return
            busy = true; failed = false; lockedKey = key; feedback = "正在转发…"; render()
            if (target != null) { targetId = target.optInt("id"); sendNext() }
            else executor.execute {
                try {
                    val created = client.favoritesConversation()
                    check(MessageForwarding.targetAllowed(created)) { "收藏夹暂时不可用，请重试" }
                    runOnUiThread { if (current()) { targets[created.getInt("id")] = created; targetId = created.getInt("id"); sendNext() } }
                } catch (error: Exception) { runOnUiThread { if (current()) { busy = false; failed = true; feedback = error.message ?: "打开收藏夹失败，请重试"; render() } } }
            }
        }
        dialog.onPick = { pick(it) }; dialog.onRetry = { pick(lockedKey) }
        dialog.onMore = { if (!loadError) load() else { loadError = false; load() } }
        dialog.onSearch = { if (dialog.query.isNotEmpty() && hasMore && !loadError) load() }
        dialog.setOnDismissListener { if (messageForwardDialog === dialog) messageForwardDialog = null }
        dialog.setOnShowListener { render(); load() }
        dialog.show()
    }

    private fun applyPersonalMessageDeletion(data: JSONObject) {
        if (data.optInt("user_id") != currentUserId) return
        val conversation = data.optInt("conversation_id"); val ids = data.optJSONArray("message_ids") ?: return
        ensureMessageScope()
        for (index in 0 until ids.length()) {
            val id = ids.optInt(index); if (id <= 0) continue
            val tombstone = JSONObject().put("id", id).put("conversation_id", conversation).put("status", "deleted").put("body", JSONObject())
            if (conversation == activeConversationId) applyCurrentMessageEvent("message.deleted", tombstone)
            else if(!BuildConfig.GO_BACKEND) { messageVersions.accept(id, "", true, null, "event"); replyVisibility.removed(id) }
        }
        if (conversation == activeConversationId) { messageActionMenu?.dismiss(); refreshMessagePins() }
        scheduleNavigationBadges(); contactsView?.invalidateConversation(conversation)
        chatHome?.takeIf { it.isAttachedToWindow }?.let { it.invalidateConversation(conversation, null); loadChatPage(it, 1) }
    }

    private fun confirmDeleteMessages(sources: List<JSONObject>) {
        val container = currentMessages ?: return; val token = api.token ?: return
        val actor = currentUserId; val conversation = activeConversationId; val base = apiBaseUrl
        val ids = sources.distinctBy { it.optInt("id") }.filter { canForwardMessage(it) }.map { it.optInt("id") }.sorted()
        if (ids.isEmpty() || messageDeleteDialog?.isShowing == true) return
        fun current() = currentMessages === container && api.token == token && activeConversationId == conversation && currentUserId == actor && apiBaseUrl == base && !appLock.locked && !isFinishing && !isDestroyed
        val dialog = android.app.AlertDialog.Builder(this).setTitle("删除 ${ids.size} 条消息？")
            .setMessage("仅从你的聊天记录中删除，对方的记录会保留。")
            .setNegativeButton("取消", null).setPositiveButton("删除", null).create()
        messageDeleteDialog = dialog
        dialog.setOnDismissListener { if (messageDeleteDialog === dialog) messageDeleteDialog = null }
        dialog.setOnShowListener {
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).apply {
                id = R.id.message_delete_confirm
                setOnClickListener {
                    if (!current() || messageDeleteDialog !== dialog) { dialog.dismiss(); return@setOnClickListener }
                    if (ids.any { currentMessageData[it]?.let { row -> canForwardMessage(row) } != true }) { dialog.dismiss(); toast("所选消息已变化，请重新选择"); return@setOnClickListener }
                    isEnabled = false; dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).isEnabled = false; dialog.setCancelable(false)
                    executor.execute {
                        try {
                            val result = ApiClient(base).apply { this.token = token }.deleteMessages(conversation, ids)
                            check(result.optInt("conversation_id") == conversation && result.optInt("user_id") == actor) { "删除结果无效，请重试" }
                            val confirmed = result.optJSONArray("message_ids") ?: throw IllegalStateException("删除结果无效，请重试")
                            check(ids.all { id -> (0 until confirmed.length()).any { confirmed.optInt(it) == id } }) { "删除结果不完整，请重试" }
                            runOnUiThread { if (current() && messageDeleteDialog === dialog) { applyPersonalMessageDeletion(result); dialog.dismiss(); clearMessageSelection(); toast("已删除 ${ids.size} 条消息") } }
                        } catch (error: Exception) { runOnUiThread { if (current() && messageDeleteDialog === dialog) { isEnabled = true; dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).isEnabled = true; dialog.setCancelable(true); dialog.setMessage(error.message ?: "删除失败，请重试") } } }
                    }
                }
            }
        }
        dialog.show()
    }

    private fun refreshMessageStaffPermission(base: String, token: String, actor: Int, current: () -> Boolean, done: (Boolean) -> Unit) {
        messageActionExecutor.execute {
            val user = runCatching { ApiClient(base).apply { this.token = token }.me() }.getOrNull()
            val valid = user?.optInt("id") == actor
            val allowed = valid && user?.opt("internal_staff") == true
            runOnUiThread {
                if (!current()) return@runOnUiThread
                currentInternalStaff = allowed
                if (valid && user != null) accountSessions.save(user, token)
                done(allowed)
            }
        }
    }

    private fun recallMessageNow(message: JSONObject) {
        val token = api.token ?: return
        val base = apiBaseUrl; val actor = currentUserId
        val id = message.optInt("id"); val conversation = message.optInt("conversation_id")
        if (id <= 0 || conversation <= 0 || actor <= 0 || !currentInternalStaff) return
        val pending = Triple(token,conversation,id)
        if (!pendingMessageRecalls.add(pending)) return
        val tombstone = JSONObject(message.toString()).put("status", "recalled").put("body", JSONObject())
        fun sameAccount() = api.token == token && currentUserId == actor && apiBaseUrl == base && !isFinishing && !isDestroyed
        // The menu already checked /auth/me; the mutation checks live permission
        // transactionally on the server. An extra GET only adds latency and cannot
        // authorize the later POST. Apply only its confirmed result, without WS.
        messageActionExecutor.execute {
            try {
                if (!sameAccount()) return@execute
                val result = ApiClient(base).apply { this.token = token }.recallMessage(id, conversation)
                check(result.optInt("message_id", result.optInt("id")) == id && result.optString("status") == "recalled") { "撤回结果无效，请重试" }
                runOnUiThread { if (sameAccount()) handlePacket(JSONObject().put("type", "message.recalled").put("data", tombstone)) }
            } catch (error: Exception) {
                runOnUiThread { if (sameAccount()) toast(error.message ?: "撤回消息失败") }
            } finally {
                runOnUiThread { pendingMessageRecalls.remove(pending) }
            }
        }
    }

    private fun showMessageActionMenu(anchor: View, container: LinearLayout, original: JSONObject) {
        val token = api.token; val conversation = activeConversationId; val base = apiBaseUrl; val actor = currentUserId
        if (token.isNullOrBlank() || actor <= 0) return
        fun current() = currentMessages === container && api.token == token && activeConversationId == conversation && currentUserId == actor && apiBaseUrl == base && anchor.isAttachedToWindow && !appLock.locked
        if (!current()) return
        val message = currentMessageData[original.optInt("id")] ?: return
        if (message.optInt("id") <= chatClearedBefore || !message.isNull("recalled_at") || message.optString("status") in listOf("recalled", "deleted")) return
        val batch = choosingMessages && selectedMessageIds.isNotEmpty()
        val sources = if (batch) selectedMessageIds.sorted().mapNotNull { currentMessageData[it] }.filter { canForwardMessage(it) } else listOf(message)
        fun copiedText() = sources.mapNotNull { it.optJSONObject("body")?.optString("text")?.takeIf { text -> text.isNotBlank() } }.joinToString("\n")
        val actions = mutableListOf<MessageMenuAction>()
        if (chatCanSend) actions.add(MessageMenuAction("reply", "回复"))
        if (batch || copiedText().isNotBlank()) actions.add(MessageMenuAction("copy", if (batch) "复制所选内容" else "复制", enabled = copiedText().isNotBlank()))
        if (canForwardMessage(message)) {
            actions.add(MessageMenuAction("forward", if (batch) "转发所选内容" else "转发"))
            actions.add(MessageMenuAction("delete", if (batch) "删除所选内容" else "删除"))
        }
        if (choosingMessages) actions.add(MessageMenuAction("cancel", "取消选择"))
        else {
            if (chatCanPin) { val pinned = pinnedMessages.any { it.optInt("id") == message.optInt("id") }; actions.add(MessageMenuAction(if (pinned) "unpin" else "pin", if (pinned) "取消置顶" else "置顶消息")) }
            if (activeConversationType == "group") actions.add(MessageMenuAction("favorite", "收藏此消息"))
            // Staff rows are added only after /auth/me confirms this account now.
            if (canForwardMessage(message)) actions.add(MessageMenuAction("select", "选择此消息"))
        }
        if (actions.isEmpty()) return
        messageActionMenu?.dismiss()
        val permissionRevision = ++messageMenuPermissionRevision
        var menuStaffAllowed = false
        val menu = MessageActionMenu(this, actions, message) { action ->
            val live = currentMessageData[message.optInt("id")]
            if (!current() || live == null || !live.isNull("recalled_at") || live.optString("status") in listOf("recalled", "deleted")) return@MessageActionMenu
            when (action) {
                "select" -> toggleMessageSelection(message.optInt("id"))
                "cancel" -> clearMessageSelection()
                "forward" -> openMessageForwardPicker(sources)
                "delete" -> confirmDeleteMessages(sources)
                "copy" -> {
                    val text = copiedText()
                    if (text.isNotBlank()) try { (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("消息", text)); toast("已复制") } catch (_: Exception) { toast("复制失败，请重试") }
                }
                "reply" -> { clearMessageSelection(); selectReply(message) }
                "pin" -> changeMessagePin(message, true)
                "unpin" -> changeMessagePin(message, false)
                "favorite" -> favoriteMessage(message, container)
                "edit" -> {
                    if (!menuStaffAllowed || !currentInternalStaff || message.optString("type") != "text") return@MessageActionMenu
                    refreshMessageStaffPermission(base, token, actor, ::current) permitted@{ allowed ->
                    if (!allowed) { toast("仅开启内部员工权限后可编辑消息"); return@permitted }
                    val editor = EditText(this).apply { setText(message.optJSONObject("body")?.optString("text", "").orEmpty()); setSelection(text.length) }
                    android.app.AlertDialog.Builder(this).setTitle("编辑消息").setView(editor).setNegativeButton("取消", null).setPositiveButton("保存") { _, _ ->
                        if (!current()) return@setPositiveButton
                        val value = editor.text.toString()
                        refreshMessageStaffPermission(base, token, actor, ::current) saving@{ canSave ->
                        if (!canSave) { toast("内部员工权限已关闭，无法编辑消息"); return@saving }
                        executor.execute {
                            try { val edited = ApiClient(base).apply { this.token = token }.editMessage(message.getInt("id"), value, conversation); runOnUiThread { if (current()) { applyCurrentMessageEvent("message.updated", edited); refreshMessagePins() } } }
                            catch (error: Exception) { runOnUiThread { if (current()) toast(error.message ?: "编辑消息失败") } }
                        }
                        }
                    }.show()
                    }
                }
                "recall" -> if (menuStaffAllowed && currentInternalStaff) recallMessageNow(message)
            }
        }
        messageActionMenu = menu
        menu.show(anchor)
        if (!choosingMessages) refreshMessageStaffPermission(base, token, actor, {
            current() && messageActionMenu === menu && menu.isShowing && messageMenuPermissionRevision == permissionRevision
        }) { allowed ->
            menuStaffAllowed = allowed
            menu.internalActions(allowed, message.optString("type") == "text")
        }
    }

    private fun attachInternalActions(view: View, container: LinearLayout, message: org.json.JSONObject) {
        ChatMessageTouch.bind(view) { anchor -> showMessageActionMenu(anchor, container, message) }
    }
    private fun mediaUrl(url: String): String = RouteManager.media(url, apiBaseUrl)
    private fun bindLocalization(view: View) {
        // 注册页面自行维护参照图中的蓝色样式和输入状态。
        if (view is AuthFlowView || view is ContactsView || view is ContactsNavigation || view is ChatScreen) return
        if (view is TextView) {
            if (view !is EditText && view.getTag(R.id.appearance_user_content) != true) view.text = localizeText(view.text.toString())
            view.hint = localizeText(view.hint?.toString() ?: "")
        }
        if (view is Button) {
            view.isAllCaps = false
            view.setTextColor(PulseColors.accent)
            view.background = rounded(Color.WHITE, 14)
            view.minimumHeight = dp(44)
            view.setPadding(dp(12), 0, dp(12), 0)
        }
        if (view is ViewGroup) {
            view.setOnHierarchyChangeListener(object : ViewGroup.OnHierarchyChangeListener {
                override fun onChildViewAdded(parent: View?, child: View?) { child?.let { bindLocalization(it); AppAppearance.apply(it) } }
                override fun onChildViewRemoved(parent: View?, child: View?) = Unit
            })
            for (index in 0 until view.childCount) bindLocalization(view.getChildAt(index))
        }
    }

    private fun localizeText(value: String): String {
        val exact = mapOf(
            "Pulse IM" to getString(R.string.app_name),
            "Sign in to your conversations" to "\u767b\u5f55\u540e\u5f00\u59cb\u804a\u5929",
            "Phone number" to "\u624b\u673a\u53f7",
            "Password" to "\u5bc6\u7801",
            "Sign in" to "\u767b\u5f55",
            "Chats" to "\u6d88\u606f",
            "Contacts" to "\u8054\u7cfb\u4eba",
            "Discover" to "\u53d1\u73b0",
            "Me" to "\u6211\u7684",
            "Realtime connected" to "\u5b9e\u65f6\u8fde\u63a5\u5df2\u5efa\u7acb",
            "Create channel" to "\u521b\u5efa\u9891\u9053",
            "Customer service" to "\u5ba2\u670d\u4f1a\u8bdd",
            "Direct chat" to "\u79c1\u804a",
            "Conversation" to "\u4f1a\u8bdd",
            "Search user or phone" to "\u641c\u7d22\u6635\u79f0\u6216\u624b\u673a\u53f7",
            "Search" to "\u641c\u7d22",
            "+ Add friend" to "+ \u6dfb\u52a0\u597d\u53cb",
            "Create group" to "\u521b\u5efa\u7fa4\u7ec4",
            "Friend requests" to "\u597d\u53cb\u7533\u8bf7",
            "Accept" to "\u540c\u610f",
            "Reject" to "\u62d2\u7edd",
            "Chat" to "\u804a\u5929",
            "Add" to "\u6dfb\u52a0",
            "Sessions and blocked contacts" to "\u767b\u5f55\u8bbe\u5907\u4e0e\u5c4f\u853d\u8054\u7cfb\u4eba",
            "Sign out" to "\u9000\u51fa\u767b\u5f55",
            "Security" to "\u5b89\u5168\u8bbe\u7f6e",
            "Change password" to "\u4fee\u6539\u5bc6\u7801",
            "Signed-in devices" to "\u767b\u5f55\u8bbe\u5907",
            "Current" to "\u5f53\u524d\u8bbe\u5907",
            "Revoke" to "\u64a4\u9500",
            "Blocked contacts" to "\u5df2\u5c4f\u853d\u8054\u7cfb\u4eba",
            "Unblock" to "\u53d6\u6d88\u5c4f\u853d",
            "Write a message" to "\u8f93\u5165\u6d88\u606f",
            "Record" to "\u5f55\u97f3",
            "Stop" to "\u505c\u6b62",
            "Send" to "\u53d1\u9001",
            "Group members" to "\u7fa4\u7ec4\u6210\u5458",
            "Add member" to "\u6dfb\u52a0\u6210\u5458",
            "Leave group" to "\u9000\u51fa\u7fa4\u7ec4",
            "Admin" to "\u8bbe\u4e3a\u7ba1\u7406\u5458",
            "Mute" to "\u7981\u8a00",
            "Red packet" to "\u7ea2\u5305",
            "Claim" to "\u9886\u53d6",
            "Play voice message" to "\u64ad\u653e\u8bed\u97f3\u6d88\u606f",
            "Open file" to "\u6253\u5f00\u6587\u4ef6",
            "Recall message" to "\u64a4\u56de\u6d88\u606f",
            "Close" to "\u5173\u95ed",
            "Cancel" to "\u53d6\u6d88",
            "Create" to "\u521b\u5efa",
            "Loading balance..." to "\u6b63\u5728\u52a0\u8f7d\u4f59\u989d",
            "Total amount in yuan" to "\u603b\u91d1\u989d\uff08\u5143\uff09",
            "Number of packets" to "\u7ea2\u5305\u4e2a\u6570",
        )
        return exact[value] ?: value
            .replace("Loading balance...", "\u6b63\u5728\u52a0\u8f7d\u4f59\u989d")
            .replace("Available", "\u53ef\u7528\u4f59\u989d")
            .replace("Frozen", "\u51bb\u7ed3\u91d1\u989d")
            .replace("Unable to load image", "\u65e0\u6cd5\u52a0\u8f7d\u56fe\u7247")
            .replace("Claim failed", "\u9886\u53d6\u5931\u8d25")
            .replace("Send failed", "\u53d1\u9001\u5931\u8d25")
            .replace("Voice message failed", "\u8bed\u97f3\u6d88\u606f\u53d1\u9001\u5931\u8d25")
            .replace("Upload failed", "\u4e0a\u4f20\u5931\u8d25")
            .replace("No voice data recorded", "\u672a\u5f55\u5236\u5230\u8bed\u97f3")
            .replace("Unable to start recording", "\u65e0\u6cd5\u5f00\u59cb\u5f55\u97f3")
            .replace("Member role updated", "\u6210\u5458\u6743\u9650\u5df2\u66f4\u65b0")
            .replace("Member muted", "\u6210\u5458\u5df2\u7981\u8a00")
            .replace("Member added", "\u6210\u5458\u5df2\u6dfb\u52a0")
            .replace("You left the group", "\u5df2\u9000\u51fa\u7fa4\u7ec4")
            .replace("Unable to update role", "\u66f4\u65b0\u6210\u5458\u6743\u9650\u5931\u8d25")
            .replace("Unable to mute member", "\u7981\u8a00\u6210\u5458\u5931\u8d25")
            .replace("Unable to add member", "\u6dfb\u52a0\u6210\u5458\u5931\u8d25")
            .replace("Unable to leave group", "\u9000\u51fa\u7fa4\u7ec4\u5931\u8d25")
            .replace("Unable to load members", "\u52a0\u8f7d\u7fa4\u7ec4\u6210\u5458\u5931\u8d25")
            .replace("Unable to load contacts", "\u52a0\u8f7d\u8054\u7cfb\u4eba\u5931\u8d25")
            .replace("Unable to", "\u65e0\u6cd5")
            .replace(" failed", "\u5931\u8d25")
            .replace("Failed", "\u5931\u8d25")
            .replace("User", "\u7528\u6237")
            .replace("member", "\u6210\u5458")
            .replace("admin", "\u7ba1\u7406\u5458")
            .replace("Red packet", "\u7ea2\u5305")
            .replace("Claimed", "\u5df2\u9886\u53d6")
            .replace("Claim failed", "\u9886\u53d6\u5931\u8d25")
            .replace("Unable to load image", "\u65e0\u6cd5\u52a0\u8f7d\u56fe\u7247")
            .replace("No application can open this file", "\u6ca1\u6709\u53ef\u6253\u5f00\u6b64\u6587\u4ef6\u7684\u5e94\u7528")
            .replace("Message recalled", "\u6d88\u606f\u5df2\u64a4\u56de")
            .replace("Allow microphone access, then tap Record again", "\u8bf7\u5141\u8bb8\u9ea6\u514b\u98ce\u6743\u9650\uff0c\u7136\u540e\u518d\u6b21\u70b9\u51fb\u5f55\u97f3")
            .replace("No voice data recorded", "\u672a\u5f55\u5236\u5230\u8bed\u97f3")
            .replace("Voice message failed", "\u8bed\u97f3\u6d88\u606f\u53d1\u9001\u5931\u8d25")
            .replace("Unable to start recording", "\u65e0\u6cd5\u5f00\u59cb\u5f55\u97f3")
            .replace("Upload failed", "\u4e0a\u4f20\u5931\u8d25")
            .replace("Red packet failed", "\u7ea2\u5305\u53d1\u9001\u5931\u8d25")
            .replace("Claim", "\u9886\u53d6")
            .replace("Send", "\u53d1\u9001")
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun column(padding: Int) = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(padding), dp(padding), dp(padding), dp(padding)) }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun space() = Space(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) }
    private fun text(value: String, size: Float, color: Int = PulseColors.ink) = TextView(this).apply { text = value; textSize = size; setTextColor(color); setPadding(dp(4), dp(8), dp(4), dp(8)) }
    private fun input(hint: String, secret: Boolean = false) = EditText(this).apply { this.hint = hint; if (secret) inputType = 0x81; setTextColor(PulseColors.ink); setHintTextColor(PulseColors.muted); background = rounded(PulseColors.surface, 14); setPadding(dp(14), dp(4), dp(14), dp(4)); minimumHeight = dp(48) }
    private fun toast(message: String) = Toast.makeText(this, localizeText(message), Toast.LENGTH_SHORT).show()
    override fun onDestroy() {
        mediaSendRequests.values.forEach { it.cancel() }; mediaSendRequests.clear()
        val interruptedTexts = ownedTextAttempts.values.toList(); ownedTextAttempts.clear()
        val interruptedMedia = ownedMediaAttempts.values.toList(); ownedMediaAttempts.clear()
        LocalChatArchive.disk.execute {
            interruptedTexts.forEach { (queue, entry, attempt) -> runCatching { queue.fail(entry, "发送已中断，请确认后重试", attempt) } }
            interruptedMedia.forEach { (queue, entry, attempt) -> runCatching { queue.fail(entry, "发送已中断，请确认后重试", attempt) } }
        }
        localDirectories.stop(); directoryExecutor.shutdownNow()
        mediaOutbox = null
        flushChatDraft(detach = true)
        chatDraftWorker.shutdown()
        cancelPendingChatEntry(); cancelChatHistory()
        clearHomeTabs()
        photoBatch?.let { finishPhotoBatch(it) }
        routeObserver?.invoke(); routeObserver = null
        invalidateForceAdd()
        clearExplore(leave = true)
        workQuestionImagePanel?.dismissPreview(); workQuestionImagePanel = null
        cancelVoiceRecording(); discardPendingVoice()
        pendingSendAcks.clear(); textSends = TextSendQueue()
        closeGroupChatOverlays()
        if (foregroundOwner === this) { foregroundOwner = null; PushNotifications.foreground = false }
        contactProfileDialog?.dismiss()
        messageHandler.removeCallbacksAndMessages(null)
        appLock.destroy(); socket?.close()
        voiceCleanupExecutor.shutdown()
        outboxStageExecutor.shutdown()
        chatImageViewport.clear()
        trimLiveMessages = null
        friendChatExecutor.shutdownNow(); chatLoadExecutor.shutdownNow(); contactsExecutor.shutdownNow(); executor.shutdownNow(); imageExecutor.shutdownNow(); mediaExecutor.shutdownNow(); photoUploadExecutor.shutdownNow(); messageExecutor.shutdownNow(); messageActionExecutor.shutdownNow(); sendExecutor.shutdownNow(); textExecutor.shutdownNow(); receiptExecutor.shutdownNow(); badgeExecutor.shutdownNow()
        super.onDestroy()
    }
    private fun favoriteMessage(message: JSONObject, container: LinearLayout) {
        val token = api.token ?: return; val actor = currentUserId; val base = apiBaseUrl; val conversation = activeConversationId
        val messageId = message.optInt("id")
        val key = FavoriteKey(actor, token, base, messageId)
        favoriteRequests.keys.removeAll { it.token != token || it.endpoint != base }
        favoriteInFlight.keys.removeAll { it.token != token || it.endpoint != base }
        if (messageId <= 0 || favoriteInFlight.containsKey(key)) return
        val requestId = favoriteRequests.getOrPut(key) { java.util.UUID.randomUUID().toString() }
        favoriteInFlight[key] = requestId
        val body = JSONObject(message.optJSONObject("body")?.toString() ?: "{}").apply { remove("reply_to_id"); remove("reply_to") }
        val type = message.optString("type", "text")
        if (type == "text" && !body.has("text")) body.put("text", "收藏消息")
        fun current() = currentMessages === container && activeConversationId == conversation && currentUserId == actor && api.token == token && apiBaseUrl == base && !appLock.locked && !isDestroyed
        val client = ApiClient(base).apply { this.token = token }
        sendExecutor.execute {
            try {
                if (!current()) return@execute
                val favorite = client.favoritesConversation()
                if (!current()) return@execute
                client.sendRawMessage(favorite.getInt("id"), type, body, requestId)
                runOnUiThread { if (favoriteRequests[key] == requestId) favoriteRequests.remove(key); if (current()) toast("已收藏到我的收藏") }
            } catch (error: Exception) { runOnUiThread { if (current()) toast(contactError(error, "收藏失败，请重试")) } }
            finally { runOnUiThread { if (favoriteInFlight[key] == requestId) favoriteInFlight.remove(key) } }
        }
    }
}
