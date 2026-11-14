import SwiftUI
import Foundation
import PhotosUI
import UniformTypeIdentifiers
import UIKit
import AVKit
import QuickLook

@MainActor struct ChatView: View {
    let conversation: Conversation
    private let actorID: Int?
    @EnvironmentObject private var session: AppSession
    init(conversation: Conversation, actorID: Int?) {
        self.conversation = conversation
        self.actorID = actorID
    }
    var body: some View {
        if actorID == session.user?.id {
            ChatConversationContent(conversation: conversation, actorID: actorID)
                .id(ChatConversationIdentity(conversationID: conversation.id, actorID: actorID, token: session.token ?? "", endpoint: APIClient.shared.endpointIdentity))
        }
    }
}

private struct ChatConversationIdentity: Hashable {
    let conversationID: Int
    let actorID: Int?
    let token: String
    let endpoint: String
}

// SwiftUI may reuse a navigation destination when its input changes. Give every
// conversation its own composer, reply/pin state, tasks and socket identity.
@MainActor private struct ChatConversationContent: View {
    let conversation: Conversation
    private let openingToken: String
    private let openingEndpoint: String
    private let openingServerIdentity: String
    private let openingActorID: Int?
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @FocusState private var privateComposerFocused: Bool
    @State private var groupComposerFocused = false
    @State private var groupComposerHandle = IOSGroupComposerHandle()
    @State private var messages: [Message] = []
    @State private var mediaActivation = UUID()
    @State private var draft = ""
    @State private var mentionCaret = 0
    @State private var mentionComposing = false
    @State private var mentionQuery: IOSGroupMentionQuery?
    @State private var mentionItems: [GroupMentionCandidate] = []
    @State private var mentionTask: Task<Void, Never>?
    @State private var mentionRequest = UUID()
    @State private var mentionStatus = ""
    @State private var mentionPage = 1
    @State private var mentionHasMore = false
    @State private var mentionDenied = false
    @State private var selectedMentions = IOSGroupMentionSelection()
    @State private var keyboardProtectedFrames: [String: CGRect] = [:]
    @StateObject private var textOutbox = IOSTextOutbox.shared
    @State private var error = ""
    @State private var toast = ""
    @State private var selectedPhotoProviders: [IOSChatPhotoSource] = []
    @State private var selectedPhotoOriginal = false
    @State private var selectedVideoProvider: NSItemProvider?
    @State private var showingVideoPicker = false
    @State private var videoPickerAfterAttachment = false
    @State private var pendingVideoSend: IOSPendingVideoSend?
    @State private var uploadedVideoToCommit: IOSUploadedVideoSend?
    @State private var videoOperation = UUID()
    @State private var videoWorkTask: Task<Void, Never>?
    @State private var isPreparingVideo = false
    @State private var videoSendError = ""
    @State private var pendingPhoto: IOSPendingPhotoPreview?
    @State private var photoPreparation = UUID()
    @State private var photoPreparationTask: Task<Void, Never>?
    @State private var photoSendWork: IOSPhotoSendWork?
    @State private var photoSendTask: Task<Void, Never>?
    @State private var photoSendProgress = ""
    @State private var photoPickerAfterAttachment = false
    @State private var reselectPhotoAfterPreview = false
    @State private var showingStandardPhotoPicker = false
    @State private var showingActionMenu = false
    @State private var contactCardPicker: IOSContactCardPresentation?
    @State private var receivedContactCard: IOSReceivedContactCardPresentation?
    @State private var pendingReceivedCardChat: (conversation: Conversation, owner: IOSReceivedContactCardPresentation)?
    @State private var receivedCardChat: Conversation?
    @State private var pendingContactCardPicker: IOSContactCardPresentation?
    @State private var chatInputPanel: ReferencePrivateInputPanel = .none
    @State private var isPreparingPhoto = false
    @State private var showingCamera = false
    @State private var showingChatMenu = false
    @State private var pendingChatAction: PrivateChatMenuAction?
    @State private var performingChatAction = false
    @State private var updatingChatNotifications = false
    @State private var showingSearch = false
    @State private var showingContactInfo = false
    @State private var nestedProfileChatActive = false
    @State private var showingGroupInfo = false
    @State private var favoriteConversation: Conversation?
    @State private var showingFileImporter = false
    @State private var fileImportKind = "file"
    @State private var editingMessage: Message?
    @State private var replyDraft: IOSReplyDraft?
    @State private var choosingMessages = false
    @State private var selectedMessageIDs = Set<Int>()
    @State private var forwarding: IOSForwardPresentation?
    @State private var actionMenuMessage: Message?
    @State private var messageMenuInternalAllowed = false
    @State private var recallingMessageIDs = Set<Int>()
    @State private var messageMenuPermissionRevision = UUID()
    @State private var messageActionFrames: [Int: CGRect] = [:]
    @State private var pendingDeletionIDs: [Int] = []
    @State private var showingDeleteConfirmation = false
    @State private var deletingMessages = false
    @State private var deletedMessageIDs = Set<Int>()
    @State private var recordingReplyDraft: IOSReplyDraft?
    @State private var pinnedMessages: [PinnedMessage] = []
    @State private var selectedPinID: Int?
    @State private var showingPinnedMessages = false
    @State private var pinSheetError = ""
    @State private var pinActionID: Int?
    @State private var canPublish: Bool
    @State private var composerAuthorization: IOSComposerAuthorization
    @State private var sendPermissionTask: Task<Void, Never>?
    @State private var lastSendPermissionAt: TimeInterval = 0
    @State private var pinsRevision = 0
    @State private var pinsGeneration = UUID()
    @State private var pinsRefreshTask: Task<Void, Never>?
    @State private var pinsRefreshRequested = false
    @State private var lastPinsLoadedAt: TimeInterval = 0
    @State private var locatingMessageID: Int?
    @State private var messageNavigation = ChatMessageNavigation()
    @State private var jumpAnimationTask: Task<Void, Never>?
    @State private var jumpRequest = 0
    @State private var isUploading = false
    @State private var sendVisible = true
    @State private var recordingContext: IOSVoiceRecordingContext?
    @State private var pendingVoice: IOSPendingVoice?
    @State private var voiceWorkID = UUID()
    @State private var voiceTransferTask: Task<Void, Never>?
    @State private var pendingSend: IOSPendingMessage?
    @State private var isSubmitting = false
    @State private var shakePhase: CGFloat = 0
    @State private var peerOnline: Bool?
    @State private var peerLastSeenAt: String?
    @State private var peerDisplayName: String
    @State private var groupMemberCount: Int?
    @State private var groupViewerRole: String?
    @State private var groupContactRoute: IOSGroupContactRoute?
    @State private var groupProfileRequestID = UUID()
    @State private var groupProfileOpening = false
    @State private var groupEntryID = UUID()
    @State private var groupMetadataRequest = UUID()
    @State private var groupMetadataTask: Task<Void, Never>?
    @State private var groupNoticeContext: IOSGroupNoticeContext?
    @State private var groupNoticeText = ""
    @State private var presentedGroupNoticeID: UUID?
    @State private var closedGroupNotice: String?
    @State private var groupNoticePopup: IOSGroupNoticePresentation?
    @State private var groupNoticeActiveSheets = Set<IOSGroupChatSheet>()
    @State private var mediaPreview: IOSMediaPreview?
    @State private var photoGallery: IOSPhotoGalleryPresentation?
    @State private var syncGeneration = UUID()
    @State private var loadGeneration = UUID()
    @State private var isReconciling = false
    @State private var syncEvents: [Int: Message] = [:]
    @State private var messageVersions: [Int: Message] = [:]
    @State private var syncRetry: Task<Void, Never>?
    @State private var syncRetryDelay = 2
    @State private var clearedBeforeMessageID = 0
    @State private var reconciledUpperID = 0
    @State private var visibleMessageID: Int?
    @State private var legacyAnchorRestoreID: Int?
    @State private var legacyAnchorRestoreRequest = 0
    @State private var scrollRequest = 0
    @State private var scrollBottomY: CGFloat = 0
    @State private var scrollViewportHeight: CGFloat = 0
    @State private var goMembershipVersion: Int?
    @State private var goMemberNames: [Int: String] = [:]
    @State private var historyReady = false
    @State private var historyAccessVerified = false
    @State private var loadingHistory = false
    @State private var olderHistoryCursor = 0
    @State private var olderHistoryHasMore = true
    @State private var loadingOlderHistory = false
    @State private var olderHistoryFailed = false
    @State private var olderHistoryGeneration = UUID()
    @State private var historyPagingArmed = false
    @State private var historyLoadFailed = false
    @State private var reconciliationQueued = false
    @State private var lastReconciledAt: TimeInterval = 0
    @State private var activityGeneration = UUID()
    @State private var recoveryTask: Task<Void, Never>?
    @State private var metadataTask: Task<Void, Never>?
    @State private var receiptTask: Task<Void, Never>?
    @State private var pendingReadIDs = Set<Int>()
    @State private var readIDs = Set<Int>()
    @State private var batchReadReceiptsAvailable = true
    @StateObject private var recorder = VoiceRecorder()
    @StateObject private var audioPlayer = MessageAudioPlayer()
    @StateObject private var realtime: RealtimeClient
    @State private var isMuted: Bool

    private var isPrivate: Bool { conversation.type == "direct" }
    private var composerSendAllowed: Bool { composerAuthorization.permission.canSend }
    private var canManagePins: Bool {
        if conversation.type == "group" { return ["owner", "admin"].contains(groupViewerRole ?? conversation.myRole ?? "") }
        return conversation.type != "channel" || canPublish
    }
    private var title: String { conversation.name ?? (isPrivate ? "私聊" : conversation.type == "favorites" ? "我的收藏" : "会话") }
    private var peerName: String { session.contactDisplayName(userID: conversation.peerUserId ?? 0, fallback: peerDisplayName) }

    init(conversation: Conversation, actorID: Int?) {
        self.conversation = conversation
        self.openingToken = APIClient.shared.webSocketToken
        self.openingEndpoint = APIClient.shared.endpointIdentity
        self.openingServerIdentity = APIClient.shared.serverIdentity
        self.openingActorID = actorID
        _isMuted = State(initialValue: conversation.notificationsMuted)
        _peerDisplayName = State(initialValue: conversation.name ?? "联系人")
        _groupMemberCount = State(initialValue: conversation.memberCount)
        _canPublish = State(initialValue: conversation.canPublish)
        _composerAuthorization = State(initialValue: IOSComposerAuthorization(permission: conversation.sendPermission))
        _realtime = StateObject(wrappedValue: RealtimeClient(conversationID: conversation.id, token: APIClient.shared.webSocketToken) { _ in })
    }

    var body: some View { finalContent }

    // Fixed-size boundaries prevent the entire stateful chat and every modal
    // modifier being copied through a single deeply nested SwiftUI value type.
    private var observedContent: some View {
        AnyView(Group {
            if isPrivate { privateContent } else { standardContent }
        }
        .coordinateSpace(name: "messageActionContainer")
        .pulseOnChange(of: draft) { value in selectedMentions.update(value); updateMentionQuery() }
        .onPreferenceChange(IOSChatTouchFramesKey.self) { keyboardProtectedFrames = $0 }
        .pulseOnChange(of: mentionCaret) { _ in updateMentionQuery() }
        .pulseOnChange(of: mentionComposing) { _ in updateMentionQuery() }
        .pulseOnChange(of: groupComposerFocused) { focused in if focused { chatInputPanel = .none } else { closeMentionPicker() } }
        .pulseOnChange(of: groupViewerRole) { _ in closeMentionPicker(); mentionDenied = false }
        .pulseOnChange(of: session.user?.internalStaff) { enabled in
            closeMentionPicker(); mentionDenied = false
            if enabled != true { messageMenuInternalAllowed = false; if !APIClient.shared.isGoV2 { editingMessage = nil } }
        }
        .pulseOnChange(of: actionMenuMessage?.id) { id in
            if id == nil { messageMenuInternalAllowed = false; messageMenuPermissionRevision = UUID() }
        }
        .pulseOnChange(of: activeGroupNoticeSession) { active in if !active { closeMentionPicker() } }
        .pulseOnChange(of: groupNoticeOtherModalBlocked) { blocked in if blocked { closeMentionPicker() } }
        .onDisappear { closeMentionPicker() }
        .onPreferenceChange(IOSMessageActionFrameKey.self) { messageActionFrames = $0 }
        .overlay { messageActionOverlay }
        .alert("删除 \(pendingDeletionIDs.count) 条消息？", isPresented: $showingDeleteConfirmation) {
            Button("取消", role: .cancel) { pendingDeletionIDs = [] }
            Button("删除", role: .destructive) { let ids = pendingDeletionIDs; Task { await deleteSelectedMessages(ids) } }
        } message: { Text("仅从你的聊天记录中删除，对方的记录会保留。") }
        .alert(Text(pendingChatAction?.title ?? "会话操作"), isPresented: Binding(get: { pendingChatAction != nil }, set: { if !$0 { pendingChatAction = nil } }), presenting: pendingChatAction) { action in
            Button("取消", role: .cancel) { pendingChatAction = nil }
            Button(action.buttonTitle, role: .destructive) {
                pendingChatAction = nil
                Task { await performChatAction(action) }
            }
        } message: { action in Text(action.explanation) }
        .pulseSwipeBack(enabled: photoGallery == nil && !voiceOwnsComposer && !showingContactInfo && !isGroupNoticePresented && forwarding == nil && contactCardPicker == nil && receivedContactCard == nil && pendingContactCardPicker == nil && actionMenuMessage == nil && !showingDeleteConfirmation && !showingChatMenu && pendingChatAction == nil && !performingChatAction,
                        identity: conversation.id) {
            if choosingMessages { clearMessageSelection() }
            else if chatInputPanel != .none { closeChatInput() }
            else { dismiss() }
        }
        .allowsHitTesting(!showingContactInfo && !isGroupNoticePresented && !performingChatAction)
        .accessibilityHidden(showingContactInfo || isGroupNoticePresented)
        .background {
            if isPrivate { PulsePalette.surface.ignoresSafeArea(.container, edges: [.top, .bottom]) }
            else { PulsePalette.surface }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar { toolbarContent }
        .toolbar(isPrivate ? .hidden : .visible, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            if !isPrivate {
                VStack(spacing: 0) {
                    if choosingMessages { messageSelectionBar }
                    groupNoticeBar
                    if !pinnedMessages.isEmpty { pinnedMessageBar }
                }
                .allowsHitTesting(!isGroupNoticePresented)
                .accessibilityHidden(isGroupNoticePresented)
            }
        }
        .task { guard !openingToken.isEmpty, session.token == openingToken else { return }; mediaActivation = UUID(); sendVisible = true; startLiveUpdates() }
        .onReceive(textOutbox.$acceptance.compactMap { $0 }) { value in
            guard currentChatSession, value.item.token == openingToken, value.item.actorID == openingActorID,
                  value.item.endpoint == openingEndpoint, value.item.conversationID == conversation.id else { return }
            acceptMessage(value.message, authoritative: false)
        }
        .onReceive(realtime.$lastMessage.compactMap { $0 }) { message in
            guard sendVisible, session.token == openingToken, openingEndpoint == APIClient.shared.endpointIdentity else { return }
            acceptMessage(message)
            if message.type == "shake" { withAnimation(.linear(duration: 0.55)) { shakePhase += 1 } }
            if message.senderId != session.user?.id {
                queueReadReceipts([message])
            }
        }
        .onReceive(realtime.$lastPersonalDeletion.compactMap { $0 }) { deletion in
            guard currentChatSession else { return }; applyPersonalDeletion(deletion)
        }
        .pulseOnChange(of: session.messageRecallRevision) { _ in acceptConfirmedRecalls() }
        .onReceive(realtime.$lastPinsSnapshot.compactMap { $0 }) { snapshot in
            guard currentChatSession else { return }
            applyPins(snapshot)
        }
        .pulseOnChange(of: visibleMessageID) { value in
            if historyPagingArmed, let value, messages.prefix(3).contains(where: { $0.id == value }) {
                Task { await loadOlderHistory() }
            }
        }
        .pulseOnChange(of: photoGallery?.id) { value in if value == nil { mediaActivation = UUID() } }
        .pulseOnChange(of: realtime.subscriptionRevision) { _ in requestPinsRefresh(); requestSendPermissionRefresh(); Task { await reconcileMessages() } }
        .pulseOnChange(of: realtime.historyInvalidationRevision) { _ in
            if APIClient.shared.isGoV2 { goMemberNames = [:]; requestGroupMetadata(); Task { await discardDeniedLocalHistory(APIClient.shared.captureSession()) } }
        }
        .pulseOnChange(of: realtime.metadataRevision) { _ in requestSendPermissionRefresh() }
        .pulseOnChange(of: realtime.connected) { connected in if !connected { Task { await reconcileMessages() } } }
        .pulseOnChange(of: scenePhase) { phase in
            if phase == .active { mediaActivation = UUID(); startLiveUpdates() }
            else {
                closeChatMenu(); pendingChatAction = nil
                pauseLiveUpdates(preserveVoicePermission: phase == .inactive && recorder.isStarting)
                if phase == .background { closeChatInput(); cancelPhotoPreview(); cancelPhotoSending() }
            }
        }
        .pulseOnChange(of: session.token) { token in
            if token != openingToken { clearMessageSelection() }
            if token != openingToken { sendVisible = false; pauseLiveUpdates(); clearGroupNotice(); mediaPreview = nil; audioPlayer.stop(); cancelVoiceWork(discard: true); pendingSend = nil; messages = []; messageVersions = [:]; pendingReadIDs = []; readIDs = []; draft = ""; replyDraft = nil; recordingReplyDraft = nil; pinnedMessages = []; showingPinnedMessages = false }
        }
        .pulseOnChange(of: session.user?.id) { actorID in
            if actorID != openingActorID { contactCardPicker = nil; pendingContactCardPicker = nil }
            if actorID != openingActorID { clearMessageSelection() }
            if actorID != openingActorID { cancelVoiceWork(discard: true); clearGroupNotice() }
        }
        .pulseOnChange(of: APIClient.shared.endpointIdentity) { endpoint in
            if endpoint != openingEndpoint { contactCardPicker = nil; pendingContactCardPicker = nil }
            if endpoint != openingEndpoint { clearMessageSelection() }
            if endpoint != openingEndpoint { cancelVoiceWork(discard: true); clearGroupNotice() }
        }
        .pulseOnChange(of: appLock.isLocked) { locked in
            if locked { contactCardPicker = nil; pendingContactCardPicker = nil }
            if locked { clearMessageSelection() }
            if locked { cancelVoiceWork(discard: true); suspendGroupNotice() } else { requestGroupMetadata() }
        }
        .pulseOnChange(of: session.updateRequired) { required in
            if required { contactCardPicker = nil; pendingContactCardPicker = nil }
            if required { clearMessageSelection() }
            if required { cancelVoiceWork(discard: true); suspendGroupNotice() } else { requestGroupMetadata() }
        }
        .pulseOnChange(of: groupNoticeOtherModalBlocked) { blocked in
            // A fresh response after a competing presentation closes avoids
            // showing a notice captured before a group edit or permission change.
            if blocked { groupNoticePopup = nil }
            else if !groupNoticeModalBlocked, !groupNoticeText.isEmpty, mayAutomaticallyPresentGroupNotice { requestGroupMetadata() }
        }
        )
    }

    private var photoLifecycleContent: some View {
        AnyView(observedContent
        .onReceive(audioPlayer.$error.removeDuplicates()) { value in if !value.isEmpty { error = value } }
        .pulseOnChange(of: activeChatSession) { active in
            if !active {
                closeChatMenu(); pendingChatAction = nil
                if !currentChatSession || nestedProfileChatActive || scenePhase == .background { closeChatInput() }
            }
        }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { closeChatMenu(); pendingChatAction = nil; closeChatInput(); cancelPhotoPreview(); cancelPhotoSending() } }
        .pulseOnChange(of: session.updateRequired) { required in if required { closeChatMenu(); pendingChatAction = nil; closeChatInput(); cancelPhotoPreview(); cancelPhotoSending() } }
        .pulseOnChange(of: privateComposerFocused) { focused in if focused { chatInputPanel = .none } }
        .pulseOnChange(of: recorder.completedRecording?.id) { id in if id != nil { stageRecordedVoice() } }
        .pulseOnChange(of: selectableMessageIDs) { valid in selectedMessageIDs.formIntersection(valid) }
        .onDisappear {
            // A system album/preview may cover the chat. Its own dismiss
            // callbacks own that transition, rather than cancelling its result.
            if showingStandardPhotoPicker || showingVideoPicker || pendingPhoto != nil || pendingVideoSend != nil || receivedContactCard != nil { return }
            closeChatMenu(); pendingChatAction = nil; sendVisible = false; pauseLiveUpdates(); audioPlayer.stop()
            // A full-screen chat opened from a profile temporarily covers this
            // conversation. Preserve its draft/retry state until the child closes.
            if !nestedProfileChatActive {
                clearMessageSelection(); mediaPreview = nil; pendingSend = nil
                cancelPhotoPreview(); cancelPhotoSending(); cancelVoiceWork(discard: true)
            }
        }
        .pulseOnChange(of: session.token) { token in if token != openingToken { cancelPhotoPreview(); cancelPhotoSending() } }
        .pulseOnChange(of: session.user?.id) { actor in if actor != openingActorID { cancelPhotoPreview(); cancelPhotoSending() } }
        .pulseOnChange(of: APIClient.shared.endpointIdentity) { endpoint in if endpoint != openingEndpoint { cancelPhotoPreview(); cancelPhotoSending() } }
        .pulseSheet(item: $pendingPhoto, onDismiss: {
            groupSheetDismissed(.photoSend)
            if reselectPhotoAfterPreview { reselectPhotoAfterPreview = false; if privateMediaActionsEnabled, !appLock.isLocked, !session.updateRequired { showingStandardPhotoPicker = true } }
            else if photoSendWork != nil { startPhotoSending() }
        }) { photo in
            IOSPhotoSendPreview(photos: photo.photos,
                onBack: { reselectPhotoAfterPreview = true; pendingPhoto = nil },
                onCancel: { pendingPhoto = nil }, onSend: { ids in sendPreviewedPhotos(photo, selectedIDs: ids) })
                .onAppear { groupSheetAppeared(.photoSend) }
        }
        )
    }

