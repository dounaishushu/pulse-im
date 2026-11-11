import SwiftUI
import PhotosUI
import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit
import Photos
import WebKit

struct RootView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("pulse_theme") private var theme = "system"

    var body: some View {
        Group {
            if session.isSignedIn {
                ZStack {
                    MainTabsView().id(session.token)
                    if let announcement = session.activeAnnouncement { AnnouncementOverlay(announcement: announcement) }
                    if appLock.isLocked { IOSAppLockScreen() }
                }
            } else if session.token != nil { sessionRestorationScreen }
            else { IOSLoginScreen().ignoresSafeArea().statusBar(hidden: true) }
        }
        .tint(PulsePalette.accent)
        .alert("记住密码", isPresented: Binding(get: { !session.rememberedLoginNotice.isEmpty }, set: { if !$0 { session.rememberedLoginNotice = "" } })) {
            Button("知道了") { session.rememberedLoginNotice = "" }
        } message: { Text(session.rememberedLoginNotice) }
        .preferredColorScheme(theme == "dark" ? .dark : theme == "light" ? .light : nil)
        .task {
            session.setAppActive(scenePhase == .active)
            IOSLocalStorageService.applyRetentionPolicy(rawValue: UserDefaults.standard.string(forKey: "pulse_cache_retention") ?? IOSCacheRetention.permanent.rawValue)
            async let configuration: Void = session.loadClientConfig()
            await session.restore()
            await configuration
        }
        .pulseFullScreenCover(isPresented: Binding(get: { session.updateRequired }, set: { _ in })) { IOSUpdateView(required: true).interactiveDismissDisabled() }
        .pulseChatPresentation(item: $session.notificationConversation)
        .pulseOnChange(of: scenePhase) { phase in
            switch phase {
            case .background: appLock.recordBackground(); session.setAppActive(false)
            case .active: session.setAppActive(true); appLock.checkWhenActive(); Task { await session.loadClientConfig(); await session.openPendingNotification() }
            default: break
            }
        }
    }

    private var sessionRestorationScreen: some View {
        VStack(spacing: 18) {
            if session.restoringSession || session.restoreMessage.isEmpty { ProgressView().controlSize(.large) }
            else { Image(systemName: "wifi.exclamationmark").font(.system(size: 32)).foregroundStyle(PulsePalette.muted) }
            Text(session.restoreMessage.isEmpty ? "正在恢复登录" : "暂时无法连接").font(.title3.weight(.semibold))
            Text(session.restoreMessage.isEmpty ? "正在安全验证登录状态，请稍候。" : session.restoreMessage)
                .font(.subheadline).foregroundStyle(PulsePalette.muted).multilineTextAlignment(.center)
            if !session.restoreMessage.isEmpty {
                Button("重新连接") { Task { await session.restore() } }.buttonStyle(PulsePrimaryButtonStyle()).disabled(session.restoringSession)
            }
            Button("使用其他账号登录") { session.signOut() }.font(.subheadline)
        }
        .padding(28).frame(maxWidth: 420).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PulsePalette.background.ignoresSafeArea())
    }
}

// Every conversation uses the same full-screen route, including group chats
// opened from contacts, search and push notifications.
@MainActor private struct PulseChatPresentation: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Binding var selection: Conversation?

    func body(content: Content) -> some View {
        content
            .pulseFullScreenCover(item: $selection) { conversation in
                PulseNavigationStack { ChatView(conversation: conversation, actorID: session.user?.id) }
            }
            .pulseOnChange(of: session.token) { _ in
                selection = nil
            }
            .pulseOnChange(of: session.isSignedIn) { signedIn in
                if !signedIn { selection = nil }
            }
            .pulseOnChange(of: session.updateRequired) { required in
                if required { selection = nil }
            }
            .pulseOnChange(of: appLock.isLocked) { locked in
                if locked { selection = nil }
            }
    }

}

extension View {
    @MainActor func pulseChatPresentation(item: Binding<Conversation?>) -> some View {
        modifier(PulseChatPresentation(selection: item))
    }
}

struct RoutePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var routes = VerifiedRoutes.shared.routes
    @State private var currentID = VerifiedRoutes.shared.current.id
    @State private var goURL = APIClient.shared.serverIdentity
    @State private var feedback = ""
    @State private var busy = false
    var body: some View {
        PulseNavigationStack {
            List {
                if APIClient.shared.isGoV2 {
                    Section("聊天服务器") {
                        #if DEBUG
                        TextField("服务地址", text: $goURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        Button("检测并保存") { Task { await selectGoServer() } }.disabled(busy || !APIClient.shared.webSocketToken.isEmpty)
                        if !APIClient.shared.webSocketToken.isEmpty { Text("退出当前账号后可切换服务器。").font(.footnote) }
                        #else
                        Text(APIClient.shared.baseURLDescription)
                        #endif
                    }
                } else {
                Section {
                    ForEach(routes) { route in
                        Button {
                            busy = true; feedback = "正在检测并切换…"
                            Task { do { try await VerifiedRoutes.shared.select(route.id); currentID = VerifiedRoutes.shared.current.id; feedback = "已切换到" + route.name } catch { feedback = error.localizedDescription }; busy = false }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: route.id == currentID ? "checkmark.circle.fill" : "circle").foregroundStyle(PulsePalette.accent)
                                VStack(alignment: .leading, spacing: 4) { Text(route.name).foregroundStyle(PulsePalette.ink); Text(route.id == currentID ? "正在使用" : route.id == VerifiedRoutes.shared.preferred ? "优先线路" : "可选线路").font(.caption).foregroundStyle(PulsePalette.muted) }
                                Spacer()
                                Text(VerifiedRoutes.shared.latency(route.id).map { "\($0) ms" } ?? "待检测").font(.caption).foregroundStyle(PulsePalette.muted)
                            }
                        }.disabled(busy)
                    }
                } footer: { Text("持续高延迟或连接异常时自动尝试更优线路，也可手动切换") }
                }
                if !feedback.isEmpty { Text(feedback).font(.footnote).foregroundStyle(PulsePalette.muted) }
                Button("更新线路并检测") { Task { await refresh() } }.disabled(busy)
            }.navigationTitle("选择线路").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
                .task { await refresh() }
                .onReceive(NotificationCenter.default.publisher(for: .pulseRouteChanged)) { _ in routes = VerifiedRoutes.shared.routes; currentID = VerifiedRoutes.shared.current.id }
        }
    }
    @MainActor private func selectGoServer() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let value = goURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard let url = URL(string: value), GoV2Transport.validBase(url), APIClient.allowedEndpoint(url) else { throw APIClientError.server("服务地址须以 /api/v2 结尾") }
            let config = try await GoV2Transport(baseURL: url, token: nil).request("/client/config")
            guard config["protocol"] as? String == "pulse-v2", APIClient.shared.switchBaseURL(value) else { throw APIClientError.server("保存失败，请先退出账号并确认服务器地址") }
            feedback = "服务器已保存"
        } catch { feedback = error.localizedDescription }
    }
    @MainActor private func refresh() async {
        if APIClient.shared.isGoV2 {
            do { _ = try await APIClient.shared.clientConfig(); feedback = "服务器连接正常" }
            catch { feedback = error.localizedDescription }
            return
        }
        busy = true
        let updated = await VerifiedRoutes.shared.refresh(); let candidates = VerifiedRoutes.shared.routes
        await withTaskGroup(of: Void.self) { group in
            for route in candidates.prefix(8) { group.addTask { _ = try? await VerifiedRoutes.shared.probe(route) } }
        }
        routes = VerifiedRoutes.shared.routes; currentID = VerifiedRoutes.shared.current.id
        feedback = updated ? "线路已更新，延迟仅供当前网络参考" : "暂时无法更新，仍可选择已保存线路"
        busy = false
    }
}

struct MainTabsView: View {
    @EnvironmentObject private var session: AppSession
    @State private var selection = 0
    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch selection {
                case 1: ModernContactsView()
                case 2: ExploreView()
                case 3: TaskView()
                case 4: ProfileView()
                default: ConversationListView()
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            PulseTabBar(selection: $selection, pendingFriendRequestCount: session.pendingFriendRequestCount)
        }.background(PulsePalette.background.ignoresSafeArea())
        .pulseSwipeBack(enabled: selection != 0, identity: selection) { selection = 0 }
        .environment(\.pulseTabBack, PulseTabBackAction(enabled: selection != 0, perform: { selection = 0 }))
        .task { try? await session.refreshFriendRequestBadge() }
        .pulseOnChange(of: selection) { _ in Task { try? await session.refreshFriendRequestBadge() } }
    }
}

struct ConversationListView: View {
    @EnvironmentObject private var session: AppSession
    @State private var editing = false
    @State private var selectedIDs = Set<Int>()
    @State private var showingMenu = false
    @State private var startChat = false
    @State private var createGroup = false
    @State private var addFriend = false
    @State private var scanner = false
    @State private var openedConversation: Conversation?
    @State private var error = ""
    @State private var working = false
    @State private var keyword = ""
    @FocusState private var searchFocused: Bool

    private var filteredConversations: [Conversation] {
        let query = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return session.conversations }
        return session.conversations.filter { conversation in
            var values = [ReferenceConversationAppearance.title(conversation), ReferenceConversationAppearance.subtitle(conversation)]
            if let peerID = conversation.peerUserId, let contact = session.contacts.first(where: { $0.userId == peerID }) {
                values += [contact.nickname, contact.remark ?? "", contact.username ?? "", contact.publicID ?? ""]
            }
            return values.contains { $0.localizedStandardContains(query) }
        }
    }

    var body: some View {
        PulseNavigationStack {
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 0) {
                    chatHeader
                    if !session.chatNotice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { noticeRow }
                    searchBar
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            if session.conversations.isEmpty { EmptyState(icon: "bubble.left.and.bubble.right", title: "还没有会话", message: "点击右上角加号开始聊天").padding(.top, 90) }
                            else if filteredConversations.isEmpty { EmptyState(icon: "magnifyingglass", title: "未找到匹配会话", message: "尝试其他会话名称或最近消息中的文字").padding(.top, 70) }
                            else { ForEach(filteredConversations) { conversation in conversationCell(conversation) } }
                        }.padding(.bottom, editing ? 74 : 12)
                    }.scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively).refreshable { await reload() }
                    if editing { editActionBar }
                }.background(ReferenceConversationAppearance.background)

                if showingMenu {
                    Color.black.opacity(0.18).ignoresSafeArea().onTapGesture { withAnimation(.easeOut(duration: 0.18)) { showingMenu = false } }
                    PlusActionMenu(
                        onStartChat: { closeMenu(); startChat = true },
                        onCreateGroup: { closeMenu(); createGroup = true },
                        onAddFriend: { closeMenu(); addFriend = true },
                        onScan: { closeMenu(); scanner = true }
                    ).padding(.top, 48).padding(.trailing, 12).transition(.scale(scale: 0.9, anchor: .topTrailing).combined(with: .opacity))
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .pulseSheet(isPresented: $startChat) { IOSStartChatView() }
            .pulseSheet(isPresented: $createGroup) { IOSCreateGroupView() }
            .pulseSheet(isPresented: $addFriend) { IOSAddFriendView() }
            .pulseFullScreenCover(isPresented: $scanner) { IOSScannerView() }
            .pulseChatPresentation(item: $openedConversation)
            .alert("操作失败", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") { error = "" } } message: { Text(error) }
            .pulseOnChange(of: session.token) { _ in keyword = ""; editing = false; selectedIDs.removeAll(); showingMenu = false; searchFocused = false }
            .background(PulsePalette.surface.ignoresSafeArea(.container, edges: .top))
        }
    }

    private var chatHeader: some View {
        ZStack {
            Text(editing ? "已选中 \(selectedIDs.count) 个聊天" : "聊天").font(.system(size: 16, weight: .semibold)).foregroundStyle(PulsePalette.ink).lineLimit(1).padding(.horizontal, 66)
            HStack {
                Button {
                    searchFocused = false; showingMenu = false
                    withAnimation(.easeInOut(duration: 0.18)) { editing.toggle(); if !editing { selectedIDs.removeAll() } }
                } label: {
                    Group {
                        if editing { Text("完成").font(.system(size: 14)) }
                        else { Image(systemName: "square.and.pencil").font(.system(size: 22, weight: .medium)) }
                    }.frame(width: 44, height: 44)
                }.buttonStyle(.plain).foregroundStyle(PulsePalette.ink).accessibilityLabel(editing ? "完成编辑" : "编辑聊天").disabled(working)
                Spacer()
                if !editing {
                    Button { searchFocused = false; withAnimation(.easeOut(duration: 0.18)) { showingMenu.toggle() } } label: { Image(systemName: "plus").font(.system(size: 24, weight: .regular)).foregroundStyle(PulsePalette.ink).frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel("添加聊天")
                }
            }
        }
        .padding(.horizontal, 8).frame(height: 44).background(PulsePalette.surface)
    }

    private var noticeRow: some View {
        Button { if session.activeAnnouncement == nil { Task { await session.loadClientConfig() } } } label: {
            HStack(spacing: 7) { ReferenceConversationNoticeIcon().frame(width: 14, height: 16); Text(session.chatNotice).font(.system(size: 13)).foregroundStyle(PulsePalette.ink).lineLimit(1); Spacer(minLength: 0) }
                .padding(.horizontal, 13).frame(height: 32).background(PulsePalette.surface)
        }.buttonStyle(.plain)
    }

    private var searchBar: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass").font(.system(size: 20, weight: .regular)).foregroundStyle(PulsePalette.muted)
                TextField("搜索消息、用户或群", text: $keyword).font(.system(size: 14)).focused($searchFocused)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                    .accessibilityHint("搜索当前会话名称、已有联系人资料和最近一条消息")
                if !keyword.isEmpty { Button { keyword = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 15)).foregroundStyle(PulsePalette.muted) }.buttonStyle(.plain).accessibilityLabel("清除搜索") }
            }.padding(.horizontal, 13).frame(height: 37).background(ReferenceConversationAppearance.searchBackground, in: RoundedRectangle(cornerRadius: 10))
            if !keyword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Text("仅搜索当前会话和最近消息").font(.system(size: 11)).foregroundStyle(PulsePalette.muted) }
        }.padding(.horizontal, 15).padding(.vertical, 6).background(PulsePalette.surface)
    }

    @ViewBuilder private func conversationCell(_ conversation: Conversation) -> some View {
        if editing {
            ConversationRow(conversation: conversation, isSelected: selectedIDs.contains(conversation.id), editing: true) { toggle(conversation) }
                .contentShape(Rectangle()).onTapGesture { toggle(conversation) }
        } else {
            Button {
                guard openedConversation == nil, conversation.id > 0, session.isSignedIn, !session.updateRequired else { return }
                searchFocused = false; openedConversation = conversation
            } label: { ConversationRow(conversation: conversation, isSelected: false, editing: false, action: {}) }
                .buttonStyle(.plain).disabled(openedConversation != nil)
        }
    }

    private var editActionBar: some View {
        HStack(spacing: 0) {
            Button { Task { await markSelectedRead() } } label: { VStack(spacing: 4) { Image(systemName: "checkmark.circle"); Text("设为已读") } }.disabled(selectedIDs.isEmpty || working)
            Button(role: .destructive) { Task { await deleteSelected() } } label: { VStack(spacing: 4) { Image(systemName: "trash"); Text("删除") } }.disabled(selectedIDs.isEmpty || working)
        }.font(.system(size: 13, weight: .medium)).foregroundStyle(selectedIDs.isEmpty ? PulsePalette.muted : PulsePalette.accent).frame(maxWidth: .infinity).padding(.vertical, 10).background(PulsePalette.surface.shadow(.drop(color: .black.opacity(0.1), radius: 8, y: -2)))
    }

    private func closeMenu() { withAnimation(.easeOut(duration: 0.18)) { showingMenu = false } }
    private func toggle(_ conversation: Conversation) { if selectedIDs.contains(conversation.id) { selectedIDs.remove(conversation.id) } else { selectedIDs.insert(conversation.id) } }
    private func reload() async { do { try await session.refreshConversations() } catch { error = error.localizedDescription } }
    private func markSelectedRead() async {
        guard !working else { return }; working = true; defer { working = false }
        for conversation in session.conversations where selectedIDs.contains(conversation.id) { try? await APIClient.shared.markConversationRead(conversation) }
        await reload(); editing = false; selectedIDs.removeAll()
    }
    private func deleteSelected() async {
        guard !working else { return }; working = true; defer { working = false }
        for conversation in session.conversations where selectedIDs.contains(conversation.id) { do { try await APIClient.shared.hideConversation(id: conversation.id) } catch { error = error.localizedDescription } }
        await reload(); editing = false; selectedIDs.removeAll()
    }
}

