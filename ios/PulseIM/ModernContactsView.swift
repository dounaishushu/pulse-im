import SwiftUI
import PhotosUI
import UIKit

struct ModernContactsView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @State private var keyword = ""
    @State private var showingAddContact = false
    @State private var showingNewFriends = false
    @State private var showingGroups = false
    @State private var showingChannels = false
    @State private var openingChat: IOSContactChatRequest?
    @State private var error = ""
    @State private var loading = false
    @State private var selectedLetter: String?
    @FocusState private var searchFocused: Bool

    private var sections: [ContactIndexSection] {
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = session.contacts
            .filter { value.isEmpty || session.contactDisplayName(userID: $0.userId, fallback: $0.contactCardDisplayName).localizedCaseInsensitiveContains(value) || $0.nickname.localizedCaseInsensitiveContains(value) || ($0.remark ?? "").localizedCaseInsensitiveContains(value) || ($0.phone ?? "").contains(value) || ($0.username ?? "").localizedCaseInsensitiveContains(value) || ($0.publicID ?? "").contains(value) }
            .sorted { ContactIndex.sortKey(session.contactDisplayName(userID: $0.userId, fallback: $0.contactCardDisplayName)) < ContactIndex.sortKey(session.contactDisplayName(userID: $1.userId, fallback: $1.contactCardDisplayName)) }

        let grouped = Dictionary(grouping: filtered) { ContactIndex.letter(for: session.contactDisplayName(userID: $0.userId, fallback: $0.contactCardDisplayName)) }
        return grouped.keys.sorted().map { ContactIndexSection(letter: $0, contacts: grouped[$0] ?? []) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                contactsHeader
                searchField
                quickLinks
                ReferenceContactsAppearance.background.frame(height: 10)
                contactList
            }
            .overlay(alignment: .trailing) {
                if !sections.isEmpty {
                    ContactAlphabetBar(letters: sections.map(\.letter), selectedLetter: selectedLetter ?? sections.first?.letter) { letter in
                        searchFocused = false; selectedLetter = letter
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(ContactIndex.targetID(for: letter), anchor: .top) }
                    }.padding(.trailing, 5)
                }
            }
        }
        .background { ReferenceContactsAppearance.background }
        .background(PulsePalette.surface.ignoresSafeArea(.container, edges: .top))
        .toolbar(.hidden, for: .navigationBar)
        .task {
            async let contacts: Void = reload()
            try? await session.refreshFriendRequestBadge()
            await contacts
        }
        .pulseSheet(isPresented: $showingAddContact) { IOSAddFriendView() }
        .pulseSheet(isPresented: $showingNewFriends) { NewFriendsView() }
        .pulseSheet(isPresented: $showingGroups) { PulseNavigationStack { MyGroupsView() } }
        .pulseSheet(isPresented: $showingChannels) { MyChannelsView() }
        .pulseFullScreenCover(item: $openingChat, onDismiss: { openingChat = nil }) { request in
            PulseNavigationStack { ContactChatOpeningView(request: request) }
        }
        .pulseOnChange(of: sections.map(\.letter)) { letters in if !letters.contains(selectedLetter ?? "") { selectedLetter = letters.first } }
        .pulseOnChange(of: session.token) { _ in openingChat = nil; keyword = ""; selectedLetter = nil; searchFocused = false }
        .pulseOnChange(of: session.user?.id) { _ in openingChat = nil }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { openingChat = nil } }
        .pulseOnChange(of: session.updateRequired) { required in if required { openingChat = nil } }
        .alert("提示", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) {
            Button("知道了") { error = "" }
        } message: {
            Text(error)
        }
    }

    private var contactsHeader: some View {
        ZStack {
            Text("联系人")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(PulsePalette.ink)
            HStack {
                Spacer()
                Button { searchFocused = false; showingAddContact = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 24, weight: .regular))
                        .foregroundStyle(PulsePalette.ink)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("添加联系人")
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 44)
        .background(PulsePalette.surface)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(PulsePalette.muted)
            TextField("搜索用户", text: $keyword)
                .font(.system(size: 14))
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { searchFocused = false }
            if !keyword.isEmpty {
                Button { keyword = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(PulsePalette.muted)
                }
            }
        }
        .padding(.horizontal, 13)
        .frame(height: 37)
        .background(ReferenceContactsAppearance.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 15)
        .padding(.vertical, 6)
        .background(PulsePalette.surface)
    }

    private var quickLinks: some View {
        HStack(alignment: .top, spacing: 0) {
            contactEntry(icon: "person.badge.plus", colors: [Color(hex: 0x24A7BB), Color(hex: 0x3BB7CD)], title: "新的朋友", badgeCount: session.pendingFriendRequestCount, action: { searchFocused = false; showingNewFriends = true })
            contactEntry(icon: "person.2", colors: [Color(hex: 0x2DB854), Color(hex: 0x62C953)], title: "我的群组", action: { searchFocused = false; showingGroups = true })
            contactEntry(icon: "megaphone", colors: [Color(hex: 0xE95261), Color(hex: 0xF16F73)], title: "我的频道", action: { searchFocused = false; showingChannels = true })
        }
        .padding(.top, 12)
        .frame(height: 93, alignment: .top)
        .background(PulsePalette.surface)
    }

    private func contactEntry(icon: String, colors: [Color], title: String, badgeCount: Int = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(.white)
                    .frame(width: 36.5, height: 36.5)
                    .background(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .overlay(alignment: .topTrailing) { PulseCountBadge(count: badgeCount).offset(x: 6, y: -5) }
                Text(title)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(PulsePalette.ink)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(badgeCount > 0 ? "\(badgeCount)条待处理好友申请" : "")
    }

    private var contactList: some View {
            ScrollView {
                LazyVStack(spacing: 0) {
                    if sections.isEmpty {
                        EmptyState(icon: "person.2", title: keyword.isEmpty ? "还没有联系人" : "没有找到联系人", message: keyword.isEmpty ? "添加好友后会显示在这里" : "请尝试其他关键词")
                            .padding(.top, 72)
                            .padding(.horizontal, 24)
                    } else {
                        ForEach(sections) { section in
                                ForEach(Array(section.contacts.enumerated()), id: \.element.userId) { index, contact in
                                    contactRow(contact).id(index == 0 ? ContactIndex.targetID(for: section.letter) : "contact-person-\(contact.userId)")
                                }
                        }
                    }
                    Text("共 \(session.contacts.count) 个联系人")
                        .font(.system(size: 14))
                        .foregroundStyle(PulsePalette.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 14).padding(.bottom, 16)
                }
            }
            .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
            .refreshable { await reload() }
    }

    private func contactRow(_ contact: Contact) -> some View {
        Button {
            searchFocused = false
            openChat(userID: contact.userId, title: session.contactDisplayName(userID: contact.userId, fallback: contact.contactCardDisplayName))
        } label: {
            HStack(alignment: .top, spacing: 10) {
                ReferenceContactsAvatar(contact: contact)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.contactDisplayName(userID: contact.userId, fallback: contact.contactCardDisplayName)).font(.system(size: 16, weight: .regular)).foregroundStyle(PulsePalette.ink).lineLimit(1)
                    Text("用户 ID：\(PublicUserIdentity.display(contact.publicID))").font(.caption).foregroundStyle(PulsePalette.muted).lineLimit(1)
                }.padding(.top, 2)
                Spacer()
            }
            .padding(.horizontal, 15)
            .frame(height: 60)
            .background(PulsePalette.surface)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(PulsePalette.line.opacity(0.3))
                    .frame(height: 0.5)
                    .padding(.leading, 67)
            }
        }
        .buttonStyle(.plain)
    }

    @MainActor private func reload() async {
        guard !loading else { return }
        let token = session.token, client = APIClient.shared.captureSession()
        guard session.isSignedIn, token != nil else { return }
        loading = true
        defer { loading = false }
        do {
            let contacts = try await client.contacts()
            guard session.token == token, session.isSignedIn, client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
            session.contacts = contacts
        } catch {
            if session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity { self.error = error.localizedDescription }
        }
    }

    @MainActor private func openChat(userID: Int, title: String) {
        guard openingChat == nil, !appLock.isLocked, !session.updateRequired else { return }
        error = ""
        openingChat = IOSContactChatRequest(userID: userID, title: title, session: session)
    }
}

