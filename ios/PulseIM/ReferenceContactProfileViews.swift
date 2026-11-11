import SwiftUI
import UIKit

enum GroupFriendRestrictionFeedback {
    static func message(_ error: Error, inGroup: Bool) -> String {
        if inGroup, let apiError = error as? APIClientError, case .server(let message) = apiError {
            let text = message.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "。"))
            if ["该群已禁止群成员互加好友", "该群已禁止群成员互相添加好友", "无权查看该群成员资料"].contains(text) { return "" }
        }
        return error.localizedDescription
    }
}

struct ReferenceContactCardSubmission {
    let requestID: String
    let body: [String: Any]
    var conversationID: Int?
}

/// One captured account/route owns the entire profile flow and its child pages.
@MainActor final class ReferenceContactProfileModel: ObservableObject {
    let userID: Int
    let conversationID: Int
    let groupContextConversationID: Int?
    let token: String
    let client: APIClient
    @Published private(set) var profile: ContactProfile?
    @Published private(set) var notificationsEnabled: Bool
    @Published private(set) var blocked = false
    @Published private(set) var isContact: Bool?
    @Published private(set) var requestSent = false
    @Published private(set) var busy = false
    @Published private(set) var mutating = false
    @Published var error = ""
    var onNotificationsChanged: ((Bool) -> Void)?
    private weak var session: AppSession?
    private weak var appLock: AppLockManager?
    private var viewerID: Int?
    private var active = true
    private var revision = 0
    private var pendingCards: [Int: ReferenceContactCardSubmission] = [:]

    init(userID: Int, conversationID: Int, muted: Bool, groupContextConversationID: Int? = nil) {
        self.userID = userID; self.conversationID = conversationID
        self.groupContextConversationID = groupContextConversationID
        let captured = APIClient.shared.captureSession()
        self.client = captured; self.token = captured.webSocketToken
        notificationsEnabled = !muted
    }
    func bind(session: AppSession, appLock: AppLockManager) { self.session = session; self.appLock = appLock; viewerID = session.user?.id }
    private var sameAccount: Bool {
        !token.isEmpty && session?.token == token && session?.user?.id == viewerID
            && session?.isSignedIn == true && client.endpointIdentity == APIClient.shared.endpointIdentity
    }
    var current: Bool {
        active && sameAccount
            && session?.isSignedIn == true && session?.updateRequired == false && appLock?.isLocked == false
    }
    var hasDirectConversation: Bool { groupContextConversationID == nil && conversationID > 0 }
    var canAddFromSource: Bool { groupContextConversationID == nil || profile?.canAddFriend == true }
    @Published var sourceRestricted = false
    func failureMessage(_ failure: Error) -> String {
        let message = GroupFriendRestrictionFeedback.message(failure, inGroup: groupContextConversationID != nil)
        if groupContextConversationID != nil && message.isEmpty { profile = nil; isContact = nil; blocked = false; sourceRestricted = true }
        return message
    }
    func clearGroupProfileOnFailure(_ failure: Error? = nil) {
        guard groupContextConversationID != nil else { return }
        profile = nil; isContact = nil; blocked = false
        if let failure { error = failureMessage(failure) }
    }
    func revalidateSource() async throws {
        guard current, !Task.isCancelled else { throw CancellationError() }
        guard groupContextConversationID != nil else { return }
        let request = revision
        do {
            let value = try await client.contactProfile(userID: userID, groupContextConversationID: groupContextConversationID)
            guard current, revision == request, !Task.isCancelled else { throw CancellationError() }
            profile = value; isContact = value.isContact; blocked = value.blockedByMe ?? false
        } catch { if current, revision == request, !Task.isCancelled { clearGroupProfileOnFailure(error) }; throw error }
    }
    func commonGroups(page: Int = 1, size: Int = 20) async throws -> ContactCommonGroupsPage {
        guard current, !Task.isCancelled else { throw CancellationError() }
        let request = revision
        do {
            let value = try await client.commonContactGroups(userID: userID, page: page, size: size, groupContextConversationID: groupContextConversationID)
            guard current, revision == request, !Task.isCancelled else { throw CancellationError() }
            return value
        } catch { if current, revision == request, !Task.isCancelled { clearGroupProfileOnFailure(error) }; throw error }
    }
    func invalidate() { active = false; revision += 1 }
    func cardSubmission(receiverID: Int) -> ReferenceContactCardSubmission {
        if let existing = pendingCards[receiverID] { return existing }
        let value = ReferenceContactCardSubmission(requestID: "ios-card-\(UUID().uuidString)", body: ["user_id": userID], conversationID: nil)
        pendingCards[receiverID] = value
        return value
    }
    func rememberCardConversation(receiverID: Int, requestID: String, conversationID: Int) {
        guard pendingCards[receiverID]?.requestID == requestID else { return }
        pendingCards[receiverID]?.conversationID = conversationID
    }
    func acknowledgeCard(receiverID: Int, requestID: String) {
        if pendingCards[receiverID]?.requestID == requestID { pendingCards.removeValue(forKey: receiverID) }
    }