struct ConversationRow: View {
    @EnvironmentObject private var session: AppSession
    let conversation: Conversation
    let isSelected: Bool
    let editing: Bool
    let action: () -> Void

    private var title: String {
        let fallback = ReferenceConversationAppearance.title(conversation)
        return conversation.type == "direct" ? session.contactDisplayName(userID: conversation.peerUserId ?? 0, fallback: fallback) : fallback
    }
    private var subtitle: String { ReferenceConversationAppearance.subtitle(conversation) }
    private var timeText: String { conversation.lastMessage.map { IOSChatMessageDisplay.timeLabel($0.createdAt) } ?? "" }

    var body: some View {
        HStack(spacing: 12) {
            if editing { Image(systemName: isSelected ? "checkmark.circle.fill" : "circle").font(.system(size: 23)).foregroundStyle(isSelected ? PulsePalette.accent : PulsePalette.muted) }
            ReferenceConversationAvatar(conversation: conversation, title: title)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 5) {
                    Text(title).font(.system(size: 17)).foregroundStyle(PulsePalette.ink).lineLimit(1)
                    if conversation.type == "group" { Image(systemName: "person.2.fill").font(.system(size: 13)).foregroundStyle(Color(hex: 0x149CE8)) }
                    if conversation.type == "channel" { Image(systemName: "checkmark.seal.fill").font(.system(size: 13)).foregroundStyle(Color(hex: 0x2DB5DE)) }
                    Spacer(minLength: 4)
                    Text(timeText).font(.system(size: 12)).foregroundStyle(PulsePalette.muted).fixedSize()
                }
                HStack(spacing: 6) {
                    if conversation.type == "group", conversation.unreadMentionCount > 0 {
                        Text("有人@你").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.red).fixedSize()
                    }
                    Text(subtitle).font(.system(size: 14)).foregroundStyle(PulsePalette.muted).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    if conversation.unreadCount > 0 { Text(conversation.unreadCount > 99 ? "99+" : "\(conversation.unreadCount)").font(.system(size: 11, weight: .medium)).foregroundStyle(.white).padding(.horizontal, 5).padding(.vertical, 2).background(Capsule().fill(PulsePalette.accent)) }
                }
            }
        }.padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 84).background(PulsePalette.surface).overlay(alignment: .bottom) { Rectangle().fill(PulsePalette.line.opacity(0.45)).frame(height: 0.5).padding(.leading, editing ? 118 : 84) }
    }
}

private enum ReferenceConversationAppearance {
    static let background = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .secondarySystemBackground : UIColor(red: 248.0 / 255, green: 249.0 / 255, blue: 250.0 / 255, alpha: 1) })
    static let searchBackground = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .tertiarySystemBackground : UIColor(red: 245.0 / 255, green: 246.0 / 255, blue: 248.0 / 255, alpha: 1) })
    static func title(_ conversation: Conversation) -> String { conversation.name ?? (conversation.type == "direct" ? "私聊" : conversation.type == "favorites" ? "我的收藏" : "会话") }
    static func subtitle(_ conversation: Conversation) -> String {
        guard let message = conversation.lastMessage else { return conversation.type == "group" ? "群组" : conversation.type == "channel" ? "频道" : "暂无消息" }
        switch message.type {
        case "image": return "图片"
        case "voice": return "语音消息"
        case "video": return "视频文件"
        case "file": return message.body["name"]?.stringValue ?? message.body["file_name"]?.stringValue ?? "文件"
        case "contact_card": return "联系人名片：\(message.body["nickname"]?.stringValue ?? "联系人")"
        case "shake": return "窗口抖动"
        case "red_packet": return "历史红包已停用"
        default: return message.body["text"]?.stringValue ?? "消息"
        }
    }
}

private struct ReferenceConversationAvatar: View {
    let conversation: Conversation
    let title: String
    private var colors: [Color] {
        switch conversation.type {
        case "group": return [Color(hex: 0xFFD268), Color(hex: 0xFFA24D)]
        case "direct": return [Color(hex: 0xA2E86F), Color(hex: 0x46C85B)]
        case "channel": return [Color(hex: 0xFF9258), Color(hex: 0xFF4C72)]
        case "favorites": return [Color(hex: 0x5C9FFF), Color(hex: 0x357BE7)]
        default:
            let hash = title.utf8.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
            let palette: [[Color]] = [[Color(hex: 0xFFD268), Color(hex: 0xFFA24D)], [Color(hex: 0xA2E86F), Color(hex: 0x46C85B)], [Color(hex: 0xFF9258), Color(hex: 0xFF4C72)]]
            return palette[Int(hash % 3)]
        }
    }
    var body: some View {
        ZStack {
            LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
            Text(String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1))).font(.system(size: 26, weight: .regular)).foregroundStyle(.white)
            if let raw = conversation.avatarURL, let url = APIClient.shared.mediaURL(raw) { StableAvatarImage(url: url) }
        }.frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous)).accessibilityHidden(true)
    }
}

private struct ReferenceConversationNoticeIcon: View {
    var body: some View {
        Canvas { context, size in
            var cone = Path(); cone.move(to: CGPoint(x: size.width * 0.25, y: size.height * 0.31)); cone.addLine(to: CGPoint(x: size.width * 0.87, y: size.height * 0.05)); cone.addLine(to: CGPoint(x: size.width * 0.87, y: size.height * 0.93)); cone.addLine(to: CGPoint(x: size.width * 0.25, y: size.height * 0.68)); cone.closeSubpath()
            context.fill(cone, with: .linearGradient(Gradient(colors: [Color(hex: 0x8938F5), Color(hex: 0x3C17E6)]), startPoint: .zero, endPoint: CGPoint(x: size.width, y: size.height)))
            context.fill(Path(CGRect(x: 0, y: size.height * 0.34, width: size.width * 0.30, height: size.height * 0.31)), with: .color(Color(hex: 0x32CDE4)))
            context.fill(Path(CGRect(x: size.width * 0.13, y: size.height * 0.68, width: size.width * 0.15, height: size.height * 0.23)), with: .color(Color(hex: 0xB6E447)))
        }.accessibilityHidden(true)
    }
}

struct PlusActionMenu: View {
    let onStartChat: () -> Void
    let onCreateGroup: () -> Void
    let onAddFriend: () -> Void
    let onScan: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            menuButton("bubble.left.and.bubble.right", "发起聊天", onStartChat)
            menuButton("person.3", "新建群组", onCreateGroup)
            menuButton("person.badge.plus", "添加朋友", onAddFriend)
            menuButton("qrcode.viewfinder", "扫一扫", onScan)
        }.padding(.vertical, 6).frame(width: 178).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous)).shadow(color: .black.opacity(0.2), radius: 18, y: 7)
    }
    private func menuButton(_ icon: String, _ title: String, _ action: @escaping () -> Void) -> some View { Button(action: action) { HStack(spacing: 12) { Image(systemName: icon).font(.system(size: 18)).frame(width: 22); Text(title).font(.system(size: 15)); Spacer() }.foregroundStyle(PulsePalette.ink).padding(.horizontal, 16).frame(height: 44) }.buttonStyle(.plain) }
}

struct IOSStartChatView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var keyword = ""
    @State private var contacts: [Contact] = []
    @State private var results: [SearchUser] = []
    @State private var conversation: Conversation?
    @State private var error = ""
    @State private var searchRevision = 0
    @State private var isSearchVisible = false

    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 0) {
                searchField
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if !results.isEmpty { listTitle("搜索结果"); ForEach(results) { userRow($0) } }
                        listTitle("联系人")
                        if contacts.isEmpty && results.isEmpty { EmptyState(icon: "person.2", title: "还没有联系人", message: "先添加好友后再发起聊天").padding(.top, 60) }
                        else { ForEach(contacts) { contactRow($0) } }
                    }.padding(.bottom, 20)
                }.scrollIndicators(.hidden)
                Text("共 \(contacts.count) 个联系人").font(.caption).foregroundStyle(PulsePalette.muted).padding(.vertical, 9)
            }.background(PulsePalette.background).navigationTitle("发起聊天").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
                .task { await loadContacts() }
                .pulseChatPresentation(item: $conversation)
                .onAppear { isSearchVisible = true }
                .onDisappear { isSearchVisible = false; searchRevision += 1 }
                .pulseOnChange(of: session.token) { _ in searchRevision += 1; results = []; contacts = [] }
                .alert("提示", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") { error = "" } } message: { Text(error) }
        }
    }

    private var searchField: some View { HStack(spacing: 8) { Image(systemName: "magnifyingglass").foregroundStyle(PulsePalette.muted); TextField("搜索联系人", text: $keyword).onSubmit { search() }; if !keyword.isEmpty { Button { keyword = ""; results = [] } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(PulsePalette.muted) } } }.padding(.horizontal, 13).frame(height: 42).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous)).padding(12) }
    private func listTitle(_ value: String) -> some View { Text(value).font(.system(size: 13, weight: .semibold)).foregroundStyle(PulsePalette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 9) }
    private func contactRow(_ contact: Contact) -> some View { Button { Task { await open(userID: contact.userId) } } label: { HStack(spacing: 12) { PulseAvatar(title: contact.nickname, size: 44, avatarURL: contact.avatarURL); VStack(alignment: .leading, spacing: 3) { Text(contact.nickname).font(.system(size: 16)).foregroundStyle(PulsePalette.ink); Text("用户 ID：\(PublicUserIdentity.display(contact.publicID))").font(.caption).foregroundStyle(PulsePalette.muted) }; Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(PulsePalette.muted) }.padding(.horizontal, 16).padding(.vertical, 10).background(PulsePalette.surface).overlay(alignment: .bottom) { Rectangle().fill(PulsePalette.line).frame(height: 0.5).padding(.leading, 72) } }.buttonStyle(.plain) }
    @MainActor private func loadContacts() async {
        guard session.isSignedIn, let token = session.token, let viewerID = session.user?.id else { return }
        let client = APIClient.shared.captureSession()
        let items = try? await client.contacts()
        guard isSearchVisible, session.isSignedIn, session.token == token, session.user?.id == viewerID,
              client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
        contacts = items ?? []
    }
    private func userRow(_ user: SearchUser) -> some View { Button { Task { await open(userID: user.id) } } label: { HStack(spacing: 12) { PulseAvatar(title: user.nickname, size: 44, avatarURL: user.avatarURL); VStack(alignment: .leading, spacing: 3) { Text(user.nickname).foregroundStyle(PulsePalette.ink); Text("用户 ID：\(PublicUserIdentity.display(user.publicID))").font(.caption).foregroundStyle(PulsePalette.muted) }; Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(PulsePalette.muted) }.padding(.horizontal, 16).padding(.vertical, 10).background(PulsePalette.surface) }.buttonStyle(.plain) }
    @MainActor private func search() {
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, isSearchVisible, session.isSignedIn, let token = session.token, let viewerID = session.user?.id else { return }
        let client = APIClient.shared.captureSession()
        searchRevision += 1; let revision = searchRevision
        func current() -> Bool { isSearchVisible && session.isSignedIn && session.token == token && session.user?.id == viewerID && client.endpointIdentity == APIClient.shared.endpointIdentity && revision == searchRevision && keyword.trimmingCharacters(in: .whitespacesAndNewlines) == value }
        Task {
            do { let items = try await client.searchUsers(keyword: value); if current() { results = items; error = items.isEmpty ? "用户不存在" : "" } }
            catch { if current() { error = error.localizedDescription } }
        }
    }
    @MainActor private func open(userID: Int) async {
        let token = session.token, client = APIClient.shared.captureSession()
        guard session.isSignedIn, token != nil else { return }
        do {
            let item = try await client.createDirectConversation(userID: userID)
            guard session.token == token, session.isSignedIn, client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
            try await session.refreshConversations()
            guard session.token == token, session.isSignedIn, client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
            conversation = item
        } catch {
            if session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity { self.error = error.localizedDescription }
        }
    }
}

struct IOSCreateGroupView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var stage = 1
    @State private var keyword = ""
    @State private var contacts: [Contact] = []
    @State private var selectedIDs = Set<Int>()
    @State private var groupName = ""
    @State private var prohibitMemberAddFriend = false
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarData: Data?
    @State private var error = ""
    @State private var working = false

    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 0) {
                if stage == 1 { memberPicker } else { groupDetails }
            }.background(PulsePalette.background).navigationTitle("新建群组").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { if stage == 1 { Button("下一步") { stage = 2 }.disabled(selectedIDs.isEmpty) } else { Button("创建") { Task { await create() } }.disabled(groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working) } } }
                .task { contacts = (try? await APIClient.shared.contacts()) ?? [] }
                .alert("创建失败", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") { error = "" } } message: { Text(error) }
        }
    }

    private var memberPicker: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) { Image(systemName: "magnifyingglass").foregroundStyle(PulsePalette.muted); TextField("搜索联系人", text: $keyword) }.padding(.horizontal, 13).frame(height: 42).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous)).padding(12)
            Text("选择一个或多个联系人发起群聊").font(.system(size: 13)).foregroundStyle(PulsePalette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 8)
            ScrollView { LazyVStack(spacing: 0) { ForEach(filteredContacts) { contact in Button { toggle(contact.userId) } label: { HStack(spacing: 12) { Image(systemName: selectedIDs.contains(contact.userId) ? "checkmark.circle.fill" : "circle").font(.system(size: 23)).foregroundStyle(selectedIDs.contains(contact.userId) ? PulsePalette.accent : PulsePalette.muted); PulseAvatar(title: contact.nickname, size: 44, avatarURL: contact.avatarURL); Text(contact.nickname).foregroundStyle(PulsePalette.ink); Spacer() }.padding(.horizontal, 16).padding(.vertical, 10).background(PulsePalette.surface).overlay(alignment: .bottom) { Rectangle().fill(PulsePalette.line).frame(height: 0.5).padding(.leading, 95) } }.buttonStyle(.plain) } } }.scrollIndicators(.hidden)
        }
    }

    private var groupDetails: some View {
        ScrollView {
            VStack(spacing: 16) {
                PhotosPicker(selection: $avatarItem, matching: .images) { if let avatarData, let image = UIImage(data: avatarData) { Image(uiImage: image).resizable().scaledToFill().frame(width: 76, height: 76).clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous)) } else { ZStack { RoundedRectangle(cornerRadius: 20, style: .continuous).fill(PulsePalette.accentSoft); Image(systemName: "camera.fill").font(.title2).foregroundStyle(PulsePalette.accent) }.frame(width: 76, height: 76) } }.buttonStyle(.plain)
                PulseCard { VStack(spacing: 0) { TextField("群组名称", text: $groupName).padding(.vertical, 4); Divider().padding(.vertical, 8); Toggle("禁止添加联系人", isOn: $prohibitMemberAddFriend).tint(PulsePalette.accent) } }
                PulseCard { VStack(alignment: .leading, spacing: 9) { Text("群组成员 \(selectedIDs.count + 1)/\(session.groupMemberLimit)").font(.system(size: 15, weight: .semibold)).foregroundStyle(PulsePalette.ink); Text("创建后仍可在群组资料中管理成员和权限").font(.caption).foregroundStyle(PulsePalette.muted); HStack(spacing: -8) { ForEach(Array(selectedIDs.prefix(8)), id: \.self) { id in if let contact = contacts.first(where: { $0.userId == id }) { PulseAvatar(title: contact.nickname, size: 34, avatarURL: contact.avatarURL).overlay(Circle().stroke(PulsePalette.surface, lineWidth: 2)) } } } } }
            }.padding(16)
        }.scrollIndicators(.hidden).pulseOnChange(of: avatarItem) { item in guard let item else { return }; Task { avatarData = try? await item.loadTransferable(type: Data.self) } }
    }

    private var filteredContacts: [Contact] { let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(); return value.isEmpty ? contacts : contacts.filter { $0.nickname.lowercased().contains(value) || ($0.phone ?? "").contains(value) } }
    private func toggle(_ id: Int) { if selectedIDs.contains(id) { selectedIDs.remove(id) } else { selectedIDs.insert(id) } }
    private func create() async {
        working = true; defer { working = false }
        do {
            var avatarURL: String?
            if let avatarData, let image = UIImage(data: avatarData), let data = image.jpegData(compressionQuality: 0.86) { avatarURL = try await APIClient.shared.uploadMedia(data: data, kind: "image", filename: "group-\(UUID().uuidString).jpg", mime: "image/jpeg").url }
            let group = try await APIClient.shared.createGroup(name: groupName.trimmingCharacters(in: .whitespacesAndNewlines), memberIDs: Array(selectedIDs), allowMemberAddFriend: !prohibitMemberAddFriend, avatarURL: avatarURL)
            try await session.refreshConversations(); _ = group; dismiss()
        } catch { error = error.localizedDescription }
    }
}

private enum IOSAddFriendDestination: String, Identifiable { case qrCode, scanner; var id: String { rawValue } }