    private var attachmentContent: some View {
        AnyView(photoLifecycleContent
        .pulseSheet(item: $forwarding, onDismiss: { groupSheetDismissed(.forwarding) }) { presentation in
            IOSMessageForwardSheet(batch: presentation.batch,
                current: { currentChatSession && session.user?.id == openingActorID && !appLock.isLocked && !session.updateRequired },
                sourceAvailable: { selectableMessageIDs.contains($0) },
                onSent: { if $0.conversationId == conversation.id { acceptMessage($0) } },
                onComplete: { count in clearMessageSelection(); session.conversationDidChange(); showToast("已转发 \(count) 条消息") })
                .onAppear { groupSheetAppeared(.forwarding) }
        }
        .pulseSheet(isPresented: $showingPinnedMessages, onDismiss: { groupSheetDismissed(.pins) }) {
            pinnedMessagesSheet.onAppear { groupSheetAppeared(.pins) }
        }
        .pulseSheet(item: $mediaPreview, onDismiss: { groupSheetDismissed(.media) }) { preview in
            IOSMessageAttachmentPreview(preview: preview).environmentObject(session).onAppear { groupSheetAppeared(.media) }
        }
        .iosPhotoGallery(item: $photoGallery, clearedBefore: clearedBeforeMessageID,
            invalidatedIDs: deletedMessageIDs.union(messageVersions.values.filter { $0.recalledAt != nil || $0.status == "recalled" }.map(\.id)),
            onUnavailable: { showToast("该图片已撤回、已清空或不可查看") })
        .pulseSheet(item: $contactCardPicker, onDismiss: { groupSheetDismissed(.contactCards) }) { presentation in
            IOSContactCardPicker(client: presentation.client, actorID: presentation.actorID,
                current: { contactCardContextCurrent(presentation) },
                cancel: { contactCardPicker = nil }, send: { sendContactCard($0, presentation: presentation) })
                .onAppear { groupSheetAppeared(.contactCards) }
        }
        .pulseSheet(item: $receivedContactCard, onDismiss: { receivedCardDismissed() }) { presentation in
            IOSReceivedContactCardView(target: presentation.target, client: presentation.client, actorID: presentation.actorID,
                sourceAvailable: { receivedContactCardCurrent(presentation) }, onChat: { direct in
                    guard receivedContactCardCurrent(presentation) else { return }
                    pendingReceivedCardChat = (direct, presentation); receivedContactCard = nil
                })
                .onAppear { groupSheetAppeared(.receivedContactCard) }
        }
        .pulseChatPresentation(item: $receivedCardChat)
        .pulseOnChange(of: receivedCardChat?.id) { id in if id == nil { setNestedProfileChatActive(false) } }
        .pulseSheet(isPresented: $showingActionMenu, onDismiss: { attachmentSheetDismissed() }) {
            PrivateChatAttachmentSheet(
                onPhotos: requestPhotoPicker,
                onCamera: { showingActionMenu = false; openCamera() },
                onFavorite: { showingActionMenu = false; openFavorites() },
                onShake: isPrivate && session.user?.internalStaff == true ? { showingActionMenu = false; sendShake() } : nil,
                onContactCard: { openContactCardPicker() }, onVideo: requestVideoPicker
            )
            .presentationDetents([.height(225)])
            .onAppear { groupSheetAppeared(.attachments) }
        }
        .pulseSheet(isPresented: $showingCamera, onDismiss: { groupSheetDismissed(.camera) }) {
            CameraCaptureView(
                onImage: { image in showingCamera = false; resumeFollowingForUserAction(); let reply = replyDraft; Task { await uploadImage(image, reply: reply) } },
                onCancel: { showingCamera = false }
            )
            .ignoresSafeArea()
            .onAppear { groupSheetAppeared(.camera) }
        }
        .pulseSheet(item: $editingMessage, onDismiss: { groupSheetDismissed(.editing) }) { message in
            EditMessageView(message: message) { updated in
                guard sendVisible, session.token == openingToken else { return }
                acceptMessage(updated, authoritative: false)
                Task { await reconcileMessages() }
            }
            .onAppear { groupSheetAppeared(.editing) }
        }
        .pulseSheet(item: $favoriteConversation, onDismiss: { groupSheetDismissed(.favorites) }) { value in
            PulseNavigationStack { ChatView(conversation: value, actorID: session.user?.id).environmentObject(session) }
                .onAppear { groupSheetAppeared(.favorites) }
        }
        )
    }

    private var profileContent: some View {
        AnyView(attachmentContent
        .overlay {
            if let peerUserId = conversation.peerUserId {
                if showingContactInfo {
                    ContactInfoView(userID: peerUserId, conversationID: conversation.id, initialMuted: isMuted, onClose: { muted, profile in
                        if session.token == openingToken, APIClient.shared.endpointIdentity == openingEndpoint {
                            isMuted = muted
                            if let profile {
                                let remark = profile.remark?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                                peerDisplayName = remark.isEmpty ? profile.nickname : remark
                                peerOnline = profile.online; peerLastSeenAt = profile.lastSeenAt
                            }
                        }
                        showingContactInfo = false
                    }, onNotificationsChanged: { muted in
                        if session.token == openingToken, APIClient.shared.endpointIdentity == openingEndpoint { isMuted = muted }
                    }, onNestedChatActive: setNestedProfileChatActive)
                        .environmentObject(session)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(PulsePalette.surface)
                        .zIndex(10)
                }
            }
        }
        .pulseSheet(isPresented: $showingGroupInfo, onDismiss: { setNestedProfileChatActive(false); groupSheetDismissed(.groupInfo) }) {
            PulseNavigationStack {
                GroupMembersView(conversation: conversation, onNestedChatActive: setNestedProfileChatActive)
                    .environmentObject(session)
            }
            .onAppear { groupSheetAppeared(.groupInfo) }
        }
        .pulseOnChange(of: showingGroupInfo) { presented in
            if presented { groupNoticePopup = nil }
        }
        .pulseSheet(item: $groupContactRoute, onDismiss: {
            setNestedProfileChatActive(false); groupSheetDismissed(.memberProfile)
            requestGroupMetadata()
        }) { route in
            if route.scope.matches(session) {
                ContactInfoView(userID: route.userID, conversationID: 0, initialMuted: false,
                    groupContextConversationID: route.scope.conversationID,
                    onClose: { _, _ in if groupContactRoute?.id == route.id { groupContactRoute = nil } },
                    onNotificationsChanged: { _ in }, onNestedChatActive: setNestedProfileChatActive)
                    .id(route.id)
                    .onAppear { groupSheetAppeared(.memberProfile) }
            }
        }
        .pulseSheet(isPresented: $showingSearch, onDismiss: { groupSheetDismissed(.search) }) {
            PulseNavigationStack { ChatSearchView(conversationID: conversation.id) }
                .onAppear { groupSheetAppeared(.search) }
        }
        )
    }