    func load() async {
        guard current, !busy else { return }
        revision += 1; let request = revision; busy = true; error = ""
        defer { if revision == request { busy = false } }
        do {
            let value = try await client.contactProfile(userID: userID, groupContextConversationID: groupContextConversationID)
            var conversation: Conversation?
            if hasDirectConversation { conversation = try await client.conversationInfo(id: conversationID) }
            guard current, request == revision, !Task.isCancelled else { return }
            guard value.userId == userID else { throw APIClientError.invalidResponse }
            if let conversation { guard conversation.id == conversationID, conversation.type == "direct", conversation.peerUserId == userID else { throw APIClientError.invalidResponse } }
            profile = value; isContact = value.isContact; blocked = value.blockedByMe ?? false
            if let conversation { notificationsEnabled = !conversation.notificationsMuted }
            if isContact == true { requestSent = false }
        } catch { if current, request == revision, !Task.isCancelled { clearGroupProfileOnFailure(); self.error = failureMessage(error) } }
    }
    @discardableResult private func mutate<Value>(_ operation: (APIClient) async throws -> Value, commit: (Value) -> Void) async -> Bool {
        guard current, !busy else { return false }
        revision += 1; let request = revision; busy = true; mutating = true; error = ""
        defer { if revision == request { busy = false }; mutating = false }
        do {
            try await revalidateSource()
            guard current, request == revision, !Task.isCancelled else { return false }
            let value = try await operation(client)
            guard current, request == revision else { return false }
            commit(value)
            if let session {
                Task { [weak self] in
                    guard let self, self.current else { return }
                    let contacts = try? await self.client.contacts()
                    if self.current, let contacts { session.contacts = contacts }
                    if self.current { try? await session.refreshConversations() }
                }
            }
            return true
        } catch { if current, request == revision { self.error = failureMessage(error) }; return false }
    }
    func setNotifications(_ enabled: Bool) async {
        guard hasDirectConversation else { return }
        _ = await mutate({ client in
            let value = try await client.updateConversationNotification(conversationID: conversationID, muted: !enabled)
            guard value.id == conversationID else { throw APIClientError.invalidResponse }
            // A security close may remove the page while the accepted write is
            // in flight. Keep only this same-account notification ACK in sync.
            if sameAccount { onNotificationsChanged?(value.notificationsMuted) }
            return value
        }) { value in
            notificationsEnabled = !value.notificationsMuted
        }
    }
    func setBlocked(_ next: Bool) async {
        _ = await mutate({ client in if next { try await client.blockUser(userID: userID) } else { try await client.unblock(userID: userID) } }) { _ in blocked = next }
    }
    func saveRemark(_ remark: String, group: String) async -> Bool {
        guard isContact == true else { return false }
        let saved = await mutate({ try await $0.updateContactRemark(userID: userID, remark: remark, groupName: group) }) { _ in }
        if saved { await load() }
        return saved
    }
    func removeContact() async {
        guard isContact == true else { return }
        _ = await mutate({ try await $0.removeContact(userID: userID) }) { _ in isContact = false; requestSent = false }
    }
    func addContact() async {
        guard isContact == false, !requestSent, canAddFromSource else { return }
        let sent = await mutate({ client in
            guard self.canAddFromSource else { throw APIClientError.server("当前无法从该群添加好友") }
            try await client.sendFriendRequest(userID: self.userID, groupContextConversationID: self.groupContextConversationID)
        }) { _ in requestSent = true }
        // A reciprocal pending request is accepted immediately by the server.
        if sent { await load() }
    }
    func openDirect() async -> Conversation? {
        guard !hasDirectConversation, profile != nil, groupContextConversationID == nil || isContact == true else { return nil }
        var result: Conversation?
        _ = await mutate({ client in
            let value = try await client.createDirectConversation(userID: userID)
            guard value.id > 0, value.type == "direct", value.peerUserId == userID else { throw APIClientError.invalidResponse }
            return value
        }) { result = $0 }
        return result
    }
}

private enum ReferenceContactPage { case profile, more, media, groups, remark, share }

struct IOSForcedContactProfileRoute: Identifiable {
    let id = UUID()
    let userID: Int
    let viewerID: Int
    let token: String
    let endpoint: String

    @MainActor func matches(_ session: AppSession) -> Bool {
        userID > 0 && userID != viewerID && viewerID > 0 && !token.isEmpty
            && session.isSignedIn && session.user?.id == viewerID && session.token == token
            && APIClient.shared.endpointIdentity == endpoint
    }

    @MainActor func refreshContacts(in session: AppSession, using client: APIClient) async {
        guard matches(session), client.webSocketToken == token, client.endpointIdentity == endpoint else { return }
        let contacts = try? await client.contacts()
        if matches(session), let contacts { session.contacts = contacts }
    }
}