struct IOSAddFriendView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var keyword = ""
    @State private var results: [SearchUser] = []
    @State private var openingTemporary = false
    @State private var temporaryChat: Conversation?
    @State private var error = ""
    @State private var destination: IOSAddFriendDestination?
    private var qrVisible: Bool { destination == .qrCode }
    private var scannerVisible: Bool { destination == .scanner }
    @State private var verifyUser: SearchUser?
    @State private var showMissing = false
    @State private var searchRevision = 0
    @State private var isSearchVisible = false
    @State private var pendingAdds: [Int: UUID] = [:]
    @State private var latestAdd = UUID()
    @State private var forcedProfile: IOSForcedContactProfileRoute?

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    HStack(spacing: 8) { Image(systemName: "magnifyingglass").foregroundStyle(PulsePalette.muted); TextField("输入完整用户名", text: $keyword).textInputAutocapitalization(.never).autocorrectionDisabled().onSubmit { search() }; Button("搜索") { search() }.font(.system(size: 15, weight: .semibold)) }.padding(.horizontal, 13).frame(height: 44).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                    HStack(spacing: 12) {
                        addAction(icon: "qrcode", title: "我的二维码") { open(.qrCode) }
                        addAction(icon: "qrcode.viewfinder", title: "扫一扫") { open(.scanner) }
                    }
                    if !results.isEmpty { VStack(spacing: 0) { Text("搜索结果").font(.system(size: 13, weight: .semibold)).foregroundStyle(PulsePalette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(12); ForEach(results) { result in HStack(spacing: 12) { PulseAvatar(title: result.nickname, size: 46, avatarURL: result.avatarURL); VStack(alignment: .leading, spacing: 3) { Text(result.nickname).foregroundStyle(PulsePalette.ink); Text("用户 ID：\(PublicUserIdentity.display(result.publicID))").font(.caption).foregroundStyle(PulsePalette.muted) }; Spacer(); if APIClient.shared.isGoV2 { Button("临时聊天") { Task { await startTemporary(result) } }.buttonStyle(PulseSmallButtonStyle()).disabled(openingTemporary || result.id == session.user?.id) }; Button(pendingAdds[result.id] == nil ? "添加" : "添加中…") { Task { await add(result) } }.buttonStyle(PulseSmallButtonStyle()).disabled(pendingAdds[result.id] != nil || forcedProfile != nil) }.padding(12).background(PulsePalette.surface) } }.clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)) }
                    if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(PulsePalette.danger).frame(maxWidth: .infinity, alignment: .leading) }
                }.padding(16)
            }.scrollIndicators(.hidden).background(PulsePalette.background).navigationTitle("添加朋友").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
                .pulseFullScreenCover(item: $destination) { route in
                    switch route { case .qrCode: MyQRCodeView(); case .scanner: IOSScannerView() }
                }
                .pulseForcedContactProfile(item: $forcedProfile)
                .pulseChatPresentation(item: $temporaryChat)
                .onAppear { isSearchVisible = true }
                .onDisappear { isSearchVisible = false; invalidateAdds() }
                .pulseOnChange(of: session.token) { _ in invalidateAdds(); destination = nil; temporaryChat = nil; results = [] }
                .pulseOnChange(of: keyword) { _ in invalidateAdds(); results = [] }
                .pulseOnChange(of: session.user?.id) { _ in invalidateAdds(); results = [] }
                .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in invalidateAdds(); results = [] }
                .pulseOnChange(of: appLock.isLocked) { locked in if locked { invalidateAdds() } }
                .pulseOnChange(of: session.updateRequired) { required in if required { invalidateAdds() } }
                .pulseOnChange(of: scenePhase) { phase in if phase == .background { invalidateAdds() } }
                .pulseOnChange(of: scannerVisible) { shown in if shown { invalidateAdds() } }
                .pulseOnChange(of: qrVisible) { shown in if shown { invalidateAdds() } }
        }
    }

    @MainActor private func startTemporary(_ user: SearchUser) async {
        guard !openingTemporary, session.isSignedIn, !appLock.isLocked, !session.updateRequired, scenePhase == .active else { return }
        let client = APIClient.shared.captureSession(), token = session.token, revision = searchRevision
        openingTemporary = true; error = ""; defer { openingTemporary = false }
        do {
            let conversation = try await client.createDirectConversation(userID: user.id)
            guard isSearchVisible, scenePhase == .active, !appLock.isLocked, !session.updateRequired, !Task.isCancelled,
                  token == session.token, client.endpointIdentity == APIClient.shared.endpointIdentity, revision == searchRevision else { return }
            temporaryChat = conversation
        } catch { if token == session.token, client.endpointIdentity == APIClient.shared.endpointIdentity { self.error = error.localizedDescription } }
    }
    private func addAction(icon: String, title: String, action: @escaping () -> Void) -> some View { Button(action: action) { VStack(spacing: 9) { Image(systemName: icon).font(.title2).foregroundStyle(PulsePalette.accent); Text(title).font(.system(size: 13)).foregroundStyle(PulsePalette.ink) }.frame(maxWidth: .infinity).frame(height: 92).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)) }.buttonStyle(.plain) }
    private func open(_ route: IOSAddFriendDestination) {
        guard destination == nil, forcedProfile == nil, session.isSignedIn, !appLock.isLocked, !session.updateRequired else { return }
        invalidateAdds(); destination = route
    }
    @MainActor private func search() {
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, isSearchVisible, session.isSignedIn, let token = session.token, let viewerID = session.user?.id else { return }
        let client = APIClient.shared.captureSession()
        invalidateAdds(); let revision = searchRevision
        func current() -> Bool { isSearchVisible && session.isSignedIn && session.token == token && session.user?.id == viewerID && client.endpointIdentity == APIClient.shared.endpointIdentity && revision == searchRevision && keyword.trimmingCharacters(in: .whitespacesAndNewlines) == value }
        Task {
            do { let items = try await client.searchUsers(keyword: value); if current() { results = items; error = items.isEmpty ? "用户不存在" : "" } }
            catch { if current() { error = error.localizedDescription } }
        }
    }
    @MainActor private func add(_ user: SearchUser) async {
        guard isSearchVisible, scenePhase == .active, !appLock.isLocked, !session.updateRequired, !scannerVisible, !qrVisible,
              forcedProfile == nil, pendingAdds[user.id] == nil, session.isSignedIn, let token = session.token,
              let viewerID = session.user?.id, user.id > 0, user.id != viewerID, results.contains(where: { $0.id == user.id }) else { return }
        let client = APIClient.shared.captureSession(), internalStaff = session.user?.internalStaff == true
        let operation = UUID(), revision = searchRevision, value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        pendingAdds[user.id] = operation; latestAdd = operation; error = ""
        defer { if pendingAdds[user.id] == operation { pendingAdds.removeValue(forKey: user.id) } }
        func current() -> Bool {
            isSearchVisible && scenePhase == .active && !appLock.isLocked && !session.updateRequired && !scannerVisible && !qrVisible
                && forcedProfile == nil && session.isSignedIn && session.token == token && session.user?.id == viewerID
                && client.endpointIdentity == APIClient.shared.endpointIdentity && revision == searchRevision && latestAdd == operation
                && pendingAdds[user.id] == operation && keyword.trimmingCharacters(in: .whitespacesAndNewlines) == value && !Task.isCancelled
        }
        do {
            if internalStaff { try await client.forceAddContact(userID: user.id) } else { try await client.sendFriendRequest(userID: user.id) }
            guard current() else { return }
            if internalStaff {
                let route = IOSForcedContactProfileRoute(userID: user.id, viewerID: viewerID, token: token, endpoint: client.endpointIdentity)
                forcedProfile = route
                Task { await route.refreshContacts(in: session, using: client) }
            } else { error = "好友申请已发送，等待对方确认" }
        } catch { if current() { error = error.localizedDescription } }
    }
    @MainActor private func invalidateAdds() { searchRevision += 1; latestAdd = UUID(); forcedProfile = nil }
}

struct MyQRCodeView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 22) {
                PulseAvatar(title: session.user?.nickname ?? "我", size: 60, avatarURL: session.user?.avatarURL)
                Text(session.user?.nickname ?? "我的账号").font(.title3.weight(.semibold)).foregroundStyle(PulsePalette.ink)
                Text("用户 ID：\(PublicUserIdentity.display(session.user?.publicID))").font(.subheadline).textSelection(.enabled)
                if let payload = PublicUserIdentity.qrPayload(session.user?.publicID) {
                    QRCodeImage(payload: payload).frame(width: 230, height: 230).padding(18).background(.white).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    Text("扫一扫二维码添加好友").font(.subheadline).foregroundStyle(PulsePalette.muted)
                } else {
                    Text("用户 ID 未就绪，暂时无法生成二维码").font(.subheadline).foregroundStyle(PulsePalette.muted)
                }
                Spacer()
            }.padding(24).frame(maxWidth: .infinity).background(PulsePalette.background).navigationTitle("我的二维码").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
    }
}

struct QRCodeImage: View {
    let payload: String
    var body: some View { if let image = Self.makeImage(payload: payload) { Image(uiImage: image).interpolation(.none).resizable().scaledToFit() } else { Image(systemName: "qrcode").font(.system(size: 120)).foregroundStyle(PulsePalette.ink) } }
    private static let context = CIContext(options: [.useSoftwareRenderer: true])
    private static let cache: NSCache<NSString, UIImage> = { let value = NSCache<NSString, UIImage>(); value.countLimit = 8; return value }()
    static func makeImage(payload: String) -> UIImage? {
        guard !payload.isEmpty, payload.utf8.count <= 2048 else { return nil }
        if let image = cache.object(forKey: payload as NSString) { return image }
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(payload.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let transformed = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cgImage = context.createCGImage(transformed, from: transformed.extent) else { return nil }
        let image = UIImage(cgImage: cgImage); cache.setObject(image, forKey: payload as NSString); return image
    }
}

struct PulseBrandedQRCode: View {
    let payload: String

    var body: some View {
        ZStack {
            QRCodeImage(payload: payload)
                .padding(25)
                .background(Color.white)
            QRCodeCornerMarks()
            ZStack {
                RoundedRectangle(cornerRadius: 7, style: .continuous).fill(PulsePalette.accent)
                Image(systemName: "waveform.path.ecg")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 34, height: 34)
        }
        .padding(7)
    }
}

private struct QRCodeCornerMarks: View {
    var body: some View {
        GeometryReader { proxy in
            Path { path in
                let w = proxy.size.width
                let h = proxy.size.height
                let inset: CGFloat = 4
                let arm: CGFloat = 27
                path.move(to: CGPoint(x: inset + arm, y: inset)); path.addLine(to: CGPoint(x: inset, y: inset)); path.addLine(to: CGPoint(x: inset, y: inset + arm))
                path.move(to: CGPoint(x: w - inset - arm, y: inset)); path.addLine(to: CGPoint(x: w - inset, y: inset)); path.addLine(to: CGPoint(x: w - inset, y: inset + arm))
                path.move(to: CGPoint(x: inset, y: h - inset - arm)); path.addLine(to: CGPoint(x: inset, y: h - inset)); path.addLine(to: CGPoint(x: inset + arm, y: h - inset))
                path.move(to: CGPoint(x: w - inset - arm, y: h - inset)); path.addLine(to: CGPoint(x: w - inset, y: h - inset)); path.addLine(to: CGPoint(x: w - inset, y: h - inset - arm))
            }
            .stroke(PulsePalette.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
        }
    }
}

struct AnnouncementOverlay: View {
    @EnvironmentObject private var session: AppSession
    let announcement: ClientAnnouncement
    var body: some View {
        ZStack {
            Color.black.opacity(0.48).ignoresSafeArea()
            VStack(spacing: 0) {
                Image(systemName: "shield.checkered").font(.system(size: 52, weight: .medium)).foregroundStyle(PulsePalette.accent).padding(.top, 24)
                Text(announcement.title).font(.system(size: 20, weight: .bold)).foregroundStyle(PulsePalette.ink).padding(.top, 16)
                ScrollView { Text(announcement.content).font(.system(size: 15)).foregroundStyle(PulsePalette.ink).multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.horizontal, 20).padding(.top, 18) }.frame(maxHeight: 230)
                Button("我知道了") { session.dismissAnnouncement() }.font(.system(size: 16, weight: .semibold)).foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 48).background(PulsePalette.accent).clipShape(Capsule()).padding(.horizontal, 24).padding(.top, 22).padding(.bottom, 24)
            }.frame(maxWidth: 350).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous)).shadow(color: .black.opacity(0.24), radius: 24)
        }.transition(.opacity)
    }
}

struct IOSScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @State private var torchOn = false
    @State private var photo: PhotosPickerItem?
    @State private var status = "将二维码放入框内即可自动识别"
    @State private var cameraDenied = false
    @State private var cameraAuthorized = false
    @State private var isVisible = false
    @State private var handling = false
    @State private var scanRevision = 0
    @State private var scanOperation: UUID?
    @State private var photoDecodeID: UUID?
    @State private var forcedProfile: IOSForcedContactProfileRoute?
    @State private var lastForcedCode: String?

    var body: some View {
        ZStack {
            if cameraAuthorized, forcedProfile == nil, photoDecodeID == nil, scenePhase == .active, !appLock.isLocked, !session.updateRequired {
                QRScannerPreview(torchOn: torchOn, onFailure: { status = $0 }) { code in Task { await handle(code) } }.ignoresSafeArea()
            } else { Color.black.ignoresSafeArea() }
            LinearGradient(colors: [.black.opacity(0.62), .clear, .black.opacity(0.72)], startPoint: .top, endPoint: .bottom).ignoresSafeArea().allowsHitTesting(false)
            VStack(spacing: 0) {
                HStack { Button { dismiss() } label: { Image(systemName: "xmark").font(.title3).foregroundStyle(.white).frame(width: 40, height: 40) }; Spacer(); Text("扫一扫").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white); Spacer(); Color.clear.frame(width: 40, height: 40) }.padding(.horizontal, 16).padding(.top, 8)
                Spacer()
                RoundedRectangle(cornerRadius: 2).stroke(PulsePalette.accent, lineWidth: 3).frame(width: 245, height: 245).overlay(alignment: .topLeading) { corner }.overlay(alignment: .topTrailing) { corner }.overlay(alignment: .bottomLeading) { corner }.overlay(alignment: .bottomTrailing) { corner }
                Text(cameraDenied ? "请在系统设置中允许相机权限" : status).font(.system(size: 14)).foregroundStyle(.white).padding(.top, 22)
                Spacer()
                HStack(spacing: 58) {
                    PhotosPicker(selection: $photo, matching: .images) { scannerBottomItem("photo", "相册") }
                    Button { torchOn.toggle() } label: { scannerBottomItem(torchOn ? "flashlight.on.fill" : "flashlight.off.fill", "开灯") }
                }.padding(.bottom, 38)
            }
        }.preferredColorScheme(.dark)
            .pulseForcedContactProfile(item: $forcedProfile)
            .onAppear { isVisible = true; requestCamera() }
            .onDisappear { isVisible = false; torchOn = false; cameraAuthorized = false; invalidateScan() }
            .pulseOnChange(of: session.token) { _ in invalidateScan(); dismiss() }
            .pulseOnChange(of: session.user?.id) { _ in invalidateScan(); dismiss() }
            .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in invalidateScan(); dismiss() }
            .pulseOnChange(of: appLock.isLocked) { locked in if locked { invalidateScan() } }
            .pulseOnChange(of: session.updateRequired) { required in if required { invalidateScan() } }
            .pulseOnChange(of: scenePhase) { phase in
                if phase == .background { torchOn = false; invalidateScan() }
                else if phase == .active { requestCamera() }
            }
            .pulseOnChange(of: photo) { item in
                invalidateScan()
                guard let item else { return }
                let operation = UUID(); photoDecodeID = operation
                Task { await decodePhoto(item, operation: operation) }
            }
    }

    private var corner: some View { Rectangle().fill(PulsePalette.accent).frame(width: 26, height: 3).padding(0) }
    private func scannerBottomItem(_ icon: String, _ title: String) -> some View { VStack(spacing: 7) { Image(systemName: icon).font(.title3); Text(title).font(.caption) }.foregroundStyle(.white).frame(width: 68) }
    private func requestCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: cameraAuthorized = true; cameraDenied = false
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { value in
                DispatchQueue.main.async { guard isVisible else { return }; cameraAuthorized = value; cameraDenied = !value }
            }
        default: cameraAuthorized = false; cameraDenied = true
        }
    }
    @MainActor private func decodePhoto(_ item: PhotosPickerItem, operation: UUID) async {
        let token = session.token, viewerID = session.user?.id, endpoint = APIClient.shared.endpointIdentity, revision = scanRevision
        func current() -> Bool {
            isVisible && scenePhase == .active && !appLock.isLocked && !session.updateRequired && forcedProfile == nil
                && session.isSignedIn && session.token == token && session.user?.id == viewerID
                && endpoint == APIClient.shared.endpointIdentity && revision == scanRevision
                && photoDecodeID == operation && !Task.isCancelled
        }
        defer { if photoDecodeID == operation { photoDecodeID = nil } }
        guard current() else { return }
        let data = try? await item.loadTransferable(type: Data.self)
        guard current() else { return }
        guard let data, let image = CIImage(data: data), let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]),
              let code = detector.features(in: image).compactMap({ ($0 as? CIQRCodeFeature)?.messageString }).first else { status = "没有识别到二维码"; return }
        // A superseded write keeps its own in-flight lock until it completes.
        while handling && current() { try? await Task.sleep(nanoseconds: 50_000_000) }
        guard current() else { return }
        photoDecodeID = nil
        await handle(code)
    }
    @MainActor private func handle(_ code: String) async {
        guard isVisible, scenePhase == .active, !appLock.isLocked, !handling, photoDecodeID == nil, forcedProfile == nil,
              code != lastForcedCode, session.isSignedIn, !session.updateRequired,
              let token = session.token, let viewerID = session.user?.id else { return }
        let client = APIClient.shared.captureSession(), internalStaff = session.user?.internalStaff == true
        scanRevision += 1; let revision = scanRevision, operation = UUID(); handling = true; scanOperation = operation
        func current() -> Bool {
            isVisible && scenePhase == .active && !appLock.isLocked && forcedProfile == nil && session.isSignedIn && !session.updateRequired
                && session.token == token && session.user?.id == viewerID && client.endpointIdentity == APIClient.shared.endpointIdentity
                && revision == scanRevision && scanOperation == operation && !Task.isCancelled
        }
        defer { if scanOperation == operation { handling = false; scanOperation = nil } }
        do {
            let target = try PublicUserIdentity.parseQRCode(code)
            if case .group(let id) = target {
                try await client.joinGroup(conversationID: id)
                guard current() else { return }
                try await session.refreshConversations()
                if current() { status = "已加入群组" }
                return
            }
            let id: Int
            switch target {
            case .publicUser(let publicID):
                status = "正在查找用户…"
                id = try await client.resolvePublicUserID(publicID)
            case .legacyUser(let legacyID):
                guard !client.isGoV2 else { throw GoV2Error.unsupported }
                id = legacyID
            case .group: return
            }
            guard current() else { return }
            guard id > 0, id != viewerID else { status = "不能添加自己为好友"; return }
            if internalStaff { try await client.forceAddContact(userID: id) }
            else { try await client.sendFriendRequest(userID: id) }
            guard current() else { return }
            if internalStaff {
                lastForcedCode = code; status = "已添加好友，可在资料页发消息"
                let route = IOSForcedContactProfileRoute(userID: id, viewerID: viewerID, token: token, endpoint: client.endpointIdentity)
                forcedProfile = route
                Task { await route.refreshContacts(in: session, using: client) }
            } else { status = "好友申请已发送" }
        } catch { if current() { status = error.localizedDescription } }
    }
    @MainActor private func invalidateScan() { scanRevision += 1; photoDecodeID = nil; forcedProfile = nil }
}

