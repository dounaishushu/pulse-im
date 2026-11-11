import SwiftUI
import Foundation
import PhotosUI
import AVFoundation
import UIKit

struct WindowShakeEffect: GeometryEffect {
    var shakes: CGFloat
    var amount: CGFloat = 5
    var animatableData: CGFloat { get { shakes } set { shakes = newValue } }
    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: sin(shakes * .pi * 8) * amount, y: 0))
    }
}

struct PrivateChatMoreMenu: View {
    let isMuted: Bool
    let onToggleNotifications: () -> Void
    let onClearHistory: () -> Void
    let onDeleteConversation: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            menuButton(isMuted ? "bell" : "bell.slash", isMuted ? "开启通知" : "关闭通知", onToggleNotifications)
            menuButton("paintbrush", "清空历史记录", onClearHistory)
            menuButton("trash", "删除对话", onDeleteConversation)
        }
        .padding(.vertical, 6)
        .background(PulsePalette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(PulsePalette.line.opacity(0.6), lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .accessibilityIdentifier("private_chat_more_menu")
    }

    private func menuButton(_ icon: String, _ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(PulsePalette.muted).frame(width: 20)
                Text(title)
                Spacer()
            }
            .font(.system(size: 15))
            .foregroundStyle(PulsePalette.ink)
            .padding(.horizontal, 16)
            .frame(height: 44)
        }
        .buttonStyle(.plain)
    }
}

enum PrivateChatMenuAction: String, Identifiable {
    case clearHistory, deleteConversation
    var id: Self { self }
    var title: String { self == .clearHistory ? "清空历史记录？" : "删除对话？" }
    var buttonTitle: String { self == .clearHistory ? "清空记录" : "删除对话" }
    var explanation: String {
        self == .clearHistory
            ? "仅清空你在此对话中的历史记录，不影响对方。清空后无法恢复。"
            : "将此对话从你的聊天列表中移除，聊天记录和好友关系会保留。"
    }
}

struct PrivateChatMenuHeaderKey: PreferenceKey {
    static var defaultValue: Anchor<CGRect>? { nil }
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        if let next = nextValue() { value = next }
    }
}

/// Keep the menu in the chat's view tree. Native popover adaptation can present
/// a sheet on iPhone, and two presenters sharing a binding can dismiss each other.
struct PrivateChatMoreMenuOverlay: View {
    let headerFrame: CGRect
    let containerSize: CGSize
    let isMuted: Bool
    let onDismiss: () -> Void
    let onToggleNotifications: () -> Void
    let onClearHistory: () -> Void
    let onDeleteConversation: () -> Void

    var body: some View {
        let width = min(184, max(0, containerSize.width - 24))
        let x = min(max(12, headerFrame.maxX - width - 12), max(12, containerSize.width - width - 12))
        let y = max(0, headerFrame.maxY + 4)
        ZStack(alignment: .topLeading) {
            Button(action: onDismiss) { Color.clear.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭会话操作菜单")
                .accessibilityIdentifier("private_chat_more_menu_dismiss")
            PrivateChatMoreMenu(isMuted: isMuted, onToggleNotifications: onToggleNotifications,
                                onClearHistory: onClearHistory, onDeleteConversation: onDeleteConversation)
                .frame(width: width)
                .offset(x: x, y: y)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, onDismiss)
    }
}

struct PrivateChatAttachmentSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onPhotos: () -> Void
    let onCamera: () -> Void
    let onFavorite: () -> Void
    let onShake: (() -> Void)?
    let onContactCard: () -> Void
    var onVideo: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 14) {
            Capsule().fill(PulsePalette.line).frame(width: 38, height: 4).padding(.top, 3)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                Button(action: onPhotos) {
                    action("photo.fill", "照片", Color(hex: 0x4C8EF7))
                }
                .buttonStyle(.plain)
                if let onVideo { Button(action: onVideo) { action("video.fill", "视频", Color(hex: 0x4C8EF7)) }.buttonStyle(.plain) }
                Button { onCamera() } label: { action("camera.fill", "拍摄", Color(hex: 0x8B6DE7)) }.buttonStyle(.plain)
                Button { onFavorite() } label: { action("star.fill", "收藏", Color(hex: 0xF2A93B)) }.buttonStyle(.plain)
                if let onShake { Button(action: onShake) { action("bolt.horizontal.fill", "窗口抖动", Color(hex: 0xE76C73)) }.buttonStyle(.plain) }
                Button { onContactCard() } label: { action("person.crop.rectangle.fill", "名片", Color(hex: 0x4C8EF7)) }.buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            Spacer(minLength: 0)
        }
        .background(PulsePalette.surface)
    }

    private func action(_ icon: String, _ title: String, _ color: Color) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 21, weight: .medium)).foregroundStyle(.white).frame(width: 46, height: 46).background(color, in: Circle())
            Text(title).font(.system(size: 12)).foregroundStyle(PulsePalette.ink).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }
}