@MainActor private struct IOSForcedContactPresentation: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @Binding var selection: IOSForcedContactProfileRoute?

    func body(content: Content) -> some View {
        content
            .pulseSheet(item: $selection) { route in
                if route.matches(session), !appLock.isLocked, !session.updateRequired, scenePhase != .background {
                    // Zero denotes an unresolved direct route, never an API conversation ID.
                    ContactInfoView(userID: route.userID, conversationID: 0, initialMuted: false,
                        onClose: { _, _ in if selection?.id == route.id { selection = nil } },
                        onNotificationsChanged: { _ in }, onNestedChatActive: { _ in })
                        .id(route.id)
                }
            }
            .pulseOnChange(of: session.token) { _ in selection = nil }
            .pulseOnChange(of: session.user?.id) { _ in selection = nil }
            .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in selection = nil }
            .pulseOnChange(of: appLock.isLocked) { locked in if locked { selection = nil } }
            .pulseOnChange(of: session.updateRequired) { required in if required { selection = nil } }
            .pulseOnChange(of: scenePhase) { phase in if phase == .background { selection = nil } }
    }
}

extension View {
    @MainActor func pulseForcedContactProfile(item: Binding<IOSForcedContactProfileRoute?>) -> some View {
        modifier(IOSForcedContactPresentation(selection: item))
    }
}