struct TaskView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var scenePhase
    @State private var employeeType = "intern"
    @State private var identityLoaded = false
    @State private var tasks: [WorkTask] = []
    @State private var selectedTask: WorkTaskPayload?
    @State private var verificationTask: TaskVerificationRequest?
    @State private var loading = false
    @State private var openingTaskID: Int?
    @State private var openingRequest: UUID?
    @State private var taskScope: TaskAccountScope?
    @State private var loadRevision = UUID()
    @State private var errorMessage = ""

    private struct TaskAccountScope: Hashable {
        let userID: Int
        let token: String
        let endpoint: String
    }

    private struct TaskVerificationRequest: Identifiable {
        let id = UUID()
        let task: WorkTask
        let scope: TaskAccountScope
    }

    private var currentTaskScope: TaskAccountScope? {
        guard session.isSignedIn, let userID = session.user?.id, let token = session.token, !token.isEmpty else { return nil }
        return TaskAccountScope(userID: userID, token: token, endpoint: APIClient.shared.endpointIdentity)
    }

    private var visibleTasks: [WorkTask] { taskScope == currentTaskScope ? tasks : [] }
    private var currentEmployeeType: String { taskScope == currentTaskScope ? employeeType : "intern" }
    private var employeeIdentityLabel: String {
        guard taskScope == currentTaskScope, identityLoaded else { return loading ? "身份加载中" : "身份待同步" }
        return employeeType == "formal" ? "正式员工" : "实习员工"
    }

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    if loading && visibleTasks.isEmpty { ProgressView().padding(.top, 60) }
                    if !loading && visibleTasks.isEmpty {
                        Text("暂无工作任务").foregroundStyle(PulsePalette.muted).padding(.top, 70)
                    }
                    ForEach(visibleTasks) { task in
                        Button { Task { await open(task) } } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack(alignment: .top, spacing: 10) {
                                    Text(task.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(PulsePalette.ink)
                                    Spacer(minLength: 8)
                                    if openingTaskID == task.id { ProgressView() }
                                    else { Text(task.statusLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(PulsePalette.accent).padding(.horizontal, 9).padding(.vertical, 5).background(PulsePalette.accentSoft).clipShape(RoundedRectangle(cornerRadius: 6)) }
                                }
                                Text("预计 \(task.estimatedMinutes) 分钟　开放时间 \(task.openTime)").font(.system(size: 12)).foregroundStyle(PulsePalette.muted)
                                if !task.description.isEmpty { Text(task.description).font(.system(size: 13)).foregroundStyle(PulsePalette.muted).multilineTextAlignment(.leading) }
                                HStack {
                                    Text("\(task.questionCount) 道题").font(.system(size: 12)).foregroundStyle(PulsePalette.muted)
                                    Spacer()
                                    Text(taskWageLabel(task)).font(.system(size: 14, weight: .semibold)).foregroundStyle(PulsePalette.accent)
                                }
                            }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(PulsePalette.surface).clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(PulsePalette.line, lineWidth: 1))
                        }.buttonStyle(.plain).disabled(openingTaskID != nil || loading)
                    }
                }.padding(16)
            }.background(PulsePalette.background)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack { Text("任务").font(.system(size: 20, weight: .semibold)).foregroundStyle(PulsePalette.ink); Spacer(); Text(employeeIdentityLabel).font(.system(size: 14, weight: .medium)).foregroundStyle(PulsePalette.accent).accessibilityHint("员工身份由后台配置") }.padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8).background(PulsePalette.surface)
            }
            .task(id: currentTaskScope) { await load() }
            .pulseOnChange(of: currentTaskScope) { scope in resetTaskScope(scope) }
            .refreshable { await load() }
            .pulseOnChange(of: scenePhase) { phase in if phase == .active { Task { await load() } } }
            .pulseFullScreenCover(item: $selectedTask, onDismiss: { Task { await load() } }) { payload in WorkTaskAnswerView(initialPayload: payload).environmentObject(session) }
            .pulseSheet(item: $verificationTask) { request in
                TaskVerificationView(task: request.task, employeeType: request.task.record?.employeeType ?? currentEmployeeType) { code in
                    try await verifyAndOpen(request, code: code)
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
            .alert("任务提示", isPresented: Binding(get: { !errorMessage.isEmpty }, set: { if !$0 { errorMessage = "" } })) { Button("确定", role: .cancel) {} } message: { Text(errorMessage) }
        }
    }

    @MainActor private func load() async {
        let scope = currentTaskScope
        resetTaskScope(scope)
        guard let scope else { return }
        let client = APIClient.shared.captureSession()
        do { _ = try await refreshTaskPage(scope: scope, client: client) }
        catch is CancellationError { }
        catch { if isCurrent(scope, client: client) { errorMessage = error.localizedDescription } }
    }

    @MainActor private func resetTaskScope(_ scope: TaskAccountScope?) {
        guard taskScope != scope else { return }
        loadRevision = UUID()
        taskScope = scope
        employeeType = "intern"
        identityLoaded = false
        tasks = []
        selectedTask = nil
        verificationTask = nil
        openingTaskID = nil
        openingRequest = nil
        loading = false
        errorMessage = ""
    }

    @MainActor private func isCurrent(_ scope: TaskAccountScope, client: APIClient) -> Bool {
        currentTaskScope == scope && client.webSocketToken == scope.token && client.endpointIdentity == scope.endpoint
    }

    @MainActor private func refreshTaskPage(scope: TaskAccountScope, client: APIClient) async throws -> WorkTaskPage {
        guard isCurrent(scope, client: client), !Task.isCancelled else { throw CancellationError() }
        let revision = UUID()
        loadRevision = revision
        loading = true
        defer { if loadRevision == revision { loading = false } }
        do {
            let result = try await client.workTasks()
            guard isCurrent(scope, client: client), loadRevision == revision, !Task.isCancelled else { throw CancellationError() }
            employeeType = result.employeeType == "formal" ? "formal" : "intern"
            identityLoaded = true
            tasks = result.items
            return result
        } catch {
            guard isCurrent(scope, client: client), loadRevision == revision, !Task.isCancelled else { throw CancellationError() }
            throw error
        }
    }

    @MainActor private func open(_ task: WorkTask) async {
        guard let scope = currentTaskScope, taskScope == scope, openingRequest == nil else { return }
        let client = APIClient.shared.captureSession()
        let requestID = UUID()
        openingRequest = requestID
        openingTaskID = task.id
        defer { if openingRequest == requestID { openingTaskID = nil; openingRequest = nil } }
        do {
            let page = try await refreshTaskPage(scope: scope, client: client)
            guard isCurrent(scope, client: client), openingRequest == requestID else { return }
            guard let currentTask = page.items.first(where: { $0.id == task.id }) else { throw APIClientError.server("任务不存在或已经停用，请刷新任务列表") }
            guard currentTask.status != "not_started" else { errorMessage = "任务尚未开放，请在 \(currentTask.openTime) 后开始"; return }
            verificationTask = TaskVerificationRequest(task: currentTask, scope: scope)
        } catch is CancellationError { }
        catch { if isCurrent(scope, client: client), openingRequest == requestID { errorMessage = error.localizedDescription } }
    }

    @MainActor private func verifyAndOpen(_ request: TaskVerificationRequest, code: String) async throws {
        let client = APIClient.shared.captureSession()
        guard isCurrent(request.scope, client: client), verificationTask?.id == request.id else { throw CancellationError() }
        let result = try await client.startWorkTask(taskID: request.task.id, verificationCode: code)
        guard isCurrent(request.scope, client: client), verificationTask?.id == request.id, !Task.isCancelled else { throw CancellationError() }
        guard result.record.userID == request.scope.userID else { throw APIClientError.invalidResponse }
        selectedTask = result
    }

    private func taskWageLabel(_ task: WorkTask) -> String {
        if let record = task.record, record.status == "reviewed" { return "工资收入 ¥\(String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), record.wage))" }
        let unitPrice = task.record?.unitPrice ?? (currentEmployeeType == "formal" ? task.formalUnitPrice : task.internUnitPrice)
        let questionCount = task.record?.totalQuestions ?? task.questionCount
        return "预计工资 ¥\(String(format: "%.3f", unitPrice * Double(questionCount)))"
    }
}

struct TaskVerificationView: View {
    let task: WorkTask
    let employeeType: String
    let verify: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var digits = Array(repeating: "", count: 6)
    @State private var submitting = false
    @State private var errorMessage = ""
    @FocusState private var focusedIndex: Int?

    private var code: String { digits.joined() }

    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 18) {
                Image(systemName: "lock.shield.fill").font(.system(size: 34)).foregroundStyle(PulsePalette.accent)
                Text("输入任务验证码").font(.system(size: 22, weight: .semibold)).foregroundStyle(PulsePalette.ink)
                VStack(spacing: 4) {
                    Text(task.name).font(.system(size: 14))
                    Text("\(employeeType == "formal" ? "正式员工" : "实习员工") · \(task.record == nil ? "身份由后台配置" : "开工身份已记录")").font(.system(size: 12))
                }.foregroundStyle(PulsePalette.muted)
                Text("请输入后台当天设置的 6 位验证码").font(.system(size: 13)).foregroundStyle(PulsePalette.muted)
                HStack(spacing: 8) {
                    ForEach(0..<6, id: \.self) { index in
                        TextField("", text: Binding(get: { digits[index] }, set: { value in
                            digits[index] = String(value.filter(\.isNumber).prefix(1))
                            if !digits[index].isEmpty && index < 5 { focusedIndex = index + 1 }
                            if code.count == 6 { submit() }
                        }))
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 22, weight: .semibold))
                        .frame(width: 42, height: 52)
                        .background(PulsePalette.background)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(focusedIndex == index ? PulsePalette.accent : PulsePalette.line, lineWidth: focusedIndex == index ? 2 : 1))
                        .focused($focusedIndex, equals: index)
                        .disabled(submitting)
                    }
                }
                if !errorMessage.isEmpty { Text(errorMessage).font(.system(size: 12)).foregroundStyle(PulsePalette.danger).multilineTextAlignment(.center).frame(maxWidth: .infinity) }
                Button { submit() } label: {
                    HStack { if submitting { ProgressView().tint(.white) }; Text(submitting ? "验证中…" : "验证进入") }
                        .frame(maxWidth: .infinity).frame(height: 48).foregroundStyle(.white).background(PulsePalette.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                }.disabled(submitting || code.count != 6)
                Spacer()
            }
            .padding(24)
            .background(PulsePalette.surface)
            .navigationTitle("任务验证")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(submitting) } }
            .onAppear { focusedIndex = 0 }
        }
    }

    private func submit() {
        guard code.count == 6, !submitting else { return }
        submitting = true
        errorMessage = ""
        Task {
            do { try await verify(code); dismiss() }
            catch {
                submitting = false
                errorMessage = error.localizedDescription
                digits = Array(repeating: "", count: 6)
                focusedIndex = 0
            }
        }
    }
}