    private var finalContent: some View {
        AnyView(profileContent
        .fileImporter(isPresented: $showingFileImporter, allowedContentTypes: fileImportKind == "video" ? [.movie] : [.item], allowsMultipleSelection: false) { result in
            let kind = fileImportKind
            Task { await importFile(result, kind: kind) }
        }
        .sheet(isPresented: $showingStandardPhotoPicker, onDismiss: photoPickerDismissed) {
            IOSChatPhotoPicker(onVideoSelection: { provider in
                selectedVideoProvider = provider; selectedPhotoProviders = []; showingStandardPhotoPicker = false
            }) { providers, original in
                selectedPhotoProviders = providers
                selectedPhotoOriginal = original
                showingStandardPhotoPicker = false
            }
        }
        .sheet(isPresented: $showingVideoPicker, onDismiss: videoPickerDismissed) {
            IOSSystemVideoPicker { provider in selectedVideoProvider = provider; showingVideoPicker = false }
        }
        .sheet(item: $pendingVideoSend, onDismiss: commitSelectedVideoIfReady) { draft in
            IOSSelectedVideoPreview(video: draft.video, sending: isUploading, error: videoSendError,
                onCancel: cancelVideoWork, onSend: { uploadSelectedVideo(draft) })
                .interactiveDismissDisabled(isUploading)
        }
        .overlay {
            if isPreparingVideo {
                VStack(spacing: 12) { ProgressView("正在读取视频…"); Button("取消", action: cancelVideoWork) }
                    .padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .alert("提示", isPresented: Binding(get: { !showingContactInfo && (!error.isEmpty || !recorder.error.isEmpty) }, set: { if !$0, !showingContactInfo { error = ""; recorder.error = "" } })) {
            if photoSendWork != nil { Button("重试剩余图片", action: startPhotoSending) }
            if pendingSend != nil { Button("重试发送") { resumeFollowingForUserAction(); Task { await retryPending() } } }
            if pendingVoice != nil { Button("重试语音上传", action: requestVoiceUpload) }
            Button("取消") { error = ""; recorder.error = ""; pendingSend = nil; cancelVoiceWork(discard: true); cancelPhotoSending() }
        } message: { Text(error.isEmpty ? recorder.error : error) }
        .overlay(alignment: .bottom) {
            if !showingContactInfo, !toast.isEmpty {
                Text(toast).font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 9).background(.black.opacity(0.78), in: Capsule()).padding(.bottom, 76)
                    .transition(.opacity)
            }
        }
        .overlay {
            if let popup = visibleGroupNoticePopup {
                IOSGroupNoticeDialog(content: popup.content, onPresented: { markGroupNoticePresented(popup) }, onConfirm: {
                    if groupNoticePopup?.id == popup.id { groupNoticePopup = nil }
                })
                .id(popup.id)
                .zIndex(20)
            }
        }
        .overlayPreferenceValue(PrivateChatMenuHeaderKey.self) { header in
            GeometryReader { proxy in
                if isPrivate, showingChatMenu, let header {
                    PrivateChatMoreMenuOverlay(headerFrame: proxy[header], containerSize: proxy.size, isMuted: isMuted,
                        onDismiss: closeChatMenu,
                        onToggleNotifications: { closeChatMenu(); toggleNotifications() },
                        onClearHistory: { requestChatAction(.clearHistory) },
                        onDeleteConversation: { requestChatAction(.deleteConversation) })
                        .zIndex(30)
                }
            }
            .allowsHitTesting(isPrivate && showingChatMenu)
        }
        .overlay {
            if performingChatAction {
                ProgressView("处理中…").padding(18)
                    .background(PulsePalette.surface, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if isPreparingPhoto { ProgressView("正在准备图片预览…").padding(8).frame(maxWidth: .infinity).background(PulsePalette.surface) }
            else if !photoSendProgress.isEmpty {
                HStack { Text(photoSendProgress).font(.footnote); Spacer(); Button("停止余下图片") { cancelPhotoSending() } }
                    .padding(10).background(PulsePalette.surface)
            }
        }
        )
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        if choosingMessages && !isPrivate {
            ToolbarItem(placement: .topBarLeading) { Button("取消") { clearMessageSelection() } }
        } else if !isPrivate {
            ToolbarItem(placement: .topBarLeading) {
                Button { dismiss() } label: { Label("返回", systemImage: "chevron.left").font(.system(size: 16)).frame(minHeight: 36) }
                    .accessibilityLabel("返回聊天列表")
                    .disabled(voiceOwnsComposer || isGroupNoticePresented)
            }
        }
        if conversation.type == "group" {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(title)
                        .font(.system(size: 16, weight: .semibold))
                        .lineLimit(1)
                    Text(groupMemberText)
                        .font(.system(size: 10))
                        .foregroundStyle(PulsePalette.muted)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingGroupInfo = true } label: {
                    Image(systemName: "ellipsis")
                }
                .disabled(isGroupNoticePresented)
            }
        } else if !isPrivate {
            ToolbarItem(placement: .principal) { Text(title).font(.system(size: 16, weight: .semibold)) }
        }
    }

    private var privateContent: some View {
        VStack(spacing: 0) {
            referencePrivateHeader
            if choosingMessages { messageSelectionBar }
            if !pinnedMessages.isEmpty { pinnedMessageBar }
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            olderHistoryControl
                            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                                VStack(spacing: 15) {
                                    if let label = privateDateLabel(at: index) {
                                        Text(label).font(.system(size: 11)).foregroundStyle(.white)
                                            .padding(.horizontal, 9).padding(.vertical, 3)
                                            .background(Color.black.opacity(0.17), in: RoundedRectangle(cornerRadius: 5))
                                            .frame(maxWidth: .infinity)
                                    }
                                    selectableMessageRow(message) { privateMessageView(message) }.modifier(MessageJumpHighlight(active: messageNavigation.highlightedMessageID == message.id))
                                }.id(message.id).modifier(IOSLegacyMessageFrame(messageID: message.id))
                            }
                            pendingTextRows
                        }
                        .modifier(IOSChatScrollTargetLayout())
                        // Keep short histories, including friend greetings, below
                        // the header. The full touch surface still dismisses input.
                        .frame(minHeight: max(0, viewport.size.height - 30), alignment: .top)
                        .padding(.horizontal, 7).padding(.top, 12).padding(.bottom, 18)
                        .background { scrollBottomMarker }
                        .modifier(IOSChatTouchSurface(protectedFrames: Array(keyboardProtectedFrames.values),
                            enabled: canDismissChatInput, onDismiss: closeChatInput))
                    }
                    .scrollIndicators(.hidden)
                    .modifier(IOSChatScrollPosition(visibleMessageID: $visibleMessageID, viewportHeight: scrollViewportHeight,
                        restoreID: legacyAnchorRestoreID, restoreRequest: legacyAnchorRestoreRequest, proxy: proxy))
                    .modifier(ChatViewportTracking(bottomY: $scrollBottomY, viewportHeight: $scrollViewportHeight))
                    .simultaneousGesture(DragGesture(minimumDistance: 3).onChanged { _ in
                        historyPagingArmed = true
                        resumeFollowingForUserAction()
                        privateComposerFocused = false
                    })
                    .modifier(WindowShakeEffect(shakes: shakePhase))
                    .pulseOnChange(of: scrollRequest) { _ in scrollToLatest(using: proxy) }
                    .pulseOnChange(of: jumpRequest) { _ in scrollToNavigationTarget(using: proxy) }
                }
            }
            .background(PulsePalette.surface)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                replyComposerPreview
                privateComposer.disabled(!historyAccessVerified)
                chatInputPanelContent
            }.background(PulsePalette.surface)
        }
    }

    private var referencePrivateHeader: some View {
        ZStack {
            Button { openContactInfo() } label: {
                VStack(spacing: 1) {
                    HStack(spacing: 4) {
                        Text(peerName).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                        if isMuted { Image(systemName: "bell.slash.fill").font(.system(size: 10)).foregroundStyle(PulsePalette.muted) }
                    }
                    Text(peerOnlineStatusText).font(.system(size: 11)).foregroundStyle(PulsePalette.muted).lineLimit(1)
                }
                .padding(.horizontal, 82).frame(maxWidth: .infinity, minHeight: 46)
            }
            .buttonStyle(.plain).accessibilityLabel("查看\(peerName)的联系人信息")
            .contextMenu {
                Button("搜索聊天记录", systemImage: "magnifyingglass") { closeChatInput(); showingSearch = true }
            }
            HStack(spacing: 0) {
                Button { if choosingMessages { clearMessageSelection() } else { dismiss() } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left").font(.system(size: 21, weight: .medium))
                        Text("返回").font(.system(size: 16))
                    }.frame(minWidth: 66, minHeight: 46)
                }.buttonStyle(.plain).accessibilityLabel("返回聊天列表")
                Spacer()
                Button(action: toggleChatMenu) { Image(systemName: "ellipsis").font(.system(size: 24, weight: .bold)).frame(width: 43, height: 46) }
                    .buttonStyle(.plain).accessibilityLabel("更多会话操作")
                    .accessibilityIdentifier("private_chat_more_button")
                    .accessibilityValue(showingChatMenu ? "已展开" : "已收起")
                    .disabled(!activeChatSession || performingChatAction || updatingChatNotifications)
            }.padding(.horizontal, 12)
        }.foregroundStyle(PulsePalette.ink).frame(height: 50).background(PulsePalette.surface)
            .anchorPreference(key: PrivateChatMenuHeaderKey.self, value: .bounds) { $0 }
    }

    private func closeChatMenu() { showingChatMenu = false }
    private func toggleChatMenu() {
        guard isPrivate, activeChatSession, !appLock.isLocked, !session.updateRequired, !performingChatAction else { return }
        if showingChatMenu { closeChatMenu(); return }
        closeChatInput(); actionMenuMessage = nil
        showingChatMenu = true
    }
    private var chatActionReady: Bool {
        isPrivate && activeChatSession && session.user?.id == openingActorID && !appLock.isLocked && !session.updateRequired
            && privateMediaActionsEnabled && pendingTexts.isEmpty && !deletingMessages && !performingChatAction
    }
    private func requestChatAction(_ action: PrivateChatMenuAction) {
        closeChatMenu()
        guard chatActionReady else { showToast("请先完成当前消息或录音，再操作对话"); return }
        closeChatInput(); pendingChatAction = action
    }
    @MainActor private func performChatAction(_ action: PrivateChatMenuAction) async {
        guard chatActionReady else { return }
        performingChatAction = true
        let client = APIClient.shared.captureSession()
        defer { performingChatAction = false }
        do {
            switch action {
            case .clearHistory:
                let result = try await client.clearConversationHistory(id: conversation.id)
                guard activeChatSession, session.user?.id == openingActorID, !appLock.isLocked, !session.updateRequired else { return }
                guard let cutoff = result.cutoff(for: conversation.id, keeping: clearedBeforeMessageID) else { throw APIClientError.invalidResponse }
                // Invalidate older in-flight syncs before applying the server's
                // boundary. Messages received after that boundary remain visible.
                try? await IOSLocalChatStore.shared.clearConversation(client.avatarCacheNamespace, conversation.id, cutoff: cutoff)
                await IOSLocalMediaCache.shared.clear()
                cancelReconciliation(); clearedBeforeMessageID = cutoff
                olderHistoryGeneration = UUID(); loadingOlderHistory = false
                olderHistoryHasMore = false; olderHistoryCursor = 0
                messages = MessageReconciliation.merge(snapshot: messages, events: [], conversationID: conversation.id, clearedBefore: cutoff)
                messageVersions = messageVersions.filter { $0.key > cutoff }
                pendingReadIDs = Set(pendingReadIDs.filter { $0 > cutoff })
                readIDs = Set(readIDs.filter { $0 > cutoff })
                deletedMessageIDs = Set(deletedMessageIDs.filter { $0 > cutoff })
                reconciledUpperID = max(reconciledUpperID, cutoff)
                clearMessageSelection(); resumeFollowingForUserAction(); pruneInvisiblePins(invalidatePending: true)
                if let reply = replyDraft, reply.message.id <= cutoff { replyDraft = nil; pendingSend = nil }
                if let id = audioPlayer.playingID, id <= cutoff { audioPlayer.stop() }
                session.conversationDidChange(); requestPinsRefresh(); scrollRequest += 1
                showToast("已清空历史记录")
                Task { await reconcileMessages() }
            case .deleteConversation:
                try await client.hideConversation(id: conversation.id)
                guard activeChatSession, session.user?.id == openingActorID, !appLock.isLocked, !session.updateRequired else { return }
                session.conversationWasHidden(conversation.id)
                dismiss()
            }
        } catch {
            if activeChatSession, session.user?.id == openingActorID { showToast(error.localizedDescription) }
        }
    }

    private var privateMediaActionsEnabled: Bool { composerSendAllowed && historyAccessVerified && currentChatSession && pendingPhoto == nil && pendingVideoSend == nil && uploadedVideoToCommit == nil && photoSendWork == nil && !isUploading && !isPreparingPhoto && !isPreparingVideo && !isSubmitting && !recorder.isRecording && !recorder.isStarting && pendingSend == nil && pendingVoice == nil }
    private func closeChatInput() { chatInputPanel = .none; privateComposerFocused = false; groupComposerFocused = false; closeMentionPicker() }
    private var canDismissChatInput: Bool {
        activeChatSession && !appLock.isLocked && !session.updateRequired && !choosingMessages && !voiceOwnsComposer
    }
    private func toggleChatInput(_ panel: ReferencePrivateInputPanel) {
        guard privateMediaActionsEnabled, activeChatSession, !appLock.isLocked, !session.updateRequired,
              conversation.type != "channel" || canPublish else { return }
        privateComposerFocused = false; groupComposerFocused = false; closeMentionPicker()
        chatInputPanel = chatInputPanel == panel ? .none : panel
    }
    @ViewBuilder private var chatInputPanelContent: some View {
        if composerSendAllowed, !voiceOwnsComposer {
            if chatInputPanel == .attachments {
                ReferencePrivateAttachmentPanel(onPhotos: requestPhotoPicker, disabled: !privateMediaActionsEnabled,
                    onCamera: { closeChatInput(); openCamera() },
                    onFile: { openPrivateFile(kind: "file") }, onVideo: { openPrivateFile(kind: "video") },
                    onFavorite: { closeChatInput(); openFavorites() },
                    onShake: isPrivate && session.user?.internalStaff == true ? { closeChatInput(); sendShake() } : nil,
                    onContactCard: { openContactCardPicker() }, showsFileAttachments: conversation.type != "group")
                    .accessibilityIdentifier("chat_attachment_panel")
            } else if chatInputPanel == .emoji {
                ReferencePrivateEmojiPanel(onSelect: { draft += $0 }, onDelete: { if !draft.isEmpty { draft.removeLast() } })
            }
        }
    }
    private func openContactInfo() {
        guard currentChatSession, conversation.peerUserId != nil else { return }
        guard !voiceOwnsComposer else { showToast("请先发送或取消当前录音"); return }
        closeChatInput(); audioPlayer.stop(); showingContactInfo = true
    }
    private func setNestedProfileChatActive(_ active: Bool) {
        guard nestedProfileChatActive != active else { return }
        nestedProfileChatActive = active
        if active {
            // Keep the original chat tree and pending request, but let only the
            // nested group own active receiving and read receipts.
            sendVisible = false; pauseLiveUpdates(); audioPlayer.stop()
        } else if session.token == openingToken, APIClient.shared.endpointIdentity == openingEndpoint {
            sendVisible = true; startLiveUpdates()
        }
    }
    private func openPrivateFile(kind: String) {
        if kind == "video" { requestVideoPicker(); return }
        guard privateMediaActionsEnabled, conversation.type != "group" else { return }
        closeChatInput(); fileImportKind = kind; showingFileImporter = true
    }
    private func privateDateLabel(at index: Int) -> String? {
        let value = String(messages[index].createdAt.prefix(10))
        if index > 0, messages[index - 1].createdAt.prefix(10) == value { return nil }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: value) else { return nil }
        if Calendar.current.isDateInToday(date) { return "今天" }
        if Calendar.current.isDateInYesterday(date) { return "昨天" }
        formatter.locale = Locale(identifier: "zh_CN"); formatter.dateFormat = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date()) ? "M月d日" : "yyyy年M月d日"
        return formatter.string(from: date)
    }

    private var standardContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) { olderHistoryControl; ForEach(messages) { message in selectableMessageRow(message) { standardMessageView(message) }.modifier(MessageJumpHighlight(active: messageNavigation.highlightedMessageID == message.id)).id(message.id).modifier(IOSLegacyMessageFrame(messageID: message.id)) }; pendingTextRows }
                    .modifier(IOSChatScrollTargetLayout()).padding(16).background { scrollBottomMarker }
                    .modifier(IOSChatTouchSurface(protectedFrames: Array(keyboardProtectedFrames.values),
                        enabled: canDismissChatInput, onDismiss: closeChatInput))
            }
            .scrollIndicators(.hidden)
            .background(PulsePalette.surface)
            .modifier(IOSChatScrollPosition(visibleMessageID: $visibleMessageID, viewportHeight: scrollViewportHeight,
                restoreID: legacyAnchorRestoreID, restoreRequest: legacyAnchorRestoreRequest, proxy: proxy))
            .modifier(ChatViewportTracking(bottomY: $scrollBottomY, viewportHeight: $scrollViewportHeight))
            .simultaneousGesture(DragGesture(minimumDistance: 3).onChanged { _ in historyPagingArmed = true; resumeFollowingForUserAction() })
            .safeAreaInset(edge: .bottom, spacing: 0) { VStack(spacing: 0) { groupMentionPicker; replyComposerPreview; standardComposer; chatInputPanelContent } }
            .pulseOnChange(of: scrollRequest) { _ in scrollToLatest(using: proxy) }
            .pulseOnChange(of: jumpRequest) { _ in scrollToNavigationTarget(using: proxy) }
        }
    }

    @ViewBuilder private var replyComposerPreview: some View {
        if let reply = replyDraft {
            let message = messageVersions[reply.message.id] ?? reply.message
            let unavailable = message.id <= clearedBeforeMessageID || message.recalledAt != nil || message.status == "recalled"
            HStack(spacing: 10) {
                Rectangle().fill(PulsePalette.accent).frame(width: 3)
                messageThumbnail(unavailable ? nil : message.previewThumbnailURL, size: 38)
                Button { Task { await locateMessage(message.id) } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("回复 \(unavailable ? "原消息" : senderName(message))").font(.system(size: 12, weight: .semibold)).foregroundStyle(PulsePalette.accent)
                        Text(unavailable ? "原消息已不可用" : message.previewText).font(.system(size: 13)).foregroundStyle(PulsePalette.muted).lineLimit(2)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).disabled(unavailable)
                Button { replyDraft = nil; pendingSend = nil } label: { Image(systemName: "xmark").frame(width: 32, height: 36) }
                    .disabled(isUploading || isSubmitting || voiceOwnsComposer).accessibilityLabel("取消引用回复")
            }
            .padding(.horizontal, 14).padding(.vertical, 9).fixedSize(horizontal: false, vertical: true)
            .background(PulsePalette.surface).overlay(alignment: .top) { Divider() }
        }
    }

    private var selectableMessageIDs: Set<Int> {
        guard currentChatSession, session.user?.id == openingActorID else { return [] }
        return Set(messages.filter {
            $0.conversationId == conversation.id && $0.id > clearedBeforeMessageID && IOSMessageForwarding.supported(messageVersions[$0.id] ?? $0)
        }.map(\.id))
    }
    private var selectedMessages: [Message] {
        messages.filter { selectedMessageIDs.contains($0.id) && selectableMessageIDs.contains($0.id) }.sorted { $0.id < $1.id }
    }
    private func clearMessageSelection() { forwarding = nil; actionMenuMessage = nil; showingDeleteConfirmation = false; choosingMessages = false; selectedMessageIDs = [] }
    private func toggleMessageSelection(_ id: Int) {
        guard selectableMessageIDs.contains(id) else { return }
        if selectedMessageIDs.contains(id) { selectedMessageIDs.remove(id) }
        else if selectedMessageIDs.count < 100 { selectedMessageIDs.insert(id) }
        else { showToast("一次最多选择 100 条消息"); return }
        choosingMessages = true; closeChatInput(); groupComposerFocused = false
    }
    private func beginForwarding(_ sources: [Message]) {
        guard currentChatSession, !voiceOwnsComposer, !isUploading, !isSubmitting, !appLock.isLocked, !session.updateRequired else { return }
        let ids = Set(sources.map(\.id))
        guard !ids.isEmpty, ids.isSubset(of: selectableMessageIDs) else { showToast("原消息已不可转发，请重新选择"); return }
        do {
            let current = messages.filter { ids.contains($0.id) }.map { messageVersions[$0.id] ?? $0 }
            forwarding = IOSForwardPresentation(batch: try IOSMessageForwardBatch(messages: current))
            closeChatInput(); groupComposerFocused = false
        } catch { showToast(error.localizedDescription) }
    }
    private var messageSelectionBar: some View {
        HStack(spacing: 10) {
            Button("转发 \(selectedMessages.count)") { beginForwarding(selectedMessages) }
                .buttonStyle(.borderedProminent).tint(Color(red: 0.21, green: 0.66, blue: 0.89)).disabled(selectedMessages.isEmpty || deletingMessages)
            Button("删除 \(selectedMessages.count)") { requestMessageDeletion(selectedMessages) }
                .buttonStyle(.borderedProminent).tint(Color(red: 0.21, green: 0.66, blue: 0.89)).disabled(selectedMessages.isEmpty || deletingMessages)
            Spacer(minLength: 0)
            Button("取消") { clearMessageSelection() }.buttonStyle(.plain).disabled(deletingMessages)
        }.font(.system(size: 13, weight: .semibold)).foregroundStyle(PulsePalette.accent).padding(.horizontal, 12).frame(height: 54).background(PulsePalette.surface)
            .accessibilityLabel("已选择 \(selectedMessages.count) 条消息")
    }
    @ViewBuilder private func selectableMessageRow<Content: View>(_ message: Message, @ViewBuilder content: () -> Content) -> some View {
        if choosingMessages, selectableMessageIDs.contains(message.id) {
            HStack(spacing: 6) {
                Image(systemName: selectedMessageIDs.contains(message.id) ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22)).foregroundStyle(PulsePalette.accent).frame(width: 26).accessibilityHidden(true)
                content().allowsHitTesting(false).accessibilityHidden(true)
            }
            .padding(.vertical, 2).background(selectedMessageIDs.contains(message.id) ? PulsePalette.accent.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle()).onTapGesture { toggleMessageSelection(message.id) }
            .onLongPressGesture(minimumDuration: 0.5) { showMessageActionMenu(message) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(selectedMessageIDs.contains(message.id) ? "已选择" : "未选择") \(message.previewText)")
            .accessibilityAddTraits(.isButton).accessibilityAction { toggleMessageSelection(message.id) }
        } else { content() }
    }

    @ViewBuilder private func messageReferenceActions(_ message: Message) -> some View {
        if selectableMessageIDs.contains(message.id) {
            Button { beginForwarding([message]) } label: { Label("转发", systemImage: "arrowshape.turn.up.right") }
                .disabled(isUploading || isSubmitting || voiceOwnsComposer)
            Button { toggleMessageSelection(message.id) } label: { Label("选择此消息", systemImage: "checkmark.circle") }
                .disabled(isUploading || isSubmitting || voiceOwnsComposer)
        }
        Button {
            guard composerSendAllowed, currentChatSession, !isUploading, !isSubmitting, !voiceOwnsComposer else { return }
            pendingSend = nil; replyDraft = IOSReplyDraft(message: message)
        } label: { Label("引用回复", systemImage: "arrowshape.turn.up.left") }
            .disabled(!composerSendAllowed || isUploading || isSubmitting || voiceOwnsComposer)
        if canManagePins {
            let pinned = pinnedMessages.contains(where: { $0.id == message.id })
            Button { Task { await changePin(message, pinned: !pinned) } } label: {
                Label(pinned ? "取消置顶" : "置顶消息", systemImage: pinned ? "pin.slash" : "pin")
            }.disabled(pinActionID != nil)
        }
    }

    private func showMessageActionMenu(_ message: Message) {
        guard currentChatSession, !appLock.isLocked, !session.updateRequired, forwarding == nil, !showingDeleteConfirmation,
              !deletingMessages, message.id > clearedBeforeMessageID, !deletedMessageIDs.contains(message.id),
              let live = messages.first(where: { $0.id == message.id }), live.recalledAt == nil, live.status != "recalled" else { return }
        let revision = UUID()
        messageMenuPermissionRevision = revision; messageMenuInternalAllowed = false
        closeChatInput(); groupComposerFocused = false; actionMenuMessage = live
        Task {
            let allowed = (try? await session.verifyInternalStaffForMessageActions()) == true
            guard currentChatSession, actionMenuMessage?.id == live.id, messageMenuPermissionRevision == revision else { return }
            messageMenuInternalAllowed = allowed
        }
    }
    private func menuSources(_ message: Message) -> [Message] {
        choosingMessages && !selectedMessages.isEmpty ? selectedMessages : [message]
    }
    private func menuActions(_ message: Message) -> [IOSMessageMenuRow] {
        let batch = choosingMessages && !selectedMessages.isEmpty
        let sources = menuSources(message)
        let canCopy = sources.contains { !($0.body["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
        var rows: [IOSMessageMenuRow] = []
        if composerSendAllowed { rows.append(.init(key: "reply", label: "回复", icon: "arrowshape.turn.up.left")) }
        if batch || canCopy { rows.append(.init(key: "copy", label: batch ? "复制所选内容" : "复制", icon: "doc.on.doc", enabled: canCopy)) }
        if selectableMessageIDs.contains(message.id) {
            rows.append(.init(key: "forward", label: batch ? "转发所选内容" : "转发", icon: "arrowshape.turn.up.right"))
            rows.append(.init(key: "delete", label: batch ? "删除所选内容" : "删除", icon: "trash"))
        }
        if choosingMessages { rows.append(.init(key: "cancel", label: "取消选择", icon: "checkmark.circle")) }
        else {
            if canManagePins {
                let pinned = pinnedMessages.contains(where: { $0.id == message.id })
                rows.append(.init(key: "pin", label: pinned ? "取消置顶" : "置顶消息", icon: pinned ? "pin.slash" : "pin"))
            }
            rows.append(.init(key: "favorite", label: "收藏此消息", icon: "star"))
            if messageMenuInternalAllowed && session.user?.internalStaff == true { rows.append(.init(key: "recall", label: "撤回消息", icon: "arrow.uturn.backward")) }
            if message.senderId == session.user?.id && composerSendAllowed && message.type == "text" && (APIClient.shared.isGoV2 || (messageMenuInternalAllowed && session.user?.internalStaff == true)) { rows.append(.init(key: "edit", label: "编辑消息", icon: "pencil")) }
            if selectableMessageIDs.contains(message.id) { rows.append(.init(key: "select", label: "选择此消息", icon: "checkmark.circle")) }
        }
        return rows
    }
    @ViewBuilder private var messageActionOverlay: some View {
        if let message = actionMenuMessage, currentChatSession {
            GeometryReader { geometry in
                let rows = menuActions(message)
                let width = min(CGFloat(174), max(0, geometry.size.width - 16))
                let height = CGFloat(rows.count * 40 + 48)
                let anchor = messageActionFrames[message.id] ?? CGRect(x: geometry.size.width / 2, y: geometry.size.height / 2, width: 0, height: 0)
                let x = min(max(width / 2 + 8, anchor.midX), max(width / 2 + 8, geometry.size.width - width / 2 - 8))
                let y = min(max(height / 2 + 8, anchor.midY), max(height / 2 + 8, geometry.size.height - height / 2 - 8))
                Color.black.opacity(0.001).contentShape(Rectangle()).onTapGesture { actionMenuMessage = nil }
                IOSMessageMenuCard(rows: rows, timestamp: message.createdAt) { key in
                    guard currentChatSession, !deletedMessageIDs.contains(message.id), messages.contains(where: { $0.id == message.id && $0.recalledAt == nil }) else { actionMenuMessage = nil; return }
                    let sources = menuSources(message)
                    let staffAllowed = messageMenuInternalAllowed && session.user?.internalStaff == true
                    actionMenuMessage = nil
                    switch key {
                    case "reply": if composerSendAllowed { clearMessageSelection(); pendingSend = nil; replyDraft = IOSReplyDraft(message: message) }
                    case "copy":
                        let text = sources.compactMap { $0.body["text"]?.stringValue }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "\n")
                        if !text.isEmpty { UIPasteboard.general.string = text; showToast("已复制") }
                    case "forward": beginForwarding(sources)
                    case "delete": requestMessageDeletion(sources)
                    case "cancel": clearMessageSelection()
                    case "select": toggleMessageSelection(message.id)
                    case "pin": Task { await changePin(message, pinned: !pinnedMessages.contains(where: { $0.id == message.id })) }
                    case "favorite": Task { await favorite(message) }
                    case "recall": if staffAllowed { Task { await recall(message) } }
                    case "edit":
                        if message.senderId == session.user?.id && composerSendAllowed && message.type == "text" {
                            if APIClient.shared.isGoV2 { editingMessage = message }
                            else if staffAllowed {
                                Task {
                                    guard (try? await session.verifyInternalStaffForMessageActions()) == true, currentChatSession else { return }
                                    editingMessage = message
                                }
                            }
                        }
                    default: break
                    }
                }.frame(width: width).position(x: x, y: y)
            }.zIndex(30)
        }
    }
    private func requestMessageDeletion(_ sources: [Message]) {
        guard currentChatSession, !deletingMessages else { return }
        let ids = sources.map(\.id).filter { selectableMessageIDs.contains($0) }
        guard !ids.isEmpty else { return }
        actionMenuMessage = nil; pendingDeletionIDs = Array(Set(ids)).sorted(); showingDeleteConfirmation = true
    }
    @MainActor private func deleteSelectedMessages(_ ids: [Int]) async {
        guard currentChatSession, !deletingMessages, !ids.isEmpty, Set(ids).isSubset(of: selectableMessageIDs) else { return }
        deletingMessages = true
        let client = APIClient.shared.captureSession()
        defer { deletingMessages = false }
        do {
            let result = try await client.deleteMessages(conversationID: conversation.id, messages: messages.filter { ids.contains($0.id) })
            guard currentChatSession, session.user?.id == openingActorID else { return }
            guard result.conversationId == conversation.id, result.userId == openingActorID, Set(ids).isSubset(of: Set(result.messageIds)) else { throw APIClientError.invalidResponse }
            applyPersonalDeletion(result); clearMessageSelection(); pendingDeletionIDs = []; showToast("已删除 \(ids.count) 条消息")
        } catch { if currentChatSession { showToast(error.localizedDescription) } }
    }
    @MainActor private func applyPersonalDeletion(_ deletion: PersonalMessageDeletion) {
        guard currentChatSession, deletion.conversationId == conversation.id, deletion.userId == openingActorID else { return }
        let ids = Set(deletion.messageIds.filter { $0 > 0 }); deletedMessageIDs.formUnion(ids)
        for id in ids {
            let current = messageVersions[id] ?? messages.first(where: { $0.id == id }) ?? Message(id: id, conversationId: conversation.id, senderId: 0, type: "text", body: [:], createdAt: "", recalledAt: nil, editedAt: nil, status: nil)
            let tombstone = MessageReconciliation.tombstone(current); messageVersions[id] = tombstone
            persistLocalEvent(tombstone)
            if isReconciling { syncEvents[id] = tombstone }
        }
        messages.removeAll { ids.contains($0.id) }; selectedMessageIDs.subtract(ids)
        pinnedMessages.removeAll { ids.contains($0.id) }; pinsRevision += 1
        if let id = selectedPinID, ids.contains(id) { selectedPinID = pinnedMessages.first?.id }
        if let reply = replyDraft, ids.contains(reply.message.id) { replyDraft = nil }
        if let preview = mediaPreview, ids.contains(preview.messageID) { mediaPreview = nil }
        if let playing = audioPlayer.playingID, ids.contains(playing) { audioPlayer.stop() }
        actionMenuMessage = nil; session.conversationDidChange(); requestPinsRefresh()
    }

    private func senderName(_ message: Message) -> String {
        if message.senderId == session.user?.id { return session.user?.nickname ?? "我" }
        return isPrivate ? peerName : session.contactDisplayName(userID: message.senderId, fallback: goMemberNames[message.senderId] ?? IOSChatMessageDisplay.senderName(message))
    }

    @ViewBuilder private func messageThumbnail(_ raw: String?, size: CGFloat) -> some View {
        if let raw, let url = APIClient.shared.mediaURL(raw) {
            AsyncImage(url: url) { phase in
                if let image = phase.image { image.resizable().scaledToFill() }
                else { Image(systemName: "photo").foregroundStyle(PulsePalette.muted).frame(maxWidth: .infinity, maxHeight: .infinity).background(PulsePalette.background) }
            }.frame(width: size, height: size).clipped().clipShape(RoundedRectangle(cornerRadius: 5))
        }
    }

    private func messageReplyPreview(_ reference: MessageReplyReference, mine: Bool) -> some View {
        let source = messageVersions[reference.id]
        let unavailable = reference.unavailable || reference.id <= clearedBeforeMessageID || source?.recalledAt != nil || source?.status == "recalled"
        let lightText = mine && !isPrivate
        return Button { if !unavailable { Task { await locateMessage(reference.id) } } } label: {
            HStack(spacing: 7) {
                RoundedRectangle(cornerRadius: 1).fill(lightText ? Color.white.opacity(0.8) : PulsePalette.accent).frame(width: 3)
                messageThumbnail(unavailable ? nil : source?.previewThumbnailURL ?? reference.thumbnailURL, size: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(unavailable ? "原消息" : reference.senderName).font(.system(size: 12, weight: .semibold))
                    Text(unavailable ? "原消息已不可用" : source?.previewText ?? reference.text).font(.system(size: 12)).lineLimit(2).opacity(0.85)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .foregroundStyle(lightText ? Color.white : PulsePalette.accent)
            .padding(8).frame(maxWidth: 230).fixedSize(horizontal: false, vertical: true)
            .background((lightText ? Color.white : PulsePalette.accent).opacity(0.1), in: RoundedRectangle(cornerRadius: 7))
        }.buttonStyle(.plain).disabled(unavailable).accessibilityLabel("引用消息：\(unavailable ? "原消息已不可用" : reference.text)")
    }

    private var selectedPinnedMessage: PinnedMessage? { pinnedMessages.first(where: { $0.id == selectedPinID }) ?? pinnedMessages.first }

    @ViewBuilder private var pinnedMessageBar: some View {
        if let pin = selectedPinnedMessage {
            let message = MessageReconciliation.preferred(current: messageVersions[pin.id], incoming: pin.message, preferIncomingOnEqual: false)
            let index = pinnedMessages.firstIndex(where: { $0.id == pin.id }) ?? 0
            HStack(spacing: 9) {
                Button { Task { await locateMessage(message.id) } } label: {
                    HStack(spacing: 9) {
                        RoundedRectangle(cornerRadius: 1).fill(PulsePalette.accent).frame(width: 3)
                        messageThumbnail(message.previewThumbnailURL, size: 38)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("置顶消息 \(index + 1)/\(pinnedMessages.count)").font(.system(size: 12, weight: .semibold)).foregroundStyle(PulsePalette.accent)
                            Text(message.previewText).font(.system(size: 13)).foregroundStyle(PulsePalette.ink).lineLimit(1)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if locatingMessageID == message.id { ProgressView().controlSize(.small) }
                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHint("跳转到这条消息并高亮显示")
                if pinnedMessages.count > 1 {
                    Button { selectedPinID = pinnedMessages[(index + 1) % pinnedMessages.count].id } label: { Image(systemName: "chevron.down").frame(width: 28, height: 38) }.accessibilityLabel("切换下一条置顶消息")
                }
                Button { showingPinnedMessages = true } label: { Image(systemName: "list.bullet").frame(width: 28, height: 38) }.accessibilityLabel("查看全部置顶消息")
                if canManagePins {
                    Button { Task { await changePin(message, pinned: false) } } label: {
                        if pinActionID == message.id { ProgressView().frame(width: 28, height: 38) }
                        else { Image(systemName: "xmark").frame(width: 28, height: 38) }
                    }.disabled(pinActionID != nil).accessibilityLabel("取消当前消息置顶")
                }
            }
            .foregroundStyle(PulsePalette.muted).padding(.horizontal, 12).padding(.vertical, 8)
            .fixedSize(horizontal: false, vertical: true).background(Color.white).overlay(alignment: .bottom) { Divider() }
        }
    }

    private var pinnedMessagesSheet: some View {
        PulseNavigationStack {
            List {
                if pinnedMessages.isEmpty { Text("暂无置顶消息").foregroundStyle(PulsePalette.muted) }
                ForEach(pinnedMessages) { pin in
                    let message = MessageReconciliation.preferred(current: messageVersions[pin.id], incoming: pin.message, preferIncomingOnEqual: false)
                    HStack(spacing: 10) {
                        Button {
                            selectedPinID = pin.id; showingPinnedMessages = false
                            Task { await locateMessage(pin.id) }
                        } label: {
                            HStack(spacing: 10) {
                                messageThumbnail(message.previewThumbnailURL, size: 42)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("置顶消息").font(.system(size: 12, weight: .semibold)).foregroundStyle(PulsePalette.accent)
                                    Text(message.previewText).font(.system(size: 14)).foregroundStyle(PulsePalette.ink).lineLimit(3)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityHint("跳转到这条消息并高亮显示")
                        if canManagePins {
                            Button { Task { await changePin(message, pinned: false) } } label: { Image(systemName: "pin.slash").frame(width: 36, height: 40) }
                                .buttonStyle(.borderless).disabled(pinActionID != nil).accessibilityLabel("取消置顶")
                        }
                    }
                }
            }
            .navigationTitle("置顶消息（\(pinnedMessages.count)/\(MessagePinsSnapshot.maximumCount)）").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingPinnedMessages = false } } }
        }
        .presentationDetents([.medium, .large])
        .alert("提示", isPresented: Binding(get: { !pinSheetError.isEmpty }, set: { if !$0 { pinSheetError = "" } })) {
            Button("确定") { pinSheetError = "" }
        } message: { Text(pinSheetError) }
    }

    private var privateComposer: some View {
        Group {
            if !composerSendAllowed { chatComposerRow }
            else if pendingVoice != nil { voiceDraftComposer }
            else if recorder.isRecording {
                HStack(spacing: 12) {
                    Button { cancelVoiceWork(discard: true) } label: { Image(systemName: "trash").foregroundStyle(PulsePalette.danger).frame(width: 38, height: 38).background(PulsePalette.danger.opacity(0.1), in: Circle()) }
                    Circle().fill(.red).frame(width: 8, height: 8)
                    Text("录音中  \(formatDuration(recorder.elapsedMilliseconds))").font(.system(size: 15, weight: .medium)).foregroundStyle(PulsePalette.ink)
                    Spacer()
                    Text("点击发送").font(.system(size: 12)).foregroundStyle(PulsePalette.muted)
                    Button { Task { await finishRecording() } } label: { Image(systemName: "arrow.up").foregroundStyle(.white).frame(width: 38, height: 38).background(PulsePalette.accent, in: Circle()) }
                }
                .padding(.horizontal, 13).padding(.vertical, 8).background(PulsePalette.surface)
            } else {
                chatComposerRow
            }
        }
    }

    @ViewBuilder private var standardComposer: some View {
        privateComposer.disabled(!historyAccessVerified)
    }

    private var chatComposerRow: some View {
        HStack(spacing: 4) {
            Button { closeChatInput(); Task { await startOrFinishRecording() } } label: {
                Image(systemName: "waveform.circle").font(.system(size: 27)).frame(width: 40, height: 44)
            }.buttonStyle(.plain).accessibilityLabel("开始录音").accessibilityIdentifier("chat_record")
                .disabled(!privateMediaActionsEnabled)
            if canSearchGroupMentions {
                Button { beginMentionQuery() } label: { Text("@").font(.system(size: 22)).frame(width: 28, height: 44) }
                    .buttonStyle(.plain).accessibilityLabel("艾特群成员")
            }
            Group {
                if !composerSendAllowed {
                    Text("已禁止发言").foregroundStyle(PulsePalette.muted).frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                        .accessibilityLabel("已禁止发言")
                } else if conversation.type == "group" {
                    IOSMentionComposerField(text: $draft, caret: $mentionCaret, composing: $mentionComposing,
                        focused: $groupComposerFocused, handle: groupComposerHandle)
                        .frame(height: 30)
                } else {
                    TextField("输入消息", text: $draft, axis: .vertical).focused($privateComposerFocused).lineLimit(1...4)
                        .accessibilityLabel("输入消息")
                }
            }
            .font(.system(size: 16)).padding(.horizontal, 10).padding(.vertical, 7).frame(minHeight: 44)
            .background(PulsePalette.background, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityIdentifier("chat_message_input")
            Button { toggleChatInput(.emoji) } label: {
                Image(systemName: "face.smiling").font(.system(size: 27)).frame(width: 40, height: 44)
            }.buttonStyle(.plain).accessibilityLabel("选择表情").disabled(!privateMediaActionsEnabled)
            Button { toggleChatInput(.attachments) } label: {
                Image(systemName: "plus.circle").font(.system(size: 27)).frame(width: 40, height: 44)
            }.buttonStyle(.plain).accessibilityLabel(chatInputPanel == .attachments ? "关闭聊天功能" : "打开聊天功能")
                .accessibilityValue(chatInputPanel == .attachments ? "已展开" : "已收起")
                .accessibilityIdentifier("chat_attach").disabled(!privateMediaActionsEnabled)
            if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pendingSend != nil {
                Button { send() } label: {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 34, height: 34).background(PulsePalette.accent, in: Circle())
                }.buttonStyle(.plain).accessibilityLabel(pendingSend == nil ? "发送消息" : "重试发送")
                    .disabled(!composerSendAllowed || isUploading || isPreparingPhoto || isSubmitting || recorder.isStarting)
            }
        }
        .foregroundStyle(PulsePalette.ink).padding(.horizontal, 6).padding(.vertical, 7).background(PulsePalette.surface)
    }

    private var voiceOwnsComposer: Bool { recorder.isRecording || recorder.isStarting || pendingVoice != nil }
    private var voiceDraftComposer: some View {
        HStack(spacing: 12) {
            Button { cancelVoiceWork(discard: true) } label: { Image(systemName: "trash").foregroundStyle(PulsePalette.danger).frame(width: 38, height: 38) }.disabled(isUploading).accessibilityLabel("删除待发送语音")
            Image(systemName: "waveform")
            Text("语音 \(formatDuration(pendingVoice?.recording.durationMilliseconds ?? 0))").font(.subheadline)
            Spacer()
            if isUploading { ProgressView() }
            else { Button("发送语音", action: requestVoiceUpload).disabled(!activeChatSession || appLock.isLocked || session.updateRequired) }
        }.padding(.horizontal, 14).padding(.vertical, 8).background(PulsePalette.surface)
    }

    @ViewBuilder private func privateMessageView(_ message: Message) -> some View {
        let mine = message.senderId == session.user?.id
        HStack(alignment: .top, spacing: 11) {
            if mine { Spacer(minLength: 38) }
            if !mine {
                Button { openContactInfo() } label: {
                    ReferencePrivateChatAvatar(title: peerName, avatarURL: conversation.avatarURL)
                }.buttonStyle(.plain)
                    .modifier(IOSChatTouchExclusion(id: "avatar-\(message.id)"))
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                messageBubble(message, mine: mine)
                    .onLongPressGesture(minimumDuration: 0.5) { showMessageActionMenu(message) }
            }
            .modifier(IOSChatTouchExclusion(id: "message-\(message.id)"))
            if !mine { Spacer(minLength: 38) }
        }
        .background(GeometryReader { proxy in Color.clear.preference(key: IOSMessageActionFrameKey.self, value: [message.id: proxy.frame(in: .named("messageActionContainer"))]) })
    }

    @ViewBuilder private func messageBubble(_ message: Message, mine: Bool) -> some View {
        if let media = IOSChatMediaDescriptor(message: message) {
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                if let reference = message.replyReference {
                    messageReplyPreview(reference, mine: mine).padding(8)
                        .background(mine ? (isPrivate ? ReferencePrivateChatStyle.outgoing : PulsePalette.accent) : PulsePalette.surface,
                                    in: RoundedRectangle(cornerRadius: 8))
                }
                IOSChatMediaBubble(source: media, client: APIClient.shared.captureSession(),
                    active: activeChatSession && !appLock.isLocked && !session.updateRequired,
                    activation: mediaActivation,
                    captionBackground: mine ? (isPrivate ? ReferencePrivateChatStyle.outgoing : PulsePalette.accent) : PulsePalette.background,
                    captionForeground: mine && !isPrivate ? .white : PulsePalette.ink,
                    open: { openMedia(message) })
            }
        } else if isPrivate {
            referencePrivateMessageBubble(message, mine: mine)
        } else {
        let fill = mine ? PulsePalette.accent : PulsePalette.background
        VStack(alignment: .leading, spacing: 7) {
            if message.recalledAt == nil, let reference = message.replyReference { messageReplyPreview(reference, mine: mine) }
            Group {
            if message.recalledAt != nil {
                HStack(alignment: .bottom, spacing: 8) { Text("消息已撤回").italic(); messageTime(message, mine: mine) }.foregroundStyle(PulsePalette.muted)
            } else if message.type == "voice", let value = message.body["url"]?.stringValue, let url = APIClient.shared.mediaURL(value) {
                HStack(alignment: .bottom, spacing: 8) {
                    Button { audioPlayer.toggle(messageID: message.id, url: url, client: APIClient.shared.captureSession()) } label: {
                        HStack(spacing: 9) { if audioPlayer.loadingID == message.id { ProgressView() } else { Image(systemName: audioPlayer.playingID == message.id ? "stop.fill" : "play.fill") }; Text("语音  \(voiceSeconds(message)) 秒").font(.system(size: 14, weight: .medium)); Image(systemName: "waveform") }
                            .foregroundStyle(mine ? .white : PulsePalette.ink).frame(minWidth: 132, alignment: mine ? .trailing : .leading)
                    }.buttonStyle(.plain)
                    messageTime(message, mine: mine)
                }
            } else if message.type == "file" {
                VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                    Button { openMedia(message) } label: {
                        Label(message.body["name"]?.stringValue ?? message.body["file_name"]?.stringValue ?? "打开附件", systemImage: "doc.fill")
                            .font(.system(size: 14, weight: .medium)).lineLimit(2).frame(maxWidth: 230, alignment: .leading)
                    }.buttonStyle(.plain)
                    messageTime(message, mine: mine)
                }.foregroundStyle(mine ? .white : PulsePalette.ink)
            } else if message.type == "contact_card" {
                HStack(alignment: .bottom, spacing: 8) {
                    receivedContactCardButton(message)
                    messageTime(message, mine: mine)
                }
                    .foregroundStyle(mine ? .white : PulsePalette.ink)
            } else if message.type == "shake" {
                HStack(alignment: .bottom, spacing: 8) {
                    Label(message.body["text"]?.stringValue ?? "窗口抖动", systemImage: "bolt.horizontal.circle.fill")
                    messageTime(message, mine: mine)
                }.foregroundStyle(mine ? .white : PulsePalette.ink)
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    Text((message.type == "red_packet" ? "历史红包（已停用）" : message.body["text"]?.stringValue ?? "消息"))
                        .foregroundStyle(mine ? .white : PulsePalette.ink)
                        .font(.system(size: 15))
                    if message.editedAt != nil { Text("已编辑").font(.system(size: 10)).foregroundStyle(mine ? .white.opacity(0.7) : PulsePalette.muted) }
                    messageTime(message, mine: mine)
                }
            }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(fill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private func referencePrivateMessageBubble(_ message: Message, mine: Bool) -> some View {
        VStack(alignment: .trailing, spacing: 3) {
            if message.recalledAt == nil, let reference = message.replyReference { messageReplyPreview(reference, mine: mine) }
            Group {
                if message.recalledAt != nil {
                    Text("消息已撤回").italic().foregroundStyle(PulsePalette.muted)
                } else if message.type == "voice", let value = message.body["url"]?.stringValue, let url = APIClient.shared.mediaURL(value) {
                    Button { audioPlayer.toggle(messageID: message.id, url: url, client: APIClient.shared.captureSession()) } label: {
                        HStack(spacing: 9) {
                            if audioPlayer.loadingID == message.id { ProgressView() }
                            else { Image(systemName: audioPlayer.playingID == message.id ? "stop.fill" : "play.fill") }
                            Text("语音  \(voiceSeconds(message)) 秒").font(.system(size: 14, weight: .medium))
                            Image(systemName: "waveform")
                        }.frame(minWidth: 132, alignment: .leading)
                    }.buttonStyle(.plain)
                } else if message.type == "file" {
                    Button { openMedia(message) } label: {
                        Label(message.body["name"]?.stringValue ?? message.body["file_name"]?.stringValue ?? "打开附件", systemImage: "doc")
                            .font(.system(size: 14, weight: .medium)).lineLimit(2)
                    }.buttonStyle(.plain)
                } else if message.type == "contact_card" {
                    receivedContactCardButton(message)
                } else if message.type == "shake" {
                    Label(message.body["text"]?.stringValue ?? "窗口抖动", systemImage: "bolt.horizontal")
                } else {
                    Text(message.type == "red_packet" ? "历史红包（已停用）" : message.body["text"]?.stringValue ?? "消息")
                        .font(.system(size: 15)).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                }
            }.foregroundStyle(PulsePalette.ink)
            HStack(spacing: 4) {
                if message.editedAt != nil { Text("已编辑").font(.system(size: 9)).foregroundStyle(PulsePalette.muted) }
                messageTime(message, mine: mine)
            }.fixedSize(horizontal: true, vertical: true)
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .background(mine ? ReferencePrivateChatStyle.outgoing : PulsePalette.background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func messageTime(_ message: Message, mine: Bool) -> some View {
        Text(timeText(message.createdAt))
            .font(.system(size: 11, weight: .regular))
            .monospacedDigit()
            .foregroundStyle(isPrivate ? PulsePalette.muted : mine ? Color.white.opacity(0.82) : PulsePalette.muted)
            .lineLimit(1)
            .fixedSize()
    }

    @ViewBuilder private func standardMessageView(_ message: Message) -> some View {
        let mine = message.senderId == session.user?.id
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 40) }
            if !mine {
                groupSenderAvatar(message)
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
                if conversation.type == "group", !mine {
                    Text(senderName(message))
                        .font(.system(size: 12)).foregroundStyle(PulsePalette.muted).lineLimit(1)
                        .accessibilityIdentifier("group_sender_name_\(message.id)")
                }
                messageBubble(message, mine: mine)
                    .background(GeometryReader { proxy in Color.clear.preference(key: IOSMessageActionFrameKey.self, value: [message.id: proxy.frame(in: .named("messageActionContainer"))]) })
                    .onLongPressGesture(minimumDuration: 0.5) { showMessageActionMenu(message) }
            }
            .modifier(IOSChatTouchExclusion(id: "message-\(message.id)"))
            if !mine { Spacer(minLength: 40) }
        }
    }

    @ViewBuilder private func groupSenderAvatar(_ message: Message) -> some View {
        let avatar = PulseAvatar(title: senderName(message), tint: Color(hex: 0x7B74D8), size: 36, avatarURL: message.senderAvatarURL)
            .clipShape(Circle())
            .frame(width: 44, height: 44, alignment: .top).contentShape(Rectangle())
            .overlay {
                IOSGroupAvatarTouchSurface(allowsMention: canMentionGroupSender,
                    onTap: { openGroupSenderProfile(message) }, onMention: { mentionGroupSender(message) })
                    .accessibilityHidden(true)
            }
            .modifier(IOSChatTouchExclusion(id: "avatar-\(message.id)"))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(senderName(message))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { openGroupSenderProfile(message) }
        if canMentionGroupSender {
            avatar.accessibilityAction(named: Text("@此成员")) { mentionGroupSender(message) }
        } else { avatar }
    }

    private func openMedia(_ message: Message) {
        guard sendVisible, let token = session.token, token == openingToken, let raw = message.body["url"]?.stringValue,
              let url = APIClient.shared.mediaURL(raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        let kind = IOSChatMediaDescriptor(message: message)?.kind == .video ? "video" : message.type
        let fallback = kind == "image" ? "图片" : kind == "video" ? "视频" : "附件"
        let name = message.body["name"]?.stringValue ?? message.body["file_name"]?.stringValue ?? message.body["original_name"]?.stringValue ?? (url.pathExtension.isEmpty ? fallback : fallback + "." + url.pathExtension)
        if message.type == "image" {
            closeChatInput(); privateComposerFocused = false; groupComposerFocused = false; closeMentionPicker()
            audioPlayer.stop()
            photoGallery = IOSPhotoGalleryPresentation(message: message, client: APIClient.shared.captureSession(), token: token, clearedBefore: clearedBeforeMessageID)
            return
        }
        mediaPreview = IOSMediaPreview(messageID: message.id, conversationID: message.conversationId, rawURL: raw, name: name, type: kind, client: APIClient.shared.captureSession(), token: token)
    }

    private func currentGroupMessage(_ message: Message) -> Message? {
        guard activeGroupNoticeSession, message.conversationId == conversation.id, message.senderId > 0,
              message.senderId != openingActorID,
              let current = messages.first(where: { $0.id == message.id }), current.id > clearedBeforeMessageID,
              current.senderId == message.senderId, current.conversationId == conversation.id,
              current.recalledAt == nil, current.status != "recalled", current.status != "deleted" else { return nil }
        return current
    }

    private func mentionGroupSender(_ message: Message) {
        guard canMentionGroupSender, let current = currentGroupMessage(message) else { return }
        guard !isPreparingPhoto, !isUploading, !isSubmitting, !voiceOwnsComposer, pendingSend == nil else {
            showToast("请先完成当前发送或录音"); return
        }
        if let committed = groupComposerHandle.commitMarkedText() {
            selectedMentions.update(committed); draft = committed; mentionComposing = false
        }
        guard let next = selectedMentions.appending(userID: current.senderId, name: current.senderName, to: draft) else {
            showToast("昵称暂不可用，或消息及@人数已达到限制"); return
        }
        closeMentionPicker()
        draft = next; mentionCaret = next.utf16.count; groupComposerFocused = true
    }

    private var canMentionGroupSender: Bool {
        composerSendAllowed && activeGroupNoticeSession && !groupNoticeOtherModalBlocked && !isGroupNoticePresented && canPublish &&
            IOSGroupMentionPolicy.canMention(role: groupViewerRole ?? conversation.myRole)
    }
    private var canSearchGroupMentions: Bool {
        composerSendAllowed && activeGroupNoticeSession && !mentionDenied && !groupNoticeOtherModalBlocked && canPublish &&
            IOSGroupMentionPolicy.canSearch(role: groupViewerRole ?? conversation.myRole)
    }
    private func closeMentionPicker() {
        mentionTask?.cancel(); mentionTask = nil; mentionRequest = UUID(); mentionQuery = nil
        mentionItems = []; mentionStatus = ""; mentionHasMore = false
    }
    private func beginMentionQuery() {
        guard canSearchGroupMentions else { return }
        groupComposerFocused = true
        if IOSGroupMentionQuery.parse(draft, caret: mentionCaret) == nil {
            let offset = max(0, min(mentionCaret, draft.utf16.count)), value = draft as NSString
            let before = value.substring(to: offset), separator = before.isEmpty || before.last?.isWhitespace == true ? "" : " "
            let addition = separator + "@"
            draft = value.replacingCharacters(in: NSRange(location: offset, length: 0), with: addition); mentionCaret = offset + addition.utf16.count
        }
        updateMentionQuery()
    }
    private func updateMentionQuery() {
        guard canSearchGroupMentions, groupComposerFocused, !mentionComposing,
              let query = IOSGroupMentionQuery.parse(draft, caret: mentionCaret) else { closeMentionPicker(); return }
        closeMentionPicker(); mentionQuery = query; loadMentionPage(1)
    }
    private func loadMentionPage(_ page: Int) {
        guard canSearchGroupMentions, let query = mentionQuery else { return }
        mentionTask?.cancel(); let request = UUID(); mentionRequest = request; mentionStatus = "正在查找群成员…"
        let client = APIClient.shared.captureSession(), activity = activityGeneration
        mentionTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(180))
                let result = try await client.groupMentionMembers(id: conversation.id, query: query.query, page: page)
                guard !Task.isCancelled, mentionRequest == request, activity == activityGeneration, canSearchGroupMentions,
                      mentionQuery == query, draft == query.draft, mentionCaret == query.caret,
                      result.conversationId == conversation.id else { return }
                guard result.canSearch else { mentionDenied = true; closeMentionPicker(); return }
                let rows = result.items.filter { $0.userId > 0 && $0.userId != openingActorID }
                mentionItems = page == 1 ? rows : mentionItems + rows.filter { row in !mentionItems.contains(where: { $0.id == row.id }) }
                mentionPage = page; mentionHasMore = result.hasMore; mentionStatus = mentionItems.isEmpty ? "未找到匹配成员" : ""
            } catch {
                guard !Task.isCancelled, mentionRequest == request, canSearchGroupMentions else { return }
                mentionStatus = "加载失败，点击重试"
            }
        }
    }
    @ViewBuilder private var groupMentionPicker: some View {
        if canSearchGroupMentions, let query = mentionQuery {
            ScrollView {
                LazyVStack(spacing: 0) {
                    HStack { Text("选择群成员").font(.caption).foregroundStyle(PulsePalette.muted); Spacer(); Button { closeMentionPicker() } label: { Image(systemName: "xmark") }.accessibilityLabel("关闭成员搜索") }.padding(.horizontal, 14).padding(.vertical, 7)
                    ForEach(mentionItems) { row in
                        Button {
                            guard canSearchGroupMentions, draft == query.draft, mentionCaret == query.caret,
                                  let value = selectedMentions.replacing(userID: row.userId, name: row.nickname, query: query) else { return }
                            closeMentionPicker(); draft = value.text; mentionCaret = value.caret; groupComposerFocused = true
                        } label: {
                            HStack(spacing: 10) {
                                PulseAvatar(title: row.nickname, tint: Color(hex: 0x8374CC), size: 34, avatarURL: row.avatarURL)
                                Text(row.nickname).font(.system(size: 14, weight: .semibold)).foregroundStyle(PulsePalette.ink).lineLimit(1)
                                Text(row.username.map { "@" + $0 } ?? row.publicId.map { "ID: " + $0 } ?? "").font(.caption).foregroundStyle(PulsePalette.muted).lineLimit(1)
                                Spacer(minLength: 0)
                            }.padding(.horizontal, 14).frame(minHeight: 46).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                    if !mentionStatus.isEmpty { Button(mentionStatus) { loadMentionPage(mentionPage) }.font(.caption).padding(12).disabled(!mentionStatus.contains("失败")) }
                    if mentionHasMore { Button("加载更多") { loadMentionPage(mentionPage + 1) }.font(.caption).padding(12).disabled(mentionStatus.contains("正在")) }
                }
            }.frame(maxHeight: 220).background(PulsePalette.surface).overlay(alignment: .top) { Divider() }
        }
    }

    private func receivedContactCardButton(_ message: Message) -> some View {
        Button { openReceivedContactCard(message) } label: {
            HStack(spacing: 9) {
                PulseAvatar(title: message.body["nickname"]?.stringValue ?? "联系人", size: 38,
                            avatarURL: message.body["avatar_url"]?.stringValue)
                VStack(alignment: .leading, spacing: 3) {
                    Text(message.body["nickname"]?.stringValue ?? "联系人名片").font(.system(size: 15, weight: .semibold))
                    Text("用户 ID：\(PublicUserIdentity.display(message.body["public_id"]?.stringValue))").font(.system(size: 11)).lineLimit(1)
                    Text("个人名片 · 点击查看").font(.system(size: 11)).opacity(0.7)
                }
            }.contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(choosingMessages || IOSReceivedContactCardTarget(message: message) == nil)
            .accessibilityLabel("查看联系人名片：\(message.body["nickname"]?.stringValue ?? "联系人")")
            .accessibilityIdentifier("chat_received_contact_card_\(message.id)")
    }

    private func receivedContactCardCurrent(_ presentation: IOSReceivedContactCardPresentation) -> Bool {
        activeChatSession && !appLock.isLocked && !session.updateRequired && session.user?.id == presentation.actorID
            && presentation.client.webSocketToken == openingToken && presentation.client.endpointIdentity == openingEndpoint
            && presentation.target.conversationID == conversation.id && presentation.target.messageID > clearedBeforeMessageID
            && !deletedMessageIDs.contains(presentation.target.messageID)
            && messages.contains(where: { presentation.target.matches($0) })
    }

    private func openReceivedContactCard(_ message: Message) {
        guard !choosingMessages, receivedContactCard == nil,
              let target = IOSReceivedContactCardTarget(message: message), let actorID = openingActorID else { return }
        let presentation = IOSReceivedContactCardPresentation(target: target, client: APIClient.shared.captureSession(), actorID: actorID)
        guard receivedContactCardCurrent(presentation) else { return }
        closeChatInput()
        guard !groupNoticeModalBlocked, !isGroupNoticePresented else { return }
        receivedContactCard = presentation
    }

    private func receivedCardDismissed() {
        groupSheetDismissed(.receivedContactCard)
        guard let pending = pendingReceivedCardChat else { return }
        pendingReceivedCardChat = nil
        guard receivedContactCardCurrent(pending.owner), pending.conversation.id > 0,
              pending.conversation.type == "direct", pending.conversation.peerUserId == pending.owner.target.userID else { return }
        if pending.conversation.id == conversation.id { return }
        setNestedProfileChatActive(true)
        receivedCardChat = pending.conversation
    }

    private func openGroupSenderProfile(_ message: Message) {
        guard currentGroupMessage(message) != nil, !groupNoticeModalBlocked, !isGroupNoticePresented else { return }
        // Refresh policy on each tap so a recently disabled ban takes effect.
        guard !groupProfileOpening, let actorID = openingActorID else { return }
        let scope = IOSGroupPageIdentity(conversationID: conversation.id, viewerID: actorID, token: openingToken, endpoint: openingEndpoint)
        let client = APIClient.shared.captureSession(), activity = activityGeneration, request = UUID()
        guard scope.matches(client) else { return }
        groupProfileRequestID = request; groupProfileOpening = true
        Task {
            defer { if groupProfileRequestID == request { groupProfileOpening = false } }
            do {
                let profile = try await client.groupProfile(id: scope.conversationID)
                guard !Task.isCancelled, groupProfileRequestID == request, activityGeneration == activity,
                      scope.matches(session), activeGroupNoticeSession, currentGroupMessage(message) != nil else { return }
                groupProfileOpening = false
                guard !groupNoticeModalBlocked, !isGroupNoticePresented else { return }
                guard profile.conversationId == scope.conversationID else { throw APIClientError.invalidResponse }
                groupViewerRole = profile.myRole
                guard profile.canViewMemberProfiles else { return }
                // The source group remains independent of a direct conversation.
                // The profile endpoint checks the current policy and memberships.
                groupContactRoute = IOSGroupContactRoute(userID: message.senderId, scope: scope)
            } catch {
                if groupProfileRequestID == request, activityGeneration == activity, activeGroupNoticeSession {
                    groupViewerRole = nil
                    if !GroupFriendRestrictionFeedback.message(error, inGroup: true).isEmpty { showToast("群成员资料加载失败，请重试") }
                }
            }
        }
    }

    private var currentChatSession: Bool { sendVisible && session.token == openingToken && APIClient.shared.endpointIdentity == openingEndpoint }
    private var activeChatSession: Bool { currentChatSession && !nestedProfileChatActive && scenePhase == .active }
    private var activeGroupNoticeSession: Bool {
        conversation.type == "group" && activeChatSession && !appLock.isLocked && !session.updateRequired
            && openingActorID != nil && session.user?.id == openingActorID
    }
    private var groupNoticeModalBlocked: Bool { showingGroupInfo || !groupNoticeActiveSheets.isEmpty || groupNoticeOtherModalBlocked }
    private var groupNoticeOtherModalBlocked: Bool {
        forwarding != nil || contactCardPicker != nil || receivedContactCard != nil || pendingContactCardPicker != nil || choosingMessages || showingPinnedMessages || mediaPreview != nil || photoGallery != nil || showingActionMenu || showingCamera || showingChatMenu
            || showingSearch || showingContactInfo || groupContactRoute != nil || groupProfileOpening || favoriteConversation != nil
            || chatInputPanel != .none || showingFileImporter || showingStandardPhotoPicker || showingVideoPicker || pendingVideoSend != nil || isPreparingVideo || uploadedVideoToCommit != nil || editingMessage != nil || session.activeAnnouncement != nil
            || !error.isEmpty || !recorder.error.isEmpty || voiceOwnsComposer
            || pendingPhoto != nil || photoSendWork != nil || isPreparingPhoto || isUploading || isSubmitting
    }
    private var visibleGroupNoticePopup: IOSGroupNoticePresentation? {
        guard let popup = groupNoticePopup, !groupNoticeModalBlocked,
              isCurrentGroupNoticeContext(popup.context), popup.content == groupNoticeText, !popup.content.isEmpty else { return nil }
        // Recording onAppear starts the cooldown without closing this dialog.
        guard !popup.automatic || presentedGroupNoticeID == popup.id || mayAutomaticallyPresentGroupNotice else { return nil }
        return popup
    }
    private var isGroupNoticePresented: Bool { visibleGroupNoticePopup != nil }

    private var groupNoticeReminderHistory: GroupNoticeReminderHistory? {
        guard let actorID = openingActorID else { return nil }
        return GroupNoticeReminderHistory(endpoint: openingServerIdentity, userID: actorID, groupID: conversation.id)
    }
    private var mayAutomaticallyPresentGroupNotice: Bool {
        !groupComposerFocused && !privateComposerFocused && !mentionComposing && groupNoticeReminderHistory?.shouldPresentAutomatically() == true
    }

    @ViewBuilder private var groupNoticeBar: some View {
        if conversation.type == "group", currentChatSession, session.user?.id == openingActorID,
           !groupNoticeText.isEmpty, closedGroupNotice != groupNoticeText {
            IOSGroupNoticeBar(content: groupNoticeText,
                animate: activeGroupNoticeSession && !groupNoticeModalBlocked && !isGroupNoticePresented,
                onOpen: openGroupNotice,
                onClose: {
                    guard activeGroupNoticeSession, !groupNoticeModalBlocked else { return }
                    closedGroupNotice = groupNoticeText
                })
                .id(groupNoticeText)
        }
    }

    private func isCurrentGroupNoticeContext(_ context: IOSGroupNoticeContext) -> Bool {
        activeGroupNoticeSession && context.entryID == groupEntryID && context.activityID == activityGeneration
            && context.requestID == groupMetadataRequest && context.conversationID == conversation.id
            && context.actorID == openingActorID && context.token == openingToken && context.endpoint == openingEndpoint
    }

    private func markGroupNoticePresented(_ popup: IOSGroupNoticePresentation) {
        guard visibleGroupNoticePopup?.id == popup.id else {
            if groupNoticePopup?.id == popup.id { groupNoticePopup = nil }
            return
        }
        guard presentedGroupNoticeID != popup.id else { return }
        presentedGroupNoticeID = popup.id
        groupNoticeReminderHistory?.markPresented()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func openGroupNotice() {
        guard activeGroupNoticeSession, !groupNoticeModalBlocked else { return }
        if let context = groupNoticeContext, isCurrentGroupNoticeContext(context), !groupNoticeText.isEmpty {
            groupNoticePopup = IOSGroupNoticePresentation(context: context, content: groupNoticeText, automatic: false)
        } else {
            requestGroupMetadata(openNotice: true)
        }
    }

    private func suspendGroupNotice() {
        groupViewerRole = nil; groupProfileRequestID = UUID(); groupProfileOpening = false
        groupMetadataRequest = UUID()
        groupMetadataTask?.cancel(); groupMetadataTask = nil
        groupNoticeContext = nil; groupNoticePopup = nil; presentedGroupNoticeID = nil
    }

    private func groupSheetAppeared(_ sheet: IOSGroupChatSheet) {
        guard conversation.type == "group" else { return }
        groupNoticeActiveSheets.insert(sheet); groupNoticePopup = nil
    }

    private func groupSheetDismissed(_ sheet: IOSGroupChatSheet) {
        if sheet == .media { mediaActivation = UUID() }
        groupNoticeActiveSheets.remove(sheet)
        guard activeGroupNoticeSession, !groupNoticeModalBlocked,
              sheet == .groupInfo || (!groupNoticeText.isEmpty && mayAutomaticallyPresentGroupNotice) else { return }
        requestGroupMetadata()
    }

    private func clearGroupNotice() {
        suspendGroupNotice()
        groupNoticeText = ""; closedGroupNotice = nil
    }
    private var isNearLatestMessage: Bool { scrollViewportHeight == 0 || scrollBottomY <= scrollViewportHeight + 80 }
    private var followsLatestMessages: Bool { photoGallery == nil && messageNavigation.shouldFollowLatest(nearBottom: isNearLatestMessage) }
    private var scrollBottomMarker: some View {
        GeometryReader { geometry in Color.clear.preference(key: ChatBottomPositionKey.self, value: geometry.frame(in: .named("chatMessages")).maxY) }
    }

    private func applyPins(_ snapshot: MessagePinsSnapshot) {
        guard currentChatSession, snapshot.conversationId == conversation.id else { return }
        pinnedMessages = MessageReconciliation.visiblePins(snapshot.items, conversationID: conversation.id, clearedBefore: clearedBeforeMessageID, versions: messageVersions)
        if !pinnedMessages.contains(where: { $0.id == selectedPinID }) { selectedPinID = pinnedMessages.first?.id }
        pinsRevision += 1; lastPinsLoadedAt = ProcessInfo.processInfo.systemUptime
    }

    private func pruneInvisiblePins(invalidatePending: Bool = false) {
        let visible = MessageReconciliation.visiblePins(pinnedMessages, conversationID: conversation.id, clearedBefore: clearedBeforeMessageID, versions: messageVersions)
        if invalidatePending || visible.map(\.id) != pinnedMessages.map(\.id) { pinsRevision += 1 }
        pinnedMessages = visible
        if !pinnedMessages.contains(where: { $0.id == selectedPinID }) { selectedPinID = pinnedMessages.first?.id }
    }

    private func requestPinsRefresh() {
        if APIClient.shared.isGoV2 { return }
        guard activeChatSession else { return }
        pinsRefreshRequested = true
        guard pinsRefreshTask == nil else { return }
        let generation = pinsGeneration
        let client = APIClient.shared.captureSession()
        pinsRefreshTask = Task {
            defer { if pinsGeneration == generation { pinsRefreshTask = nil } }
            while !Task.isCancelled, activeChatSession, pinsGeneration == generation, pinsRefreshRequested {
                pinsRefreshRequested = false
                let revision = pinsRevision
                do {
                    let snapshot = try await client.messagePins(conversationID: conversation.id)
                    guard !Task.isCancelled, activeChatSession, pinsGeneration == generation else { return }
                    if revision == pinsRevision { applyPins(snapshot) }
                    else { pinsRefreshRequested = true }
                } catch {
                    guard activeChatSession, pinsGeneration == generation else { return }
                    // Recovery retries independently of whether the socket remains healthy.
                    lastPinsLoadedAt = 0
                    return
                }
            }
        }
    }

    private func changePin(_ message: Message, pinned: Bool) async {
        guard currentChatSession, pinActionID == nil, message.conversationId == conversation.id, canManagePins else { return }
        if pinned, !pinnedMessages.contains(where: { $0.id == message.id }), pinnedMessages.count >= MessagePinsSnapshot.maximumCount { error = "最多置顶\(MessagePinsSnapshot.maximumCount)条消息，请先取消一条置顶。"; requestPinsRefresh(); return }
        let generation = pinsGeneration, revision = pinsRevision
        let client = APIClient.shared.captureSession()
        pinActionID = message.id
        defer { if pinsGeneration == generation { pinActionID = nil } }
        do {
            let snapshot = try await client.setMessagePin(conversationID: conversation.id, messageID: message.id, pinned: pinned)
            guard currentChatSession, pinsGeneration == generation else { return }
            if revision == pinsRevision { applyPins(snapshot) } else { requestPinsRefresh() }
            showToast(pinned ? "已置顶消息，所有会话成员可见" : "已取消置顶")
        } catch {
            guard currentChatSession, pinsGeneration == generation else { return }
            if showingPinnedMessages { pinSheetError = error.localizedDescription } else { self.error = error.localizedDescription }
            requestPinsRefresh()
        }
    }

    private func locateMessage(_ id: Int) async {
        guard activeChatSession, id > 0 else { return }
        if messageNavigation.isResolving, messageNavigation.targetID == id { return }
        let activity = activityGeneration
        jumpAnimationTask?.cancel(); jumpAnimationTask = nil
        let revision = messageNavigation.begin(targetID: id)
        locatingMessageID = id
        defer { if activityGeneration == activity, messageNavigation.revision == revision { locatingMessageID = nil } }
        if !messages.contains(where: { $0.id == id }) {
            let client = APIClient.shared.captureSession()
            do {
                let page = try await client.locateMessage(conversationID: conversation.id, messageID: id)
                guard activeChatSession, activityGeneration == activity, messageNavigation.revision == revision else { return }
                guard page.targetId == id, page.items.contains(where: { $0.id == id && $0.conversationId == conversation.id }) else { throw APIClientError.invalidResponse }
                for message in page.items where message.conversationId == conversation.id {
                    messageVersions[message.id] = MessageReconciliation.preferred(current: messageVersions[message.id], incoming: message, preferIncomingOnEqual: false)
                    if isReconciling { syncEvents[message.id] = messageVersions[message.id] }
                }
                messages = MessageReconciliation.merge(snapshot: messages, events: Array(messageVersions.values), conversationID: conversation.id, clearedBefore: clearedBeforeMessageID)
                confirmPendingTexts()
            } catch {
                if activeChatSession, activityGeneration == activity, messageNavigation.fail(revision: revision) { locatingMessageID = nil; self.error = error.localizedDescription; requestPinsRefresh() }
                return
            }
        }
        guard messages.contains(where: { $0.id == id }) else {
            if messageNavigation.fail(revision: revision) { locatingMessageID = nil; showToast("原消息已不可用"); requestPinsRefresh() }
            return
        }
        // Allow the newly inserted history page to enter SwiftUI's scroll layout.
        await Task.yield()
        guard activeChatSession, activityGeneration == activity, messageNavigation.revision == revision else { return }
        guard messages.contains(where: { $0.id == id }) else {
            if messageNavigation.fail(revision: revision) { locatingMessageID = nil; showToast("原消息已不可用"); requestPinsRefresh() }
            return
        }
        guard messageNavigation.resolve(revision: revision) else { return }
        jumpRequest += 1
    }

    private func scrollToNavigationTarget(using proxy: ScrollViewProxy) {
        guard activeChatSession, let target = messageNavigation.targetID, messages.contains(where: { $0.id == target }) else { return }
        let revision = messageNavigation.revision, activity = activityGeneration
        jumpAnimationTask?.cancel()
        jumpAnimationTask = Task {
            defer { if messageNavigation.revision == revision { jumpAnimationTask = nil } }
            await Task.yield()
            guard !Task.isCancelled, activeChatSession, activityGeneration == activity, messageNavigation.revision == revision, messages.contains(where: { $0.id == target }) else { return }
            withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(target, anchor: .center) }
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            guard !Task.isCancelled, activeChatSession, activityGeneration == activity, messageNavigation.revision == revision, messages.contains(where: { $0.id == target }) else { return }
            // A lazy history page may acquire its final heights after the first layout.
            proxy.scrollTo(target, anchor: .center)
            do { try await Task.sleep(for: .milliseconds(2500)) } catch { return }
            guard !Task.isCancelled, activeChatSession, activityGeneration == activity else { return }
            messageNavigation.clearHighlight(revision: revision)
        }
    }

    private func resumeFollowingForUserAction() {
        guard messageNavigation.holdsPosition || messageNavigation.isResolving else { return }
        jumpAnimationTask?.cancel(); jumpAnimationTask = nil
        messageNavigation.resumeFollowing(); locatingMessageID = nil
    }

    private func applyComposerAuthorization(_ permission: IOSConversationSendPermission, request: UUID) {
        guard currentChatSession, session.user?.id == openingActorID,
              composerAuthorization.apply(permission, request: request) else { return }
        synchronizeComposerAuthorization()
    }
    private func synchronizeComposerAuthorization() {
        guard currentChatSession, let actorID = openingActorID, session.user?.id == actorID else { return }
        textOutbox.updateSendPermission(token: openingToken, actorID: actorID, endpoint: openingEndpoint,
            conversationID: conversation.id, allowed: composerSendAllowed)
        guard !composerSendAllowed else { return }
        // Keep the text/reply drafts and staged voice, but stop entry points and
        // pending picker callbacks before they can initiate another submission.
        closeChatInput(); groupComposerHandle.field?.resignFirstResponder()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        cancelVoiceWork(discard: false); cancelPhotoPreview(); cancelPhotoSending()
        showingActionMenu = false; showingCamera = false; showingFileImporter = false
        contactCardPicker = nil; pendingContactCardPicker = nil
    }
    private func requestSendPermissionRefresh() {
        guard activeChatSession, !appLock.isLocked, !session.updateRequired,
              let actorID = openingActorID, session.user?.id == actorID else { return }
        sendPermissionTask?.cancel()
        let request = composerAuthorization.beginRefresh(), activity = activityGeneration
        let client = APIClient.shared.captureSession()
        lastSendPermissionAt = ProcessInfo.processInfo.systemUptime
        sendPermissionTask = Task {
            defer { if composerAuthorization.request == request { sendPermissionTask = nil } }
            do {
                let info = try await client.conversationInfo(id: conversation.id)
                guard !Task.isCancelled, activeChatSession, activityGeneration == activity,
                      session.user?.id == actorID, client.webSocketToken == openingToken,
                      client.endpointIdentity == openingEndpoint, info.id == conversation.id,
                      composerAuthorization.request == request else { return }
                canPublish = info.canPublish
                applyComposerAuthorization(info.sendPermission, request: request)
            } catch { /* Keep the last known authorization; the live loop retries. */ }
        }
    }

    private func startLiveUpdates() {
        guard activeChatSession else { return }
        synchronizeComposerAuthorization()
        acceptConfirmedRecalls()
        guard recoveryTask == nil else { realtime.connect(); return }
        realtime.reconnectNow()
        requestPinsRefresh()
        let activity = UUID(); activityGeneration = activity
        let client = APIClient.shared.captureSession()
        metadataTask = Task {
            if isPrivate, let peerUserId = conversation.peerUserId, let profile = try? await client.contactProfile(userID: peerUserId), activeChatSession, activityGeneration == activity {
                let remark = profile.remark?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                peerDisplayName = remark.isEmpty ? profile.nickname : remark
                peerOnline = profile.online; peerLastSeenAt = profile.lastSeenAt
            }
            // Keep lightweight permission refresh independent of history or
            // reconciliation requests that may be waiting on a slow network.
            while !Task.isCancelled, activeChatSession, activityGeneration == activity {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard !Task.isCancelled, activeChatSession, activityGeneration == activity else { return }
                let permissionAge = ProcessInfo.processInfo.systemUptime - lastSendPermissionAt
                if sendPermissionTask == nil, permissionAge >= 5 || (permissionAge >= 2 && composerAuthorization.permission.needsExpiryRefresh()) {
                    requestSendPermissionRefresh()
                }
            }
        }
        requestGroupMetadata()
        requestSendPermissionRefresh()
        recoveryTask = Task {
            defer { if activityGeneration == activity { recoveryTask = nil } }
            if !historyReady { await load() } else { await reconcileMessages() }
            while !Task.isCancelled, activeChatSession, activityGeneration == activity {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard !Task.isCancelled, activeChatSession, activityGeneration == activity else { return }
                if !historyReady { await load() }
                else if !isReconciling && (!realtime.connected || ProcessInfo.processInfo.systemUptime - lastReconciledAt >= 15) { await reconcileMessages() }
                queueReadReceipts(messages)
                if ProcessInfo.processInfo.systemUptime - lastPinsLoadedAt >= (realtime.connected ? 15 : 2) { requestPinsRefresh() }
            }
        }
    }

    private func pauseLiveUpdates(preserveVoicePermission: Bool = false) {
        contactCardPicker = nil; pendingContactCardPicker = nil; receivedContactCard = nil
        // The microphone permission alert temporarily inactivates the scene.
        // Preserve that startup; other pauses stop recording/upload work.
        // A staged recording remains available to retry in this same chat.
        if !preserveVoicePermission { cancelVoiceWork(discard: false) }
        suspendGroupNotice()
        activityGeneration = UUID(); loadGeneration = UUID(); loadingHistory = false
        olderHistoryGeneration = UUID(); loadingOlderHistory = false
        recoveryTask?.cancel(); recoveryTask = nil
        metadataTask?.cancel(); metadataTask = nil
        sendPermissionTask?.cancel(); sendPermissionTask = nil; composerAuthorization.cancelRefresh()
        receiptTask?.cancel(); receiptTask = nil
        pinsGeneration = UUID(); pinsRefreshTask?.cancel(); pinsRefreshTask = nil; pinsRefreshRequested = false
        pinActionID = nil; locatingMessageID = nil
        jumpAnimationTask?.cancel(); jumpAnimationTask = nil; messageNavigation.pause()
        cancelReconciliation(); realtime.close()
        if APIClient.shared.isGoV2 {
            messages = []; messageVersions = [:]; historyReady = false; historyAccessVerified = false; goMemberNames = [:]
            mediaPreview = nil; photoGallery = nil; audioPlayer.stop()
        }
    }

    /// Bounded receipt work must not delay connecting or displaying new messages.
    private func queueReadReceipts(_ items: [Message]) {
        guard activeChatSession else { return }
        for message in items where message.senderId != session.user?.id && message.recalledAt == nil && message.status != "recalled" && !readIDs.contains(message.id) { pendingReadIDs.insert(message.id) }
        guard receiptTask == nil, !pendingReadIDs.isEmpty else { return }
        let activity = activityGeneration
        let client = APIClient.shared.captureSession()
        let capturedConversationID = conversation.id
        receiptTask = Task {
            defer { if activityGeneration == activity { receiptTask = nil } }
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            var changed = false
            while !Task.isCancelled, activeChatSession, activityGeneration == activity, !pendingReadIDs.isEmpty {
                let visible = Set(messages.filter { $0.recalledAt == nil && $0.status != "recalled" }.map(\.id))
                pendingReadIDs.formIntersection(visible)
                guard !pendingReadIDs.isEmpty else { break }
                if batchReadReceiptsAvailable, let throughID = pendingReadIDs.max() {
                    do {
                        try await client.markConversationRead(conversationID: conversation.id, throughID: throughID)
                        guard !Task.isCancelled, activeChatSession, activityGeneration == activity else { return }
                        let completed = pendingReadIDs.filter { $0 <= throughID }
                        pendingReadIDs.subtract(completed); readIDs.formUnion(completed); changed = true
                        continue
                    } catch {
                        guard !Task.isCancelled, activeChatSession, activityGeneration == activity else { return }
                        if let failure = error as? APIClientError {
                            if case .sessionExpired = failure { return }
                            if client.isGoV2 { break }
                            // Keep compatibility with servers predating snapshot receipts.
                            batchReadReceiptsAvailable = false
                        } else { break }
                    }
                }
                let batch = Array(pendingReadIDs.sorted().prefix(4))
                let completed = await withTaskGroup(of: Int?.self, returning: [Int].self) { group in
                    for id in batch {
                        group.addTask {
                            do { try await client.markMessageRead(id: id, conversationID: capturedConversationID); return id } catch { return nil }
                        }
                    }
                    var result: [Int] = []
                    for await id in group { if let id { result.append(id) } }
                    return result
                }
                guard !Task.isCancelled, activeChatSession, activityGeneration == activity else { return }
                for id in completed { pendingReadIDs.remove(id); readIDs.insert(id) }
                changed = changed || !completed.isEmpty
                if completed.count != batch.count { break }
            }
            if changed, activeChatSession, activityGeneration == activity { session.conversationDidChange() }
        }
    }

    @MainActor private func acceptConfirmedRecalls() {
        for message in session.confirmedMessageRecalls(conversationID: conversation.id) where messageVersions[message.id] != message { acceptMessage(message, persistLocally: false) }
    }

    @MainActor private func acceptMessage(_ incoming: Message, authoritative: Bool = true, persistLocally: Bool = true) {
        if APIClient.shared.isGoV2, !historyAccessVerified { return }
        guard currentChatSession, incoming.conversationId == conversation.id, !deletedMessageIDs.contains(incoming.id) else { return }
        if !authoritative && incoming.id <= reconciledUpperID && !messages.contains(where: { $0.id == incoming.id }) { return }
        textOutbox.confirm(incoming, token: openingToken, actorID: openingActorID, endpoint: openingEndpoint)
        let message = MessageReconciliation.preferred(current: messageVersions[incoming.id], incoming: incoming, preferIncomingOnEqual: authoritative)
        if persistLocally { persistLocalEvent(message) }
        let previousLastID = messages.last?.id ?? 0
        let follow = photoGallery == nil && messageNavigation.shouldFollowLatest(nearBottom: isNearLatestMessage, ownMessage: message.senderId == session.user?.id)
        if messageVersions[message.id] != message { messageVersions[message.id] = message }
        if isReconciling, syncEvents[message.id] != message { syncEvents[message.id] = message }
        let update = MessageReconciliation.applying(message, to: messages, conversationID: conversation.id, clearedBefore: clearedBeforeMessageID)
        guard update.changed || message.editedAt != nil || message.recalledAt != nil || message.status == "recalled" else { return }
        if update.changed { messages = update.items; session.conversationDidChange() }
        if message.editedAt != nil || message.recalledAt != nil || message.status == "recalled" { requestPinsRefresh() }
        if message.recalledAt != nil || message.status == "recalled" {
            pinnedMessages.removeAll(where: { $0.id == message.id }); pinsRevision += 1
            if !pinnedMessages.contains(where: { $0.id == selectedPinID }) { selectedPinID = pinnedMessages.first?.id }
            if audioPlayer.playingID == message.id { audioPlayer.stop() }
            if mediaPreview?.messageID == message.id { mediaPreview = nil }
        } else if follow && message.id > previousLastID { scrollRequest += 1 }
    }

    @MainActor private func persistLocalEvent(_ message: Message) {
        let client = APIClient.shared.captureSession(), namespace = client.avatarCacheNamespace
        Task {
            guard session.token == openingToken, namespace == APIClient.shared.avatarCacheNamespace else { return }
            try? await IOSLocalChatStore.shared.mergeEvent(namespace, message: message)
            guard namespace == APIClient.shared.avatarCacheNamespace else { return }
            if message.recalledAt != nil || ["recalled", "deleted"].contains(message.status ?? "") { await IOSLocalMediaCache.shared.clear() }
        }
    }
    @MainActor private func cancelReconciliation() {
        syncGeneration = UUID(); syncRetry?.cancel(); syncRetry = nil
        isReconciling = false; syncEvents = [:]; reconciliationQueued = false
    }

    @MainActor private func reconcileMessages() async {
        guard activeChatSession, let token = session.token else { return }
        guard historyReady else { reconciliationQueued = true; return }
        if isReconciling { reconciliationQueued = true; return }
        syncRetry?.cancel(); syncRetry = nil
        let current = UUID(); syncGeneration = current
        let client = APIClient.shared.captureSession()
        let floor = messages.map(\.id).min() ?? 0
        let anchor = visibleMessageID
        let previousLastID = messages.last?.id ?? 0
        let follow = followsLatestMessages
        let navigationRevision = messageNavigation.revision
        isReconciling = true; syncEvents = [:]; reconciliationQueued = false
        defer {
            if syncGeneration == current {
                isReconciling = false; syncEvents = [:]
                if reconciliationQueued { reconciliationQueued = false; Task { await reconcileMessages() } }
            }
        }
        let localTicket = try? await IOSLocalChatStore.shared.ticket(client.avatarCacheNamespace, conversation.id)
        var snapshotVersion: Int?
        var snapshot: Int?; var after = 0; var rows: [Message] = []; var cutoff = clearedBeforeMessageID
        do {
            while true {
                let page = try await client.syncMessages(conversationID: conversation.id, afterID: after, floorID: floor, snapshotMaxID: snapshot, membershipVersion: snapshotVersion)
                guard activeChatSession, session.token == token, syncGeneration == current else { return }
                if let version = page.membershipVersion {
                    if let old = goMembershipVersion, old != version { throw GoV2Error.membershipChanged }
                    if let old = snapshotVersion, old != version { throw GoV2Error.membershipChanged }
                    snapshotVersion = version
                }
                guard page.conversationId == conversation.id, snapshot == nil || page.snapshotMaxId == snapshot else { throw APIClientError.invalidResponse }
                snapshot = page.snapshotMaxId; cutoff = max(cutoff, page.clearedBeforeMessageId)
                rows.append(contentsOf: page.items)
                if !page.hasMore { break }
                guard page.nextAfterId > after else { throw APIClientError.invalidResponse }
                after = page.nextAfterId
            }
            if let version = snapshotVersion { try client.requireGoMembership(conversation.id, version: version) }
            if let localTicket { try? await IOSLocalChatStore.shared.merge(localTicket, items: rows, floor: floor, maximum: Int.max, cutoff: cutoff) }
            guard activeChatSession, session.token == token, syncGeneration == current else { return }
            if let version = snapshotVersion { try client.requireGoMembership(conversation.id, version: version) }
            let tombstones = messageVersions.values.filter { $0.recalledAt != nil || $0.status == "recalled" } + session.confirmedMessageRecalls(conversationID: conversation.id)
            let reconciled = MessageReconciliation.merge(snapshot: messages.filter { $0.id < floor } + rows, events: Array(tombstones) + Array(syncEvents.values), conversationID: conversation.id, clearedBefore: cutoff).map {
                MessageReconciliation.preferred(current: messageVersions[$0.id], incoming: $0)
            }
            reconciledUpperID = max(max(reconciledUpperID, snapshot ?? 0), messages.map(\.id).max() ?? 0)
            let present = Set(reconciled.map(\.id))
            for old in messages where !present.contains(old.id) { messageVersions[old.id] = MessageReconciliation.tombstone(old) }
            let cutoffAdvanced = cutoff > clearedBeforeMessageID
            messages = reconciled; clearedBeforeMessageID = cutoff; syncRetryDelay = 2
            confirmPendingTexts()
            if photoGallery == nil, follow, !messageNavigation.holdsPosition, messageNavigation.revision == navigationRevision, (reconciled.last?.id ?? 0) > previousLastID { scrollRequest += 1 }
            lastReconciledAt = ProcessInfo.processInfo.systemUptime
            for message in reconciled { messageVersions[message.id] = message }
            pruneInvisiblePins(invalidatePending: cutoffAdvanced)
            queueReadReceipts(reconciled)
            if !messageNavigation.holdsPosition, messageNavigation.revision == navigationRevision, let anchor, !reconciled.contains(where: { $0.id == anchor }) {
                let replacement = reconciled.first(where: { $0.id > anchor })?.id ?? reconciled.last?.id
                visibleMessageID = replacement
                if #unavailable(iOS 17.0) { legacyAnchorRestoreID = replacement; legacyAnchorRestoreRequest += 1 }
            }
            if let playing = audioPlayer.playingID, !reconciled.contains(where: { $0.id == playing }) { audioPlayer.stop() }
            if let preview = mediaPreview, !reconciled.contains(where: { $0.id == preview.messageID }) { mediaPreview = nil }
        } catch {
            guard activeChatSession, session.token == token, syncGeneration == current else { return }
            if IOSLocalChatAccessDenied.matches(error) { await discardDeniedLocalHistory(client); return }
            let delay = syncRetryDelay; syncRetryDelay = min(30, delay * 2)
            syncRetry = Task { @MainActor in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, activeChatSession, session.token == token, syncGeneration == current else { return }
                syncRetry = nil
                await reconcileMessages()
            }
        }
    }

    @ViewBuilder private var olderHistoryControl: some View {
        if historyReady {
            Button {
                historyPagingArmed = true
                Task { await loadOlderHistory() }
            } label: {
                HStack(spacing: 6) {
                    if loadingOlderHistory { ProgressView().scaleEffect(0.7) }
                    Text(loadingOlderHistory ? "正在加载更早消息…" : olderHistoryFailed ? "加载失败，点按重试更早消息" : olderHistoryHasMore ? "加载更早消息" : "已到聊天记录开头")
                }.font(.system(size: 12)).foregroundStyle(PulsePalette.muted)
                    .frame(maxWidth: .infinity, minHeight: 32)
            }.buttonStyle(.plain).disabled(loadingOlderHistory || !olderHistoryHasMore)
                .accessibilityIdentifier("chat_history_older")
                .onAppear { if historyPagingArmed && !olderHistoryFailed { Task { await loadOlderHistory() } } }
        }
    }

    @MainActor private func loadOlderHistory() async {
        guard activeChatSession, historyReady, !loadingOlderHistory, olderHistoryHasMore,
              olderHistoryCursor > 0, let token = session.token else { return }
        let current = UUID(); olderHistoryGeneration = current
        let maximum = olderHistoryCursor, cutoff = clearedBeforeMessageID
        let client = APIClient.shared.captureSession()
        loadingOlderHistory = true; olderHistoryFailed = false
        defer { if olderHistoryGeneration == current { loadingOlderHistory = false } }
        do {
            let namespace = client.avatarCacheNamespace
            let local = try? await IOSLocalChatStore.shared.read(namespace, conversation.id, before: maximum, limit: 51)
            let page: IOSChatHistoryPage
            if !client.isGoV2, let local, local.complete || local.items.count >= 51 {
                page = IOSChatHistoryPage(items: Array(local.items.suffix(50)), hasMore: local.items.count > 50 || !local.complete)
            } else {
                let t = try? await IOSLocalChatStore.shared.ticket(namespace, conversation.id)
                page = try await client.historyPage(conversationID: conversation.id, maximumID: maximum)
                if let version = page.membershipVersion, version != goMembershipVersion { throw GoV2Error.membershipChanged }
                if let version = page.membershipVersion { try client.requireGoMembership(conversation.id, version: version) }
                if let t, activeChatSession, session.token == token { try? await IOSLocalChatStore.shared.savePage(t, page: page, maximum: maximum, cutoff: cutoff) }
            }
            guard !Task.isCancelled, activeChatSession, session.token == token,
                  olderHistoryGeneration == current, clearedBeforeMessageID == cutoff else { return }
            // Capture the current row after HTTP; an in-flight read must not undo a user's scroll.
            let anchor = visibleMessageID ?? messages.first?.id
            for message in page.chronological {
                messageVersions[message.id] = MessageReconciliation.preferred(current: messageVersions[message.id], incoming: message, preferIncomingOnEqual: false)
            }
            messages = MessageReconciliation.merge(snapshot: messages, events: Array(messageVersions.values), conversationID: conversation.id, clearedBefore: cutoff)
            olderHistoryCursor = page.nextMaxID; olderHistoryHasMore = page.hasMore
            if #unavailable(iOS 17.0), let anchor { legacyAnchorRestoreID = anchor; legacyAnchorRestoreRequest += 1 }
            await reconcileMessages()
        } catch {
            guard !Task.isCancelled, activeChatSession, session.token == token, olderHistoryGeneration == current else { return }
            if IOSLocalChatAccessDenied.matches(error) { await discardDeniedLocalHistory(client) }
            olderHistoryFailed = true
        }
    }

    @MainActor private func discardDeniedLocalHistory(_ client: APIClient) async {
        guard currentChatSession, client.avatarCacheNamespace == APIClient.shared.avatarCacheNamespace else { return }
        let invalidation = UUID(); loadGeneration = invalidation; loadingHistory = true
        defer { if loadGeneration == invalidation { loadingHistory = false } }
        olderHistoryGeneration = UUID(); loadingOlderHistory = false; cancelReconciliation()
        messages = []; messageVersions = [:]; historyReady = false; historyAccessVerified = false
        goMembershipVersion = nil; clearedBeforeMessageID = 0; deletedMessageIDs = []; readIDs = []; pendingReadIDs = []
        mediaPreview = nil; photoGallery = nil; audioPlayer.stop()
        try? await IOSLocalChatStore.shared.clearConversation(client.avatarCacheNamespace, conversation.id)
        guard currentChatSession, loadGeneration == invalidation, client.avatarCacheNamespace == APIClient.shared.avatarCacheNamespace else { return }
        await IOSLocalMediaCache.shared.clear()
    }

    @MainActor private func load() async {
        guard activeChatSession, !loadingHistory, let token = session.token else { return }
        let current = UUID(); loadGeneration = current
        loadingHistory = true
        defer { if loadGeneration == current { loadingHistory = false } }
        let client = APIClient.shared.captureSession(), namespace = APIClient.shared.avatarCacheNamespace
        await IOSLocalChatStore.shared.bind(namespace)
        if !client.isGoV2, let cached = try? await IOSLocalChatStore.shared.read(namespace, conversation.id, limit: 50), activeChatSession, session.token == token, loadGeneration == current, messages.isEmpty {
            clearedBeforeMessageID = max(clearedBeforeMessageID, cached.cutoff)
            messages = MessageReconciliation.merge(snapshot: cached.items, events: Array(messageVersions.values) + session.confirmedMessageRecalls(conversationID: conversation.id), conversationID: conversation.id, clearedBefore: clearedBeforeMessageID)
            if !messages.isEmpty { historyReady = true; scrollRequest += 1 }
        }
        let localTicket = try? await IOSLocalChatStore.shared.ticket(namespace, conversation.id)
        do {
            let page = try await client.historyPage(conversationID: conversation.id)
            let history = page.chronological
            guard activeChatSession, session.token == token, loadGeneration == current else { return }
            if let version = page.membershipVersion {
                try client.requireGoMembership(conversation.id, version: version)
                do { try await IOSLocalChatStore.shared.authorizeGo(namespace, conversation.id, version: version, cutoff: page.clearedBeforeMessageID ?? 0) }
                catch let error as GoV2Error { throw error }
                catch { /* Optional cache failure must not block freshly authorized network history. */ }
                guard activeChatSession, session.token == token, loadGeneration == current else { return }
                if goMembershipVersion != version {
                    messages = []; messageVersions = [:]; deletedMessageIDs = []; readIDs = []; pendingReadIDs = []
                    clearedBeforeMessageID = page.clearedBeforeMessageID ?? 0
                }
                goMembershipVersion = version; clearedBeforeMessageID = max(clearedBeforeMessageID, page.clearedBeforeMessageID ?? 0)
                if let fresh = try? await IOSLocalChatStore.shared.ticket(namespace, conversation.id) { try? await IOSLocalChatStore.shared.savePage(fresh, page: page, cutoff: clearedBeforeMessageID) }
            } else if let localTicket { try? await IOSLocalChatStore.shared.savePage(localTicket, page: page, cutoff: clearedBeforeMessageID) }
            guard activeChatSession, session.token == token, loadGeneration == current else { return }
            if let version = page.membershipVersion { try client.requireGoMembership(conversation.id, version: version) }
            historyAccessVerified = true
            await IOSLocalChatStore.shared.enqueue(client, conversationID: conversation.id)
            guard activeChatSession, session.token == token, loadGeneration == current else { return }
            if let version = page.membershipVersion { try client.requireGoMembership(conversation.id, version: version) }
            // Socket events and send acknowledgements can arrive before this
            // initial request. Merge them, including tombstones, instead of
            // replacing the screen with an older HTTP response.
            acceptConfirmedRecalls()
            for message in history {
                messageVersions[message.id] = MessageReconciliation.preferred(current: messageVersions[message.id], incoming: message, preferIncomingOnEqual: false)
            }
            messages = MessageReconciliation.merge(snapshot: [], events: Array(messageVersions.values), conversationID: conversation.id, clearedBefore: clearedBeforeMessageID)
            confirmPendingTexts()
            historyReady = true; historyLoadFailed = false
            olderHistoryCursor = page.nextMaxID; olderHistoryHasMore = page.hasMore
            if !messageNavigation.holdsPosition { scrollRequest += 1 }
            queueReadReceipts(messages)
            await reconcileMessages()
        } catch {
            guard activeChatSession, session.token == token, loadGeneration == current, !Task.isCancelled else { return }
            if IOSLocalChatAccessDenied.matches(error) {
                try? await IOSLocalChatStore.shared.clearConversation(namespace, conversation.id)
                await IOSLocalMediaCache.shared.clear(); messages = []; messageVersions = [:]; historyReady = false; historyAccessVerified = false
            }
            if !historyLoadFailed { historyLoadFailed = true; showToast("聊天记录暂未加载，正在自动重试") }
        }
    }

    private func begin(_ type: String, body: [String: Any], client: APIClient, token: String, reply: IOSReplyDraft?, requestID: String = "ios-\(UUID().uuidString)") async {
        guard composerSendAllowed, currentChatSession, session.token == token, client.endpointIdentity == openingEndpoint else { return }
        var payload = body
        // A retry owns the same reply target, body and request ID as its first submission.
        if let reply, reply.message.conversationId == conversation.id { payload["reply_to_id"] = reply.message.id }
        let pending = IOSPendingMessage(client: client, token: token, conversationID: conversation.id, type: type, body: payload, requestID: requestID, replySelectionID: reply?.id)
        pendingSend = pending
        await retryPending()
    }
    private func retryPending() async {
        guard composerSendAllowed, !isSubmitting else { return }
        guard let pending = pendingSend, currentChatSession, session.token == pending.token, pending.client.endpointIdentity == openingEndpoint else { pendingSend = nil; return }
        if pending.type == "shake", session.user?.internalStaff != true || !isPrivate {
            pendingSend = nil; error = "窗口抖动仅限内部人员在私聊中使用。"; return
        }
        let activity = activityGeneration
        func acceptsVoiceResult() -> Bool {
            !["voice", "contact_card"].contains(pending.type) || (activeChatSession && !appLock.isLocked && !session.updateRequired && activityGeneration == activity)
        }
        guard acceptsVoiceResult() else { return }
        isSubmitting = true; isUploading = true; error = ""
        defer { isSubmitting = false; isUploading = false }
        do {
            let message = try await pending.client.sendRawMessage(conversationID: pending.conversationID, type: pending.type, body: pending.body, requestID: pending.requestID)
            if pending.type == "contact_card" {
                guard message.id > 0, message.conversationId == pending.conversationID, message.type == "contact_card", message.senderId == openingActorID,
                      message.body["user_id"]?.intValue == (pending.body["user_id"] as? Int) else { throw APIClientError.invalidResponse }
            }
            guard currentChatSession, session.token == pending.token, pendingSend?.requestID == pending.requestID, acceptsVoiceResult() else { return }
            acceptMessage(message, authoritative: false)
            if pending.type == "text", let sentText = pending.body["text"] as? String, draft.trimmingCharacters(in: .whitespacesAndNewlines) == sentText { draft = "" }
            if let selection = pending.replySelectionID, replyDraft?.id == selection { replyDraft = nil }
            pendingSend = nil
        } catch { if currentChatSession, session.token == pending.token, pendingSend?.requestID == pending.requestID, acceptsVoiceResult() { self.error = "\(error.localizedDescription)\n重试会复用请求编号，避免重复发送。" } }
    }
    private func send() {
        guard composerSendAllowed, activeChatSession, !appLock.isLocked, !session.updateRequired, !isUploading, !isPreparingPhoto, !voiceOwnsComposer, photoSendWork == nil else { return }
        resumeFollowingForUserAction()
        if pendingSend != nil { Task { await retryPending() }; return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, sendVisible, let token = session.token, token == openingToken, let actorID = openingActorID else { return }
        let client = APIClient.shared.captureSession()
        guard client.webSocketToken == token, client.endpointIdentity == openingEndpoint else { return }
        textOutbox.enqueue(client: client, token: token, actorID: actorID, endpoint: openingEndpoint,
            conversationID: conversation.id, text: text, replyToID: replyDraft?.message.id,
            mentionUserIDs: conversation.type == "group" ? selectedMentions.userIDs(in: text) : [], realtime: realtime)
        selectedMentions = IOSGroupMentionSelection()
        draft = ""; replyDraft = nil; scrollRequest += 1
    }
    private var pendingTexts: [IOSTextOutbox.Item] {
        currentChatSession ? textOutbox.pending(token: openingToken, actorID: openingActorID, endpoint: openingEndpoint, conversationID: conversation.id) : []
    }
    private func confirmPendingTexts() {
        for message in messages { textOutbox.confirm(message, token: openingToken, actorID: openingActorID, endpoint: openingEndpoint) }
    }
    private var pendingTextRows: some View {
        let pending = pendingTexts
        let waitingForRetry = pending.first?.phase == .failed
        return ForEach(pending) { item in
            HStack {
                Spacer(minLength: 42)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(item.text).font(.system(size: 16)).foregroundStyle(PulsePalette.ink)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(PulsePalette.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
                    if item.phase == .failed {
                        HStack {
                            Button("发送未确认 · 点击重试") { if currentChatSession, composerSendAllowed { textOutbox.retry(item.id) } }
                                .foregroundStyle(PulsePalette.danger).accessibilityHint(item.error).disabled(!composerSendAllowed)
                            Button("移除") { if currentChatSession { textOutbox.discard(item.id) } }
                                .foregroundStyle(PulsePalette.muted).accessibilityLabel("移除待发送消息")
                        }.font(.caption2)
                    } else {
                        Text(item.phase == .sending ? "发送中…" : waitingForRetry ? "请先重试或移除前一条未确认消息" : "等待发送…").font(.caption2).foregroundStyle(PulsePalette.muted)
                    }
                }
                .modifier(IOSChatTouchExclusion(id: item.id))
            }.id("pending-text-" + item.id)
        }
    }
    private func scrollToLatest(using proxy: ScrollViewProxy) {
        guard !messageNavigation.holdsPosition else { return }
        // Private chats reveal only what is offscreen; visible short histories
        // must not be moved down to align their last row with the input bar.
        let anchor: UnitPoint? = isPrivate ? nil : .bottom
        if let item = pendingTexts.last { proxy.scrollTo("pending-text-" + item.id, anchor: anchor) }
        else if let id = messages.last?.id { proxy.scrollTo(id, anchor: anchor) }
    }
    private func startOrFinishRecording() async {
        guard composerSendAllowed, activeChatSession, !appLock.isLocked, !session.updateRequired,
              session.user?.id == openingActorID, !isUploading, !isSubmitting, !isPreparingPhoto,
              pendingSend == nil, pendingVoice == nil, photoSendWork == nil, !recorder.isStarting,
              conversation.type != "channel" || canPublish else { return }
        if recorder.isRecording { await finishRecording(); return }
        let client = APIClient.shared.captureSession()
        guard client.webSocketToken == openingToken, client.endpointIdentity == openingEndpoint else { return }
        let context = IOSVoiceRecordingContext(client: client, token: openingToken, actorID: openingActorID,
            conversationID: conversation.id, endpoint: openingEndpoint)
        recordingContext = context; recordingReplyDraft = replyDraft
        audioPlayer.stop(); closeChatInput()
        let started = await recorder.startRecording(whenActive: {
            currentVoiceContext(context) && recordingContext?.id == context.id
        })
        guard recordingContext?.id == context.id else { return }
        if !started || !currentVoiceContext(context) {
            recorder.cancelRecording(); recordingContext = nil; recordingReplyDraft = nil
        }
    }
    private func finishRecording() async {
        guard composerSendAllowed, !isUploading, !isSubmitting else { return }
        _ = recorder.stopRecording()
        stageRecordedVoice()
        requestVoiceUpload()
    }
    private func currentVoiceContext(_ context: IOSVoiceRecordingContext) -> Bool {
        composerSendAllowed && activeChatSession && !appLock.isLocked && !session.updateRequired
            && context.token == openingToken && session.user?.id == context.actorID && context.actorID == openingActorID
            && context.endpoint == openingEndpoint && context.client.endpointIdentity == openingEndpoint
            && context.client.webSocketToken == openingToken && context.conversationID == conversation.id
    }
    private func stageRecordedVoice() {
        guard let result = recorder.completedRecording else { return }
        guard let context = recordingContext, currentVoiceContext(context), pendingVoice == nil, pendingSend == nil else {
            recorder.cancelRecording(); recordingContext = nil; recordingReplyDraft = nil; return
        }
        pendingVoice = IOSPendingVoice(recording: result, context: context, reply: recordingReplyDraft,
            requestID: "ios-voice-\(UUID().uuidString)")
        recorder.consumeCompletedRecording(); recordingContext = nil; recordingReplyDraft = nil
    }
    private func cancelVoiceWork(discard: Bool) {
        voiceWorkID = UUID(); recordingContext = nil; recordingReplyDraft = nil
        voiceTransferTask?.cancel(); voiceTransferTask = nil
        recorder.cancelRecording()
        if discard { pendingVoice = nil }
    }
    private func requestVoiceUpload() {
        guard composerSendAllowed, voiceTransferTask == nil, pendingVoice != nil, !isUploading, !isSubmitting else { return }
        let request = UUID(); voiceWorkID = request
        voiceTransferTask = Task {
            await uploadPendingVoice(request: request)
            if voiceWorkID == request { voiceTransferTask = nil }
        }
    }
    private func uploadPendingVoice(request: UUID) async {
        guard !Task.isCancelled, voiceWorkID == request, let pending = pendingVoice, currentVoiceContext(pending.context), !isUploading, !isSubmitting,
              !isPreparingPhoto, !recorder.isRecording, !recorder.isStarting, pendingSend == nil else { return }
        resumeFollowingForUserAction()
        isUploading = true; error = ""
        defer { isUploading = false }
        do {
            let url = try await pending.context.client.uploadVoice(data: pending.recording.data)
            guard !Task.isCancelled, currentVoiceContext(pending.context), voiceWorkID == request, pendingVoice?.id == pending.id else { return }
            pendingVoice = nil
            await begin("voice", body: ["url": url, "duration_ms": pending.recording.durationMilliseconds,
                "size": pending.recording.data.count, "mime": IOSVoiceFileFormat.uploadType(pending.recording.data)?.mime ?? "audio/wav"], client: pending.context.client, token: pending.context.token,
                reply: pending.reply, requestID: pending.requestID)
        } catch {
            guard !Task.isCancelled, currentVoiceContext(pending.context), voiceWorkID == request, pendingVoice?.id == pending.id else { return }
            self.error = "\(error.localizedDescription)\n录音已保留，可重试上传。"
        }
    }
    private func requestPhotoPicker() {
        guard privateMediaActionsEnabled, activeChatSession, !appLock.isLocked, !session.updateRequired else { return }
        closeChatInput(); selectedPhotoProviders = []; selectedPhotoOriginal = false
        if showingActionMenu { photoPickerAfterAttachment = true; showingActionMenu = false }
        else { showingStandardPhotoPicker = true }
    }
    private func photoPickerDismissed() {
        if selectedVideoProvider != nil { selectedPhotoProviders = []; videoPickerDismissed(); return }
        let providers = selectedPhotoProviders; selectedPhotoProviders = []
        let original = selectedPhotoOriginal; selectedPhotoOriginal = false
        guard !providers.isEmpty else { return }
        photoPreparationTask?.cancel()
        photoPreparationTask = Task { await preparePhotoPreview(providers, original: original) }
    }
    private func preparePhotoPreview(_ providers: [IOSChatPhotoSource], original: Bool = false) async {
        guard composerSendAllowed, currentChatSession, pendingPhoto == nil, !isPreparingPhoto, !isUploading, !isSubmitting, !voiceOwnsComposer, pendingSend == nil,
              photoSendWork == nil, !appLock.isLocked, !session.updateRequired, scenePhase != .background,
              let token = session.token, let actor = session.user?.id else { return }
        do {
            let files = try IOSPhotoDraftFiles()
            let sources = Array(providers.prefix(IOSPhotoSelection.limit))
            guard !sources.isEmpty else { return }
            let photos = sources.map { _ in
                let id = UUID()
                return IOSPreparedPhoto(id: id, fileURL: files.directory.appendingPathComponent("\(id.uuidString).jpg"), width: 0, height: 0, original: original)
            }
            let photo = IOSPendingPhotoPreview(photos: photos, files: files, client: APIClient.shared.captureSession(), token: token, actorID: actor, conversationID: conversation.id, reply: replyDraft)
            guard photoPreviewContextCurrent(photo) else { return }
            photoSendWork = IOSPhotoSendWork(preview: photo, queue: IOSPhotoSendQueue<UploadData>(photos: photos),
                sources: Dictionary(uniqueKeysWithValues: zip(photos.map(\.id), sources)))
            resumeFollowingForUserAction()
            startPhotoSending()
        } catch { self.error = error.localizedDescription }
    }
    private func photoPreviewContextCurrent(_ photo: IOSPendingPhotoPreview) -> Bool {
        composerSendAllowed && currentChatSession && scenePhase != .background && !appLock.isLocked && !session.updateRequired && photo.token == session.token && photo.actorID == session.user?.id
            && photo.actorID == openingActorID && photo.conversationID == conversation.id && photo.client.endpointIdentity == openingEndpoint
    }
    private func cancelPhotoPreview() {
        cancelVideoWork()
        photoPreparation = UUID(); photoPreparationTask?.cancel(); photoPreparationTask = nil
        pendingPhoto = nil; selectedPhotoProviders = []; selectedPhotoOriginal = false; isPreparingPhoto = false
        showingStandardPhotoPicker = false; reselectPhotoAfterPreview = false; photoPickerAfterAttachment = false
    }
    private func sendPreviewedPhotos(_ photo: IOSPendingPhotoPreview, selectedIDs: [UUID]) {
        guard pendingPhoto?.id == photo.id else { return }
        guard photoPreviewContextCurrent(photo), !isUploading, !isSubmitting, !voiceOwnsComposer, pendingSend == nil, photoSendWork == nil else { return }
        let selected = photo.photos.filter { selectedIDs.contains($0.id) }
        guard !selected.isEmpty, selected.count == selectedIDs.count, selected.count <= IOSPhotoSelection.limit else { return }
        photoSendWork = IOSPhotoSendWork(preview: photo, queue: IOSPhotoSendQueue<UploadData>(photos: selected))
        resumeFollowingForUserAction()
        pendingPhoto = nil // Start only from the preview's onDismiss.
    }
    private func startPhotoSending() {
        guard photoSendTask == nil, let work = photoSendWork, photoPreviewContextCurrent(work.preview), !isSubmitting, !isUploading else { return }
        error = ""; isUploading = true
        photoSendTask = Task {
            defer {
                if photoSendWork?.id == work.id { isUploading = false; photoSendTask = nil }
            }
            func current() -> Bool { photoSendWork?.id == work.id && photoPreviewContextCurrent(work.preview) }
            do {
                try await work.queue.run(current: current, upload: { photo in
                    guard current() else { throw CancellationError() }
                    let prepared: IOSPreparedPhoto
                    if let cached = work.prepared[photo.id] { prepared = cached }
                    else if let source = work.sources[photo.id] {
                        prepared = try await IOSPhotoPreparation.prepare(source, files: work.preview.files, id: photo.id, original: photo.original)
                        guard current() else { throw CancellationError() }
                        work.prepared[photo.id] = prepared
                    } else { prepared = photo }
                    let data = try Data(contentsOf: prepared.fileURL, options: .mappedIfSafe)
                    return try await work.preview.client.uploadMedia(data: data, kind: "image", filename: prepared.fileURL.lastPathComponent, mime: prepared.mime, original: prepared.original)
                }, send: { photo, upload, index in
                    let prepared = work.prepared[photo.id] ?? photo
                    var body: [String: Any] = ["url": upload.url, "mime": upload.mime ?? prepared.mime, "size": upload.size ?? 0, "width": prepared.width, "height": prepared.height, "original": prepared.original]
                    if index == 0, let reply = work.preview.reply, reply.message.conversationId == conversation.id { body["reply_to_id"] = reply.message.id }
                    return try await work.preview.client.sendRawMessage(conversationID: work.preview.conversationID, type: "image", body: body, requestID: photo.requestID)
                }, accepted: { message, index in
                    guard message.id > 0, message.conversationId == work.preview.conversationID,
                          message.type == "image", message.senderId == work.preview.actorID else { throw APIClientError.invalidResponse }
                    acceptMessage(message, authoritative: false)
                    if index == 0, let reply = work.preview.reply, replyDraft?.id == reply.id { replyDraft = nil }
                    session.conversationDidChange()
                }, progress: { sent, total in
                    if current() { photoSendProgress = "正在发送图片 \(min(sent + 1, total))/\(total)" }
                })
                if current(), work.queue.completed {
                    isUploading = false; photoSendWork = nil; photoSendTask = nil; photoSendProgress = ""
                    showToast("已发送 \(work.queue.photos.count) 张图片")
                }
            } catch {
                if error is CancellationError || !current() {
                    if photoSendWork?.id == work.id { cancelPhotoSending() }
                } else {
                    photoSendProgress = "已发送 \(work.queue.nextIndex)/\(work.queue.photos.count) 张，余下图片待重试"
                    self.error = "\(error.localizedDescription)\n已发送的图片不会重复发送，可重试余下图片。"
                }
            }
        }
    }
    private func cancelPhotoSending() {
        guard let work = photoSendWork else { return }
        work.queue.stop(); photoSendTask?.cancel(); photoSendTask = nil
        photoSendWork = nil; photoSendProgress = ""; isUploading = false
    }
    private func requestVideoPicker() {
        guard privateMediaActionsEnabled, activeChatSession, !appLock.isLocked, !session.updateRequired else { return }
        closeChatInput(); selectedVideoProvider = nil; videoSendError = ""
        if showingActionMenu { videoPickerAfterAttachment = true; showingActionMenu = false }
        else { showingVideoPicker = true }
    }
    private func videoPickerDismissed() {
        guard let provider = selectedVideoProvider else { return }
        selectedVideoProvider = nil
        guard privateMediaActionsEnabled, activeChatSession, !appLock.isLocked, !session.updateRequired,
              let token = session.token, let actor = session.user?.id else { return }
        let operation = UUID(), client = APIClient.shared.captureSession(), reply = replyDraft
        videoOperation = operation; isPreparingVideo = true; videoSendError = ""
        videoWorkTask = Task {
            defer { if videoOperation == operation { isPreparingVideo = false; videoWorkTask = nil } }
            do {
                let video = try await IOSVideoPreparation.prepare(provider)
                let draft = IOSPendingVideoSend(video: video, client: client, token: token, actorID: actor, conversationID: conversation.id, reply: reply)
                guard !Task.isCancelled, videoOperation == operation, videoContextCurrent(draft) else { return }
                pendingVideoSend = draft
            } catch {
                if !(error is CancellationError), videoOperation == operation, activeChatSession, session.token == token,
                   session.user?.id == actor, client.endpointIdentity == openingEndpoint { self.error = error.localizedDescription }
            }
        }
    }
    private func videoContextCurrent(_ draft: IOSPendingVideoSend) -> Bool {
        composerSendAllowed && activeChatSession && !appLock.isLocked && !session.updateRequired && draft.token == session.token
            && draft.actorID == session.user?.id && draft.actorID == openingActorID
            && draft.conversationID == conversation.id && draft.client.endpointIdentity == openingEndpoint
    }
    private func uploadSelectedVideo(_ draft: IOSPendingVideoSend) {
        guard pendingVideoSend?.id == draft.id, videoContextCurrent(draft), !isUploading, !isSubmitting,
              !voiceOwnsComposer, pendingSend == nil else { return }
        let operation = videoOperation
        isUploading = true; videoSendError = ""
        videoWorkTask = Task {
            defer { if videoOperation == operation { isUploading = false; videoWorkTask = nil } }
            do {
                let data = try await IOSVideoPreparation.data(draft.video)
                guard !Task.isCancelled, videoOperation == operation, videoContextCurrent(draft) else { return }
                let upload = try await draft.client.uploadMedia(data: data, kind: "video", filename: draft.video.fileURL.lastPathComponent, mime: draft.video.mime)
                guard !Task.isCancelled, videoOperation == operation, videoContextCurrent(draft) else { return }
                uploadedVideoToCommit = IOSUploadedVideoSend(draft: draft, upload: upload)
                pendingVideoSend = nil
            } catch {
                if !(error is CancellationError), videoOperation == operation, videoContextCurrent(draft) { videoSendError = error.localizedDescription }
            }
        }
    }
    private func commitSelectedVideoIfReady() {
        guard let ready = uploadedVideoToCommit else { return }
        uploadedVideoToCommit = nil
        guard videoContextCurrent(ready.draft), !isSubmitting, pendingSend == nil else { return }
        let operation = videoOperation
        isUploading = true
        videoWorkTask = Task {
            defer { if videoOperation == operation { isUploading = false; videoWorkTask = nil } }
            guard !Task.isCancelled, videoOperation == operation, videoContextCurrent(ready.draft) else { return }
            resumeFollowingForUserAction()
            await begin("video", body: ["url": ready.upload.url, "mime": ready.upload.mime, "size": ready.upload.size,
                "name": ready.draft.video.fileURL.lastPathComponent], client: ready.draft.client, token: ready.draft.token,
                reply: ready.draft.reply, requestID: "ios-video-\(ready.draft.id.uuidString)")
        }
    }
    private func cancelVideoWork() {
        let owned = videoWorkTask != nil || pendingVideoSend != nil || uploadedVideoToCommit != nil || isPreparingVideo
        videoOperation = UUID(); videoWorkTask?.cancel(); videoWorkTask = nil
        selectedVideoProvider = nil; showingVideoPicker = false; videoPickerAfterAttachment = false
        pendingVideoSend = nil; uploadedVideoToCommit = nil; isPreparingVideo = false; videoSendError = ""
        if owned { isUploading = false }
    }
    private func uploadImage(_ image: UIImage, client captured: APIClient? = nil, token capturedToken: String? = nil, reply: IOSReplyDraft?) async {
        guard let data = image.jpegData(compressionQuality: 0.85), let token = capturedToken ?? session.token else { return }
        let client = captured ?? APIClient.shared.captureSession()
        guard composerSendAllowed, currentChatSession, session.token == token, token == openingToken, client.endpointIdentity == openingEndpoint, !appLock.isLocked, !session.updateRequired, !isUploading else { return }
        isUploading = true
        defer { isUploading = false }
        do {
            let upload = try await client.uploadMedia(data: data, kind: "image", filename: "image-\(UUID().uuidString).jpg", mime: "image/jpeg")
            await begin("image", body: ["url": upload.url, "mime": upload.mime, "size": upload.size], client: client, token: token, reply: reply)
        } catch { if sendVisible, session.token == token { self.error = error.localizedDescription } }
    }
    private func importFile(_ result: Result<[URL], Error>, kind: String) async {
        guard composerSendAllowed, let token = session.token, token == openingToken, sendVisible, !isUploading, !isPreparingPhoto, !isSubmitting, !voiceOwnsComposer, pendingSend == nil else { return }
        let client = APIClient.shared.captureSession()
        let reply = replyDraft
        isUploading = true; defer { isUploading = false }
        do {
            guard let url = try result.get().first else { return }
            resumeFollowingForUserAction()
            let secured = url.startAccessingSecurityScopedResource(); defer { if secured { url.stopAccessingSecurityScopedResource() } }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if kind == "video", !mime.hasPrefix("video/") { error = "请选择视频文件"; return }
            let limit = (kind == "video" ? 100 : 50) * 1024 * 1024
            if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > limit { error = kind == "video" ? "视频文件不能超过100MB" : "文件不能超过50MB"; return }
            let data = try Data(contentsOf: url)
            let upload = try await client.uploadMedia(data: data, kind: kind, filename: url.lastPathComponent, mime: mime)
            await begin(kind, body: ["url": upload.url, "mime": upload.mime, "size": upload.size, "name": url.lastPathComponent], client: client, token: token, reply: reply)
        } catch { if sendVisible, session.token == token { self.error = error.localizedDescription } }
    }

    private func openCamera() {
        guard privateMediaActionsEnabled else { return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { error = "当前设备没有可用摄像头"; return }
        showingCamera = true
    }

    private func openFavorites() {
        guard sendVisible, let token = session.token, token == openingToken else { return }
        let client = APIClient.shared.captureSession()
        Task {
            do {
                let favorite = try await client.favoriteConversation()
                guard sendVisible, session.token == token else { return }
                favoriteConversation = favorite
            } catch { if sendVisible, session.token == token { self.error = error.localizedDescription } }
        }
    }

    private func sendShake() {
        guard isPrivate, session.user?.internalStaff == true else { showToast("窗口抖动仅限内部人员在私聊中使用"); return }
        guard currentChatSession, !isUploading, !isSubmitting, !voiceOwnsComposer, pendingSend == nil, let token = session.token else { return }
        resumeFollowingForUserAction()
        let client = APIClient.shared.captureSession()
        let reply = replyDraft
        Task {
            await begin("shake", body: ["text": "窗口抖动"], client: client, token: token, reply: reply)
            if currentChatSession, pendingSend == nil, error.isEmpty {
                withAnimation(.linear(duration: 0.55)) { shakePhase += 1 }
                showToast("已发送窗口抖动")
            }
        }
    }
    private func contactCardContextCurrent(_ value: IOSContactCardPresentation) -> Bool {
        composerSendAllowed && activeChatSession && !appLock.isLocked && !session.updateRequired && activityGeneration == value.activity
            && session.user?.id == value.actorID && openingActorID == value.actorID && value.token == openingToken
            && value.client.endpointIdentity == openingEndpoint && value.client.webSocketToken == openingToken
            && (conversation.type != "channel" || canPublish)
    }
    private func openContactCardPicker() {
        guard privateMediaActionsEnabled, activeChatSession, !appLock.isLocked, !session.updateRequired,
              contactCardPicker == nil, pendingContactCardPicker == nil, let actorID = openingActorID,
              conversation.type != "channel" || canPublish else { return }
        let value = IOSContactCardPresentation(client: APIClient.shared.captureSession(), token: openingToken, actorID: actorID,
            activity: activityGeneration, reply: replyDraft)
        closeChatInput()
        if showingActionMenu { pendingContactCardPicker = value; showingActionMenu = false }
        else { contactCardPicker = value }
    }
    private func attachmentSheetDismissed() {
        if videoPickerAfterAttachment {
            videoPickerAfterAttachment = false
            if privateMediaActionsEnabled, !appLock.isLocked, !session.updateRequired { showingVideoPicker = true }
        }
        if photoPickerAfterAttachment {
            photoPickerAfterAttachment = false
            if privateMediaActionsEnabled, !appLock.isLocked, !session.updateRequired { showingStandardPhotoPicker = true }
        }
        if let value = pendingContactCardPicker { pendingContactCardPicker = nil; if contactCardContextCurrent(value) { contactCardPicker = value } }
        groupSheetDismissed(.attachments)
    }
    private func sendContactCard(_ contact: Contact, presentation: IOSContactCardPresentation) {
        guard contactCardPicker?.id == presentation.id, contactCardContextCurrent(presentation), privateMediaActionsEnabled,
              contact.userId > 0, contact.userId != presentation.actorID else { return }
        contactCardPicker = nil
        resumeFollowingForUserAction()
        Task {
            guard contactCardContextCurrent(presentation) else { return }
            await begin("contact_card", body: ["user_id": contact.userId], client: presentation.client, token: presentation.token,
                reply: presentation.reply, requestID: "ios-card-\(presentation.id.uuidString)")
            if contactCardContextCurrent(presentation), pendingSend == nil, error.isEmpty { showToast("名片已发送") }
        }
    }

    private func favorite(_ message: Message) async {
        guard sendVisible, let token = session.token, token == openingToken else { return }
        let client = APIClient.shared.captureSession()
        do {
            let favorite = try await client.favoriteConversation()
            guard sendVisible, session.token == token else { return }
            var body = message.body.mapValues { $0.anyValue }
            body.removeValue(forKey: "reply_to_id"); body.removeValue(forKey: "reply_to")
            if message.type == "text" && body["text"] == nil { body["text"] = "收藏消息" }
            _ = try await client.sendRawMessage(conversationID: favorite.id, type: message.type, body: body)
            guard sendVisible, session.token == token else { return }
            showToast("已收藏到我的收藏")
        } catch { if sendVisible, session.token == token { self.error = error.localizedDescription } }
    }

    private func toggleNotifications() {
        guard activeChatSession, !updatingChatNotifications, let token = session.token, token == openingToken else { return }
        let client = APIClient.shared.captureSession()
        let next = !isMuted
        isMuted = next; updatingChatNotifications = true
        Task {
            defer { updatingChatNotifications = false }
            do {
                _ = try await client.updateConversationNotification(conversationID: conversation.id, muted: next)
                guard currentChatSession, session.token == token, session.user?.id == openingActorID else { return }
                session.conversationDidChange()
                showToast(next ? "已关闭通知" : "已开启通知")
            } catch { if currentChatSession, session.token == token, session.user?.id == openingActorID { isMuted = !next; self.error = error.localizedDescription } }
        }
    }

    private func recall(_ message: Message) async {
        guard currentChatSession, sendVisible, session.user?.internalStaff == true,
              let token = session.token, token == openingToken, message.conversationId == conversation.id,
              message.id > 0, !recallingMessageIDs.contains(message.id),
              messages.contains(where: { $0.id == message.id && $0.recalledAt == nil && $0.status != "recalled" }) else { return }
        let client = APIClient.shared.captureSession()
        guard client.webSocketToken == token, client.endpointIdentity == openingEndpoint else { return }
        recallingMessageIDs.insert(message.id)
        defer { recallingMessageIDs.remove(message.id) }
        do {
            // The menu already checked /auth/me. The mutation endpoint checks the
            // current permission again in its transaction, without another GET.
            try await client.recallMessage(message)
            session.confirmMessageRecall(MessageReconciliation.tombstone(message), client: client, actorID: openingActorID)
            guard currentChatSession, sendVisible, session.token == token else { return }
            acceptMessage(MessageReconciliation.tombstone(message), persistLocally: false)
        } catch {
            // A realtime recall can be confirmed before its HTTP reply is lost.
            if currentChatSession, sendVisible, session.token == token,
               messageVersions[message.id]?.recalledAt == nil, messageVersions[message.id]?.status != "recalled" {
                self.error = error.localizedDescription
            }
        }
    }

    private func showToast(_ value: String) {
        withAnimation { toast = value }
        Task { try? await Task.sleep(for: .seconds(2)); await MainActor.run { withAnimation { toast = "" } } }
    }

    private var peerOnlineStatusText: String {
        if peerOnline == true { return "在线" }
        if let lastSeenAt = peerLastSeenAt, let formatted = formatLastSeen(lastSeenAt) {
            return "\(formatted) 在线"
        }
        if peerOnline == false { return "最近在线时间未知" }
        return "状态未知"
    }

    private var groupMemberText: String {
        groupMemberCount.map { "\($0) 位成员" } ?? "成员数量加载中"
    }

    private func requestGroupMetadata(openNotice: Bool = false) {
        guard activeGroupNoticeSession, let actorID = openingActorID else { return }
        groupMetadataTask?.cancel()
        sendPermissionTask?.cancel(); sendPermissionTask = nil
        let permissionRequest = composerAuthorization.beginRefresh()
        lastSendPermissionAt = ProcessInfo.processInfo.systemUptime
        let request = UUID(); groupMetadataRequest = request
        let context = IOSGroupNoticeContext(entryID: groupEntryID, activityID: activityGeneration,
            requestID: request, conversationID: conversation.id, actorID: actorID,
            token: openingToken, endpoint: openingEndpoint)
        groupNoticeContext = nil; groupNoticePopup = nil
        groupViewerRole = nil; goMemberNames = [:]
        let client = APIClient.shared.captureSession()
        guard client.endpointIdentity == openingEndpoint, client.webSocketToken == openingToken else { return }
        // Reuse the existing profile call for both member count and notice. No
        // notice polling or dependency is added to message send/history work.
        groupMetadataTask = Task {
            defer { if groupMetadataRequest == request { groupMetadataTask = nil } }
            do {
                let profile = try await client.groupProfile(id: conversation.id)
                guard !Task.isCancelled, isCurrentGroupNoticeContext(context), profile.conversationId == conversation.id else { return }
                groupMemberCount = profile.memberCount
                groupViewerRole = profile.myRole
                applyComposerAuthorization(profile.sendPermission, request: permissionRequest)
                let content = (profile.announcement ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if content != groupNoticeText { closedGroupNotice = nil }
                groupNoticeText = content; groupNoticeContext = context
                if client.isGoV2 {
                    let members = try await client.conversationMembers(id: conversation.id)
                    guard !Task.isCancelled, isCurrentGroupNoticeContext(context) else { return }
                    goMemberNames = Dictionary(members.map { ($0.userId, $0.nickname) }, uniquingKeysWith: { first, _ in first })
                }
                guard !content.isEmpty, !groupNoticeModalBlocked,
                      openNotice || mayAutomaticallyPresentGroupNotice else { return }
                groupNoticePopup = IOSGroupNoticePresentation(context: context, content: content, automatic: !openNotice)
            } catch {
                guard !Task.isCancelled, isCurrentGroupNoticeContext(context) else { return }
                groupNoticeContext = nil; groupNoticePopup = nil
                if openNotice, !groupNoticeModalBlocked { showToast("群公告加载失败，请稍后重试") }
            }
        }
    }

    private func formatLastSeen(_ value: String) -> String? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        guard let date = formatter.date(from: value) else { return nil }
        let calendar = Calendar.current
        let timeFormatter = DateFormatter()
        timeFormatter.locale = Locale(identifier: "zh_CN")
        timeFormatter.dateFormat = "HH:mm"
        if calendar.isDateInToday(date) { return "今天 \(timeFormatter.string(from: date))" }
        if calendar.isDateInYesterday(date) { return "昨天 \(timeFormatter.string(from: date))" }
        timeFormatter.dateFormat = "M月d日 HH:mm"
        return timeFormatter.string(from: date)
    }

    private func timeText(_ value: String) -> String { IOSChatMessageDisplay.timeLabel(value) }
    private func voiceSeconds(_ message: Message) -> Int { max(1, Int((message.body["duration_ms"]?.intValue ?? 1000) / 1000)) }
    private func formatDuration(_ milliseconds: Int) -> String { String(format: "%02d:%02d", milliseconds / 60000, (milliseconds / 1000) % 60) }
}

private enum IOSGroupChatSheet: Hashable {
    case pins, media, attachments, camera, editing, favorites, groupInfo, search, memberProfile, forwarding, contactCards, receivedContactCard, photoSend
}

private struct IOSPendingVideoSend: Identifiable {
    let id = UUID()
    let video: IOSPreparedVideo
    let client: APIClient
    let token: String
    let actorID: Int
    let conversationID: Int
    let reply: IOSReplyDraft?
}
private struct IOSUploadedVideoSend {
    let draft: IOSPendingVideoSend
    let upload: UploadData
}
private struct IOSSelectedVideoPreview: View {
    let video: IOSPreparedVideo
    let sending: Bool
    let error: String
    let onCancel: () -> Void
    let onSend: () -> Void
    @State private var player: AVPlayer?
    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Button("取消", action: onCancel).frame(minWidth: 48, minHeight: 44)
                Spacer(); Text("视频预览").font(.headline); Spacer()
                Button(error.isEmpty ? "发送" : "重试发送", action: onSend)
                    .frame(minWidth: 48, minHeight: 44).disabled(sending)
            }.padding(.horizontal)
            VideoPlayer(player: player).frame(maxWidth: .infinity, maxHeight: .infinity)
            if sending { ProgressView("正在发送视频…") }
            if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal) }
            Text("视频单独发送，最大100MB").font(.footnote).foregroundStyle(.secondary).padding(.bottom)
        }
        .onAppear { player = AVPlayer(url: video.fileURL); player?.play() }
        .onDisappear { player?.pause(); player = nil }
    }
}

private struct IOSPendingPhotoPreview: Identifiable {
    let id = UUID()
    let photos: [IOSPreparedPhoto]
    let files: IOSPhotoDraftFiles
    let client: APIClient
    let token: String
    let actorID: Int
    let conversationID: Int
    let reply: IOSReplyDraft?
}

@MainActor private final class IOSPhotoSendWork: Identifiable {
    let id = UUID()
    let preview: IOSPendingPhotoPreview
    let queue: IOSPhotoSendQueue<UploadData>
    let sources: [UUID: IOSChatPhotoSource]
    var prepared: [UUID: IOSPreparedPhoto] = [:]
    init(preview: IOSPendingPhotoPreview, queue: IOSPhotoSendQueue<UploadData>, sources: [UUID: IOSChatPhotoSource] = [:]) {
        self.preview = preview; self.queue = queue; self.sources = sources
    }
}

private struct IOSContactCardPresentation: Identifiable {
    let id = UUID()
    let client: APIClient
    let token: String
    let actorID: Int
    let activity: UUID
    let reply: IOSReplyDraft?
}

private struct IOSReceivedContactCardPresentation: Identifiable {
    let id = UUID()
    let target: IOSReceivedContactCardTarget
    let client: APIClient
    let actorID: Int
}

private struct IOSGroupNoticeContext: Equatable {
    let entryID: UUID
    let activityID: UUID
    let requestID: UUID
    let conversationID: Int
    let actorID: Int
    let token: String
    let endpoint: String
}

private struct IOSGroupNoticePresentation: Identifiable {
    let id = UUID()
    let context: IOSGroupNoticeContext
    let content: String
    let automatic: Bool
}

private struct IOSGroupNoticeBar: View {
    let content: String
    let animate: Bool
    let onOpen: () -> Void
    let onClose: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onOpen) {
                HStack(spacing: 9) {
                    Image(systemName: "megaphone.fill").font(.system(size: 16)).accessibilityHidden(true)
                    IOSGroupNoticeSummary(content: content, active: animate)
                        .accessibilityHidden(true)
                }
                .padding(.leading, 14).padding(.trailing, 8)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: "群公告：" + content))
            .accessibilityHint("查看完整群公告")
            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("关闭本次群公告条")
        }
        .foregroundStyle(colorScheme == .dark ? Color(red: 1, green: 0.87, blue: 0.46) : Color(red: 0.50, green: 0.32, blue: 0.02))
        .background(colorScheme == .dark ? Color(red: 0.29, green: 0.24, blue: 0.08) : Color(red: 1, green: 0.95, blue: 0.77))
    }
}