private struct ContactIndexSection: Identifiable {
    let letter: String
    let contacts: [Contact]
    var id: String { letter }
}

private enum ContactIndex {
    static func targetID(for letter: String) -> String { "contact-letter-\(letter)" }

    static func letter(for value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "#" }
        let latin = trimmed.applyingTransform(.toLatin, reverse: false) ?? trimmed
        let normalized = latin.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).uppercased()
        for scalar in normalized.unicodeScalars {
            if CharacterSet.uppercaseLetters.contains(scalar) { return String(scalar) }
            if CharacterSet.decimalDigits.contains(scalar) { return "#" }
        }
        return "#"
    }

    static func sortKey(_ value: String) -> String {
        let latin = value.applyingTransform(.toLatin, reverse: false) ?? value
        return latin.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased()
    }
}

private struct ContactAlphabetBar: View {
    let letters: [String]
    let selectedLetter: String?
    let select: (String) -> Void

    var body: some View {
        VStack(spacing: 3) {
            ForEach(letters, id: \.self) { letter in
                Button { select(letter) } label: {
                    Text(letter)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(selectedLetter == letter ? .white : PulsePalette.muted)
                        .frame(width: 14, height: 14)
                        .background(selectedLetter == letter ? Color(hex: 0x052EFA) : .clear, in: Circle())
                        .frame(width: 18, height: 18)
                }.buttonStyle(.plain).accessibilityLabel("跳转到\(letter)开头的联系人").accessibilityValue(selectedLetter == letter ? "已选中" : "")
            }
        }
        .padding(.vertical, 7)
        .background(PulsePalette.surface, in: Capsule())
        .overlay { Capsule().stroke(PulsePalette.line.opacity(0.15), lineWidth: 0.5) }
    }
}