struct WorkTaskAnswerView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var payload: WorkTaskPayload
    @State private var index = 0
    @State private var answers: [String: Bool] = [:]
    @State private var showingList = false
    @State private var showingSubmit = false
    @State private var submitting = false
    @State private var saving = false
    @State private var errorMessage = ""
    @State private var showingSettlementDetails = false
    @State private var settlementReviewFilter: SettlementReviewFilter = .all
    @State private var restoredDraft = false
    @State private var questionPreview: IOSWorkQuestionPreview?
    private let imageClient: APIClient
    private var draftKey: String { "pulse_work_\(payload.record.userID)_\(payload.record.id)" }
    private var reviewed: Bool { payload.hasCompleteSettlement }
    private var employeeTitle: String { payload.record.employeeType == "formal" ? "正式员工" : "实习员工" }
    private var canAnswer: Bool { payload.record.status == "in_progress" }

    init(initialPayload: WorkTaskPayload) {
        _payload = State(initialValue: initialPayload)
        imageClient = APIClient.shared.captureSession()
    }

    private var currentImageScope: Bool {
        session.isSignedIn && session.user?.id == payload.record.userID
            && session.token == imageClient.webSocketToken && imageClient.endpointIdentity == APIClient.shared.endpointIdentity
            && !appLock.isLocked && !session.updateRequired
    }

    var body: some View {
        PulseNavigationStack {
            Group {
                if canAnswer { answerBody }
                else if reviewed { settlementBody }
                else {
                    VStack(spacing: 18) {
                        Text("未能取得完整结算结果，请重新获取").foregroundStyle(PulsePalette.muted)
                        Button("重新获取结算") { Task { await refreshResult() } }.disabled(submitting)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(PulsePalette.background)
            .navigationTitle(canAnswer ? "工作任务" : "任务结算")
            .navigationBarTitleDisplayMode(.inline)
            .pulseSwipeBack(enabled: !saving && !submitting, identity: payload.record.id)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "chevron.left") }.disabled(submitting) }
                ToolbarItem(placement: .topBarTrailing) { if canAnswer { Button("答题列表") { showingList = true } } }
            }
            .task {
                guard !restoredDraft else { return }
                restoredDraft = true
                for question in payload.questions { if let answer = question.answer { answers[question.id] = answer } }
                if let bytes = UserDefaults.standard.data(forKey: draftKey), let draft = try? JSONDecoder().decode([String: Bool].self, from: bytes) { for question in payload.questions { if let value = draft[question.id] { answers[question.id] = value } } }
                index = payload.questions.firstIndex(where: { answers[$0.id] == nil }) ?? 0
            }
            .pulseSheet(isPresented: $showingList) { answerSheet.presentationDetents([.medium, .large]).presentationDragIndicator(.visible) }
            .pulseSheet(isPresented: $showingSettlementDetails) { settlementDetails.presentationDetents([.medium, .large]).presentationDragIndicator(.visible) }
            .pulseFullScreenCover(item: $questionPreview) { preview in IOSWorkQuestionPreviewView(preview: preview) }
            .pulseOnChange(of: index) { _ in questionPreview = nil }
            .pulseOnChange(of: currentImageScope) { current in if !current { questionPreview = nil } }
            .pulseOnChange(of: scenePhase) { phase in if phase != .active { questionPreview = nil } }
            .confirmationDialog("提交后不能再修改答案，确定提交吗？", isPresented: $showingSubmit, titleVisibility: .visible) { Button("提交作业") { Task { await submit() } }; Button("继续答题", role: .cancel) {} }
            .alert("任务提示", isPresented: Binding(get: { !errorMessage.isEmpty }, set: { if !$0 { errorMessage = "" } })) { Button("确定", role: .cancel) {} } message: { Text(errorMessage) }
        }
    }

    private var answerBody: some View {
        VStack(spacing: 14) {
            Text("第 \(index + 1) / \(payload.questions.count) 题　已答 \(answers.count) 题").font(.system(size: 13)).foregroundStyle(PulsePalette.muted).padding(.top, 14)
            if payload.questions.indices.contains(index) {
                let question = payload.questions[index]
                IOSWorkQuestionImage(url: currentImageScope ? imageClient.workImageURL(question.imageURL) : nil) { image in
                    guard currentImageScope, scenePhase == .active, payload.questions.indices.contains(index),
                          payload.questions[index].id == question.id else { return }
                    questionPreview = IOSWorkQuestionPreview(questionID: question.id, image: image)
                }.id(question.id).frame(maxWidth: .infinity, maxHeight: .infinity).layoutPriority(1)
                HStack(spacing: 16) { answerButton(true, question: question); answerButton(false, question: question) }.padding(.horizontal, 20)
                HStack {
                    Button { index = max(0, index - 1) } label: { Image(systemName: "chevron.left"); Text("上一题") }.disabled(index == 0)
                    Spacer()
                    if saving { ProgressView() }
                    Spacer()
                    Button { index = min(payload.questions.count - 1, index + 1) } label: { Text("下一题"); Image(systemName: "chevron.right") }.disabled(index == payload.questions.count - 1)
                }.font(.system(size: 13)).padding(.horizontal, 20)
                if answers.count == payload.questions.count {
                    Button { showingSubmit = true } label: {
                        HStack { if submitting { ProgressView().tint(.white) }; Text(submitting ? "正在提交…" : "提交结算").font(.system(size: 16, weight: .semibold)) }.frame(maxWidth: .infinity).frame(height: 50).foregroundStyle(.white).background(PulsePalette.accent).clipShape(RoundedRectangle(cornerRadius: 8))
                    }.disabled(submitting || saving).padding(.horizontal, 20).padding(.bottom, 14)
                } else {
                    Text("完成全部题目后可提交").font(.system(size: 13)).foregroundStyle(PulsePalette.muted).padding(.bottom, 14)
                }
            } else { Text("没有可作答的题目").foregroundStyle(PulsePalette.muted); Spacer() }
        }
    }

    private func answerButton(_ value: Bool, question: WorkQuestion) -> some View {
        let selected = answers[question.id] == value
        let color = value ? PulsePalette.accent : PulsePalette.danger
        return Button { Task { await choose(value, questionID: question.id) } } label: {
            Text(value ? "对" : "错").font(.system(size: 22, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 60).foregroundStyle(selected ? .white : color).background(selected ? color : color.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius: 8))
        }.disabled(saving || submitting)
    }

    private var answerSheet: some View {
        PulseNavigationStack {
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 5), spacing: 16) {
                    ForEach(Array(payload.questions.enumerated()), id: \.element.id) { number, question in
                        Button { index = number; showingList = false } label: {
                            VStack(spacing: 5) { Text("\(number + 1)").font(.system(size: 17, weight: .medium)); Text(answers[question.id].map { $0 ? "对" : "错" } ?? "未答").font(.system(size: 11)) }.frame(maxWidth: .infinity).frame(height: 58).foregroundStyle(answers[question.id] == nil ? PulsePalette.muted : Color(red: 0.18, green: 0.50, blue: 0.93)).background(answers[question.id] == nil ? Color(.systemGray6) : Color(red: 0.91, green: 0.95, blue: 1.0)).clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(index == number ? Color(red: 0.18, green: 0.50, blue: 0.93) : .clear, lineWidth: 2))
                        }
                    }
                }.padding(20)
            }.navigationTitle("答题列表 \(answers.count)/\(payload.questions.count)").navigationBarTitleDisplayMode(.inline).toolbar { Button("关闭") { showingList = false } }
        }
    }

    private var settlementBody: some View {
        ZStack {
            answerBody
                .disabled(true)
                .accessibilityHidden(true)
            Color.black.opacity(0.54)
                .ignoresSafeArea()
            GeometryReader { bounds in
                ViewThatFits(in: .vertical) {
                    settlementCard.fixedSize(horizontal: false, vertical: true)
                    ScrollView(showsIndicators: false) { settlementCard }
                }
                .frame(maxWidth: 333)
                .background(PulsePalette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: .black.opacity(0.22), radius: 28, y: 12)
                .padding(.horizontal, 30)
                .padding(.vertical, 16)
                .frame(width: bounds.size.width, height: bounds.size.height)
            }
            .ignoresSafeArea(.container, edges: [.top, .bottom])
        }
    }

    private var settlementCard: some View {
        VStack(spacing: 0) {
            Image(systemName: "checkmark")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(Color(hex: 0x60B76E))
                .frame(width: 60, height: 60)
                .background(Color(hex: 0xE8F4EA), in: Circle())
                .padding(.bottom, 16)
            Text(employeeTitle)
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(Color(hex: 0xEA432D))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 22)
                .padding(.bottom, 14)
            Text(payload.record.taskName.isEmpty ? "工作任务结算" : payload.record.taskName)
                .font(.system(size: 13)).foregroundStyle(PulsePalette.muted).padding(.bottom, 10)
            VStack(spacing: 0) {
                settlementDetailRow("完成时间", settlementCompletionTime)
                settlementDetailRow("完成耗时", payload.record.durationText)
                settlementDetailRow("状态", "已完成")
            }
            HStack(spacing: 15) {
                settlementStatistic(correct: true)
                settlementStatistic(correct: false)
            }
            .padding(.top, 12)
            .padding(.bottom, 18)
            VStack(spacing: 3) {
                Text("工资收入").font(.system(size: 12)).foregroundStyle(Color.white.opacity(0.78))
                Text("¥\(settlementWage)")
                    .font(.system(size: 30, weight: .bold)).foregroundStyle(.white)
                Text(payload.record.employeeType == "formal" ? "(正式员工)" : "(实习员工)")
                    .font(.system(size: 12)).foregroundStyle(Color.white.opacity(0.78))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 100)
            .background(LinearGradient(colors: [Color(hex: 0xFF6B32), Color(hex: 0xFF8F52)], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            HStack(spacing: 10) {
                PulseAvatar(title: settlementNickname, size: 38, avatarURL: payload.record.avatarURL)
                    .clipShape(Circle())
                Text(settlementNickname)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(PulsePalette.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minHeight: 38)
            .padding(.top, 18)
            Button { dismiss() } label: {
                Text("确定").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).frame(height: 44)
                    .background(PulsePalette.accent, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .padding(.top, 18)
        }
        .padding(.horizontal, 22)
        .padding(.top, 22)
        .padding(.bottom, 18)
    }

    private func settlementDetailRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text("\(title):").foregroundStyle(PulsePalette.muted)
            Spacer(minLength: 12)
            Text(value.isEmpty ? "-" : value).foregroundStyle(PulsePalette.ink).multilineTextAlignment(.trailing)
        }
        .font(.system(size: 13))
        .frame(minHeight: 26)
    }

    private func settlementStatistic(correct: Bool) -> some View {
        let color = Color(hex: correct ? 0x66B977 : 0xE76460)
        let count = "\(correct ? payload.record.correctCount : payload.record.wrongCount)题"
        let title = correct ? "批改正确" : "批改错误"
        return Button {
            settlementReviewFilter = correct ? .correct : .wrong
            showingSettlementDetails = true
        } label: {
            VStack(spacing: 2) {
                Text(count).font(.system(size: 15, weight: .bold))
                Text(title).font(.system(size: 10))
            }
            .foregroundStyle(color)
            .frame(width: 72, height: 50)
            .background(Color(hex: correct ? 0xEAF6EC : 0xFFF0EC), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color(hex: correct ? 0xC3DFC5 : 0xF3C4C1), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!reviewed)
        .accessibilityLabel("\(title)，\(count)")
        .accessibilityHint("轻点查看\(title)明细，也可切换查看全部题目")
    }

    private var settlementNickname: String {
        payload.record.nickname.isEmpty ? session.user?.nickname ?? "用户" : payload.record.nickname
    }

    private var settlementCompletionTime: String {
        let value = payload.record.submittedAt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return "-" }
        let time = String(value.split(whereSeparator: { $0 == " " || $0 == "T" }).last ?? "")
        return time.range(of: #"^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$"#, options: .regularExpression) == nil ? value : time
    }

    private var settlementWage: String {
        String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), payload.record.wage)
    }

    private enum SettlementReviewFilter: String, CaseIterable {
        case all = "全部"
        case correct = "正确"
        case wrong = "错误"
    }

    private var settlementDetails: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !payload.record.reviewNote.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("批改备注").font(.system(size: 13, weight: .semibold)).foregroundStyle(PulsePalette.ink)
                            Text(payload.record.reviewNote).font(.system(size: 13)).foregroundStyle(PulsePalette.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14).background(PulsePalette.surface, in: RoundedRectangle(cornerRadius: 10))
                    }
                    Picker("题目范围", selection: $settlementReviewFilter) {
                        Text("全部").tag(SettlementReviewFilter.all)
                        Text("正确").tag(SettlementReviewFilter.correct)
                        Text("错误").tag(SettlementReviewFilter.wrong)
                    }.pickerStyle(.segmented)
                    let questions = Array(payload.questions.enumerated()).filter { item in
                        settlementReviewFilter == .all || (settlementReviewFilter == .correct ? item.element.reviewedCorrect == true : item.element.reviewedCorrect == false)
                    }
                    if questions.isEmpty {
                        Text("暂无此类题目").font(.system(size: 13)).foregroundStyle(PulsePalette.muted).frame(maxWidth: .infinity).padding(.vertical, 24)
                    }
                    ForEach(questions, id: \.element.id) { number, question in
                        HStack(spacing: 8) {
                            Text("第 \(number + 1) 题")
                            Spacer()
                            Text("作答：\(question.answer.map { $0 ? "对" : "错" } ?? "未答")")
                            Text(question.reviewedCorrect.map { $0 ? "批改正确" : "批改错误" } ?? "未批改")
                                .foregroundStyle(question.reviewedCorrect == true ? Color(hex: 0x159A78) : PulsePalette.danger)
                        }
                        .font(.system(size: 12)).foregroundStyle(PulsePalette.ink)
                        .padding(14).background(PulsePalette.surface, in: RoundedRectangle(cornerRadius: 10))
                    }
                }.padding(16)
            }
            .background(PulsePalette.background)
            .navigationTitle("批改明细")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { showingSettlementDetails = false } } }
        }
    }

    private func settlementRow(_ title: String, _ value: String) -> some View {
        HStack { Text(title).foregroundStyle(PulsePalette.muted); Spacer(); Text(value.isEmpty ? "-" : value).foregroundStyle(title == "工资收入" ? PulsePalette.accent : PulsePalette.ink) }.font(.system(size: 14)).padding(16).background(PulsePalette.surface).overlay(alignment: .bottom) { Divider() }
    }

    @MainActor private func choose(_ value: Bool, questionID: String) async {
        answers[questionID] = value
        if let bytes = try? JSONEncoder().encode(answers) { UserDefaults.standard.set(bytes, forKey: draftKey) }
        saving = true
        defer { saving = false }
        do { let _ = try await imageClient.saveWorkTaskAnswers(recordID: payload.record.id, answers: [questionID: value]); guard currentImageScope else { return }; if index < payload.questions.count - 1 { index += 1 } }
        catch { errorMessage = "进度已保存在本机，服务器同步失败：\(error.localizedDescription)" }
    }

    @MainActor private func submit() async {
        guard currentImageScope, !submitting, !saving else { return }
        submitting = true
        defer { submitting = false }
        do { let result = try await imageClient.submitWorkTask(recordID: payload.record.id, answers: answers); guard currentImageScope else { return }; UserDefaults.standard.removeObject(forKey: draftKey); payload = result }
        catch { if currentImageScope { errorMessage = error.localizedDescription } }
    }

    @MainActor private func refreshResult() async {
        submitting = true
        defer { submitting = false }
        do { let result = try await imageClient.workTaskRecord(id: payload.record.id); guard currentImageScope else { return }; payload = result }
        catch { if currentImageScope { errorMessage = error.localizedDescription } }
    }
}

private struct IOSWorkQuestionPreview: Identifiable {
    let id = UUID()
    let questionID: String
    let image: UIImage
}

private struct IOSWorkQuestionImage: View {
    let url: URL?
    let open: (UIImage) -> Void
    @State private var image: UIImage?
    @State private var loading = true
    @State private var failed = false
    @State private var retry = UUID()

    var body: some View {
        GeometryReader { bounds in
            ScrollView {
                VStack(spacing: 10) {
                    if let image {
                        Button { open(image) } label: {
                            Image(uiImage: image).resizable().scaledToFit()
                                .frame(width: max(1, bounds.size.width - 24))
                        }.buttonStyle(.plain).accessibilityLabel("放大题目图片")
                        Text("点击图片放大，可双指缩放查看").font(.caption).foregroundStyle(PulsePalette.muted)
                    } else if loading {
                        ProgressView("正在加载题目图片…").padding(.top, 32)
                    } else if failed {
                        Image(systemName: "photo.badge.exclamationmark").font(.title2)
                        Text("题目图片加载失败").font(.footnote)
                        Button("重新加载图片") { retry = UUID() }
                    }
                }.padding(.vertical, 12).frame(maxWidth: .infinity, minHeight: bounds.size.height, alignment: .top)
            }.background(PulsePalette.surface)
        }
        .task(id: "\(url?.absoluteString ?? "")|\(retry)") { await loadImage() }
    }

    @MainActor private func loadImage() async {
        image = nil; loading = true; failed = false
        defer { if !Task.isCancelled { loading = false } }
        guard let url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              url.user == nil, url.password == nil else { failed = true; return }
        do {
            // Task images retain their server-provided URL/signature. No app
            // bearer token is attached to an arbitrary image host.
            let (data, response) = try await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 30))
            guard !Task.isCancelled else { return }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let value = UIImage(data: data), value.size.width > 0, value.size.height > 0 else {
                failed = true; return
            }
            image = value
        } catch { if !Task.isCancelled { failed = true } }
    }
}

private struct IOSWorkQuestionPreviewView: View {
    let preview: IOSWorkQuestionPreview
    @Environment(\.dismiss) private var dismiss
    @State private var reset = UUID()
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("关闭") { dismiss() }.frame(minWidth: 44, minHeight: 44)
                Spacer()
                Text("题目图片").font(.headline)
                Spacer()
                Button("还原") { reset = UUID() }.frame(minWidth: 44, minHeight: 44)
            }.padding(.horizontal, 16).foregroundStyle(.white)
            IOSWorkQuestionZoom(image: preview.image, reset: reset).frame(maxWidth: .infinity, maxHeight: .infinity)
            Text("双指缩放 · 放大后拖动 · 双击放大或还原").font(.caption).foregroundStyle(.white.opacity(0.8)).padding(12)
        }.background(Color.black.ignoresSafeArea()).preferredColorScheme(.dark)
    }
}

private struct IOSWorkQuestionZoom: UIViewRepresentable {
    let image: UIImage
    let reset: UUID
    func makeUIView(context: Context) -> IOSWorkQuestionZoomScrollView {
        let view = IOSWorkQuestionZoomScrollView(frame: .zero)
        view.setPicture(image, reset: reset)
        return view
    }
    func updateUIView(_ view: IOSWorkQuestionZoomScrollView, context: Context) { view.setPicture(image, reset: reset) }
}