private struct IOSGroupNoticeSummary: View {
    let content: String
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14
    @State private var textWidth: CGFloat = 0
    @State private var motionStart = Date()

    private var summary: String { content.components(separatedBy: .newlines).filter { !$0.isEmpty }.joined(separator: " ") }
    var body: some View {
        GeometryReader { geometry in
            let moving = active && !reduceMotion && !voiceOverEnabled && textWidth > geometry.size.width + 1
            let summaryText = Text(verbatim: summary).font(.system(size: fontSize))
            ZStack(alignment: .leading) {
                // Measure the actual Dynamic Type text, independent of clipping.
                summaryText.fixedSize().hidden()
                    .background { GeometryReader { size in Color.clear.preference(key: IOSGroupNoticeTextWidthKey.self, value: size.size.width) } }
                    .accessibilityHidden(true)
                if moving {
                    TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
                        let distance = max(1, textWidth + 48)
                        let elapsed = max(0, timeline.date.timeIntervalSince(motionStart) - 1.5)
                        let offset = CGFloat(elapsed * 28).truncatingRemainder(dividingBy: distance)
                        HStack(spacing: 48) { summaryText; summaryText }
                            .fixedSize().offset(x: -offset)
                            .frame(width: geometry.size.width, alignment: .leading)
                    }
                    .accessibilityHidden(true)
                } else {
                    summaryText.lineLimit(1).truncationMode(.tail)
                        .frame(width: geometry.size.width, alignment: .leading)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
            .clipped()
            .onPreferenceChange(IOSGroupNoticeTextWidthKey.self) { textWidth = $0 }
            .pulseOnChange(of: moving) { _ in motionStart = Date() }
            .onAppear { motionStart = Date() }
        }
        .frame(height: max(22, fontSize * 1.5))
    }
}

private struct IOSGroupNoticeTextWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct IOSGroupNoticeDialog: View {
    let content: String
    let onPresented: () -> Void
    let onConfirm: () -> Void
    @AccessibilityFocusState private var titleFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.42).ignoresSafeArea().contentShape(Rectangle()).onTapGesture { }
                    .accessibilityHidden(true)
                VStack(spacing: 0) {
                    Text("群公告").font(.headline).padding(18)
                        .accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
                    ScrollView {
                        Text(verbatim: content).font(.body).lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled).padding(.horizontal, 20).padding(.bottom, 20)
                    }
                    .layoutPriority(-1)
                    Divider()
                    Button(action: onConfirm) {
                        Text("确认").font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain).foregroundStyle(PulsePalette.accent).padding(.horizontal, 12).padding(.vertical, 8)
                }
                .frame(width: min(400, max(0, geometry.size.width - 32)))
                .frame(maxHeight: min(520, max(0, geometry.size.height - 32)))
                .foregroundStyle(Color.primary).background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 16))
                .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape, onConfirm)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { onPresented(); titleFocused = true }
    }
}