@MainActor struct ContactInfoView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: ReferenceContactProfileModel
    @State private var page: ReferenceContactPage = .profile
    @State private var selectedGroup: Conversation?
    private let onClose: (Bool, ContactProfile?) -> Void
    private let onNestedChatActive: (Bool) -> Void
    private let onNotificationsChanged: (Bool) -> Void

    init(userID: Int, conversationID: Int, initialMuted: Bool, groupContextConversationID: Int? = nil, onClose: @escaping (Bool, ContactProfile?) -> Void, onNotificationsChanged: @escaping (Bool) -> Void, onNestedChatActive: @escaping (Bool) -> Void) {
        _model = StateObject(wrappedValue: ReferenceContactProfileModel(userID: userID, conversationID: conversationID, muted: initialMuted, groupContextConversationID: groupContextConversationID))
        self.onClose = onClose; self.onNestedChatActive = onNestedChatActive; self.onNotificationsChanged = onNotificationsChanged
    }

    var body: some View {
        PulseNavigationStack {
            Group {
                if model.groupContextConversationID != nil, model.profile == nil { profilePage }
                else {
                switch page {
                case .profile: profilePage
                case .more: ContactMoreInfoView(model: model, back: { page = .profile }, media: { page = .media }, groups: { page = .groups })
                case .media: ReferenceContactMediaView(model: model, back: { page = .more })
                case .groups: ReferenceContactGroupsView(model: model, back: { page = .more }, open: { onNestedChatActive(true); selectedGroup = $0 })
                case .remark: ReferenceContactRemarkView(model: model, back: { page = .profile })
                case .share: ReferenceShareContactView(model: model, back: { page = .profile })
                }
                }
            }
            .pulseSwipeBack(enabled: !model.mutating && selectedGroup == nil, identity: String(describing: page)) {
                switch page {
                case .profile: close()
                case .media, .groups: page = .more
                case .more, .remark, .share: page = .profile
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .pulseOnChange(of: model.sourceRestricted) { restricted in if restricted { close(force: true) } }
            .pulseChatPresentation(item: $selectedGroup)
        }
        .background(PulsePalette.background.ignoresSafeArea(.container))
        .task {
            model.bind(session: session, appLock: appLock)
            model.onNotificationsChanged = onNotificationsChanged
            await model.load()
            while !Task.isCancelled {
                guard model.current else { close(force: true); return }
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
        .pulseOnChange(of: selectedGroup?.id) { id in onNestedChatActive(id != nil) }
        .pulseOnChange(of: session.token) { _ in close(force: true) }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { close(force: true) } }
        .pulseOnChange(of: session.updateRequired) { required in if required { close(force: true) } }
        .pulseOnChange(of: scenePhase) { phase in if phase == .background || (model.groupContextConversationID != nil && phase != .active) { close(force: true) } }
        .onDisappear { if selectedGroup == nil { model.invalidate(); onNestedChatActive(false) } }
        .alert("操作失败", isPresented: Binding(get: { !model.error.isEmpty }, set: { if !$0 { model.error = "" } })) { Button("知道了") { model.error = "" } } message: { Text(model.error) }
    }

    private func close(force: Bool = false) {
        guard force || !model.mutating else { return }
        selectedGroup = nil; onNestedChatActive(false)
        onClose(!model.notificationsEnabled, model.profile)
        model.invalidate()
    }
    private var profilePage: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ScrollView {
                VStack(spacing: 0) {
                    hero(width: width, safeTop: geometry.safeAreaInsets.top)
                    VStack(spacing: 8) {
                        HStack { Text("用户 ID"); Spacer(); Text(PublicUserIdentity.display(model.profile?.publicID)).textSelection(.enabled) }
                            .font(.system(size: 14)).padding(.horizontal, 29).padding(.vertical, 14).background(PulsePalette.surface)
                        ReferenceContactRow(title: "分组和备注", detail: model.isContact == true ? (model.profile?.groupName?.nonempty ?? "我的好友") : "非联系人", arrow: true) { page = .remark }
                            .disabled(model.busy || model.isContact != true)
                            .padding(.horizontal, 14)
                        VStack(spacing: 0) {
                            if model.hasDirectConversation { Toggle("消息通知", isOn: Binding(get: { model.notificationsEnabled }, set: { value in Task { await model.setNotifications(value) } }))
                                .tint(Color(hex: 0x20CB50)).padding(.horizontal, 15).frame(height: 52).disabled(model.busy || model.profile == nil)
                            }
                            ReferenceContactRow(title: "更多信息", arrow: true) { page = .more }.disabled(model.profile == nil)
                            if model.isContact != true {
                                Button { Task { await model.addContact() } } label: {
                                    Text(model.requestSent ? "好友申请已发送" : !model.canAddFromSource ? "暂不可添加好友" : model.isContact == false ? "添加好友" : "正在加载联系人状态…")
                                        .foregroundStyle(Color(hex: 0xF36B67)).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 15).frame(height: 52)
                                }.buttonStyle(.plain).disabled(model.busy || model.isContact == nil || model.requestSent || !model.canAddFromSource)
                            }
                        }.background(PulsePalette.surface)
                    }.font(.system(size: 15)).padding(.top, 0)
                    Button {
                        if model.groupContextConversationID != nil && model.isContact != true { Task { await model.addContact() } }
                        else if model.hasDirectConversation { close() }
                        else { Task { if let direct = await model.openDirect(), model.current { onNestedChatActive(true); selectedGroup = direct } } }
                    } label: {
                        Text(model.groupContextConversationID != nil && model.isContact != true ? model.requestSent ? "好友申请已发送" : model.canAddFromSource ? "添加好友" : "暂不可添加好友" : "发消息").font(.system(size: 16)).foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 47)
                            .background(Color(hex: 0x0733F4), in: RoundedRectangle(cornerRadius: 8))
                    }.buttonStyle(.plain).disabled(model.busy || model.profile == nil || (model.groupContextConversationID != nil && model.isContact != true && (model.requestSent || !model.canAddFromSource))).padding(.horizontal, 15).padding(.top, 30).padding(.bottom, 30)
                    if model.busy { ProgressView().padding(.bottom, 12) }
                    if model.profile == nil, !model.busy { Button("重新加载") { Task { await model.load() } }.padding(20) }
                }
            }.scrollIndicators(.hidden).background(ReferenceContactPageStyle.background)
                .ignoresSafeArea(.container, edges: .top)
        }
    }
    private func hero(width: CGFloat, safeTop: CGFloat) -> some View {
        let coverHeight = width * 0.41
        return VStack(spacing: 0) {
            ZStack(alignment: .top) {
                Image("ContactProfileCover").resizable().scaledToFill().frame(width: width, height: coverHeight).clipped()
                Color.black.opacity(0.12)
                ReferenceContactHeader(title: "个人信息", white: true, back: { close() }, trailing: model.profile == nil ? nil : { page = .share })
                    .disabled(model.mutating)
                    .padding(.top, safeTop)
            }.frame(height: coverHeight).clipped()
            VStack(spacing: 0) {
                ReferenceContactAvatar(name: model.profile?.nickname ?? "", avatarURL: model.profile?.avatarURL)
                    .offset(y: -35).padding(.bottom, -35)
                HStack(spacing: 7) {
                    Text(model.profile?.nickname ?? "正在加载…").font(.system(size: 18, weight: .semibold)).lineLimit(1)
                    if let gender = model.profile?.gender?.lowercased(), ["male", "female", "男", "女"].contains(gender) {
                        Text(["male", "男"].contains(gender) ? "♂" : "♀").font(.system(size: 18, weight: .semibold)).foregroundStyle(["male", "男"].contains(gender) ? Color(hex: 0x1599D0) : Color(hex: 0xED78AB))
                    }
                }.padding(.top, 15).padding(.horizontal, 16)
                Text(referenceContactLastSeen(model.profile)).font(.system(size: 12)).foregroundStyle(PulsePalette.muted).padding(.top, 12)
                Spacer(minLength: 0)
            }.frame(maxWidth: .infinity).frame(height: width * 0.42)
                .background(PulsePalette.surface, in: UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8))
        }.foregroundStyle(PulsePalette.ink)
    }
}

private enum ReferenceContactPageStyle {
    static let background = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .systemGroupedBackground : UIColor(red: 248.0 / 255, green: 249.0 / 255, blue: 250.0 / 255, alpha: 1) })
}
private extension String { var nonempty: String? { let result = trimmingCharacters(in: .whitespacesAndNewlines); return result.isEmpty ? nil : result } }