private final class IOSWorkQuestionZoomScrollView: UIScrollView, UIScrollViewDelegate {
    private let picture = UIImageView()
    private var fittedSize = CGSize.zero
    private var resetID: UUID?
    private var fitNeeded = true
    private var fitting = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self; backgroundColor = .black; bouncesZoom = true
        showsHorizontalScrollIndicator = true; showsVerticalScrollIndicator = true
        contentInsetAdjustmentBehavior = .never
        picture.contentMode = .scaleAspectFit
        picture.isAccessibilityElement = true
        picture.accessibilityLabel = "题目图片"
        picture.accessibilityHint = "使用缩放操作查看细节"
        addSubview(picture)
        let doubleTapGesture = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        doubleTapGesture.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTapGesture)
        picture.accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: "放大图片", target: self, selector: #selector(accessibilityZoomIn(_:))),
            UIAccessibilityCustomAction(name: "还原图片", target: self, selector: #selector(accessibilityReset(_:)))
        ]
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func setPicture(_ image: UIImage, reset: UUID) {
        if picture.image !== image {
            minimumZoomScale = 1; maximumZoomScale = 1; zoomScale = 1
            picture.image = image; picture.frame = CGRect(origin: .zero, size: image.size)
            contentSize = image.size; fitNeeded = true
        }
        if resetID != reset { resetID = reset; fitNeeded = true }
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard !fitting, let image = picture.image, bounds.width > 0, bounds.height > 0 else { return }
        fitting = true
        defer { fitting = false }
        let resetting = fitNeeded || fittedSize != bounds.size
        if resetting {
            fittedSize = bounds.size; fitNeeded = false
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            minimumZoomScale = fit; maximumZoomScale = fit * 32
            setZoomScale(fit, animated: false)
        }
        centerPicture()
        if resetting { contentOffset = CGPoint(x: -contentInset.left, y: -contentInset.top) }
    }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerPicture() }
    private func centerPicture() {
        let vertical = max(0, (bounds.height - picture.frame.height) / 2)
        let horizontal = max(0, (bounds.width - picture.frame.width) / 2)
        let insets = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
        if contentInset != insets { contentInset = insets }
    }
    @objc private func doubleTap(_ gesture: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale * 1.05 { setZoomScale(minimumZoomScale, animated: true); return }
        let next = min(maximumZoomScale, minimumZoomScale * 3)
        let point = gesture.location(in: picture)
        zoom(to: CGRect(x: point.x - bounds.width / next / 2, y: point.y - bounds.height / next / 2,
                        width: bounds.width / next, height: bounds.height / next), animated: true)
    }
    @objc private func accessibilityZoomIn(_ action: UIAccessibilityCustomAction) -> Bool {
        setZoomScale(min(maximumZoomScale, max(minimumZoomScale, zoomScale * 2)), animated: true); return true
    }
    @objc private func accessibilityReset(_ action: UIAccessibilityCustomAction) -> Bool {
        setZoomScale(minimumZoomScale, animated: true); return true
    }
}

struct ProfileView: View {
    @EnvironmentObject private var session: AppSession
    var body: some View { IOSProfileHomeView().environmentObject(session) }
}

struct EditProfileView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var avatarURL = ""
    @State private var error = ""
    var body: some View { PulseNavigationStack { VStack(spacing: 16) { PulseCard { VStack(spacing: 12) { TextField("昵称", text: $nickname).pulseField(title: "昵称", text: $nickname, icon: "person"); TextField("头像地址", text: $avatarURL).textInputAutocapitalization(.never).pulseField(title: "头像地址", text: $avatarURL, icon: "photo") } }; if !error.isEmpty { Text(error).foregroundStyle(PulsePalette.danger) }; Spacer() }.padding(16).background(PulsePalette.background).navigationTitle("编辑资料").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } } } }.task { nickname = session.user?.nickname ?? ""; avatarURL = session.user?.avatarURL ?? "" } } }
    private func save() async { do { try await session.saveProfile(nickname: nickname.trimmingCharacters(in: .whitespacesAndNewlines), avatarURL: avatarURL.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() } catch { error = error.localizedDescription } }
}

struct SecuritySettingsView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var sessions: [SessionInfo] = []
    @State private var blocked: [BlockedUser] = []
    @State private var error = ""
    var body: some View { PulseNavigationStack { ScrollView { VStack(alignment: .leading, spacing: 16) { PulseCard { VStack(alignment: .leading, spacing: 12) { Text("修改密码").font(.headline); PulseSecureField(title: "当前密码", text: $currentPassword, icon: "lock"); PulseSecureField(title: "新密码", text: $newPassword, icon: "key"); Button("修改密码") { Task { await changePassword() } }.buttonStyle(PulsePrimaryButtonStyle()) } }; Text("登录设备").font(.headline).padding(.horizontal, 4); ForEach(sessions) { item in PulseCard { HStack { Image(systemName: "iphone").foregroundStyle(PulsePalette.accent); VStack(alignment: .leading) { Text(item.deviceType).foregroundStyle(PulsePalette.ink); Text(item.createdAt).font(.caption).foregroundStyle(PulsePalette.muted) }; Spacer(); if item.isCurrent { Text("当前设备").font(.caption).foregroundStyle(PulsePalette.accent) } else { Button("移除") { Task { await revoke(item) } }.foregroundStyle(PulsePalette.danger) } } } }; if !error.isEmpty { Text(error).foregroundStyle(PulsePalette.danger) } }.padding(16) }.background(PulsePalette.background).navigationTitle("安全设置").navigationBarTitleDisplayMode(.inline).toolbar { Button("完成") { dismiss() } }.task { await load() } } }
    private func load() async { do { sessions = try await APIClient.shared.sessions(); blocked = try await APIClient.shared.blockedUsers() } catch { error = error.localizedDescription } }
    private func changePassword() async { do { try await APIClient.shared.changePassword(current: currentPassword, newPassword: newPassword); session.signOut(); dismiss() } catch { error = error.localizedDescription } }
    private func revoke(_ item: SessionInfo) async { do { try await APIClient.shared.revokeSession(id: item.id); await load() } catch { error = error.localizedDescription } }
}

struct IOSProfileHomeView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingEdit = false
    @State private var showingQRCode = false
    @State private var showingAppearance = false
    @State private var showingPrivacy = false
    @State private var showingStorage = false
    @State private var showingLanguage = false
    @State private var showingSound = false
    @State private var showingLogs = false
    @State private var showingUpdate = false
    @AppStorage("pulse_language") private var language = "zh-Hans"

    private var profileSignature: String? {
        guard let value = session.user?.signature?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    private var profileBackground: Color { colorScheme == .dark ? PulsePalette.background : Color(hex: 0xF8F9FB) }
    private var profileSecondary: Color { colorScheme == .dark ? PulsePalette.muted : Color(hex: 0x999999) }
    private var profileIconColor: Color { Color(hex: colorScheme == .dark ? 0x7D9EFF : 0x0632E4) }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let scale = min(1.12, max(0.85, width / 393))

            ScrollView {
                VStack(spacing: 0) {
                    profileCard(scale: scale)
                    profileIntro(scale: scale)
                    profileGroup(scale: scale) {
                        profileRow(icon: "checkmark.shield.fill", title: "隐私安全", scale: scale) { showingPrivacy = true }
                        profileRow(icon: "broom.fill", title: "数据存储", scale: scale) { showingStorage = true }
                        profileRow(icon: "globe.asia.australia.fill", title: "语言设置", detail: language == "zh-Hant" ? "繁體中文" : "简体中文", scale: scale) { showingLanguage = true }
                        profileRow(icon: "bell.fill", title: "通知声音", scale: scale) { showingSound = true }
                    }
                    profileGroup(scale: scale) {
                        profileRow(icon: "paintbrush.fill", title: "外观显示", scale: scale) { showingAppearance = true }
                        profileRow(icon: "arrow.up.doc.fill", title: "上传日志", scale: scale) { showingLogs = true }
                        profileRow(icon: "arrow.clockwise.circle.fill", title: "检查更新", detail: "当前 \(APIClient.appVersion)", scale: scale) {
                            Task { await session.loadClientConfig(); showingUpdate = true }
                        }
                    }
                    Text("\(PulseApp.name) v\(APIClient.appVersion)")
                        .font(.system(size: 12 * scale))
                        .foregroundStyle(profileSecondary)
                        .padding(.top, 32 * scale)
                        .padding(.bottom, 32 * scale)
                }
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
        }
        .background(profileBackground)
        .toolbar(.hidden, for: .navigationBar)
        .pulseSheet(isPresented: $showingEdit) { IOSProfileEditorView() }
        .pulseSheet(isPresented: $showingQRCode) { IOSProfileQRCodeView() }
        .pulseSheet(isPresented: $showingAppearance) { IOSAppearanceSettingsView() }
        .pulseSheet(isPresented: $showingPrivacy) { IOSPrivacySecurityView() }
        .pulseSheet(isPresented: $showingStorage) { IOSDataStorageView() }
        .pulseSheet(isPresented: $showingLanguage) { IOSLanguageSettingsView() }
        .pulseSheet(isPresented: $showingSound) { IOSNotificationSoundView() }
        .pulseSheet(isPresented: $showingLogs) { IOSDiagnosticsView() }
        .pulseSheet(isPresented: $showingUpdate) { IOSUpdateView(required: false) }
    }

    private func profileCard(scale: CGFloat) -> some View {
        return ZStack(alignment: .topTrailing) {
            Button { showingEdit = true } label: {
                HStack(spacing: 14 * scale) {
                    profileAvatar(size: 64 * scale)
                    VStack(alignment: .leading, spacing: 10 * scale) {
                        HStack(spacing: 7) {
                            Text(session.user?.nickname ?? "用户")
                                .font(.system(size: 17 * scale, weight: .bold))
                                .foregroundStyle(PulsePalette.ink)
                                .lineLimit(1)
                            Image(systemName: "pencil")
                                .font(.system(size: 14 * scale, weight: .medium))
                                .foregroundStyle(colorScheme == .dark ? PulsePalette.accent : Color(hex: 0x7DA5DC))
                        }
                        Text("账号：\(session.user?.username ?? "未设置")")
                            .font(.system(size: 12 * scale))
                            .foregroundStyle(profileSecondary)
                            .lineLimit(1)
                        Text("用户 ID：\(PublicUserIdentity.display(session.user?.publicID))")
                            .font(.system(size: 12 * scale)).foregroundStyle(profileSecondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, 23 * scale)
                .padding(.trailing, 72 * scale)
                .padding(.vertical, 20 * scale)
                .frame(maxWidth: .infinity, minHeight: 104 * scale, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("编辑个人资料")

            Button { showingQRCode = true } label: {
                Image(systemName: "qrcode")
                    .font(.system(size: 22 * scale, weight: .medium))
                    .foregroundStyle(PulsePalette.ink)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("我的二维码")
            .padding(.top, 16 * scale)
            .padding(.trailing, 16 * scale)
        }
        .background(PulsePalette.surface.ignoresSafeArea(edges: .top))
    }

    private func profileAvatar(size: CGFloat) -> some View {
        Group {
            if let value = session.user?.avatarURL, let url = APIClient.shared.mediaURL(value) {
                ZStack { profileAvatarPlaceholder(size: size); StableAvatarImage(url: url) }
            } else { profileAvatarPlaceholder(size: size) }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 7 / 64, style: .continuous))
    }

    private func profileAvatarPlaceholder(size: CGFloat) -> some View {
        let initial = String((session.user?.nickname ?? "用").trimmingCharacters(in: .whitespacesAndNewlines).prefix(1))
        return Text(initial.isEmpty ? "用" : initial)
            .font(.system(size: size * 27 / 64, weight: .medium))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(LinearGradient(colors: [Color(hex: 0xFF9161), Color(hex: 0xFF4E73)], startPoint: .top, endPoint: .bottom))
    }

    private func profileIntro(scale: CGFloat) -> some View {
        Button { showingEdit = true } label: {
            HStack(spacing: 10 * scale) {
                ZStack {
                    Circle().fill(Color(hex: 0x34BFA8))
                    Image(systemName: "face.smiling").font(.system(size: 13 * scale, weight: .semibold)).foregroundStyle(.white)
                }.frame(width: 18 * scale, height: 18 * scale)
                Text(profileSignature ?? "点击添加个人简介，让人们更了解你")
                    .font(.system(size: 12.5 * scale, weight: .medium))
                    .foregroundStyle(PulsePalette.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16 * scale)
            .frame(maxWidth: .infinity, minHeight: 41 * scale)
            .background(profileBackground, in: RoundedRectangle(cornerRadius: 9 * scale, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 18 * scale)
        .padding(.top, 3 * scale)
        .padding(.bottom, 38 * scale)
        .background(PulsePalette.surface)
    }

    private func profileGroup(scale: CGFloat, @ViewBuilder content: () -> some View) -> some View {
        VStack(spacing: 0, content: content)
            .background(PulsePalette.surface)
            .padding(.top, 8 * scale)
    }

    private func profileRow(icon: String, title: String, detail: String? = nil, scale: CGFloat, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10 * scale) {
                Image(systemName: icon)
                    .symbolRenderingMode(.monochrome)
                    .font(.system(size: 17 * scale, weight: .semibold))
                    .foregroundStyle(profileIconColor)
                    .frame(width: 17 * scale)
                Text(title)
                    .font(.system(size: 16.5 * scale))
                    .foregroundStyle(PulsePalette.ink)
                Spacer()
                if let detail {
                    Text(detail)
                        .font(.system(size: 16 * scale))
                        .foregroundStyle(profileSecondary)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 17 * scale, weight: .medium))
                    .foregroundStyle(colorScheme == .dark ? PulsePalette.muted : Color(hex: 0xBFBFBF))
            }
            .padding(.horizontal, 15 * scale)
            .frame(maxWidth: .infinity, minHeight: 60 * scale)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct IOSProfileEditorView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var username = ""
    @State private var signature = ""
    @State private var gender = "保密"
    @State private var birthday = ""
    @State private var birthdayChangeCount = 0
    @State private var birthdayDate = Date()
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarSelection = AvatarSelectionState()
    @State private var avatarPreview: UIImage?
    @State private var photoLoadTask: Task<Void, Never>?
    @State private var editingClient: APIClient?
    @State private var editingUserID = 0
    @State private var originalAvatarURL = ""
    @State private var didLoadProfile = false
    @State private var showingSaveError = false
    @State private var showingAddAccount = false
    @State private var showingAccounts = false
    @State private var showingPassword = false
    @State private var showingUsername = false
    @State private var showingNickname = false
    @State private var showingSignature = false
    @State private var showingBirthday = false
    @State private var showingGender = false
    @State private var showingBirthdayWarning = false
    @State private var pendingBirthday: Date?
    @State private var error = ""
    @State private var working = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { photoLoadTask?.cancel(); dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 23, weight: .medium))
                        .foregroundStyle(PulsePalette.ink)
                        .frame(width: 44, height: 44)
                }
                .disabled(working)
                Spacer()
                Text("编辑资料")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(PulsePalette.ink)
                Spacer()
                Button(working ? "保存中" : (avatarSelection.isLoading ? "读取中" : "完成")) { Task { await save() } }
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(PulsePalette.accent)
                    .frame(width: 72, height: 44)
                    .disabled(working || !avatarSelection.canSave || !didLoadProfile)
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .background(PulsePalette.surface)
            .alert("资料未保存", isPresented: $showingSaveError) { Button("确定", role: .cancel) {} } message: { Text(error) }

            if !error.isEmpty {
                Text(error).font(.system(size: 13)).foregroundStyle(PulsePalette.danger)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 10)
            }

            ScrollView {
                VStack(spacing: 0) {
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        if let image = avatarPreview {
                            Image(uiImage: image).resizable().scaledToFill().frame(width: 112, height: 112).clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        } else {
                            ZStack {
                                PulseAvatar(title: session.user?.nickname ?? "用", size: 112, avatarURL: session.user?.avatarURL)
                                Circle().fill(Color.black.opacity(0.92)).frame(width: 52, height: 52)
                                Image(systemName: "plus").font(.system(size: 30, weight: .medium)).foregroundStyle(.white)
                            }
                        }
                    }
                    .overlay { if avatarSelection.isLoading { ProgressView().padding(12).background(.regularMaterial, in: Circle()) } }
                    .buttonStyle(.plain)
                    .disabled(working)
                    .padding(.top, 22)
                    .padding(.bottom, 28)

                    if avatarItem != nil {
                        Button("取消更换头像") {
                            photoLoadTask?.cancel(); avatarItem = nil; avatarSelection.reset(); avatarPreview = nil; error = ""
                        }
                        .font(.system(size: 14)).foregroundStyle(PulsePalette.accent).padding(.bottom, 18)
                        .disabled(working)
                    }

                    Button { showingSignatureEditor() } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "face.smiling").foregroundStyle(Color(hex: 0x34BFA8)).font(.system(size: 21))
                            Text(signature.isEmpty ? "个人简介" : signature).foregroundStyle(signature.isEmpty ? PulsePalette.muted : PulsePalette.ink).lineLimit(1)
                            Spacer()
                            Image(systemName: "pencil").foregroundStyle(PulsePalette.accent)
                        }
                        .padding(.horizontal, 20)
                        .frame(height: 62)
                        .background(PulsePalette.background)
                        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .padding(.horizontal, 16)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 18)

                    VStack(spacing: 0) {
                        profileEditorRow(title: "昵称", value: nickname) { showingNicknameEditor() }
                        profileEditorRow(title: "修改登录密码", value: nil) { showingPassword = true }
                        profileEditorRow(title: "账号", value: username.isEmpty ? "未设置" : username, disabled: !username.isEmpty) { if username.isEmpty { showingUsername = true } }
                        profileEditorRow(title: "用户 ID", value: PublicUserIdentity.display(session.user?.publicID), disabled: true) {}
                        profileEditorRow(title: "生日", value: birthday.isEmpty ? nil : birthday, disabled: birthdayChangeCount >= 1) { if birthdayChangeCount < 1 { showingBirthday = true } }
                        profileEditorRow(title: "性别", value: gender.isEmpty ? "保密" : gender, isLast: true) { showingGender = true }
                    }
                    .background(PulsePalette.surface)
                    .padding(.bottom, 18)

                    Button { showingAddAccount = true } label: {
                        Text("添加账号")
                            .font(.system(size: 19, weight: .medium))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 58)
                            .background(PulsePalette.accent)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(avatarSelection.isLoading || session.changingAccount)
                    .accessibilityIdentifier("profile_add_account")
                    .padding(.horizontal, 16)

                    if session.savedAccounts.count > 1 {
                        Button("切换账号") { showingAccounts = true }
                            .font(.system(size: 17, weight: .medium))
                            .frame(maxWidth: .infinity).frame(height: 52)
                            .background(PulsePalette.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .padding(.horizontal, 16).padding(.top, 12)
                            .disabled(session.changingAccount)
                            .accessibilityIdentifier("profile_switch_account")
                    }

                    Button("退出登录", role: .destructive) { session.signOut(); if !session.isSignedIn { dismiss() } else { error = session.error } }
                        .font(.system(size: 18))
                        .frame(maxWidth: .infinity)
                        .frame(height: 58)
                        .background(PulsePalette.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .padding(.bottom, 30)

                }
            }
            .scrollIndicators(.hidden)
            .disabled(working)
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .interactiveDismissDisabled(working || avatarSelection.isLoading)
        .task { loadProfile() }
        .pulseOnChange(of: avatarItem) { item in
            loadAvatar(item)
        }
        .pulseOnChange(of: session.token) { _ in
            if let editingClient, !session.canEditProfile(client: editingClient, userID: editingUserID) { photoLoadTask?.cancel(); dismiss() }
        }
        .pulseOnChange(of: session.user?.username) { value in if let value, !value.isEmpty { username = value } }
        .pulseFullScreenCover(isPresented: $showingAddAccount) { IOSAddAccountView() }
        .pulseSheet(isPresented: $showingAccounts) { IOSSavedAccountsView() }
        .pulseSheet(isPresented: $showingPassword) { IOSChangePasswordView() }
        .pulseSheet(isPresented: $showingUsername) { IOSUsernameEditorView() }
        .pulseSheet(isPresented: $showingNickname) { IOSNicknameEditorView(value: $nickname) }
        .pulseSheet(isPresented: $showingSignature) { IOSSignatureEditorView(value: $signature) }
        .pulseSheet(isPresented: $showingBirthday) {
            IOSBirthdayPickerView(date: $birthdayDate) { value in chooseBirthday(value) }
        }
        .pulseSheet(isPresented: $showingGender) {
            IOSGenderPickerView(value: $gender)
        }
        .alert("提醒", isPresented: $showingBirthdayWarning) {
            Button("取消", role: .cancel) { pendingBirthday = nil }
            Button("确定") { if let pendingBirthday { birthdayDate = pendingBirthday; birthday = profileDate(pendingBirthday) }; pendingBirthday = nil }
        } message: {
            Text("用户生日只能修改一次，是否继续修改？")
        }
    }

    private func profileEditorRow(title: String, value: String?, disabled: Bool = false, isLast: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title).font(.system(size: 17)).foregroundStyle(disabled ? PulsePalette.muted : PulsePalette.ink)
                Spacer()
                if let value { Text(value).font(.system(size: 16)).foregroundStyle(PulsePalette.muted) }
                if !disabled { Image(systemName: "chevron.right").font(.system(size: 17)).foregroundStyle(PulsePalette.muted.opacity(0.65)) }
            }
            .padding(.horizontal, 20)
            .frame(height: 66)
            .overlay(alignment: .bottom) { if !isLast { Rectangle().fill(PulsePalette.line.opacity(0.35)).frame(height: 0.5) } }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func loadProfile() {
        guard !didLoadProfile else { return }
        didLoadProfile = true
        editingClient = APIClient.shared.captureSession(); editingUserID = session.user?.id ?? 0
        originalAvatarURL = session.user?.avatarURL ?? ""
        nickname = session.user?.nickname ?? ""
        username = session.user?.username ?? ""
        signature = session.user?.signature ?? ""
        gender = session.user?.gender ?? "保密"
        birthday = session.user?.birthday ?? ""
        birthdayChangeCount = session.user?.birthdayChangeCount ?? 0
        if let value = profileDate(birthday) { birthdayDate = value }
    }

    private func save() async {
        guard !working, avatarSelection.canSave else { return }
        guard let client = editingClient, session.canEditProfile(client: client, userID: editingUserID) else { dismiss(); return }
        guard avatarItem == nil || avatarSelection.data != nil else { reportSaveError("请等待照片读取完成，或重新选择图片"); return }
        let value = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...32).contains(value.count) else { reportSaveError("昵称长度必须为 2 到 32 个字符"); return }
        guard signature.count <= 70 else { reportSaveError("个人简介最多 70 个字符"); return }
        let selectionRevision = avatarSelection.revision
        let prepared = avatarSelection.data
        working = true; error = ""
        defer { working = false }
        do {
            var avatar = avatarSelection.uploadURL ?? originalAvatarURL
            if let prepared, avatarSelection.uploadURL == nil {
                avatar = try await client.uploadAvatar(prepared)
                guard !Task.isCancelled, avatarSelection.revision == selectionRevision,
                      session.canEditProfile(client: client, userID: editingUserID) else { throw CancellationError() }
                avatarSelection.uploaded(avatar, revision: selectionRevision)
            }
            try await session.saveProfile(nickname: value, avatarURL: avatar, username: username.isEmpty ? nil : username,
                                          birthday: birthday.isEmpty ? nil : birthday, gender: gender, signature: signature,
                                          avatarData: prepared, client: client, userID: editingUserID)
            dismiss()
        } catch is CancellationError {
            if !session.canEditProfile(client: client, userID: editingUserID) { dismiss() }
            else { reportSaveError("保存已中断，请重试；当前选择的头像已保留") }
        } catch {
            if session.canEditProfile(client: client, userID: editingUserID) { reportSaveError(error.localizedDescription) }
        }
    }

    private func loadAvatar(_ item: PhotosPickerItem?) {
        photoLoadTask?.cancel()
        guard let item, let client = editingClient else { return }
        let revision = avatarSelection.begin()
        avatarPreview = nil; error = ""
        photoLoadTask = Task {
            do {
                guard let raw = try await item.loadTransferable(type: Data.self) else { throw APIClientError.server("照片读取失败，请重新选择图片") }
                let prepared = try await AvatarImageProcessor.prepare(raw)
                guard !Task.isCancelled, session.canEditProfile(client: client, userID: editingUserID),
                      avatarSelection.finish(prepared, revision: revision) else { return }
                avatarPreview = UIImage(data: prepared)
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled, avatarSelection.revision == revision,
                      session.canEditProfile(client: client, userID: editingUserID) else { return }
                let message = "照片读取失败，请重新选择或取消更换头像。\n" + error.localizedDescription
                avatarSelection.fail(message, revision: revision); reportSaveError(message)
            }
        }
    }

    private func reportSaveError(_ message: String) {
        error = message; showingSaveError = true
    }

    private func chooseBirthday(_ value: Date) {
        showingBirthday = false
        let next = profileDate(value)
        if !birthday.isEmpty && birthday != next { pendingBirthday = value; showingBirthdayWarning = true }
        else { birthdayDate = value; birthday = next }
    }

    private func showingSignatureEditor() {
        showingSignature = true
    }

    private func showingNicknameEditor() {
        showingNickname = true
    }
}