private struct MessageJumpHighlight: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: 14).fill(PulsePalette.accent.opacity(active ? 0.13 : 0)))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(PulsePalette.accent.opacity(active ? 0.65 : 0), lineWidth: 2).allowsHitTesting(false) }
            .animation(.easeOut(duration: 0.2), value: active)
            .accessibilityValue(active ? "已定位的消息" : "")
    }
}

private struct IOSLegacyMessageFramesKey: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

private struct IOSLegacyMessageFrame: ViewModifier {
    let messageID: Int
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 17.0, *) { content }
        else {
            content.background {
                GeometryReader { geometry in
                    Color.clear.preference(key: IOSLegacyMessageFramesKey.self,
                        value: [messageID: geometry.frame(in: .named("chatMessages"))])
                }
            }
        }
    }
}

private struct IOSChatScrollTargetLayout: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 17.0, *) { content.scrollTargetLayout() }
        else { content }
    }
}

private struct IOSChatScrollPosition: ViewModifier {
    @Binding var visibleMessageID: Int?
    let viewportHeight: CGFloat
    let restoreID: Int?
    let restoreRequest: Int
    let proxy: ScrollViewProxy
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.scrollPosition(id: $visibleMessageID, anchor: .top)
        } else {
            content.onPreferenceChange(IOSLegacyMessageFramesKey.self) { frames in
                if let id = IOSLegacyChatViewport.firstVisibleMessage(frames: frames, height: viewportHeight), id != visibleMessageID {
                    visibleMessageID = id
                }
            }.onChange(of: restoreRequest) { _ in
                // Only an explicit restore request scrolls. Merely tracking the
                // visible row must never snap a person back while they drag.
                if let restoreID { proxy.scrollTo(restoreID, anchor: .top) }
            }
        }
    }
}