struct ChatSearchView: View {
    let conversationID: Int
    @Environment(\.dismiss) private var dismiss
    @State private var keyword = ""
    @State private var results: [MessageSearchResult] = []
    @State private var loading = false
    @State private var error = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(PulsePalette.muted)
                TextField("搜索聊天记录", text: $keyword).textFieldStyle(.plain).onSubmit { search() }
                if loading { ProgressView().controlSize(.small) }
                if !keyword.isEmpty { Button { keyword = ""; results = [] } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(PulsePalette.muted) }.buttonStyle(.plain) }
            }
            .padding(.horizontal, 13).frame(height: 42).background(PulsePalette.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous)).padding(12)
            if results.isEmpty {
                EmptyState(icon: "magnifyingglass", title: "搜索聊天记录", message: "输入关键词，查找当前会话中的消息").padding(.top, 58)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) { ForEach(results) { resultRow($0) } }
                }.scrollIndicators(.hidden)
            }
        }
        .background(PulsePalette.background)
        .navigationTitle("搜索")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .alert("搜索失败", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") { error = "" } } message: { Text(error) }
    }

    private func resultRow(_ result: MessageSearchResult) -> some View {
        Button { dismiss() } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack { Text(result.senderNickname ?? "联系人").font(.system(size: 13, weight: .semibold)).foregroundStyle(PulsePalette.accent); Spacer(); Text(result.createdAt).font(.system(size: 11)).foregroundStyle(PulsePalette.muted) }
                Text(result.body["text"]?.stringValue ?? messageType(result.type)).font(.system(size: 15)).foregroundStyle(PulsePalette.ink).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16).padding(.vertical, 12).background(PulsePalette.surface)
        }.buttonStyle(.plain)
    }

    private func messageType(_ type: String) -> String { switch type { case "image": return "图片"; case "voice": return "语音"; case "contact_card": return "联系人名片"; case "shake": return "窗口抖动"; default: return "消息" } }
    private func search() {
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        loading = true
        let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())
        Task { defer { loading = false }; do { results = try await APIClient.shared.searchMessages(conversationID: conversationID, keyword: value, date: today) } catch { error = error.localizedDescription } }
    }
}

struct CameraCaptureView: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    let onCancel: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIImagePickerController { let picker = UIImagePickerController(); picker.sourceType = .camera; picker.mediaTypes = ["public.image"]; picker.delegate = context.coordinator; return picker }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraCaptureView
        init(_ parent: CameraCaptureView) { self.parent = parent }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.onCancel() }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) { if let image = info[.originalImage] as? UIImage { parent.onImage(image) } else { parent.onCancel() } }
    }
}