struct IOSProfileQRCodeView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var error = ""
    @State private var isVisible = false

    private var payload: String? { PublicUserIdentity.qrPayload(session.user?.publicID) }
    private var publicID: String { PublicUserIdentity.display(session.user?.publicID) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 23)).foregroundStyle(PulsePalette.ink).frame(width: 44, height: 44) }
                Spacer()
                Text("我的二维码").font(.system(size: 20, weight: .semibold)).foregroundStyle(PulsePalette.ink)
                Spacer()
                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .background(PulsePalette.surface)
            ScrollView {
                VStack(spacing: 0) {
                    VStack(spacing: 0) {
                        PulseAvatar(title: session.user?.nickname ?? "用", size: 112, avatarURL: session.user?.avatarURL)
                            .padding(.top, 34)
                        Text(session.user?.nickname ?? "用户")
                            .font(.system(size: 23, weight: .bold))
                            .foregroundStyle(PulsePalette.ink)
                            .padding(.top, 18)
                        Text("用户 ID：\(publicID)")
                            .font(.system(size: 18))
                            .foregroundStyle(PulsePalette.muted)
                            .padding(.top, 9)
                        if let payload {
                            PulseBrandedQRCode(payload: payload).frame(width: 304, height: 304).padding(.top, 28)
                        } else {
                            Text("用户 ID 未就绪，暂时无法生成二维码").foregroundStyle(PulsePalette.muted).padding(.top, 28)
                        }
                        Text("扫一扫上面的二维码图案，加我好友")
                            .font(.system(size: 17))
                            .foregroundStyle(PulsePalette.muted)
                            .padding(.top, 23)
                            .padding(.bottom, 34)
                    }
                    .frame(maxWidth: .infinity)
                    .background(PulsePalette.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .padding(.horizontal, 16)
                    Button { saveQRCode() } label: {
                        Text("保存二维码")
                            .font(.system(size: 19, weight: .medium))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 58)
                            .background(PulsePalette.accent)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(payload == nil)
                    .padding(.horizontal, 38)
                    .padding(.top, 42)
                    if !error.isEmpty { Text(error).font(.system(size: 13)).foregroundStyle(PulsePalette.danger).padding(.top, 12) }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 22)
                .padding(.bottom, 30)
            }
            .scrollIndicators(.hidden)
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .pulseOnChange(of: session.token) { _ in dismiss() }
    }

    private func imageForShare() -> UIImage? {
        guard let payload, let qr = QRCodeImage.makeImage(payload: payload) else { return nil }
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 720, height: 980))
        return renderer.image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 720, height: 980))
            if let avatarURL = session.user?.avatarURL, let url = APIClient.shared.mediaURL(avatarURL), let data = try? Data(contentsOf: url), let avatar = UIImage(data: data) { avatar.draw(in: CGRect(x: 290, y: 42, width: 140, height: 140)) }
            let nickname = session.user?.nickname ?? "用户"
            nickname.draw(at: CGPoint(x: 250, y: 198), withAttributes: [.font: UIFont.systemFont(ofSize: 26, weight: .semibold), .foregroundColor: UIColor.black])
            "用户 ID：\(publicID)".draw(at: CGPoint(x: 190, y: 238), withAttributes: [.font: UIFont.systemFont(ofSize: 19), .foregroundColor: UIColor.gray])
            qr.draw(in: CGRect(x: 80, y: 300, width: 560, height: 560))
            let cg = context.cgContext
            cg.setStrokeColor(UIColor.systemBlue.cgColor)
            cg.setLineWidth(8)
            cg.setLineCap(.round)
            cg.move(to: CGPoint(x: 112, y: 300)); cg.addLine(to: CGPoint(x: 80, y: 300)); cg.addLine(to: CGPoint(x: 80, y: 332))
            cg.move(to: CGPoint(x: 608, y: 300)); cg.addLine(to: CGPoint(x: 640, y: 300)); cg.addLine(to: CGPoint(x: 640, y: 332))
            cg.move(to: CGPoint(x: 80, y: 828)); cg.addLine(to: CGPoint(x: 80, y: 860)); cg.addLine(to: CGPoint(x: 112, y: 860))
            cg.move(to: CGPoint(x: 608, y: 860)); cg.addLine(to: CGPoint(x: 640, y: 860)); cg.addLine(to: CGPoint(x: 640, y: 828))
            cg.strokePath()
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 336, y: 556, width: 48, height: 48))
            UIColor.white.setFill()
            context.fill(CGRect(x: 344, y: 564, width: 32, height: 32))
            "扫一扫上面的二维码图案，加我好友".draw(at: CGPoint(x: 190, y: 895), withAttributes: [.font: UIFont.systemFont(ofSize: 18), .foregroundColor: UIColor.black])
        }
    }

    private func saveQRCode() {
        guard isVisible, payload != nil, let image = imageForShare() else { error = "用户 ID 未就绪，暂时无法生成二维码"; return }
        let token = session.token, viewerID = session.user?.id, endpoint = APIClient.shared.endpointIdentity
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            DispatchQueue.main.async {
                guard isVisible, session.token == token, session.user?.id == viewerID, endpoint == APIClient.shared.endpointIdentity else { return }
                guard status == .authorized || status == .limited else { error = "请在系统设置中允许保存照片"; return }
                UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil); error = "二维码已保存到系统相册"
            }
        }
    }

}

struct IOSChangePasswordView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var next = ""
    @State private var error = ""
    var body: some View {
        VStack(spacing: 0) {
            profilePageHeader(title: "设置新密码", dismiss: dismiss)
            VStack(spacing: 18) {
                SecureField("请输入旧密码", text: $current).profileInput()
                SecureField("请输入新密码", text: $next).profileInput()
                Button("确定") { Task { await save() } }.buttonStyle(PulsePrimaryButtonStyle()).disabled(current.isEmpty || next.count < 8)
                if !error.isEmpty { Text(error).font(.system(size: 13)).foregroundStyle(PulsePalette.danger) }
            }.padding(24)
            Spacer()
        }.background(PulsePalette.background).toolbar(.hidden, for: .navigationBar)
    }
    private func save() async { do { try await APIClient.shared.changePassword(current: current, newPassword: next); session.signOut(); dismiss() } catch { error = error.localizedDescription } }
}

struct IOSUsernameEditorView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var error = ""
    var body: some View {
        VStack(spacing: 0) {
            profilePageHeader(title: "账号", dismiss: dismiss, trailing: "完成") { Task { await save() } }
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) { Text("账号").font(.system(size: 19)).foregroundStyle(PulsePalette.ink); TextField("", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled().font(.system(size: 19)); Spacer(); if !username.isEmpty { Button { username = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(PulsePalette.muted) } } }.padding(.horizontal, 18).frame(height: 58).background(PulsePalette.surface)
                Text("设置用户名后，其他用户可以通过用户名找到您，从而保证您无需泄漏手机号。\n\n您可以使用 a-z、A-Z 以及 0-9，并且至少使用 5 个字符，最多 24 个字符，并以 a-z、A-Z 开头。")
                    .font(.system(size: 16)).foregroundStyle(PulsePalette.muted).lineSpacing(6).padding(.horizontal, 18)
                if !error.isEmpty { Text(error).font(.system(size: 13)).foregroundStyle(PulsePalette.danger).padding(.horizontal, 18) }
            }.padding(.top, 20)
            Spacer()
        }.background(PulsePalette.background).toolbar(.hidden, for: .navigationBar).task { username = session.user?.username ?? "" }
    }
    private func save() async {
        let value = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[A-Za-z][A-Za-z0-9]{4,23}$", options: .regularExpression) != nil else { error = "账号需要 5 到 24 位，以字母开头，只能包含字母和数字"; return }
        do { try await session.saveProfile(nickname: session.user?.nickname ?? "用户", avatarURL: session.user?.avatarURL ?? "", username: value, birthday: session.user?.birthday, gender: session.user?.gender, signature: session.user?.signature); dismiss() } catch { error = error.localizedDescription }
    }
}

struct IOSBirthdayPickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var date: Date
    let onDone: (Date) -> Void
    var body: some View { VStack(spacing: 0) { HStack { Button("取消") { dismiss() }.foregroundStyle(PulsePalette.muted); Spacer(); Button("完成") { onDone(date); dismiss() }.foregroundStyle(PulsePalette.accent) }.padding(.horizontal, 20).frame(height: 52).background(PulsePalette.surface); DatePicker("", selection: $date, in: ...Date(), displayedComponents: .date).datePickerStyle(.wheel).labelsHidden().frame(maxWidth: .infinity).background(PulsePalette.surface); Spacer() }.background(PulsePalette.background).presentationDetents([.height(340)]).presentationDragIndicator(.visible) }
}