private struct ChatBottomPositionKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ChatViewportHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ChatViewportTracking: ViewModifier {
    @Binding var bottomY: CGFloat
    @Binding var viewportHeight: CGFloat
    func body(content: Content) -> some View {
        content.coordinateSpace(name: "chatMessages")
            .background { GeometryReader { geometry in Color.clear.preference(key: ChatViewportHeightKey.self, value: geometry.size.height) } }
            .onPreferenceChange(ChatBottomPositionKey.self) { bottomY = $0 }
            .onPreferenceChange(ChatViewportHeightKey.self) { viewportHeight = $0 }
    }
}

private struct IOSPendingMessage {
    let client: APIClient
    let token: String
    let conversationID: Int
    let type: String
    let body: [String: Any]
    let requestID: String
    let replySelectionID: UUID?
}

private struct IOSVoiceRecordingContext {
    let id = UUID()
    let client: APIClient
    let token: String
    let actorID: Int?
    let conversationID: Int
    let endpoint: String
}

private struct IOSPendingVoice: Identifiable {
    let id = UUID()
    let recording: IOSRecordedVoice
    let context: IOSVoiceRecordingContext
    let reply: IOSReplyDraft?
    let requestID: String
}

private struct IOSReplyDraft {
    let id = UUID()
    let message: Message
}