private enum ReferenceContactsAppearance {
    static let background = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .secondarySystemBackground : UIColor(red: 248.0 / 255, green: 249.0 / 255, blue: 250.0 / 255, alpha: 1) })
    static let searchBackground = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .tertiarySystemBackground : UIColor(red: 247.0 / 255, green: 248.0 / 255, blue: 249.0 / 255, alpha: 1) })
}

private struct ReferenceContactsAvatar: View {
    let contact: Contact
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0xA2E86F), Color(hex: 0x46C85B)], startPoint: .top, endPoint: .bottom)
            Text(String(contact.nickname.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1))).font(.system(size: 18, weight: .regular)).foregroundStyle(.white)
            if let raw = contact.avatarURL, let url = APIClient.shared.mediaURL(raw) { StableAvatarImage(url: url) }
        }.frame(width: 42, height: 42).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous)).accessibilityHidden(true)
    }
}

struct NewFriendsView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var loading = false
    @State private var error = ""

    private var pendingRequests: [ContactRequest] {
        session.pendingFriendRequests
    }

    var body: some View {
        VStack(spacing: 0) {
            sheetHeader(title: "新的朋友", dismiss: dismiss)
            ScrollView {
                LazyVStack(spacing: 0) {
                    if pendingRequests.isEmpty {
                        EmptyState(icon: "person.crop.circle.badge.plus", title: "暂时未有新申请", message: "有人添加你为好友时会显示在这里")
                            .padding(.top, 120)
                            .padding(.horizontal, 25)
                    } else {
                        ForEach(pendingRequests) { request in
                            friendRequestRow(request)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            .refreshable { await load() }
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .alert("提示", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) {
            Button("知道了") { error = "" }
        } message: {
            Text(error)
        }
    }

    private func friendRequestRow(_ request: ContactRequest) -> some View {
        HStack(spacing: 12) {
            PulseAvatar(title: request.nickname, size: 46, avatarURL: request.avatarURL)
            VStack(alignment: .leading, spacing: 5) {
                Text(request.nickname)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(PulsePalette.ink)
                Text(request.message?.isEmpty == false ? request.message! : "请求添加你为好友")
                    .font(.system(size: 12))
                    .foregroundStyle(PulsePalette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            HStack(spacing: 7) {
                Button("拒绝") { Task { await handle(request, action: "reject") } }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(PulsePalette.muted)
                Button("同意") { Task { await handle(request, action: "accept") } }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(PulsePalette.accent)
                    .clipShape(Capsule())
            }
            .disabled(session.handlingFriendRequestIDs.contains(request.id))
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 74)
        .background(PulsePalette.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(PulsePalette.line).frame(height: 0.5).padding(.leading, 74)
        }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            try await session.refreshFriendRequests()
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func handle(_ request: ContactRequest, action: String) async {
        do {
            try await session.handleFriendRequest(request, action: action)
        } catch is CancellationError {
            return
        } catch {
            error = error.localizedDescription
        }
    }
}

struct MyGroupsView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var groups: [Conversation] = []
    @State private var keyword = ""
    @State private var error = ""
    @State private var loading = false
    @State private var joinCode = ""
    @State private var showingJoin = false
    @State private var joining = false

    private var filteredGroups: [Conversation] {
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? groups : groups.filter { ($0.name ?? "").localizedCaseInsensitiveContains(value) }
    }

    var body: some View {
        VStack(spacing: 0) {
            sheetHeader(title: "我的群组", dismiss: dismiss)
            if !session.chatNotice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                noticeBanner(session.chatNotice)
            }
            if APIClient.shared.isGoV2 {
                Button("通过邀请码加入群组") { showingJoin = true }.padding(.vertical, 8).disabled(joining)
            }
            searchBar(placeholder: "搜索消息、用户或群", text: $keyword)
            ScrollView {
                LazyVStack(spacing: 0) {
                    if filteredGroups.isEmpty {
                        EmptyState(icon: "person.3", title: "还没有加入群组", message: "创建或加入群组后会显示在这里")
                            .padding(.top, 100)
                            .padding(.horizontal, 25)
                    } else {
                        ForEach(filteredGroups) { group in
                            NavigationLink {
                                GroupMembersView(conversation: group).pulseSwipeBack()
                            } label: {
                                ConversationDirectoryRow(conversation: group, kind: "group")
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            .refreshable { await load() }
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .alert("邀请码入群", isPresented: $showingJoin) {
            TextField("输入邀请码", text: $joinCode)
            Button("取消", role: .cancel) { joinCode = "" }
            Button("加入") { Task { await join() } }
        } message: { Text("加入后可查看权限允许的消息。") }
        .pulseOnChange(of: session.token) { _ in groups = []; dismiss() }
        .alert("提示", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) {
            Button("知道了") { error = "" }
        } message: {
            Text(error)
        }
    }

    @MainActor private func join() async {
        let code = joinCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !joining, !code.isEmpty, session.isSignedIn else { return }
        let client = APIClient.shared.captureSession(), token = session.token
        joining = true; defer { joining = false }
        do {
            try await client.joinGroup(inviteCode: code)
            guard token == session.token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            joinCode = ""; try await session.refreshConversations(); await load()
        } catch { if token == session.token, client.endpointIdentity == APIClient.shared.endpointIdentity { self.error = error.localizedDescription } }
    }
    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let client = APIClient.shared.captureSession(), token = session.token
            let values = try await client.conversations(type: "group")
            guard token == session.token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            groups = values
        } catch {
            error = error.localizedDescription
        }
    }
}

struct MyChannelsView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var channels: [Conversation] = []
    @State private var keyword = ""
    @State private var showingCreate = false
    @State private var openingConversation: Conversation?
    @State private var error = ""
    @State private var loading = false

    private var filteredChannels: [Conversation] {
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? channels : channels.filter { ($0.name ?? "").localizedCaseInsensitiveContains(value) }
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("我的频道")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(PulsePalette.ink)
                HStack {
                    Button("返回") { dismiss() }
                        .font(.system(size: 16))
                        .foregroundStyle(PulsePalette.accent)
                    Spacer()
                    Button("添加") { showingCreate = true }
                        .font(.system(size: 16))
                        .foregroundStyle(PulsePalette.accent)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 6)
            .background(PulsePalette.surface)
            if !session.chatNotice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                noticeBanner(session.chatNotice)
            }
            searchBar(placeholder: "搜索消息、用户或频道", text: $keyword)
            ScrollView {
                LazyVStack(spacing: 0) {
                    if filteredChannels.isEmpty {
                        EmptyState(icon: "megaphone", title: "还没有频道", message: "点击右上角添加频道")
                            .padding(.top, 100)
                            .padding(.horizontal, 25)
                    } else {
                        ForEach(filteredChannels) { channel in
                            Button { openingConversation = channel } label: {
                                ConversationDirectoryRow(conversation: channel, kind: "channel")
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            .refreshable { await load() }
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .pulseSheet(isPresented: $showingCreate) {
            CreateChannelView {
                Task { await load() }
            }
        }
        .pulseSheet(item: $openingConversation) { conversation in
            PulseNavigationStack { ChatView(conversation: conversation, actorID: session.user?.id) }
        }
        .alert("提示", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) {
            Button("知道了") { error = "" }
        } message: {
            Text(error)
        }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            channels = try await APIClient.shared.conversations(type: "channel")
        } catch {
            error = error.localizedDescription
        }
    }
}

private struct ConversationDirectoryRow: View {
    @EnvironmentObject private var session: AppSession
    let conversation: Conversation
    let kind: String

    private var title: String { conversation.name ?? (kind == "channel" ? "未命名频道" : "未命名群组") }
    private var tint: Color { kind == "channel" ? Color(hex: 0xF19A3E) : Color(hex: 0x7168D8) }
    private var preview: String {
        if let message = conversation.lastMessage {
            if message.type == "image" { return "图片" }
            if message.type == "voice" { return "语音消息" }
            if message.type == "file" { return "文件" }
            return message.body["text"]?.stringValue ?? "消息"
        }
        return kind == "channel" ? "频道" : "群组"
    }
    private var time: String {
        guard let value = conversation.lastMessage?.createdAt else { return "" }
        return String((value.split(separator: " ").last.map(String.init) ?? value).prefix(5))
    }

    var body: some View {
        HStack(spacing: 12) {
            PulseAvatar(title: title, tint: tint, size: 52, avatarURL: conversation.avatarURL)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(PulsePalette.ink)
                        .lineLimit(1)
                    Image(systemName: kind == "channel" ? "checkmark.seal.fill" : "person.3.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(kind == "channel" ? PulsePalette.accent : PulsePalette.muted)
                }
                Text(session.showGroupMemberCount ? "\(conversation.memberCount ?? 0) 位成员 · \(preview)" : preview)
                    .font(.system(size: 13))
                    .foregroundStyle(PulsePalette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 8) {
                Text(time)
                    .font(.system(size: 11))
                    .foregroundStyle(PulsePalette.muted)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(PulsePalette.muted)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 76)
        .background(PulsePalette.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(PulsePalette.line).frame(height: 0.5).padding(.leading, 80)
        }
    }
}

struct CreateChannelView: View {
    let onCreated: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarData: Data?
    @State private var error = ""
    @State private var working = false

    var body: some View {
        VStack(spacing: 0) {
            sheetHeader(title: "创建频道", dismiss: dismiss)
            ScrollView {
                VStack(spacing: 18) {
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        if let avatarData, let image = UIImage(data: avatarData) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 86, height: 86)
                                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                        } else {
                            ZStack {
                                RoundedRectangle(cornerRadius: 24, style: .continuous)
                                    .fill(PulsePalette.accentSoft)
                                Image(systemName: "camera.fill")
                                    .font(.system(size: 25))
                                    .foregroundStyle(PulsePalette.accent)
                            }
                            .frame(width: 86, height: 86)
                        }
                    }
                    .buttonStyle(.plain)

                    VStack(spacing: 0) {
                        TextField("频道名称", text: $name)
                            .padding(.horizontal, 14)
                            .frame(height: 52)
                        Divider().padding(.leading, 14)
                        TextField("频道简介（选填）", text: $description, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 14)
                    }
                    .background(PulsePalette.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                    Text("频道头像、名称和简介会保存到服务器，创建后可以在频道资料中继续管理。")
                        .font(.system(size: 12))
                        .foregroundStyle(PulsePalette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if !error.isEmpty {
                        Text(error)
                            .font(.system(size: 13))
                            .foregroundStyle(PulsePalette.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button { Task { await create() } } label: {
                        HStack(spacing: 8) {
                            if working { ProgressView().tint(.white) }
                            Text(working ? "创建中…" : "创建频道")
                        }
                    }
                    .buttonStyle(PulsePrimaryButtonStyle())
                    .disabled(working || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(16)
            }
            .scrollIndicators(.hidden)
        }
        .background(PulsePalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .pulseOnChange(of: avatarItem) { item in
            guard let item else { return }
            Task { avatarData = try? await item.loadTransferable(type: Data.self) }
        }
        .alert("创建失败", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) {
            Button("知道了") { error = "" }
        } message: {
            Text(error)
        }
    }

    private func create() async {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { error = "请输入频道名称"; return }
        working = true
        defer { working = false }
        do {
            var avatarURL: String?
            if let avatarData, let image = UIImage(data: avatarData), let data = image.jpegData(compressionQuality: 0.86) {
                avatarURL = try await APIClient.shared.uploadMedia(data: data, kind: "image", filename: "channel-\(UUID().uuidString).jpg", mime: "image/jpeg").url
            }
            _ = try await APIClient.shared.createChannel(name: value, avatarURL: avatarURL, description: description.trimmingCharacters(in: .whitespacesAndNewlines))
            onCreated()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private func sheetHeader(title: String, dismiss: DismissAction) -> some View {
    ZStack {
        Text(title)
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(PulsePalette.ink)
        HStack {
            Button("返回") { dismiss() }
                .font(.system(size: 16))
                .foregroundStyle(PulsePalette.accent)
            Spacer()
        }
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 6)
    .background(PulsePalette.surface)
}

private func noticeBanner(_ message: String) -> some View {
    HStack(spacing: 8) {
        Image(systemName: "megaphone.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(PulsePalette.accent)
        Text(message)
            .font(.system(size: 13))
            .foregroundStyle(PulsePalette.ink)
            .lineLimit(1)
        Spacer()
    }
    .padding(.horizontal, 16)
    .frame(height: 35)
    .background(PulsePalette.accentSoft)
}

private func searchBar(placeholder: String, text: Binding<String>) -> some View {
    HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
            .foregroundStyle(PulsePalette.muted)
        TextField(placeholder, text: text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }
    .padding(.horizontal, 13)
    .frame(height: 42)
    .background(PulsePalette.surface)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
}

struct PulseSmallButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(PulsePalette.accent.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(Capsule())
    }
}