@MainActor struct IOSReceivedContactCardView: View {
    let target: IOSReceivedContactCardTarget
    let client: APIClient
    let actorID: Int
    let sourceAvailable: () -> Bool
    let onChat: (Conversation) -> Void
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.dismiss) private var dismiss
    @State private var user: SearchUser?
    @State private var isContact = false
    @State private var canAddFriend = false
    @State private var friendRestriction = ""
    @State private var requestSent = false
    @State private var forcedAdded = false
    @State private var busy = false
    @State private var visible = false
    @State private var operation = UUID()
    @State private var error = ""
    @State private var remark = ""
    @State private var remarkDraft = ""
    @State private var editingRemark = false

    private var current: Bool {
        visible && sourceAvailable() && session.isSignedIn && session.user?.id == actorID
            && session.token == client.token && client.endpointIdentity == APIClient.shared.endpointIdentity
            && !appLock.isLocked && !session.updateRequired
    }

    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 0) {
                if let user {
                    HStack(alignment: .center, spacing: 16) {
                        PulseAvatar(title: user.nickname, size: 68, avatarURL: user.avatarURL)
                        VStack(alignment: .leading, spacing: 7) {
                            Text(remark.isEmpty ? user.nickname : remark).font(.system(size: 21, weight: .semibold))
                            if !remark.isEmpty, remark != user.nickname { Text("昵称：\(user.nickname)").font(.subheadline).foregroundStyle(PulsePalette.muted) }
                            if let username = user.username, !username.isEmpty { Text("账号：\(username)").font(.subheadline).foregroundStyle(PulsePalette.muted).textSelection(.enabled) }
                            Text("ID：\(PublicUserIdentity.display(user.publicID))").font(.footnote).foregroundStyle(PulsePalette.muted).textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.horizontal, 22).padding(.vertical, 24)
                    if isContact, user.id != actorID {
                        Divider()
                        Button { remarkDraft = remark; editingRemark = true } label: {
                            HStack { Text("备注名"); Spacer(); Text(remark.isEmpty ? "设置备注" : remark).foregroundStyle(PulsePalette.muted); Image(systemName: "chevron.right").font(.footnote).foregroundStyle(PulsePalette.muted) }
                                .padding(.horizontal, 22).padding(.vertical, 18)
                        }.buttonStyle(.plain).disabled(busy || !current).accessibilityIdentifier("received_contact_card_remark")
                    }
                    Divider()
                    Button { Task { if isContact { await openChat() } else { await addFriend() } } } label: {
                        Text(user.id == actorID ? "这是你自己" : busy ? "处理中…" : isContact ? (forcedAdded ? "聊天" : "发送消息") : requestSent ? "已申请添加好友" : "添加好友")
                            .font(.system(size: 17, weight: .medium)).frame(maxWidth: .infinity).frame(minHeight: 48)
                    }.buttonStyle(PulseSmallButtonStyle()).padding(.horizontal, 22).padding(.vertical, 20)
                        .disabled(!current || busy || user.id == actorID || (!isContact && (!canAddFriend || requestSent)))
                        .accessibilityIdentifier(isContact ? "received_contact_card_message" : "received_contact_card_add")
                    if requestSent { Text("等待对方确认").font(.footnote).foregroundStyle(PulsePalette.muted) }
                    if !friendRestriction.isEmpty, !isContact { Text(friendRestriction).font(.footnote).foregroundStyle(PulsePalette.muted) }
                } else if busy { ProgressView("正在加载名片…") }
                if !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(PulsePalette.danger).multilineTextAlignment(.center)
                    if user == nil { Button("重新加载") { Task { await load() } }.disabled(busy || !current) }
                }
                Spacer()
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(PulsePalette.surface)
                .navigationTitle("联系人名片").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
                .onAppear { visible = true }
                .onDisappear { visible = false; operation = UUID(); busy = false }
                .task { visible = true; await load() }
                .pulseOnChange(of: sourceAvailable()) { available in if !available { operation = UUID(); dismiss() } }
                .alert("备注名", isPresented: $editingRemark) {
                    TextField("设置备注名", text: $remarkDraft)
                    Button("保存") { Task { await saveRemark() } }
                    Button("取消", role: .cancel) { }
                }
        }
    }

    private func load() async {
        guard current, !busy else { return }
        let request = UUID(); operation = request; busy = true; error = ""
        defer { if operation == request { busy = false } }
        do {
            let value = try await client.receivedContactCardProfile(target)
            guard current, operation == request, !Task.isCancelled else { return }
            user = value.user; isContact = value.isContact; canAddFriend = value.canAddFriend
            friendRestriction = value.restriction ?? ""
            remark = value.isContact ? session.contacts.first(where: { $0.userId == value.user.id })?.remark ?? "" : ""
            if value.isContact {
                Task {
                    guard let profile = try? await client.contactProfile(userID: value.user.id), profile.isContact == true,
                          current, operation == request else { return }
                    remark = profile.remark ?? ""
                    session.rememberContactName(userID: value.user.id, nickname: value.user.nickname, remark: remark)
                }
            }
        } catch { if current, operation == request, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func openChat() async {
        guard current, !busy, isContact, let user, user.id != actorID else { return }
        let request = UUID(); operation = request; busy = true; error = ""
        defer { if operation == request { busy = false } }
        do {
            let fresh = try await client.receivedContactCardProfile(target)
            guard current, operation == request, !Task.isCancelled else { return }
            isContact = fresh.isContact; canAddFriend = fresh.canAddFriend; friendRestriction = fresh.restriction ?? ""
            guard fresh.isContact else { throw APIClientError.server("你们还不是好友，请先添加好友") }
            let direct = try await client.createDirectConversation(userID: user.id)
            guard current, operation == request, !Task.isCancelled else { return }
            guard direct.id > 0, direct.type == "direct", direct.peerUserId == user.id else { throw APIClientError.invalidResponse }
            onChat(direct)
        } catch { if current, operation == request, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func saveRemark() async {
        guard current, !busy, isContact, let user, user.id != actorID else { return }
        let value = remarkDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count <= 64 else { error = "备注名最多64个字符"; return }
        let request = UUID(); operation = request; busy = true; error = ""
        defer { if operation == request { busy = false } }
        do {
            try await client.updateContactRemark(userID: user.id, remark: value)
            guard current, operation == request, !Task.isCancelled else { return }
            remark = value; session.rememberContactName(userID: user.id, nickname: user.nickname, remark: value)
        } catch { if current, operation == request, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func addFriend() async {
        guard current, !busy, canAddFriend, !isContact, !requestSent, let user, user.id != actorID else { return }
        let request = UUID(); operation = request; busy = true; error = ""
        let staff = session.user?.internalStaff == true
        defer { if operation == request { busy = false } }
        do {
            if staff { try await client.forceAddContact(userID: user.id) }
            else { try await client.sendFriendRequest(userID: user.id, contactCard: target) }
            guard current, operation == request, !Task.isCancelled else { return }
            if staff { isContact = true; forcedAdded = true } else { requestSent = true }
            Task {
                let contacts = try? await client.contacts()
                guard current, operation == request else { return }
                if let contacts {
                    session.contacts = contacts
                    if contacts.contains(where: { $0.userId == user.id }) { isContact = true }
                }
            }
        } catch {
            guard current, operation == request, !Task.isCancelled else { return }
            let message = error.localizedDescription
            let profile = try? await client.contactProfile(userID: user.id)
            guard current, operation == request, !Task.isCancelled else { return }
            if profile?.isContact == true { isContact = true }
            else { self.error = message }
        }
    }
}

@MainActor final class MessageAudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var playingID: Int?
    @Published private(set) var loadingID: Int?
    @Published private(set) var error = ""
    private var player: AVAudioPlayer?
    private var loadTask: Task<Void, Never>?
    private var generation = UUID()
    private var cachedURL: URL?

    func stop() {
        generation = UUID(); loadTask?.cancel(); loadTask = nil
        player?.stop(); player = nil; playingID = nil; loadingID = nil
        if let cachedURL { APIClient.removeDownloadedMedia(at: cachedURL) }; cachedURL = nil
    }
    func toggle(messageID: Int, url: URL, client: APIClient) {
        if playingID == messageID || loadingID == messageID { stop(); return }
        stop(); error = ""; loadingID = messageID
        let current = generation
        loadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let file = try await client.downloadMedia(url.absoluteString, fileName: IOSVoiceFileFormat.downloadName(url), maximumBytes: 10 * 1024 * 1024)
                guard !Task.isCancelled, self.generation == current, client.webSocketToken == APIClient.shared.webSocketToken,
                      client.endpointIdentity == APIClient.shared.endpointIdentity else { APIClient.removeDownloadedMedia(at: file); return }
                self.cachedURL = file
                let audio = AVAudioSession.sharedInstance()
                try audio.setCategory(.playback, mode: .spokenAudio); try audio.setActive(true)
                let value = try AVAudioPlayer(contentsOf: file)
                value.delegate = self; value.prepareToPlay()
                guard value.play() else { throw APIClientError.server("语音无法播放") }
                self.player = value; self.playingID = messageID; self.loadingID = nil; self.loadTask = nil
            } catch {
                guard self.generation == current, !Task.isCancelled else { return }
                self.stop(); self.error = "语音加载失败，请稍后重试"
            }
        }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in guard self.player === player else { return }; self.stop() }
    }
}