struct IOSMediaPreview: Identifiable {
    let id = UUID()
    let messageID: Int
    let conversationID: Int
    let rawURL: String
    let name: String
    let type: String
    let client: APIClient
    let token: String
}

struct IOSMessageAttachmentPreview: View {
    let preview: IOSMediaPreview
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    @State private var player: AVPlayer?
    @State private var failure = ""
    @State private var attempt = 0

    var body: some View {
        PulseNavigationStack {
            Group {
                if let localURL {
                    if preview.type == "video" {
                        VideoPlayer(player: player).onAppear { player?.play() }
                    } else { IOSQuickLookPreview(url: localURL) }
                } else if !failure.isEmpty {
                    VStack(spacing: 16) { Text(failure).multilineTextAlignment(.center); Button("重新加载") { attempt += 1 } }.padding(24)
                } else { ProgressView("正在加载附件…") }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(preview.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { if let localURL { ShareLink(item: localURL) { Image(systemName: "square.and.arrow.up") } } }
            }
        }
        .task(id: attempt) {
            failure = ""
            guard current else { dismiss(); return }
            do {
                let file: URL
                if preview.type == "video" {
                    let page = try await preview.client.locateMessage(conversationID: preview.conversationID, messageID: preview.messageID)
                    guard current, !Task.isCancelled else { return }
                    guard page.targetId == preview.messageID,
                          let message = page.items.first(where: { $0.id == preview.messageID && $0.conversationId == preview.conversationID }),
                          let source = IOSChatMediaDescriptor(message: message), source.kind == .video else { throw IOSChatMediaFailure.unavailable }
                    file = try await IOSChatMediaLoader.load(source: source, current: { current }, operation: { item in
                        try await preview.client.downloadMedia(item.rawURL, fileName: preview.name)
                    }, refresh: {
                        let renewed = try await preview.client.locateMessage(conversationID: preview.conversationID, messageID: preview.messageID)
                        return try source.refreshed(from: renewed)
                    }, discard: { APIClient.removeDownloadedMedia(at: $0) })
                } else { file = try await preview.client.downloadMedia(preview.rawURL, fileName: preview.name) }
                guard !Task.isCancelled, current else { APIClient.removeDownloadedMedia(at: file); return }
                localURL = file
                if preview.type == "video" { player = AVPlayer(url: file) }
            } catch {
                if !Task.isCancelled, current { failure = error.localizedDescription }
            }
        }
        .pulseOnChange(of: session.token) { token in if token != preview.token { dismiss() } }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { dismiss() } }
        .pulseOnChange(of: session.updateRequired) { required in if required { dismiss() } }
        .onDisappear { player?.pause(); player = nil; if let localURL { APIClient.removeDownloadedMedia(at: localURL) }; localURL = nil }
    }
    private var current: Bool { session.token == preview.token && preview.client.endpointIdentity == APIClient.shared.endpointIdentity && !appLock.isLocked && !session.updateRequired }
}