private struct ReferenceContactAvatar: View {
    let name: String
    let avatarURL: String?
    var body: some View {
        ZStack {
            LinearGradient(colors: [ReferencePrivateChatStyle.avatarTop, ReferencePrivateChatStyle.avatarBottom], startPoint: .top, endPoint: .bottom)
            Text(String(name.prefix(1))).font(.system(size: 29)).foregroundStyle(.white)
            if let avatarURL, let url = APIClient.shared.mediaURL(avatarURL) { StableAvatarImage(url: url) }
        }.frame(width: 70, height: 70).clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
private struct ReferenceContactHeader: View {
    let title: String
    var white = false
    let back: () -> Void
    var trailing: (() -> Void)? = nil
    var body: some View {
        ZStack {
            Text(title).font(.system(size: 17, weight: white ? .regular : .semibold)).lineLimit(1).padding(.horizontal, 58)
            HStack {
                Button(action: back) { Image(systemName: "arrow.left").font(.system(size: 24)).frame(width: 46, height: 50) }.buttonStyle(.plain).accessibilityLabel("返回")
                Spacer()
                if let trailing { Button(action: trailing) { ReferenceContactShareIcon().frame(width: 46, height: 50) }.buttonStyle(.plain).accessibilityLabel("分享联系人") }
            }.padding(.horizontal, 8)
        }.foregroundStyle(white ? .white : PulsePalette.ink).frame(height: 50)
    }
}
private struct ReferenceContactShareIcon: View {
    var body: some View {
        Canvas { context, size in
            let points = [CGPoint(x: size.width * 0.30, y: size.height * 0.50), CGPoint(x: size.width * 0.66, y: size.height * 0.30), CGPoint(x: size.width * 0.66, y: size.height * 0.70)]
            var lines = Path(); lines.move(to: points[1]); lines.addLine(to: points[0]); lines.addLine(to: points[2])
            context.stroke(lines, with: .color(.white), style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
            for point in points {
                let ring = Path(ellipseIn: CGRect(x: point.x - 3.5, y: point.y - 3.5, width: 7, height: 7))
                context.stroke(ring, with: .color(.white), lineWidth: 1.8)
            }
        }.accessibilityHidden(true)
    }
}
private struct ReferenceContactRow: View {
    let title: String
    var detail = ""
    var arrow = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title).font(.system(size: 15)).foregroundStyle(PulsePalette.ink)
                Spacer()
                Text(detail).font(.system(size: 14)).foregroundStyle(PulsePalette.muted).lineLimit(1)
                if arrow { Image(systemName: "chevron.right").font(.system(size: 17)).foregroundStyle(PulsePalette.muted.opacity(0.6)) }
            }.padding(.horizontal, 15).frame(minHeight: 52).contentShape(Rectangle())
        }.buttonStyle(.plain).background(PulsePalette.surface)
    }
}
private func referenceContactLastSeen(_ profile: ContactProfile?) -> String {
    guard let profile else { return "正在获取最近在线时间…" }
    if profile.online { return "在线" }
    if profile.lastSeenHidden == true { return "最近在线时间不可见" }
    guard let seen = profile.lastSeenAt else { return "暂无最近在线时间" }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    guard let date = formatter.date(from: seen.replacingOccurrences(of: "T", with: " ")) else { return "暂无最近在线时间" }
    formatter.dateFormat = "M/d/yy"
    return "\(formatter.string(from: date)) 在线"
}

private struct ReferenceContactPageFrame<Content: View>: View {
    let title: String
    let back: () -> Void
    let content: Content
    init(title: String, back: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.title = title; self.back = back; self.content = content()
    }
    var body: some View {
        VStack(spacing: 0) {
            ReferenceContactHeader(title: title, back: back).background(PulsePalette.surface)
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(ReferenceContactPageStyle.background)
        }.background(PulsePalette.surface.ignoresSafeArea(.container, edges: [.top, .bottom]))
    }
}

@MainActor private struct ContactMoreInfoView: View {
    @ObservedObject var model: ReferenceContactProfileModel
    let back: () -> Void
    let media: () -> Void
    let groups: () -> Void
    @State private var groupCount: Int?
    @State private var failed = false
    @State private var attempt = 0
    var body: some View {
        ReferenceContactPageFrame(title: "更多信息", back: back) {
            VStack(spacing: 0) {
                VStack(spacing: 0) {
                    if model.hasDirectConversation {
                        ReferenceContactRow(title: "分享的媒体文件", arrow: true, action: media)
                        Divider().padding(.horizontal, 15)
                    }
                    ReferenceContactRow(title: "共同加入的群组", detail: (groupCount ?? model.profile?.commonGroupCount).map { "\($0)个" } ?? "…", arrow: true, action: groups)
                }.padding(.horizontal, 15).padding(.top, 8)
                if failed { Button("数量暂时无法加载，点击重试") { attempt += 1 }.font(.footnote).padding(20) }
                Spacer()
            }
        }
        .task(id: attempt) {
            failed = false
            let groupValue = try? await model.commonGroups(page: 1, size: 1)
            guard model.current, !Task.isCancelled else { return }
            groupCount = groupValue?.total
            failed = groupValue == nil
        }
    }
}

