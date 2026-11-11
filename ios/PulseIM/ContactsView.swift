import SwiftUI

struct ContactsView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @State private var keyword = ""
    @State private var results: [SearchUser] = []
    private var requests: [ContactRequest] { session.pendingFriendRequests }
    @State private var error = ""
    @State private var showingCreateGroup = false
    @State private var openingConversation: Conversation?
    @State private var searchRevision = 0
    @State private var isSearchVisible = false
    @State private var pendingAdds: [Int: UUID] = [:]
    @State private var latestAdd = UUID()
    @State private var forcedProfile: IOSForcedContactProfileRoute?
    private var groups: [Conversation] { session.conversations.filter { $0.type == "group" } }

    var body: some View {
        PulseNavigationStack {
            List {
                Section {
                    Label("新的联系人", systemImage: "person.badge.plus").contentShape(Rectangle()).onTapGesture { search() }
                    Button { invalidateAdds(); showingCreateGroup = true } label: { Label("创建群组", systemImage: "person.3") }
                }
                if !groups.isEmpty { Section("我的群组") { ForEach(groups) { group in NavigationLink(group.name ?? "群组") { GroupMembersView(conversation: group).pulseSwipeBack() } } } }
                if !requests.isEmpty { Section("好友申请") { ForEach(requests) { request in HStack { Text(request.nickname); Spacer(); Button("同意") { Task { await handle(request, action: "accept") } }; Button("拒绝") { Task { await handle(request, action: "reject") } }.foregroundStyle(.red) } } } }
                Section("联系人") { ForEach(session.contacts) { contact in HStack { VStack(alignment: .leading) { Label(contact.nickname, systemImage: "person.circle.fill"); Text("用户 ID：\(PublicUserIdentity.display(contact.publicID))").font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("聊天") { Task { await openChat(userID: contact.userId) } } } } }
                if !results.isEmpty {
                    Section("搜索结果") {
                        ForEach(results) { user in
                            HStack(alignment: .top, spacing: 12) {
                                PulseAvatar(title: user.nickname, size: 52, avatarURL: user.avatarURL)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(user.nickname).font(.headline)
                                    if let username = user.username, !username.isEmpty { Text("用户名：\(username)").font(.caption).foregroundStyle(.secondary) }
                                    Text("用户 ID：\(PublicUserIdentity.display(user.publicID))").font(.caption).foregroundStyle(.secondary)
                                    HStack(spacing: 10) {
                                        Button("聊天") { Task { await openChat(userID: user.id) } }.buttonStyle(.bordered)
                                        Button(pendingAdds[user.id] == nil ? "添加好友" : "添加中…") { Task { await add(user) } }
                                            .buttonStyle(.borderedProminent)
                                            .disabled(user.id == session.user?.id || pendingAdds[user.id] != nil || forcedProfile != nil)
                                    }.padding(.top, 4)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(.vertical, 6)
                        }
                    }
                }
            }
            .searchable(text: $keyword, prompt: "输入完整用户名")
            .navigationTitle("联系人")
            .toolbar { Button { invalidateAdds(); showingCreateGroup = true } label: { Image(systemName: "person.3.fill") } }
            .onSubmit(of: .search) { search() }
            .task { await loadRequests() }
            .pulseSheet(isPresented: $showingCreateGroup) { CreateGroupView() }
            .pulseChatPresentation(item: $openingConversation)
            .pulseForcedContactProfile(item: $forcedProfile)
            .onAppear { isSearchVisible = true }
            .onDisappear { isSearchVisible = false; invalidateAdds() }
            .pulseOnChange(of: session.token) { _ in invalidateAdds(); results = [] }
            .pulseOnChange(of: keyword) { _ in invalidateAdds(); results = [] }
            .pulseOnChange(of: session.user?.id) { _ in invalidateAdds(); results = [] }
            .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in invalidateAdds(); results = [] }
            .pulseOnChange(of: appLock.isLocked) { locked in if locked { invalidateAdds() } }
            .pulseOnChange(of: session.updateRequired) { required in if required { invalidateAdds() } }
            .pulseOnChange(of: scenePhase) { phase in if phase == .background { invalidateAdds() } }
            .pulseOnChange(of: showingCreateGroup) { shown in if shown { invalidateAdds() } }
            .pulseOnChange(of: openingConversation?.id) { id in if id != nil { invalidateAdds() } }
            .alert("提示", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") { error = "" } } message: { Text(error) }
        }
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
    @MainActor private func openChat(userID: Int) async {
        guard isSearchVisible, scenePhase == .active, !appLock.isLocked, !session.updateRequired, !showingCreateGroup,
              session.isSignedIn, let token = session.token, let viewerID = session.user?.id, userID > 0, userID != viewerID else { return }
        invalidateAdds()
        let client = APIClient.shared.captureSession(), revision = searchRevision, operation = latestAdd
        func current() -> Bool {
            isSearchVisible && scenePhase == .active && !appLock.isLocked && !session.updateRequired && !showingCreateGroup
                && openingConversation == nil && forcedProfile == nil && session.isSignedIn && session.token == token && session.user?.id == viewerID
                && client.endpointIdentity == APIClient.shared.endpointIdentity && revision == searchRevision
                && latestAdd == operation && !Task.isCancelled
        }
        do {
            let conversation = try await client.createDirectConversation(userID: userID)
            guard current() else { return }
            guard conversation.id > 0, conversation.type == "direct", conversation.peerUserId == userID else { throw APIClientError.invalidResponse }
            try await session.refreshConversations()
            guard current() else { return }
            openingConversation = conversation
        } catch {
            if current() { self.error = error.localizedDescription }
        }
    }
    @MainActor private func add(_ user: SearchUser) async {
        guard isSearchVisible, scenePhase == .active, !appLock.isLocked, !session.updateRequired, !showingCreateGroup,
              openingConversation == nil, forcedProfile == nil, pendingAdds[user.id] == nil,
              session.isSignedIn, let token = session.token, let viewerID = session.user?.id, user.id > 0, user.id != viewerID,
              results.contains(where: { $0.id == user.id }) else { return }
        let client = APIClient.shared.captureSession(), internalStaff = session.user?.internalStaff == true
        let operation = UUID(), revision = searchRevision, value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        pendingAdds[user.id] = operation; latestAdd = operation; error = ""
        defer { if pendingAdds[user.id] == operation { pendingAdds.removeValue(forKey: user.id) } }
        func current() -> Bool {
            isSearchVisible && scenePhase == .active && !appLock.isLocked && !session.updateRequired && !showingCreateGroup
                && openingConversation == nil && forcedProfile == nil && session.isSignedIn && session.token == token && session.user?.id == viewerID
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
            } else { error = "好友申请已发送" }
        } catch { if current() { error = error.localizedDescription } }
    }
    @MainActor private func invalidateAdds() { searchRevision += 1; latestAdd = UUID(); forcedProfile = nil }
    private func loadRequests() async { do { try await session.refreshFriendRequests() } catch is CancellationError { return } catch { error = error.localizedDescription } }
    private func handle(_ request: ContactRequest, action: String) async { do { try await session.handleFriendRequest(request, action: action) } catch is CancellationError { return } catch { error = error.localizedDescription } }
}

struct CreateGroupView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: AppSession
    @State private var name = ""
    @State private var error = ""
    var body: some View { PulseNavigationStack { Form { Section("群组") { TextField("群组名称", text: $name) } }.navigationTitle("创建群组").toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("创建") { Task { await create() } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } }.alert("创建失败", isPresented: Binding(get: { !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") { error = "" } } message: { Text(error) } } }
    private func create() async { do { _ = try await APIClient.shared.createGroup(name: name.trimmingCharacters(in: .whitespacesAndNewlines)); try await session.refreshConversations(); dismiss() } catch { error = error.localizedDescription } }
}

@MainActor struct GroupMembersView: View {
    let conversation: Conversation
    var onNestedChatActive: (Bool) -> Void = { _ in }
    @EnvironmentObject private var session: AppSession

    var body: some View {
        let scope = IOSGroupPageIdentity(conversationID: conversation.id, viewerID: session.user?.id ?? 0,
            token: session.token ?? "", endpoint: APIClient.shared.endpointIdentity)
        GroupMembersContent(conversation: conversation, scope: scope, onNestedChatActive: onNestedChatActive).id(scope)
    }
}

struct IOSGroupPageIdentity: Hashable {
    let conversationID: Int
    let viewerID: Int
    let token: String
    let endpoint: String

    @MainActor func matches(_ session: AppSession) -> Bool {
        viewerID > 0 && !token.isEmpty && session.isSignedIn && session.user?.id == viewerID
            && session.token == token && APIClient.shared.endpointIdentity == endpoint
    }

    func matches(_ client: APIClient) -> Bool { client.webSocketToken == token && client.endpointIdentity == endpoint }
}

struct IOSGroupContactRoute: Identifiable {
    let id = UUID()
    let userID: Int
    let scope: IOSGroupPageIdentity
}

private struct IOSGroupMemberSnapshot {
    let profile: GroupProfile
    let members: [GroupMember]
}

@MainActor private struct GroupMembersContent: View {
    let conversation: Conversation
    let scope: IOSGroupPageIdentity
    let onNestedChatActive: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @State private var snapshot: IOSGroupMemberSnapshot?
    @State private var error = ""
    @State private var showingAddMember = false
    @State private var showingProfile = false
    @State private var editorProfile: GroupProfile?
    @State private var generatedInviteCode = ""
    @State private var isVisible = false
    @State private var isLoading = false
    @State private var isMutating = false
    @State private var lifecycleID = UUID()
    @State private var requestID = UUID()
    @State private var reloadTask: Task<Void, Never>?
    @State private var memberProfile: IOSGroupContactRoute?
    @State private var profileOpening = false

    private var active: Bool { isVisible && scope.matches(session) && scenePhase == .active && !appLock.isLocked && !session.updateRequired }
    private var visibleSnapshot: IOSGroupMemberSnapshot? { active ? snapshot : nil }
    private var busy: Bool { isLoading || isMutating || profileOpening }

    var body: some View {
        List {
            if let data = visibleSnapshot {
                let profile = data.profile
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(profile.name).font(.headline)
                        Text("群号：\(profile.inviteCode ?? "暂无") · \(profile.memberCount) 名成员").font(.caption).foregroundStyle(.secondary)
                        if let description = profile.description, !description.isEmpty { Text(description).font(.subheadline).foregroundStyle(.secondary) }
                        if let announcement = profile.announcement, !announcement.isEmpty { Text("群公告：\(announcement)").font(.subheadline).foregroundStyle(PulsePalette.accent) }
                    }
                    if APIClient.shared.isGoV2, profile.canManage {
                        if !generatedInviteCode.isEmpty { Text(generatedInviteCode).textSelection(.enabled).font(.footnote) }
                        Button("生成新邀请码") { Task { await rotateInviteCode() } }
                        Text("生成后旧邀请码失效。").font(.caption).foregroundStyle(.secondary)
                    }
                    Toggle("消息免打扰", isOn: Binding(get: { profile.notificationsMuted }, set: { value in Task { await updateSettings(notificationsMuted: value, isPinned: nil) } }))
                    Toggle("置顶会话", isOn: Binding(get: { profile.isPinned }, set: { value in Task { await updateSettings(notificationsMuted: nil, isPinned: value) } }))
                }
                Section("群成员") {
                    // This is exactly the server's permitted roster. Never
                    // request a second full list or infer total count from it.
                    ForEach(data.members) { member in memberRow(member, profile: profile) }
                    if profile.membersRestricted {
                        Text("其他成员设置隐私，无法查看").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if profile.canInviteMembers { Button { discardSnapshot(); showingAddMember = true } label: { Label("添加成员", systemImage: "person.badge.plus") } }
                if profile.isOwner { Button("解散群组", role: .destructive) { Task { await dissolve() } } }
            } else if busy {
                HStack { ProgressView(); Text(isMutating ? "正在更新群资料…" : "正在加载群资料…") }
            } else {
                Text("群资料暂不可用").foregroundStyle(.secondary)
                Button("重新加载") { scheduleReload() }.disabled(!active)
            }
        }
        .disabled(busy)
        .pulseSwipeBack(enabled: !isMutating && !profileOpening, identity: conversation.id)
        .navigationTitle(visibleSnapshot?.profile.name ?? conversation.name ?? "群组成员")
        .toolbar {
            ToolbarItemGroup {
                if let profile = visibleSnapshot?.profile {
                    if profile.canManage {
                        Button { editorProfile = profile; discardSnapshot(); showingProfile = true } label: { Image(systemName: "pencil") }.disabled(busy)
                    }
                    if profile.canInviteMembers { Button { discardSnapshot(); showingAddMember = true } label: { Image(systemName: "person.badge.plus") }.disabled(busy) }
                }
            }
        }
        .pulseSheet(isPresented: $showingAddMember, onDismiss: scheduleReload) {
            AddGroupMemberView(scope: scope) { discardSnapshot() }
        }
        .pulseSheet(isPresented: $showingProfile, onDismiss: scheduleReload) {
            if let editorProfile { GroupProfileEditor(scope: scope, profile: editorProfile) { discardSnapshot() } }
        }
        .pulseSheet(item: $memberProfile, onDismiss: { onNestedChatActive(false); scheduleReload() }) { route in
            if route.scope.matches(session) {
                ContactInfoView(userID: route.userID, conversationID: 0, initialMuted: false,
                    groupContextConversationID: route.scope.conversationID,
                    onClose: { _, _ in if memberProfile?.id == route.id { memberProfile = nil } },
                    onNotificationsChanged: { _ in }, onNestedChatActive: onNestedChatActive)
                    .id(route.id)
            }
        }
        .onAppear { isVisible = true; scheduleReload() }
        .onDisappear { isVisible = false; invalidate(); onNestedChatActive(false) }
        .pulseOnChange(of: scenePhase) { phase in if phase == .active { scheduleReload() } else { invalidate() } }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { invalidate() } else { scheduleReload() } }
        .pulseOnChange(of: session.updateRequired) { required in if required { invalidate() } else { scheduleReload() } }
        .pulseOnChange(of: session.token) { _ in invalidate() }
        .pulseOnChange(of: session.user?.id) { _ in invalidate() }
        .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in invalidate() }
        .refreshable { await load() }
        .alert("提示", isPresented: Binding(get: { active && !error.isEmpty }, set: { if !$0 { error = "" } })) { Button("知道了") { error = "" } } message: { Text(error) }
    }

    private func memberRow(_ member: GroupMember, profile: GroupProfile) -> some View {
        HStack {
            Button { Task { await openMemberProfile(member) } } label: {
                HStack {
                    PulseAvatar(title: session.contactDisplayName(userID: member.userId, fallback: member.nickname), size: 30, avatarURL: member.avatarURL)
                    Text(session.contactDisplayName(userID: member.userId, fallback: member.nickname))
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("查看\(session.contactDisplayName(userID: member.userId, fallback: member.nickname))的资料")
            Spacer()
            Text(member.role == "owner" ? "群主" : member.role == "admin" ? "管理员" : "成员").font(.caption).foregroundStyle(.secondary)
            if member.role != "owner", profile.canManage {
                Menu {
                    if profile.isOwner {
                        Button(member.role == "admin" ? "取消管理员" : "设为管理员") { Task { await setRole(member, role: member.role == "admin" ? "member" : "admin") } }
                    }
                    Button(member.mutedUntil == nil ? (APIClient.shared.isGoV2 ? "永久禁言" : "禁言10分钟") : "解除禁言") { Task { await mute(member, minutes: member.mutedUntil == nil ? (APIClient.shared.isGoV2 ? -1 : 10) : 0) } }
                    Button("移出群组", role: .destructive) { Task { await remove(member) } }
                    if profile.isOwner { Button("转让群主") { Task { await transfer(member) } } }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
    }

    private func openMemberProfile(_ member: GroupMember) async {
        guard active, !busy, member.userId != scope.viewerID, let data = visibleSnapshot,
              data.members.contains(where: { $0.userId == member.userId }) else { return }
        let client = APIClient.shared.captureSession()
        guard scope.matches(client) else { return }
        let request = UUID(), lifecycle = lifecycleID; requestID = request; profileOpening = true
        defer { if requestID == request, lifecycleID == lifecycle { profileOpening = false } }
        do {
            let profile = try await client.groupProfile(id: scope.conversationID)
            guard current(request, lifecycle: lifecycle, client: client) else { return }
            guard profile.conversationId == scope.conversationID else { throw APIClientError.invalidResponse }
            guard profile.canViewMemberProfiles else {
                profileOpening = false; discardSnapshot(); error = ""; scheduleReload(); return
            }
            profileOpening = false; discardSnapshot()
            memberProfile = IOSGroupContactRoute(userID: member.userId, scope: scope)
        } catch {
            guard current(request, lifecycle: lifecycle, client: client) else { return }
            profileOpening = false; discardSnapshot(); self.error = GroupFriendRestrictionFeedback.message(error, inGroup: true)
        }
    }

    private func current(_ request: UUID, lifecycle: UUID, client: APIClient) -> Bool {
        active && !Task.isCancelled && lifecycleID == lifecycle && requestID == request && scope.matches(client)
    }

    private func discardSnapshot() {
        requestID = UUID(); snapshot = nil
        reloadTask?.cancel(); reloadTask = nil
    }

    private func invalidate() {
        lifecycleID = UUID(); discardSnapshot()
        isLoading = false; isMutating = false; error = ""
        profileOpening = false; memberProfile = nil
        showingAddMember = false; showingProfile = false; editorProfile = nil
    }

    private func scheduleReload() {
        guard active, !isMutating else { return }
        discardSnapshot(); isLoading = true
        reloadTask = Task { await load() }
    }

    private func load(preserveError: Bool = false) async {
        guard !Task.isCancelled, active, !isMutating else { return }
        let client = APIClient.shared.captureSession()
        guard scope.matches(client) else { return }
        let request = UUID(), lifecycle = lifecycleID; requestID = request
        snapshot = nil; isLoading = true
        if !preserveError { error = "" }
        defer { if requestID == request, lifecycleID == lifecycle { isLoading = false } }
        do {
            async let loadedProfile = client.groupProfile(id: conversation.id)
            async let loadedMembers = client.conversationMembers(id: conversation.id)
            let (profile, members) = try await (loadedProfile, loadedMembers)
            guard current(request, lifecycle: lifecycle, client: client), profile.conversationId == scope.conversationID else { return }
            let restricted = profile.membersRestricted
            if restricted, members.contains(where: { $0.userId == scope.viewerID || !["owner", "admin"].contains($0.role) }) {
                // Separate HTTP responses can straddle a demotion. Reject the
                // whole inconsistent snapshot; never locally trim a full list.
                throw APIClientError.server("群成员权限已变更，请重新加载")
            }
            snapshot = IOSGroupMemberSnapshot(profile: profile, members: members)
        } catch {
            guard current(request, lifecycle: lifecycle, client: client) else { return }
            snapshot = nil; self.error = error.localizedDescription
        }
    }

    private func mutate(target: GroupMember? = nil, managerOnly: Bool = false, ownerOnly: Bool = false,
                        dismissAfter: Bool = false, action: (APIClient) async throws -> Void) async {
        guard active, !busy, let data = visibleSnapshot,
              !managerOnly || data.profile.canManage, !ownerOnly || data.profile.isOwner else { return }
        if let target { guard target.role != "owner", data.members.contains(where: { $0.userId == target.userId && $0.role == target.role }) else { return } }
        let client = APIClient.shared.captureSession()
        guard scope.matches(client) else { return }
        discardSnapshot()
        let request = UUID(), lifecycle = lifecycleID; requestID = request
        isMutating = true; error = ""
        defer { if requestID == request, lifecycleID == lifecycle { isMutating = false } }
        do {
            try await action(client)
            guard current(request, lifecycle: lifecycle, client: client) else { return }
            isMutating = false
            if dismissAfter { invalidate(); dismiss() } else { await load() }
        } catch {
            guard current(request, lifecycle: lifecycle, client: client) else { return }
            isMutating = false; self.error = error.localizedDescription
            await load(preserveError: true)
        }
    }

    private func rotateInviteCode() async {
        await mutate(managerOnly: true) { client in
            let result = try await client.rotateGoInviteCode(conversationID: scope.conversationID)
            if active, scope.matches(client) { generatedInviteCode = result.inviteCode }
        }
    }
    private func setRole(_ member: GroupMember, role: String) async { await mutate(target: member, managerOnly: true, ownerOnly: true) { try await $0.setConversationRole(conversationID: conversation.id, userID: member.userId, role: role) } }
    private func mute(_ member: GroupMember, minutes: Int) async { await mutate(target: member, managerOnly: true) { try await $0.muteConversationMember(conversationID: conversation.id, userID: member.userId, minutes: minutes) } }
    private func remove(_ member: GroupMember) async { await mutate(target: member, managerOnly: true) { try await $0.removeConversationMember(conversationID: conversation.id, userID: member.userId) } }
    private func transfer(_ member: GroupMember) async { await mutate(target: member, managerOnly: true, ownerOnly: true) { try await $0.transferGroup(conversationID: conversation.id, userID: member.userId) } }
    private func dissolve() async { await mutate(ownerOnly: true, dismissAfter: true) { try await $0.dissolveGroup(conversationID: conversation.id) } }
    private func updateSettings(notificationsMuted: Bool?, isPinned: Bool?) async {
        await mutate { _ = try await $0.updateGroupSettings(conversationID: conversation.id, notificationsMuted: notificationsMuted, isPinned: isPinned) }
    }
}

private struct IOSGroupFormRequest {
    let id: UUID
    let lifecycle: UUID
    let client: APIClient
}

@MainActor private final class IOSGroupFormLifetime: ObservableObject {
    @Published var error = ""
    @Published private(set) var busy = false
    private var visible = false
    private var lifecycle = UUID()
    private var requestID = UUID()

    func activate() { visible = true }
    func invalidate() { visible = false; lifecycle = UUID(); requestID = UUID(); busy = false; error = "" }
    func begin(scope: IOSGroupPageIdentity, session: AppSession, active: Bool) -> IOSGroupFormRequest? {
        guard visible, active, !busy, scope.matches(session) else { return nil }
        let client = APIClient.shared.captureSession()
        guard scope.matches(client) else { return nil }
        requestID = UUID(); busy = true; error = ""
        return IOSGroupFormRequest(id: requestID, lifecycle: lifecycle, client: client)
    }
    func current(_ request: IOSGroupFormRequest, scope: IOSGroupPageIdentity, session: AppSession, active: Bool) -> Bool {
        visible && active && !Task.isCancelled && scope.matches(session) && scope.matches(request.client)
            && requestID == request.id && lifecycle == request.lifecycle
    }
    func finish(_ request: IOSGroupFormRequest) { if requestID == request.id, lifecycle == request.lifecycle { busy = false } }
}

@MainActor struct GroupProfileEditor: View {
    let scope: IOSGroupPageIdentity
    let profile: GroupProfile
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @StateObject private var lifetime = IOSGroupFormLifetime()
    @State private var name = ""
    @State private var description = ""
    @State private var announcement = ""
    @State private var banMemberFriends = false
    @State private var initialized = false
    private var active: Bool { scenePhase == .active && !appLock.isLocked && !session.updateRequired && scope.matches(session) }

    var body: some View {
        PulseNavigationStack {
            Form {
                TextField("群名称", text: $name)
                TextField("群简介", text: $description, axis: .vertical)
                TextField("群公告", text: $announcement, axis: .vertical)
                Toggle("禁止群成员互加好友", isOn: $banMemberFriends)
            }
            .disabled(lifetime.busy || !active)
            .navigationTitle("编辑群资料")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { lifetime.invalidate(); dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(lifetime.busy || !active) }
            }
        }
        .onAppear {
            guard active else { dismiss(); return }
            if !initialized { name = profile.name; description = profile.description ?? ""; announcement = profile.announcement ?? ""; banMemberFriends = !(profile.allowMemberAddFriend ?? true); initialized = true }
            lifetime.activate()
        }
        .onDisappear { lifetime.invalidate() }
        .pulseOnChange(of: scenePhase) { phase in if phase == .active, active { lifetime.activate() } else { lifetime.invalidate() } }
        .pulseOnChange(of: session.token) { _ in close() }
        .pulseOnChange(of: session.user?.id) { _ in close() }
        .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in close() }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { close() } }
        .pulseOnChange(of: session.updateRequired) { required in if required { close() } }
        .alert("保存失败", isPresented: Binding(get: { active && !lifetime.error.isEmpty }, set: { if !$0 { lifetime.error = "" } })) {
            Button("知道了") { lifetime.error = "" }
        } message: { Text(lifetime.error) }
    }

    private func close() { lifetime.invalidate(); dismiss() }
    private func save() async {
        guard profile.canManage, let request = lifetime.begin(scope: scope, session: session, active: active) else { return }
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines), detail = description, notice = announcement, allowFriends = !banMemberFriends
        defer { lifetime.finish(request) }
        do {
            let result = try await request.client.updateGroupProfile(conversationID: scope.conversationID, name: value, description: detail, announcement: notice, allowMemberAddFriend: allowFriends)
            guard lifetime.current(request, scope: scope, session: session, active: active), result.conversationId == scope.conversationID else { return }
            onSaved(); close()
        } catch { if lifetime.current(request, scope: scope, session: session, active: active) { lifetime.error = error.localizedDescription } }
    }
}

@MainActor struct AddGroupMemberView: View {
    let scope: IOSGroupPageIdentity
    let onAdded: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @State private var allowHistory = false
    @State private var account = ""
    @State private var searchResults: [SearchUser] = []
    @StateObject private var lifetime = IOSGroupFormLifetime()
    private var active: Bool { scenePhase == .active && !appLock.isLocked && !session.updateRequired && scope.matches(session) }

    var body: some View {
        PulseNavigationStack {
            List {
                if APIClient.shared.isGoV2 {
                    Section { Toggle("允许新成员查看入群前的消息", isOn: $allowHistory) }
                    header: { Text("历史消息权限") }
                    footer: { Text("默认关闭，仅群主或管理员可授予历史权限。") }
                    Section("按账号邀请") {
                        TextField("完整账号", text: $account).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("查找账号") { Task { await searchAccount() } }.disabled(account.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        ForEach(searchResults) { result in
                            Button("邀请 " + result.nickname) { Task { await add(userID: result.id) } }
                        }
                    }
                }
                ForEach(active ? session.contacts : []) { contact in
                    Button { Task { await add(userID: contact.userId) } } label: { Label(contact.nickname, systemImage: "person.circle") }
                }
            }
            .disabled(lifetime.busy || !active)
            .navigationTitle("添加成员")
            .toolbar { Button("完成") { close() } }
        }
        .onAppear { if active { lifetime.activate() } else { dismiss() } }
        .onDisappear { lifetime.invalidate() }
        .pulseOnChange(of: account) { _ in searchResults = [] }
        .pulseOnChange(of: scenePhase) { phase in if phase == .active, active { lifetime.activate() } else { lifetime.invalidate() } }
        .pulseOnChange(of: session.token) { _ in close() }
        .pulseOnChange(of: session.user?.id) { _ in close() }
        .pulseOnChange(of: APIClient.shared.endpointIdentity) { _ in close() }
        .pulseOnChange(of: appLock.isLocked) { locked in if locked { close() } }
        .pulseOnChange(of: session.updateRequired) { required in if required { close() } }
        .alert("添加失败", isPresented: Binding(get: { active && !lifetime.error.isEmpty }, set: { if !$0 { lifetime.error = "" } })) {
            Button("知道了") { lifetime.error = "" }
        } message: { Text(lifetime.error) }
    }

    private func searchAccount() async {
        guard let request = lifetime.begin(scope: scope, session: session, active: active) else { return }
        let value = account.trimmingCharacters(in: .whitespacesAndNewlines)
        defer { lifetime.finish(request) }
        searchResults = []
        do {
            let users = try await request.client.searchUsers(keyword: value)
            guard lifetime.current(request, scope: scope, session: session, active: active), value == account.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            searchResults = users
            if users.isEmpty { lifetime.error = "没有找到该账号" }
        } catch { if lifetime.current(request, scope: scope, session: session, active: active) { lifetime.error = error.localizedDescription } }
    }
    private func close() { lifetime.invalidate(); dismiss() }
    private func add(userID: Int) async {
        guard userID > 0, let request = lifetime.begin(scope: scope, session: session, active: active) else { return }
        defer { lifetime.finish(request) }
        do {
            let profile = try await request.client.groupProfile(id: scope.conversationID)
            guard lifetime.current(request, scope: scope, session: session, active: active) else { return }
            guard profile.canInviteMembers else { throw APIClientError.server("只有群主或管理员可以邀请新成员。") }
            try await request.client.addConversationMember(conversationID: scope.conversationID, userID: userID, allowHistory: allowHistory)
            guard lifetime.current(request, scope: scope, session: session, active: active) else { return }
            onAdded(); close()
        } catch { if lifetime.current(request, scope: scope, session: session, active: active) { lifetime.error = error.localizedDescription } }
    }
}