struct IOSGenderPickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var value: String
    var body: some View { VStack(spacing: 0) { HStack { Button("取消") { dismiss() }.foregroundStyle(PulsePalette.muted); Spacer(); Button("完成") { dismiss() }.foregroundStyle(PulsePalette.accent) }.padding(.horizontal, 20).frame(height: 52).background(PulsePalette.surface); Picker("性别", selection: $value) { Text("男").tag("男"); Text("女").tag("女"); Text("保密").tag("保密") }.pickerStyle(.wheel).frame(maxWidth: .infinity).background(PulsePalette.surface); Spacer() }.background(PulsePalette.background).presentationDetents([.height(300)]).presentationDragIndicator(.visible) }
}

struct IOSNicknameEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var value: String
    @State private var draft = ""
    var body: some View {
        VStack(spacing: 0) {
            profilePageHeader(title: "修改昵称", dismiss: dismiss, trailing: "完成") { value = draft; dismiss() }
            TextField("昵称", text: $draft)
                .padding(.horizontal, 18)
                .frame(height: 58)
                .background(PulsePalette.surface)
                .padding(.top, 20)
            Spacer()
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .task { draft = value }
    }
}

struct IOSSignatureEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var value: String
    @State private var draft = ""
    var body: some View {
        VStack(spacing: 0) {
            profilePageHeader(title: "个人简介", dismiss: dismiss, trailing: "完成") { value = String(draft.prefix(70)); dismiss() }
            TextEditor(text: $draft)
                .font(.system(size: 17))
                .scrollContentBackground(.hidden)
                .padding(12)
                .frame(height: 150)
                .background(PulsePalette.surface)
                .padding(.top, 20)
            Text("最多 70 个字符")
                .font(.system(size: 12))
                .foregroundStyle(PulsePalette.muted)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, 18)
            Spacer()
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .task { draft = value }
    }
}

struct IOSAppearanceSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("pulse_theme") private var theme = "system"
    @AppStorage("pulse_font_scale") private var fontScale = 1.0

    var body: some View {
        PulseNavigationStack {
            List {
                Section("主题") {
                    appearanceChoice(title: "跟随系统", value: "system")
                    appearanceChoice(title: "浅色模式", value: "light")
                    appearanceChoice(title: "深色模式", value: "dark")
                }
                Section("字体大小") {
                    Picker("聊天字体", selection: $fontScale) {
                        Text("小").tag(0.9)
                        Text("标准").tag(1.0)
                        Text("大").tag(1.15)
                        Text("特大").tag(1.3)
                    }
                    .pickerStyle(.menu)
                }
            }
            .navigationTitle("外观显示")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { dismiss() } }
        }
    }

    private func appearanceChoice(title: String, value: String) -> some View {
        Button { theme = value } label: {
            HStack {
                Text(title).foregroundStyle(PulsePalette.ink)
                Spacer()
                if theme == value { Image(systemName: "checkmark").foregroundStyle(PulsePalette.accent) }
            }
        }
    }
}

private enum IOSCacheRetention: String, CaseIterable, Identifiable {
    case threeDays = "3d"
    case oneWeek = "7d"
    case oneMonth = "1m"
    case permanent = "permanent"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .threeDays: return "3 天"
        case .oneWeek: return "1 周"
        case .oneMonth: return "1 个月"
        case .permanent: return "永久"
        }
    }

    var age: TimeInterval? {
        switch self {
        case .threeDays: return 3 * 24 * 60 * 60
        case .oneWeek: return 7 * 24 * 60 * 60
        case .oneMonth: return 30 * 24 * 60 * 60
        case .permanent: return nil
        }
    }
}

private struct IOSStorageUsage {
    var serviceBytes: Int64 = 0
    var cacheBytes: Int64 = 0
}

private enum IOSLocalStorageService {
    private static let fileManager = FileManager.default

    static func usage() -> IOSStorageUsage {
        IOSStorageUsage(
            serviceBytes: directoryBytes(applicationSupportURL),
            cacheBytes: cacheURLs.reduce(0) { $0 + directoryBytes($1) }
        )
    }

    static func applyRetentionPolicy(rawValue: String) {
        guard let retention = IOSCacheRetention(rawValue: rawValue), let age = retention.age else { return }
        let cutoff = Date().addingTimeInterval(-age)
        for url in cacheURLs {
            removeItems(in: url, olderThan: cutoff)
        }
    }

    @MainActor static func clearCache() {
        Task { await IOSLocalMediaCache.shared.clear() }
        AvatarImageCache.shared.clear()
        IOSChatImageCache.shared.clear()
        for url in cacheURLs {
            guard let items = try? fileManager.contentsOfDirectory(at: url, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { continue }
            for item in items { try? fileManager.removeItem(at: item) }
        }
    }

    private static var applicationSupportURL: URL {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? fileManager.temporaryDirectory
    }

    private static var cacheURLs: [URL] {
        [fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first, fileManager.temporaryDirectory].compactMap { $0 }
    }

    private static func directoryBytes(_ url: URL) -> Int64 {
        guard let enumerator = fileManager.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey], options: [.skipsHiddenFiles]) else { return 0 }
        return enumerator.reduce(0) { total, item in
            total + Int64((try? item.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
    }

    private static func removeItems(in url: URL, olderThan cutoff: Date) {
        guard let enumerator = fileManager.enumerator(at: url, includingPropertiesForKeys: [.contentAccessDateKey, .contentModificationDateKey, .creationDateKey, .isDirectoryKey], options: [.skipsHiddenFiles]) else { return }
        let items = enumerator.compactMap { $0 as? URL }
        for item in items.reversed() {
            guard let values = try? item.resourceValues(forKeys: [.contentAccessDateKey, .contentModificationDateKey, .creationDateKey, .isDirectoryKey]), values.isDirectory != true else { continue }
            let dates = [values.contentAccessDate, values.contentModificationDate, values.creationDate].compactMap { $0 }
            guard let latest = dates.max(), latest < cutoff else { continue }
            try? fileManager.removeItem(at: item)
        }
    }
}

struct IOSDataStorageView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                NavigationLink(destination: IOSStorageUsageView().pulseSwipeBack()) {
                    HStack {
                        Text("存储用量").font(.system(size: 20)).foregroundStyle(PulsePalette.ink)
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 19, weight: .medium)).foregroundStyle(PulsePalette.muted)
                    }
                    .padding(.horizontal, 26)
                    .frame(maxWidth: .infinity, minHeight: 74)
                    .background(PulsePalette.surface)
                }
                .buttonStyle(.plain)
            }
            .background(PulsePalette.background)
            .navigationTitle("数据存储")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 22, weight: .medium))
                    }
                    .accessibilityLabel("返回")
                }
            }
        }
    }
}

private struct IOSStorageUsageView: View {
    @AppStorage("pulse_cache_retention") private var cacheRetentionRaw = IOSCacheRetention.permanent.rawValue
    @State private var usage = IOSStorageUsage()
    @State private var showingRetention = false
    @State private var showingClear = false
    @State private var message = ""
    @State private var loading = true

    private var retention: IOSCacheRetention { IOSCacheRetention(rawValue: cacheRetentionRaw) ?? .permanent }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                storageActionRow(title: "保留缓存", detail: retention.title) { showingRetention = true }
                Text("为节省储存空间，此期限内您没有使用过的缓存文件都会被删除。\n这包括您消息记录中的图片、视频或其他文件。\n\n但这些文件都会保留在 \(PulseApp.name) 云端，您需要时可再次下载。")
                    .font(.system(size: 16))
                    .foregroundStyle(PulsePalette.muted)
                    .lineSpacing(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 26)
                    .padding(.vertical, 19)
                    .background(PulsePalette.background)

                storageValueRow(title: "服务文件", value: formattedSize(usage.serviceBytes), disabled: true)
                storageActionRow(title: "清除缓存", detail: formattedSize(usage.cacheBytes)) { showingClear = true }

                if loading {
                    ProgressView("正在计算存储用量")
                        .padding(.top, 28)
                }
                if !message.isEmpty {
                    Text(message)
                        .font(.system(size: 14))
                        .foregroundStyle(PulsePalette.accent)
                        .padding(.top, 18)
                }
            }
        }
        .background(PulsePalette.background)
        .navigationTitle("存储用量")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { actionSheetOverlay }
        .task { refresh() }
        .pulseOnChange(of: cacheRetentionRaw) { value in
            IOSLocalStorageService.applyRetentionPolicy(rawValue: value)
            refresh()
        }
    }

    private func storageActionRow(title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 20)).foregroundStyle(PulsePalette.ink)
                Spacer()
                Text(detail).font(.system(size: 18)).foregroundStyle(PulsePalette.muted)
                Image(systemName: "chevron.right").font(.system(size: 19, weight: .medium)).foregroundStyle(PulsePalette.muted)
            }
            .padding(.horizontal, 26)
            .frame(maxWidth: .infinity, minHeight: 74)
            .background(PulsePalette.surface)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { Rectangle().fill(PulsePalette.line.opacity(0.35)).frame(height: 0.5) }
    }

    private func storageValueRow(title: String, value: String, disabled: Bool) -> some View {
        HStack {
            Text(title).font(.system(size: 19)).foregroundStyle(disabled ? PulsePalette.muted : PulsePalette.ink)
            Spacer()
            Text(value).font(.system(size: 17)).foregroundStyle(PulsePalette.muted)
        }
        .padding(.horizontal, 26)
        .frame(maxWidth: .infinity, minHeight: 74)
        .background(PulsePalette.surface)
    }

    @ViewBuilder
    private var actionSheetOverlay: some View {
        if showingRetention || showingClear {
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.38)
                    .ignoresSafeArea()
                    .onTapGesture { closeSheet() }
                if showingRetention { retentionSheet }
                if showingClear { clearSheet }
            }
            .transition(.opacity)
        }
    }

    private var retentionSheet: some View {
        VStack(spacing: 10) {
            VStack(spacing: 0) {
                ForEach(IOSCacheRetention.allCases) { option in
                    Button {
                        cacheRetentionRaw = option.rawValue
                        closeSheet()
                    } label: {
                        Text(option.title)
                            .font(.system(size: 20))
                            .foregroundStyle(PulsePalette.accent)
                            .frame(maxWidth: .infinity, minHeight: 62)
                    }
                    .buttonStyle(.plain)
                    if option.id != IOSCacheRetention.allCases.last?.id { Divider() }
                }
            }
            .background(PulsePalette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            cancelSheetButton
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
    }

    private var clearSheet: some View {
        VStack(spacing: 10) {
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "checkmark").foregroundStyle(PulsePalette.accent)
                    Text("其它").font(.system(size: 20)).foregroundStyle(PulsePalette.ink)
                    Spacer()
                    Text(formattedSize(usage.cacheBytes)).font(.system(size: 18)).foregroundStyle(PulsePalette.muted)
                }
                .padding(.horizontal, 28)
                .frame(minHeight: 62)
                Divider()
                Button("清空（\(formattedSize(usage.cacheBytes))）") {
                    IOSLocalStorageService.clearCache()
                    message = "缓存已清除"
                    closeSheet()
                    refresh()
                }
                .font(.system(size: 20))
                .foregroundStyle(PulsePalette.accent)
                .frame(maxWidth: .infinity, minHeight: 62)
            }
            .background(PulsePalette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            cancelSheetButton
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
    }

    private var cancelSheetButton: some View {
        Button("取消") { closeSheet() }
            .font(.system(size: 20))
            .foregroundStyle(PulsePalette.accent)
            .frame(maxWidth: .infinity, minHeight: 62)
            .background(PulsePalette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func closeSheet() {
        withAnimation(.easeOut(duration: 0.18)) {
            showingRetention = false
            showingClear = false
        }
    }

    private func refresh() {
        loading = true
        message = ""
        IOSLocalStorageService.applyRetentionPolicy(rawValue: cacheRetentionRaw)
        usage = IOSLocalStorageService.usage()
        loading = false
    }

    private func formattedSize(_ bytes: Int64) -> String {
        if bytes < 1024 * 1024 { return "\(max(0, bytes / 1024)) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
    }
}

struct IOSDiagnosticsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var uploading = false
    @State private var result = ""
    @State private var error = ""

    var body: some View {
        PulseNavigationStack {
            List {
                Section("日志") {
                    Text("上传应用版本、设备型号和操作结果，帮助后台排查问题。聊天内容和登录密码不会包含在日志中。")
                        .font(.system(size: 14))
                        .foregroundStyle(PulsePalette.muted)
                    Button { upload() } label: {
                        HStack {
                            Label("上传日志", systemImage: "square.and.arrow.up")
                            Spacer()
                            if uploading { ProgressView() }
                        }
                    }
                    .disabled(uploading)
                }
                if !result.isEmpty { Section { Text(result).foregroundStyle(PulsePalette.accent) } }
                if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
            }
            .navigationTitle("上传日志")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("完成") { dismiss() } }
        }
    }

    private func upload() {
        uploading = true
        result = ""
        error = ""
        Task {
            do {
                let value = try await APIClient.shared.uploadDiagnostics()
                result = "上传成功，编号：\(value.reportId)"
            } catch {
                self.error = error.localizedDescription
            }
            uploading = false
        }
    }
}

struct IOSLanguageSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("pulse_language") private var language = "zh-Hans"

    private let languages = [
        (code: "zh-Hans", englishName: "Chinese (Simplified)", nativeName: "简体中文"),
        (code: "zh-Hant", englishName: "Chinese (Traditional)", nativeName: "繁體中文")
    ]

    var body: some View {
        PulseNavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(languages.enumerated()), id: \.offset) { index, item in
                        Button {
                            language = item.code
                        } label: {
                            HStack(spacing: 0) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(item.englishName)
                                        .font(.system(size: 20))
                                        .foregroundStyle(PulsePalette.ink)
                                    Text(item.nativeName)
                                        .font(.system(size: 18))
                                        .foregroundStyle(PulsePalette.muted)
                                }

                                Spacer()

                                if language == item.code {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 24, weight: .semibold))
                                        .foregroundStyle(PulsePalette.accent)
                                }
                            }
                            .padding(.horizontal, 36)
                            .frame(maxWidth: .infinity, minHeight: 100)
                            .background(PulsePalette.surface)
                        }
                        .buttonStyle(.plain)

                        if index == 0 {
                            Rectangle()
                                .fill(PulsePalette.background)
                                .frame(height: 14)
                        }
                    }
                }
            }
            .background(PulsePalette.background)
            .navigationTitle("语言设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 22, weight: .medium))
                    }
                    .accessibilityLabel("返回")
                }
            }
        }
    }
}

private struct ProfilePageHeader: View {
    let title: String
    let dismiss: DismissAction
    var trailing = "完成"
    var onTrailing: (() -> Void)? = nil
    var body: some View { HStack { Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 22)).foregroundStyle(PulsePalette.ink).frame(width: 44, height: 44) }; Spacer(); Text(title).font(.system(size: 20, weight: .semibold)).foregroundStyle(PulsePalette.ink); Spacer(); Button(trailing) { if let onTrailing { onTrailing() } else { dismiss() } }.foregroundStyle(PulsePalette.accent).frame(width: 62, height: 44) }.padding(.horizontal, 10).background(PulsePalette.surface) }
}

private func profilePageHeader(title: String, dismiss: DismissAction, trailing: String = "", onTrailing: (() -> Void)? = nil) -> some View { ProfilePageHeader(title: title, dismiss: dismiss, trailing: trailing.isEmpty ? "返回" : trailing, onTrailing: onTrailing) }

private extension View { func profileInput() -> some View { self.padding(.horizontal, 20).frame(height: 54).background(PulsePalette.surface).clipShape(Capsule()) } }

private func profileDate(_ value: Date) -> String { let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN"); formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from: value) }
private func profileDate(_ value: String) -> Date? { let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; return formatter.date(from: value) }

struct IOSUpdateView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    let required: Bool
    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "arrow.down.app").font(.system(size: 48)).foregroundStyle(PulsePalette.accent)
                Text(session.updateAvailable ? "新版本 \(session.latestVersion)" : "当前已是最新版本").font(.title2)
                Text(session.updateDescription).foregroundStyle(PulsePalette.muted)
                if session.updateAvailable {
                    if let url = session.updateURL { Link("打开更新地址", destination: url).buttonStyle(PulsePrimaryButtonStyle()) }
                    else { Text("更新地址尚未配置，请联系管理员。").foregroundStyle(PulsePalette.danger) }
                }
                Button("重新检查") { Task { await session.loadClientConfig() } }
                if !required { Button("关闭") { dismiss() } }
            }.padding(28).navigationTitle(required ? "请更新后继续使用" : "客户端更新")
        }
    }
}