@MainActor private struct ReferenceContactMediaView: View {
    @ObservedObject var model: ReferenceContactProfileModel
    let back: () -> Void
    @State private var items: [Message] = []
    @State private var nextPage = 1
    @State private var total = 0
    @State private var hasMore = true
    @State private var clearedBefore = 0
    @State private var loading = false
    @State private var active = false
    @State private var generation = UUID()
    @State private var failure = ""
    @State private var openingID: Int?
    @State private var preview: IOSMediaPreview?
    @State private var photoGallery: IOSPhotoGalleryPresentation?
    var body: some View {
        ReferenceContactPageFrame(title: "分享的媒体文件", back: back) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(items) { message in
                        Button { Task { await open(message) } } label: {
                            HStack(spacing: 12) {
                                Image(systemName: message.type == "image" ? "photo" : message.type == "video" ? "video" : "doc").font(.system(size: 23)).foregroundStyle(PulsePalette.accent).frame(width: 38)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(message.body["name"]?.stringValue ?? message.body["file_name"]?.stringValue ?? (message.type == "image" ? "图片" : message.type == "video" ? "视频文件" : "文件")).font(.system(size: 15)).lineLimit(2)
                                    Text(message.createdAt.replacingOccurrences(of: "T", with: " ")).font(.system(size: 11)).foregroundStyle(PulsePalette.muted)
                                }
                                Spacer()
                                if openingID == message.id { ProgressView() } else { Image(systemName: "chevron.right").foregroundStyle(PulsePalette.muted) }
                            }.padding(15).frame(maxWidth: .infinity, alignment: .leading).background(PulsePalette.surface)
                        }.buttonStyle(.plain).disabled(openingID != nil)
                        Divider().padding(.leading, 65)
                    }
                    if items.isEmpty, !loading { Text("暂无共享媒体").foregroundStyle(PulsePalette.muted).padding(30) }
                    if loading { ProgressView().padding(20) }
                    if !failure.isEmpty { Text(failure).font(.footnote).foregroundStyle(PulsePalette.danger).padding(12) }
                    if !loading, hasMore || !failure.isEmpty { Button(failure.isEmpty ? "加载更多（已加载\(items.count)/\(total)）" : "重试") { Task { await load() } }.padding(20) }
                }.padding(.top, 8)
            }.refreshable { await load(reset: true) }
        }
        .task { active = true; loading = false; openingID = nil; generation = UUID(); await load(reset: true) }
        .onDisappear { active = false; loading = false; openingID = nil; generation = UUID(); preview = nil }
        .pulseSheet(item: $preview) { value in IOSMessageAttachmentPreview(preview: value) }
        .iosPhotoGallery(item: $photoGallery, clearedBefore: clearedBefore,
                         onUnavailable: { failure = "该图片已撤回、已清空或不可查看" })
    }
    private func load(reset: Bool = false) async {
        guard model.current, active, !loading else { return }
        let request = generation; loading = true; failure = ""
        defer { if generation == request { loading = false } }
        var requestedPage = reset ? 1 : nextPage
        do {
            while true {
                let oldCutoff = clearedBefore
                let value = try await model.client.sharedMedia(conversationID: model.conversationID, page: requestedPage)
                guard model.current, active, generation == request, !Task.isCancelled else { return }
                clearedBefore = max(clearedBefore, value.clearedBeforeMessageId)
                items.removeAll { $0.id <= clearedBefore }
                if requestedPage > 1, clearedBefore > oldCutoff {
                    // Clearing changes page offsets: start again from page 1.
                    requestedPage = 1; items = []; continue
                }
                if requestedPage == 1 { items = [] }
                for item in value.visibleItems(clearedBefore: clearedBefore) where !items.contains(where: { $0.id == item.id }) { items.append(item) }
                nextPage = value.page + 1; total = value.total; hasMore = value.hasMore
                return
            }
        } catch { if model.current, active, generation == request, !Task.isCancelled { failure = model.failureMessage(error) } }
    }
    private func open(_ message: Message) async {
        guard model.current, active, openingID == nil else { return }
        let request = generation; openingID = message.id; failure = ""
        defer { if generation == request { openingID = nil } }
        do {
            // Revalidate visibility and use a fresh viewer-specific media URL.
            let located = try await model.client.locateMessage(conversationID: model.conversationID, messageID: message.id)
            guard model.current, active, generation == request, !Task.isCancelled else { return }
            guard let current = located.items.first(where: { $0.id == message.id && $0.conversationId == model.conversationID }), current.id > clearedBefore,
                  current.recalledAt == nil, current.status != "recalled", let raw = current.body["url"]?.stringValue else { throw APIClientError.server("该媒体已撤回、已清空或不可访问") }
            if current.type == "image" {
                photoGallery = IOSPhotoGalleryPresentation(message: current, client: model.client, token: model.token, clearedBefore: clearedBefore)
            } else {
                preview = IOSMediaPreview(messageID: current.id, conversationID: current.conversationId, rawURL: raw, name: current.body["name"]?.stringValue ?? current.body["file_name"]?.stringValue ?? (current.type == "video" ? "视频文件" : "文件"), type: IOSChatMediaDescriptor(message: current)?.kind == .video ? "video" : current.type, client: model.client, token: model.token)
            }
        } catch { if model.current, active, generation == request { failure = model.failureMessage(error) } }
    }
}