private struct IOSQuickLookPreview: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url { context.coordinator.url = url; controller.reloadData() }
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

private struct IOSMessageActionFrameKey: PreferenceKey {
    static let defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, new in new }) }
}
private struct IOSMessageMenuRow: Identifiable {
    let key: String
    let label: String
    let icon: String
    var enabled = true
    var id: String { key }
}
private struct IOSMessageMenuCard: View {
    let rows: [IOSMessageMenuRow]
    let timestamp: String
    let onPick: (String) -> Void
    private var displayTime: String {
        let parser = DateFormatter(); parser.locale = Locale(identifier: "zh_CN"); parser.dateFormat = "yyyy-MM-dd HH:mm:ss"
        guard let date = parser.date(from: timestamp) else { return "" }
        let clock = DateFormatter(); clock.locale = Locale(identifier: "zh_CN"); clock.dateFormat = "HH:mm"
        let calendar = Calendar.current
        let day: String
        if calendar.isDateInToday(date) { day = "今天" }
        else if calendar.isDateInYesterday(date) { day = "昨天" }
        else { parser.dateFormat = "yyyy/M/d"; day = parser.string(from: date) }
        return day + " " + clock.string(from: date)
    }
    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                Button { onPick(row.key) } label: {
                    HStack(spacing: 18) {
                        Image(systemName: row.icon).font(.system(size: 17, weight: .regular)).frame(width: 18, height: 18)
                        Text(row.label).font(.system(size: 13)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.horizontal, 14).frame(height: 40).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(!row.enabled).opacity(row.enabled ? 1 : 0.4)
            }
            Rectangle().fill(Color.primary.opacity(0.06)).frame(height: 6).padding(.top, 4)
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath").font(.system(size: 17)).frame(width: 18)
                Text(displayTime).font(.system(size: 12)); Spacer(minLength: 0)
            }.padding(.horizontal, 8).frame(height: 34)
        }.padding(.vertical, 4).foregroundStyle(PulsePalette.ink).background(PulsePalette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 7)).shadow(color: .black.opacity(0.2), radius: 9, y: 3)
    }
}


private struct IOSChatTouchFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

private struct IOSChatTouchExclusion: ViewModifier {
    let id: String
    func body(content: Content) -> some View {
        content.background {
            GeometryReader { proxy in
                Color.clear.preference(key: IOSChatTouchFramesKey.self,
                    value: [id: proxy.frame(in: .named("chatTouchContent"))])
            }.allowsHitTesting(false)
        }
    }
}

private struct IOSChatTouchSurface: ViewModifier {
    let protectedFrames: [CGRect]
    let enabled: Bool
    let onDismiss: () -> Void
    func body(content: Content) -> some View {
        content.coordinateSpace(name: "chatTouchContent")
            .background { IOSChatBlankTapSurface(protectedFrames: protectedFrames, enabled: enabled, onDismiss: onDismiss) }
    }
}

/// Installs one recognizer on this chat's scroll view. The probe never covers
/// controls, and message/avatar rectangles are rejected before recognition.
@MainActor private struct IOSChatBlankTapSurface: UIViewRepresentable {
    let protectedFrames: [CGRect]
    let enabled: Bool
    let onDismiss: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> IOSChatTouchProbe {
        let view = IOSChatTouchProbe(), coordinator = context.coordinator
        view.isUserInteractionEnabled = false
        view.onMove = { [weak view, weak coordinator] in if let view { coordinator?.attach(view) } }
        return view
    }
    func updateUIView(_ view: IOSChatTouchProbe, context: Context) {
        context.coordinator.parent = self
        context.coordinator.attach(view)
    }
    static func dismantleUIView(_ view: IOSChatTouchProbe, coordinator: Coordinator) {
        view.onMove = nil; coordinator.detach()
    }
    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: IOSChatBlankTapSurface
        private weak var scroll: UIScrollView?
        private weak var probe: IOSChatTouchProbe?
        private let tap = UITapGestureRecognizer()
        init(_ parent: IOSChatBlankTapSurface) {
            self.parent = parent; super.init()
            tap.addTarget(self, action: #selector(dismissInput))
            tap.cancelsTouchesInView = false
            tap.delaysTouchesBegan = false; tap.delaysTouchesEnded = false
            tap.delegate = self
        }
        func attach(_ view: IOSChatTouchProbe) {
            guard view.window != nil else { detach(); return }
            var ancestor = view.superview
            while let current = ancestor, !(current is UIScrollView) { ancestor = current.superview }
            guard let target = ancestor as? UIScrollView else { return }
            if scroll !== target { detach(); scroll = target; target.addGestureRecognizer(tap) }
            probe = view
        }
        func detach() { scroll?.removeGestureRecognizer(tap); scroll = nil; probe = nil }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard let probe, let scroll, scroll.window != nil, probe.window === scroll.window,
                  IOSChatBlankTapPolicy.allows(touch.location(in: probe), protectedFrames: parent.protectedFrames, enabled: parent.enabled) else { return false }
            var target = touch.view
            while let view = target, view !== scroll {
                if view is UIControl || view is UITextView || view is IOSGroupAvatarTouchView { return false }
                target = view.superview
            }
            return target === scroll
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
        @objc private func dismissInput(_ recognizer: UITapGestureRecognizer) {
            guard recognizer.state == .ended, parent.enabled, let scroll, let probe,
                  scroll.window != nil, probe.window === scroll.window else { return }
            parent.onDismiss()
            // Also resign a native field whose begin-editing binding is pending.
            scroll.window?.endEditing(true)
        }
    }
}

@MainActor private final class IOSChatTouchProbe: UIView {
    var onMove: (() -> Void)?
    override func didMoveToWindow() { super.didMoveToWindow(); onMove?() }
    override func didMoveToSuperview() { super.didMoveToSuperview(); onMove?() }
    override func layoutSubviews() { super.layoutSubviews(); onMove?() }
}

/// Native recognition tolerates small finger movement on a phone. The tap waits
/// for a failed hold, so a successful @ never also opens the member profile.
@MainActor private struct IOSGroupAvatarTouchSurface: UIViewRepresentable {
    let allowsMention: Bool
    let onTap: () -> Void
    let onMention: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UIView {
        let view = IOSGroupAvatarTouchView()
        view.backgroundColor = .clear; view.isOpaque = false
        view.addGestureRecognizer(context.coordinator.tap)
        view.addGestureRecognizer(context.coordinator.hold)
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.hold.isEnabled != allowsMention {
            context.coordinator.hold.isEnabled = allowsMention
        }
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) {
        coordinator.active = false
        view.removeGestureRecognizer(coordinator.tap); view.removeGestureRecognizer(coordinator.hold)
    }
    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: IOSGroupAvatarTouchSurface
        var active = true
        let tap = UITapGestureRecognizer()
        let hold = UILongPressGestureRecognizer()
        init(_ parent: IOSGroupAvatarTouchSurface) {
            self.parent = parent; super.init()
            hold.minimumPressDuration = 0.45; hold.allowableMovement = 22
            hold.isEnabled = parent.allowsMention
            tap.require(toFail: hold)
            tap.addTarget(self, action: #selector(openProfile))
            hold.addTarget(self, action: #selector(mention))
            tap.delegate = self; hold.delegate = self
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            // Cooperate with ancestor scroll/SwiftUI drags, but keep our tap and
            // long press mutually exclusive through the failure relationship.
            otherGestureRecognizer !== tap && otherGestureRecognizer !== hold
        }
        @objc private func openProfile(_ recognizer: UITapGestureRecognizer) {
            if active, recognizer.state == .ended { parent.onTap() }
        }
        @objc private func mention(_ recognizer: UILongPressGestureRecognizer) {
            if active, parent.allowsMention, recognizer.state == .began { parent.onMention() }
        }
    }
}

@MainActor private final class IOSGroupAvatarTouchView: UIView {}

@MainActor private final class IOSGroupComposerHandle {
    weak var field: UITextField?
    func commitMarkedText() -> String? {
        guard let field, field.markedTextRange != nil else { return nil }
        field.unmarkText()
        return field.text ?? ""
    }
}

// UITextField exposes the caret and marked-text state on iOS 16+, keeping searches
// tied to the token at the cursor without interfering with Chinese composition.
private struct IOSMentionComposerField: UIViewRepresentable {
    @Binding var text: String
    @Binding var caret: Int
    @Binding var composing: Bool
    @Binding var focused: Bool
    let handle: IOSGroupComposerHandle
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITextField {
        let field = UITextField(); field.placeholder = "输入消息"; field.font = .systemFont(ofSize: 16)
        handle.field = field
        field.accessibilityLabel = "输入消息"; field.delegate = context.coordinator
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.addTarget(context.coordinator, action: #selector(Coordinator.edit), for: .editingChanged)
        return field
    }
    func updateUIView(_ field: UITextField, context: Context) {
        handle.field = field
        let coordinator = context.coordinator; coordinator.parent = self; coordinator.updating = true
        let changed = field.text != text
        if changed, field.markedTextRange == nil { field.text = text }
        if field.markedTextRange == nil {
            let offset = max(0, min(caret, text.utf16.count))
            let actual = field.selectedTextRange.map { field.offset(from: field.beginningOfDocument, to: $0.start) }
            if (changed || actual != offset), let position = field.position(from: field.beginningOfDocument, offset: offset) {
                field.selectedTextRange = field.textRange(from: position, to: position)
            }
        }
        if let requested = coordinator.focusRequest.consume(focused) {
            if requested && !field.isFirstResponder { field.becomeFirstResponder() }
            if !requested && field.isFirstResponder { field.resignFirstResponder() }
        }
        coordinator.updating = false
    }
    static func dismantleUIView(_ field: UITextField, coordinator: Coordinator) {
        if coordinator.parent.handle.field === field { coordinator.parent.handle.field = nil }
        coordinator.active = false; coordinator.focusPublication += 1; field.delegate = nil
    }
    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: IOSMentionComposerField; var updating = false
        var focusRequest = IOSComposerFocusRequest()
        var focusPublication = 0
        var active = true
        init(_ parent: IOSMentionComposerField) { self.parent = parent }
        @objc func edit(_ field: UITextField) { publish(field) }
        func textFieldDidChangeSelection(_ field: UITextField) { publish(field) }
        private func publish(_ field: UITextField) {
            guard active, !updating else { return }
            let value = field.text ?? "", range = field.selectedTextRange
            parent.composing = field.markedTextRange != nil || range.map { !$0.isEmpty } == true
            parent.text = value
            parent.caret = range.map { field.offset(from: field.beginningOfDocument, to: $0.start) } ?? value.utf16.count
        }
        private func publishFocus(_ focused: Bool, field: UITextField) {
            focusPublication += 1; let revision = focusPublication
            if !updating { parent.focused = focused; return }
            DispatchQueue.main.async { [weak self, weak field] in
                guard let self, let field, self.active, self.focusPublication == revision,
                      field.isFirstResponder == focused else { return }
                self.parent.focused = focused
            }
        }
        func textFieldDidBeginEditing(_ field: UITextField) { publishFocus(true, field: field) }
        func textFieldDidEndEditing(_ field: UITextField) { publish(field); publishFocus(false, field: field) }
    }
}