@MainActor private struct ReferenceContactGroupsView: View {
    @ObservedObject var model: ReferenceContactProfileModel
    let back: () -> Void
    let open: (Conversation) -> Void
    @State private var items: [Conversation] = []
    @State private var nextPage = 1
    @State private var total = 0
    @State private var hasMore = true
    @State private var loading = false
    @State private var active = false
    @State private var generation = UUID()
    @State private var openingID: Int?
    @State private var failure = ""
    var body: some View {
        ReferenceContactPageFrame(title: "共同加入的群组", back: back) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(items) { group in
                        Button { Task { await openGroup(group) } } label: {
                            HStack(spacing: 12) {
                                PulseAvatar(title: group.name ?? "群", size: 42, avatarURL: group.avatarURL)
                                VStack(alignment: .leading, spacing: 5) { Text(group.name ?? "群组").font(.system(size: 15)); if let count = group.memberCount { Text("\(count) 位成员").font(.system(size: 11)).foregroundStyle(PulsePalette.muted) } }
                                Spacer()
                                if openingID == group.id { ProgressView() } else { Image(systemName: "chevron.right").foregroundStyle(PulsePalette.muted) }
                            }.padding(15).background(PulsePalette.surface)
                        }.buttonStyle(.plain).disabled(openingID != nil)
                        Divider().padding(.leading, 68)
                    }
                    if items.isEmpty, !loading { Text("暂无共同加入的群组").foregroundStyle(PulsePalette.muted).padding(30) }
                    if loading { ProgressView().padding(20) }
                    if !failure.isEmpty { Text(failure).font(.footnote).foregroundStyle(PulsePalette.danger).padding(12) }
                    if !loading, hasMore || !failure.isEmpty { Button(failure.isEmpty ? "加载更多（已加载\(items.count)/\(total)）" : "重试") { Task { await load() } }.padding(20) }
                }.padding(.top, 8)
            }.refreshable { await load(reset: true) }
        }
        .task { active = true; loading = false; openingID = nil; generation = UUID(); await load(reset: true) }
        .onDisappear { active = false; loading = false; openingID = nil; generation = UUID() }
    }
    private func load(reset: Bool = false) async {
        guard model.current, active, !loading else { return }
        let request = generation; loading = true; failure = ""
        defer { if generation == request { loading = false } }
        do {
            let value = try await model.commonGroups(page: reset ? 1 : nextPage)
            guard model.current, active, request == generation, !Task.isCancelled else { return }
            if value.page == 1 { items = [] }
            for item in value.items where !items.contains(where: { $0.id == item.id }) { items.append(item) }
            total = value.total; hasMore = value.hasMore; nextPage = value.page + 1
        } catch { if model.current, active, request == generation, !Task.isCancelled { failure = model.failureMessage(error) } }
    }
    private func openGroup(_ group: Conversation) async {
        guard model.current, active, openingID == nil else { return }
        let request = generation; openingID = group.id
        defer { if request == generation { openingID = nil } }
        do {
            try await model.revalidateSource()
            let current = try await model.client.conversationInfo(id: group.id)
            guard model.current, active, request == generation, !Task.isCancelled else { return }
            guard current.id == group.id, current.type == "group" else { throw APIClientError.invalidResponse }
            open(current)
        } catch { if model.current, active, request == generation { failure = model.failureMessage(error) } }
    }
}

@MainActor private struct ReferenceContactRemarkView: View {
    @EnvironmentObject private var session: AppSession
    @ObservedObject var model: ReferenceContactProfileModel
    let back: () -> Void
    @State private var remark = ""
    @State private var group = ""
    @State private var active = false
    var body: some View {
        ReferenceContactPageFrame(title: "分组和备注", back: back) {
            Form {
                Section("备注") { TextField("设置备注名", text: $remark).textInputAutocapitalization(.never).pulseOnChange(of: remark) { value in if value.count > 64 { remark = String(value.prefix(64)) } } }
                Section("分组") { TextField("输入分组名称", text: $group).textInputAutocapitalization(.never).pulseOnChange(of: group) { value in if value.count > 64 { group = String(value.prefix(64)) } } }
                Section { Text("分组和备注会在当前账号的其他设备同步。留空可清除备注或分组。").font(.footnote).foregroundStyle(PulsePalette.muted) }
                Section { Button { Task {
                    let saved = await model.saveRemark(remark.trimmingCharacters(in: .whitespacesAndNewlines), group: group.trimmingCharacters(in: .whitespacesAndNewlines))
                    if saved, model.current, active {
                        if let profile = model.profile { session.rememberContactName(userID: profile.userId, nickname: profile.nickname, remark: profile.remark ?? "") }
                        session.refreshContactNames(force: true); session.conversationDidChange(); back()
                    }
                } } label: { if model.busy { ProgressView() } else { Text("保存") } }.disabled(model.busy || model.isContact != true) }
            }
        }
        .onAppear { active = true; remark = model.profile?.remark ?? ""; group = model.profile?.groupName ?? "" }
        .onDisappear { active = false }
    }
}

@MainActor private struct ReferenceShareContactView: View {
    @ObservedObject var model: ReferenceContactProfileModel
    let back: () -> Void
    @State private var contacts: [Contact] = []
    @State private var active = false
    @State private var generation = UUID()
    @State private var sending = false
    @State private var loading = false
    @State private var failure = ""
    @State private var sentName = ""
    @State private var selectedContact: Contact?
    var body: some View {
        ReferenceContactPageFrame(title: "分享联系人", back: back) {
            List {
                Section("选择要接收名片的联系人") {
                    ForEach(contacts.filter { $0.userId != model.userID }) { contact in
                        Button { selectedContact = contact } label: { HStack(spacing: 12) { PulseAvatar(title: contact.nickname, size: 42, avatarURL: contact.avatarURL); VStack(alignment: .leading, spacing: 3) { Text(contact.remark?.nonempty ?? contact.nickname); Text("用户 ID：\(PublicUserIdentity.display(contact.publicID))").font(.caption).foregroundStyle(PulsePalette.muted) }; Spacer(); Image(systemName: "paperplane").foregroundStyle(PulsePalette.accent) } }.disabled(sending)
                    }
                    if contacts.isEmpty, !loading { Text("暂无可分享的联系人").foregroundStyle(PulsePalette.muted) }
                    if loading || sending { ProgressView() }
                    if !failure.isEmpty { Text(failure).foregroundStyle(PulsePalette.danger); Button("重试加载联系人") { Task { await load() } }.disabled(sending) }
                }
            }
        }
        .task { active = true; generation = UUID(); await load() }
        .onDisappear { active = false; generation = UUID() }
        .confirmationDialog("发送联系人名片", isPresented: Binding(get: { selectedContact != nil }, set: { if !$0 { selectedContact = nil } }), titleVisibility: .visible) {
            if let contact = selectedContact { Button("发送给\(contact.nickname)") { selectedContact = nil; Task { await send(contact) } } }
            Button("取消", role: .cancel) { selectedContact = nil }
        }
        .alert("发送成功", isPresented: Binding(get: { !sentName.isEmpty }, set: { if !$0 { sentName = "" } })) { Button("知道了") { sentName = "" } } message: { Text("已将名片发送给\(sentName)") }
    }
    private func load() async {
        guard model.current, active, !loading else { return }
        let request = generation; loading = true; failure = ""
        defer { if generation == request { loading = false } }
        do {
            try await model.revalidateSource()
            guard model.current, active, request == generation, !Task.isCancelled else { return }
            let result = try await model.client.contacts()
            guard model.current, active, request == generation, !Task.isCancelled else { return }
            contacts = result
        } catch { if model.current, active, request == generation { failure = model.failureMessage(error) } }
    }
    private func send(_ contact: Contact) async {
        guard model.current, active, !sending else { return }
        let request = generation; let submission = model.cardSubmission(receiverID: contact.userId)
        sending = true; failure = ""
        defer { if generation == request { sending = false } }
        do {
            try await model.revalidateSource()
            guard model.current, active, request == generation, !Task.isCancelled else { return }
            let conversationID: Int
            if let existing = submission.conversationID { conversationID = existing }
            else {
                let conversation = try await model.client.createDirectConversation(userID: contact.userId)
                guard model.current, active, request == generation, !Task.isCancelled else { return }
                conversationID = conversation.id
                model.rememberCardConversation(receiverID: contact.userId, requestID: submission.requestID, conversationID: conversationID)
            }
            guard model.current, active, request == generation, !Task.isCancelled else { return }
            let sent = try await model.client.sendRawMessage(conversationID: conversationID, type: "contact_card", body: submission.body, requestID: submission.requestID)
            guard sent.conversationId == conversationID else { throw APIClientError.invalidResponse }
            if model.current { model.acknowledgeCard(receiverID: contact.userId, requestID: submission.requestID) }
            guard model.current, active, request == generation else { return }
            sentName = contact.nickname
        } catch { if model.current, active, request == generation { failure = "\(error.localizedDescription)\n再次确认发送给同一联系人会复用请求编号，避免重复发送。" } }
    }
}
