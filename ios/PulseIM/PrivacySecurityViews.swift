import SwiftUI

struct IOSPrivacySecurityView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appLock: AppLockManager
    @EnvironmentObject private var session: AppSession
    @State private var settings: UserSettings?
    @State private var settingsToken: String?
    @State private var settingsEndpoint: String?
    @State private var loadID = UUID()
    @State private var blockedCount = 0
    @State private var error = ""
    @State private var loading = true

    var body: some View {
        PulseNavigationStack {
            List {
                Section {
                    NavigationLink { IOSBlockedUsersView().pulseSwipeBack() } label: {
                        privacyRow(title: "黑名单管理", detail: blockedCount == 0 ? "无" : "\(blockedCount) 人", icon: "hand.raised.fill", tint: PulsePalette.danger)
                    }
                    NavigationLink { IOSLockCodeView().pulseSwipeBack() } label: {
                        privacyRow(title: "锁定码 & Face ID", detail: appLock.hasPasscode ? "开" : "关", icon: "lock.fill", tint: PulsePalette.accent)
                    }
                }

                if APIClient.shared.isGoV2 {
                    Section("隐私") {
                        NavigationLink("临时聊天") { GoPrivacyView(invitations: false).pulseSwipeBack() }
                        NavigationLink("群邀请") { GoPrivacyView(invitations: true).pulseSwipeBack() }
                    }
                } else if canManagePrivacy {
                    Section("隐私") {
                        NavigationLink { IOSPrivacyOptionView(kind: .phone).pulseSwipeBack() } label: { privacyRow(title: "手机号码", detail: privacyLabel(settings?.phoneVisibility ?? "nobody")) }
                        NavigationLink { IOSPrivacyOptionView(kind: .online).pulseSwipeBack() } label: { privacyRow(title: "在线状态", detail: privacyLabel(settings?.lastSeenVisibility ?? "everyone")) }
                        NavigationLink { IOSPrivacyOptionView(kind: .voice).pulseSwipeBack() } label: { privacyRow(title: "语音通话", detail: privacyLabel(settings?.voiceCallVisibility ?? "everyone")) }
                        NavigationLink { IOSPrivacyOptionView(kind: .groups).pulseSwipeBack() } label: { privacyRow(title: "群组和频道", detail: privacyLabel(settings?.inviteVisibility ?? "everyone")) }
                    } footer: {
                        Text("控制谁能邀请您进入群组或频道。")
                    }
                }

                Section {
                    NavigationLink { IOSAutoDeleteAccountView().pulseSwipeBack() } label: {
                        privacyRow(title: "如果离开", detail: autoDeleteTitle(settings?.accountAutoDeleteDays ?? 180))
                    }
                } footer: {
                    Text("如果您在这段时间内没有上线，您的账号资料、消息记录和联系人将被删除。")
                }

                Section("账号安全") {
                    NavigationLink("登录密码与设备") { SecuritySettingsView().pulseSwipeBack() }
                }


                if loading { Section { ProgressView("正在加载") } }
                if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("隐私安全")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .onAppear { Task { await load() } }
        }
    }

    private func privacyRow(title: String, detail: String, icon: String? = nil, tint: Color = PulsePalette.accent) -> some View {
        HStack(spacing: 13) {
            if let icon {
                Image(systemName: icon).font(.system(size: 16, weight: .semibold)).foregroundStyle(.white).frame(width: 30, height: 30).background(tint).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            Text(title).foregroundStyle(PulsePalette.ink)
            Spacer()
            Text(detail).foregroundStyle(PulsePalette.muted)
        }
    }

    private func privacyLabel(_ value: String) -> String {
        ["everyone": "所有人", "contacts": "我的联系人", "nobody": "隐藏"][value] ?? value
    }

    private func autoDeleteTitle(_ days: Int) -> String {
        [0: "关闭", 30: "1 个月", 90: "3 个月", 180: "6 个月", 365: "12 个月"][days] ?? "6 个月"
    }

    private var canManagePrivacy: Bool {
        settings?.canManagePrivacy == true && session.user?.internalStaff == true &&
        settingsToken == session.token && settingsEndpoint == APIClient.shared.endpointIdentity
    }

    @MainActor
    private func load() async {
        let request = UUID(), token = session.token, client = APIClient.shared.captureSession()
        loadID = request
        settings = nil
        loading = true
        error = ""
        do {
            let updated = try await client.userSettings()
            guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            settings = updated
            settingsToken = token
            settingsEndpoint = client.endpointIdentity
            let blocks = try await client.blockedUsers()
            guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            blockedCount = blocks.count
        } catch {
            guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            error = error.localizedDescription
        }
        loading = false
    }
}

enum IOSPrivacyPageKind: Equatable {
    case phone, online, voice, groups

    var title: String {
        switch self {
        case .phone: return "手机号码"
        case .online: return "在线状态"
        case .voice: return "语音通话"
        case .groups: return "群组和频道"
        }
    }

    var sectionTitle: String {
        switch self {
        case .phone: return "谁可以看到我的手机号码？"
        case .online: return "谁可以看到我的上线时间"
        case .voice: return "谁可以呼叫我"
        case .groups: return "邀请权限控制"
        }
    }

    var description: String {
        switch self {
        case .phone: return "此设置控制其他用户在\(PulseApp.name)中查看您的手机号码。\"我的联系人\"指您在本程序中添加的联系人。"
        case .online: return "您不会看到与您不共享的人的最后上线时间。取而代之的是大致的上线时间（最近、一周内或一个月内）。"
        case .voice: return "您可以控制其他人和您语音通话的权限。"
        case .groups: return "您可以精确控制其他人能否邀请您进入任意群组或频道。"
        }
    }

    var exceptionTitle: String {
        switch self {
        case .phone: return "总是共享给"
        case .online: return "从不共享给"
        case .voice: return "从不允许"
        case .groups: return "从不允许"
        }
    }

    var exceptionKey: String {
        switch self {
        case .phone: return "phone_visibility_always"
        case .online: return "last_seen_never"
        case .voice: return "voice_call_never"
        case .groups: return "invite_never"
        }
    }

    var primaryKey: String {
        switch self {
        case .phone: return "phone_visibility"
        case .online: return "last_seen_visibility"
        case .voice: return "voice_call_visibility"
        case .groups: return "invite_visibility"
        }
    }

    var choices: [(String, String)] {
        switch self {
        case .groups: return [("everyone", "所有人"), ("contacts", "我的联系人")]
        default: return [("everyone", "所有人"), ("contacts", "我的联系人"), ("nobody", "隐藏")]
        }
    }
}

struct IOSPrivacyOptionView: View {
    let kind: IOSPrivacyPageKind
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: AppSession
    @State private var settings: UserSettings?
    @State private var settingsToken: String?
    @State private var settingsEndpoint: String?
    @State private var loadID = UUID()
    @State private var contacts: [Contact] = []
    @State private var showingPicker = false
    @State private var error = ""
    @State private var loading = true
    @State private var savingKey: String?
    @State private var localValues: [String: String] = [:]
    @State private var localExceptionIDs: [Int]?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if canManagePrivacy {
                    privacySectionTitle(kind.sectionTitle)
                    privacyChoiceCard(value: settingsValue(kind.primaryKey), choices: kind.choices, key: kind.primaryKey)
                    privacyHelp(kind.description)

                    if kind == .phone {
                        privacySectionTitle("谁可以通过我的手机号找到我？", top: 28)
                        privacyChoiceCard(value: settingsValue("phone_search_visibility"), choices: [("everyone", "所有人"), ("contacts", "我的联系人")], key: "phone_search_visibility")
                        privacyHelp("已将您的手机号码保存在其联系人中的用户将在\(PulseApp.name)上看到该号码。")
                    }

                    if kind == .voice {
                        privacySectionTitle("端对端连接", top: 28)
                        privacyChoiceCard(value: settingsValue("voice_call_peer_to_peer"), choices: [("everyone", "总是"), ("contacts", "我的联系人"), ("nobody", "从不")], key: "voice_call_peer_to_peer")
                        privacyHelp("禁用端对端连接后，所有通话流量将使用服务器中转，以避免泄露您的 IP 地址，但这可能会轻微降低音质。")
                    }

                    privacySectionTitle("例外", top: 28)
                    Button { showingPicker = true } label: {
                        HStack {
                            Text(kind.exceptionTitle).foregroundStyle(PulsePalette.ink)
                            Spacer()
                            if savingKey == "privacy_exceptions" {
                                ProgressView()
                            } else {
                                Text("添加用户").foregroundStyle(PulsePalette.muted)
                                Image(systemName: "chevron.right").foregroundStyle(PulsePalette.muted)
                            }
                        }
                        .padding(.horizontal, 26)
                        .frame(maxWidth: .infinity, minHeight: 62)
                        .background(PulsePalette.surface)
                    }
                    .buttonStyle(.plain)
                    .disabled(savingKey != nil || !canManagePrivacy)
                    ForEach(exceptionContacts) { contact in
                        privacyExceptionRow(contact)
                    }
                    privacyHelp("您可以将用户添加为覆盖上述设置的例外。")
                }

                if loading { ProgressView("正在加载").padding(.top, 24).frame(maxWidth: .infinity) }
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(PulsePalette.danger).padding(20) }
            }
        }
        .background(PulsePalette.background)
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .pulseSheet(isPresented: $showingPicker) {
            IOSPrivacyExceptionPickerView(existingIDs: exceptionIDs) { ids in
                saveExceptions(ids)
            }
        }
        .task(id: session.token) { await load() }
        .pulseOnChange(of: session.user?.internalStaff) { _ in if session.user?.internalStaff != true { showingPicker = false; dismiss() } }
    }

    private var exceptionIDs: [Int] {
        if let localExceptionIDs { return localExceptionIDs }
        guard let exceptions = settings?.privacyExceptions else { return [] }
        switch kind {
        case .phone: return exceptions.phoneVisibilityAlways
        case .online: return exceptions.lastSeenNever
        case .voice: return exceptions.voiceCallNever
        case .groups: return exceptions.inviteNever
        }
    }

    private var canManagePrivacy: Bool {
        settings?.canManagePrivacy == true && session.user?.internalStaff == true &&
        settingsToken == session.token && settingsEndpoint == APIClient.shared.endpointIdentity
    }

    private var exceptionContacts: [Contact] { contacts.filter { exceptionIDs.contains($0.id) } }

    private func settingsValue(_ key: String) -> String {
        if let localValue = localValues[key] { return localValue }
        switch key {
        case "phone_visibility": return settings?.phoneVisibility ?? "nobody"
        case "phone_search_visibility": return settings?.phoneSearchVisibility ?? "everyone"
        case "last_seen_visibility": return settings?.lastSeenVisibility ?? "everyone"
        case "voice_call_visibility": return settings?.voiceCallVisibility ?? "everyone"
        case "voice_call_peer_to_peer": return settings?.voiceCallPeerToPeer ?? "everyone"
        case "invite_visibility": return settings?.inviteVisibility ?? "everyone"
        default: return "everyone"
        }
    }

    private func privacySectionTitle(_ title: String, top: CGFloat = 20) -> some View {
        Text(title).font(.system(size: 16)).foregroundStyle(PulsePalette.muted).padding(.horizontal, 26).padding(.top, top).padding(.bottom, 12)
    }

    private func privacyChoiceCard(value: String, choices: [(String, String)], key: String) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(choices.enumerated()), id: \.offset) { index, choice in
                Button {
                    save([key: choice.0])
                } label: {
                    HStack {
                        Text(choice.1).font(.system(size: 18)).foregroundStyle(PulsePalette.ink)
                        Spacer()
                        if savingKey == key && choice.0 == value {
                            ProgressView()
                        } else if choice.0 == value {
                            Image(systemName: "checkmark").font(.system(size: 19, weight: .semibold)).foregroundStyle(PulsePalette.accent)
                        }
                    }
                    .padding(.horizontal, 26)
                    .frame(maxWidth: .infinity, minHeight: 64)
                    .background(PulsePalette.surface)
                }
                .buttonStyle(.plain)
                .disabled(savingKey != nil || !canManagePrivacy)
                if index < choices.count - 1 { Divider().padding(.leading, 26) }
            }
        }
    }

    private func privacyHelp(_ text: String) -> some View {
        Text(text).font(.system(size: 14)).foregroundStyle(PulsePalette.muted).lineSpacing(4).padding(.horizontal, 26).padding(.top, 15)
    }

    private func privacyExceptionRow(_ contact: Contact) -> some View {
        HStack(spacing: 12) {
            PulseAvatar(title: contact.nickname, size: 40, avatarURL: contact.avatarURL)
            VStack(alignment: .leading, spacing: 3) {
                Text(contact.nickname).foregroundStyle(PulsePalette.ink)
                if let username = contact.username, !username.isEmpty { Text("@\(username)").font(.caption).foregroundStyle(PulsePalette.muted) }
                Text("用户 ID：\(PublicUserIdentity.display(contact.publicID))").font(.caption).foregroundStyle(PulsePalette.muted)
            }
            Spacer()
            Button("移除") { saveExceptions(exceptionIDs.filter { $0 != contact.id }) }
                .foregroundStyle(PulsePalette.danger)
                .disabled(savingKey != nil)
        }
        .padding(.horizontal, 26)
        .frame(maxWidth: .infinity, minHeight: 62)
        .background(PulsePalette.surface)
    }

    @MainActor
    private func load() async {
        let request = UUID(), token = session.token, client = APIClient.shared.captureSession()
        loadID = request
        settings = nil
        localValues = [:]
        localExceptionIDs = nil
        loading = true
        guard session.user?.internalStaff == true else { showingPicker = false; loading = false; dismiss(); return }
        do {
            let updated = try await client.userSettings()
            guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            guard updated.canManagePrivacy else { showingPicker = false; loading = false; dismiss(); return }
            settings = updated
            settingsToken = token
            settingsEndpoint = client.endpointIdentity
            if let settings {
                localValues = [
                    "phone_visibility": settings.phoneVisibility,
                    "phone_search_visibility": settings.phoneSearchVisibility,
                    "last_seen_visibility": settings.lastSeenVisibility,
                    "voice_call_visibility": settings.voiceCallVisibility,
                    "voice_call_peer_to_peer": settings.voiceCallPeerToPeer,
                    "invite_visibility": settings.inviteVisibility
                ]
            }
            let fetchedContacts = try await client.contacts()
            guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            contacts = fetchedContacts
        } catch {
            guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity, !Task.isCancelled else { return }
            error = error.localizedDescription
        }
        loading = false
    }

    @MainActor
    private func save(_ patch: [String: Any]) {
        guard canManagePrivacy, savingKey == nil else { return }
        let token = session.token, client = APIClient.shared.captureSession(), request = loadID
        error = ""
        savingKey = patch.keys.first
        let previousValues = localValues
        let previousExceptionIDs = localExceptionIDs
        for (key, value) in patch { if let value = value as? String { localValues[key] = value } }
        Task {
            do {
                let updated = try await client.updateUserSettings(patch)
                guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
                settings = updated
                guard updated.canManagePrivacy else { showingPicker = false; savingKey = nil; dismiss(); return }
                localValues = [
                    "phone_visibility": updated.phoneVisibility,
                    "phone_search_visibility": updated.phoneSearchVisibility,
                    "last_seen_visibility": updated.lastSeenVisibility,
                    "voice_call_visibility": updated.voiceCallVisibility,
                    "voice_call_peer_to_peer": updated.voiceCallPeerToPeer,
                    "invite_visibility": updated.inviteVisibility
                ]
                localExceptionIDs = nil
            } catch {
                guard loadID == request, session.token == token, client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
                for key in patch.keys where key != "privacy_exceptions" {
                    if let previousValue = previousValues[key] { localValues[key] = previousValue }
                    else { localValues.removeValue(forKey: key) }
                }
                localExceptionIDs = previousExceptionIDs
                error = error.localizedDescription
                // Recheck a permission revoked while this editor was open.
                await load()
            }
            savingKey = nil
        }
    }

    private func saveExceptions(_ ids: [Int]) {
        guard canManagePrivacy, savingKey == nil else { return }
        let normalized = Array(Set(ids)).sorted()
        var dictionary = settings?.privacyExceptions.dictionary ?? PrivacyExceptions.empty.dictionary
        dictionary[kind.exceptionKey] = normalized
        save(["privacy_exceptions": dictionary])
    }
}

struct IOSAutoDeleteAccountView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var days = 180
    @State private var error = ""
    @State private var saving = false
    private struct AutoDeleteOption: Identifiable {
        let days: Int
        let title: String
        var id: Int { days }
    }
    private let options = [
        AutoDeleteOption(days: 30, title: "1 个月"),
        AutoDeleteOption(days: 90, title: "3 个月"),
        AutoDeleteOption(days: 180, title: "6 个月"),
        AutoDeleteOption(days: 365, title: "12 个月")
    ]

    var body: some View {
        List {
            Section {
                ForEach(options) { option in
                    Button {
                        days = option.days
                        save(option.days)
                    } label: {
                        HStack {
                            Text(option.title).foregroundStyle(PulsePalette.ink)
                            Spacer()
                            if saving && days == option.days {
                                ProgressView()
                            } else if days == option.days {
                                Image(systemName: "checkmark").foregroundStyle(PulsePalette.accent)
                            }
                        }
                    }
                    .disabled(saving)
                }
            } header: {
                Text("如果离开")
            } footer: {
                Text("如果您在这段时间内没有上线，您的账号资料、消息记录和联系人将被删除。")
            }
            if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("自动删除账号")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do { days = try await APIClient.shared.userSettings().accountAutoDeleteDays }
        catch { error = error.localizedDescription }
    }

    private func save(_ value: Int) {
        error = ""
        saving = true
        let previousDays = days
        Task {
            do { days = try await APIClient.shared.updateUserSettings(["account_auto_delete_days": value]).accountAutoDeleteDays }
            catch {
                days = previousDays
                error = error.localizedDescription
            }
            saving = false
        }
    }
}

struct IOSPrivacyExceptionPickerView: View {
    @Environment(\.dismiss) private var dismiss
    let existingIDs: [Int]
    let onComplete: ([Int]) -> Void
    @State private var contacts: [Contact] = []
    @State private var selectedIDs: Set<Int>
    @State private var keyword = ""
    @State private var error = ""
    @State private var loading = true

    init(existingIDs: [Int], onComplete: @escaping ([Int]) -> Void) {
        self.existingIDs = existingIDs
        self.onComplete = onComplete
        _selectedIDs = State(initialValue: Set(existingIDs))
    }

    var body: some View {
        PulseNavigationStack {
            List {
                Section { Text("选择一个或多个联系人").foregroundStyle(PulsePalette.muted).frame(maxWidth: .infinity, alignment: .center) }
                Section {
                    if loading {
                        ProgressView("正在加载联系人")
                            .frame(maxWidth: .infinity, alignment: .center)
                    } else {
                        ForEach(filteredContacts) { contact in
                            Button { toggle(contact.id) } label: {
                                HStack(spacing: 12) {
                                    selectionCircle(selected: selectedIDs.contains(contact.id))
                                    PulseAvatar(title: contact.nickname, size: 46, avatarURL: contact.avatarURL)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(contact.nickname).foregroundStyle(PulsePalette.ink)
                                        if let username = contact.username, !username.isEmpty { Text("@\(username)").font(.caption).foregroundStyle(PulsePalette.muted) }
                                        Text("用户 ID：\(PublicUserIdentity.display(contact.publicID))").font(.caption).foregroundStyle(PulsePalette.muted)
                                    }
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        if filteredContacts.isEmpty { Text(keyword.isEmpty ? "暂无联系人" : "没有找到匹配的联系人").foregroundStyle(PulsePalette.muted) }
                }
                if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
            }
            }
            .listStyle(.plain)
            .searchable(text: $keyword, prompt: "搜索用户")
            .navigationTitle("添加用户")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { onComplete(Array(selectedIDs)); dismiss() } }
            }
            .task { await load() }
        }
    }

    private var filteredContacts: [Contact] {
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return contacts }
        return contacts.filter { $0.nickname.localizedCaseInsensitiveContains(value) || ($0.username ?? "").localizedCaseInsensitiveContains(value) || ($0.publicID ?? "").contains(value) }
    }

    private func selectionCircle(selected: Bool) -> some View {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 25))
            .foregroundStyle(selected ? PulsePalette.accent : PulsePalette.line)
    }

    private func toggle(_ id: Int) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) } else { selectedIDs.insert(id) }
    }

    private func load() async {
        loading = true
        do { contacts = try await APIClient.shared.contacts() }
        catch { error = error.localizedDescription }
        loading = false
    }
}

struct IOSBlockedUsersView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var users: [BlockedUser] = []
    @State private var showingPicker = false
    @State private var pendingUnblock: BlockedUser?
    @State private var error = ""
    @State private var loading = true

    var body: some View {
        List {
            Section {
                Button { showingPicker = true } label: {
                    Label("加入黑名单", systemImage: "plus.circle.fill")
                        .foregroundStyle(PulsePalette.accent)
                }
            }

            Section("已屏蔽用户") {
                if loading {
                    ProgressView("正在加载")
                } else if users.isEmpty {
                    Text("暂无黑名单用户").foregroundStyle(PulsePalette.muted)
                } else {
                    ForEach(users) { user in
                        HStack(spacing: 12) {
                            PulseAvatar(title: user.nickname ?? user.username ?? "用", size: 44, avatarURL: user.avatarURL)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(user.nickname ?? user.username ?? "未命名用户").foregroundStyle(PulsePalette.ink)
                                if let username = user.username, !username.isEmpty { Text("@\(username)").font(.caption).foregroundStyle(PulsePalette.muted) }
                                Text("用户 ID：\(PublicUserIdentity.display(user.publicID))").font(.caption).foregroundStyle(PulsePalette.muted)
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button("解除") { pendingUnblock = user }.tint(PulsePalette.accent)
                        }
                    }
                }
            } footer: {
                Text("您屏蔽的用户将无法向您发送消息，或邀请您加入群组。他们也无法看到您的头像、在线状态及最后上线时间。")
            }

            if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("黑名单管理")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        .pulseSheet(isPresented: $showingPicker) { IOSBlockContactPickerView { await load() } }
        .confirmationDialog("解除屏蔽？", item: $pendingUnblock) { user in
            Button("解除屏蔽", role: .destructive) { Task { await unblock(user) } }
            Button("取消", role: .cancel) { pendingUnblock = nil }
        } message: { user in
            Text("解除后，\(user.nickname ?? "该用户")可以再次向您发送消息。")
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        do { users = try await APIClient.shared.blockedUsers() }
        catch { error = error.localizedDescription }
        loading = false
    }

    private func unblock(_ user: BlockedUser) async {
        do {
            try await APIClient.shared.unblock(userID: user.blockedId)
            users.removeAll { $0.id == user.id }
            pendingUnblock = nil
        } catch { error = error.localizedDescription }
    }
}

struct IOSBlockContactPickerView: View {
    @Environment(\.dismiss) private var dismiss
    let onBlocked: () async -> Void
    @State private var keyword = ""
    @State private var candidates: [BlockCandidate] = []
    @State private var loading = true
    @State private var processingID: Int?
    @State private var error = ""

    init(onBlocked: @escaping () async -> Void) { self.onBlocked = onBlocked }

    var body: some View {
        PulseNavigationStack {
            List {
                if loading {
                    ProgressView("正在加载联系人")
                } else if candidates.isEmpty {
                    Text(keyword.isEmpty ? "暂无可加入黑名单的联系人" : "没有找到匹配的联系人")
                        .foregroundStyle(PulsePalette.muted)
                } else {
                    ForEach(candidates) { candidate in
                        Button { Task { await block(candidate) } } label: {
                            HStack(spacing: 12) {
                                PulseAvatar(title: candidate.nickname, size: 44, avatarURL: candidate.avatarURL)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(candidate.nickname).foregroundStyle(PulsePalette.ink)
                                    if let username = candidate.username, !username.isEmpty { Text("@\(username)").font(.caption).foregroundStyle(PulsePalette.muted) }
                                    Text("用户 ID：\(PublicUserIdentity.display(candidate.publicID))").font(.caption).foregroundStyle(PulsePalette.muted)
                                }
                                Spacer()
                                if processingID == candidate.id { ProgressView() } else { Image(systemName: "plus.circle").foregroundStyle(PulsePalette.accent) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if !error.isEmpty { Text(error).foregroundStyle(PulsePalette.danger) }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $keyword, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索联系人")
            .onSubmit(of: .search) { Task { await load() } }
            .pulseOnChange(of: keyword) { value in
                if value.isEmpty { Task { await load() } }
            }
            .navigationTitle("加入黑名单")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        do { candidates = try await APIClient.shared.blockCandidates(keyword: keyword) }
        catch { error = error.localizedDescription }
        loading = false
    }

    private func block(_ candidate: BlockCandidate) async {
        processingID = candidate.id
        error = ""
        do {
            try await APIClient.shared.blockUser(userID: candidate.id)
            candidates.removeAll { $0.id == candidate.id }
            await onBlocked()
            dismiss()
        } catch { error = error.localizedDescription }
        processingID = nil
    }
}

struct IOSLockCodeView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appLock: AppLockManager

    var body: some View {
        Group {
            if appLock.hasPasscode { IOSLockCodeManagementView() }
            else { IOSLockCodeIntroView() }
        }
        .navigationTitle("锁定码与 Face ID")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
    }
}

private struct IOSLockCodeIntroView: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: 17) {
                    Image(systemName: "lock.shield.fill").font(.system(size: 48)).foregroundStyle(PulsePalette.accent).padding(.top, 22)
                    Text("锁定码").font(.system(size: 24, weight: .bold)).foregroundStyle(PulsePalette.ink)
                    Text("为应用设置锁定码，离开应用后需要验证锁定码才能继续使用。您也可以使用 Face ID 快速解锁。")
                        .font(.system(size: 15)).foregroundStyle(PulsePalette.muted).multilineTextAlignment(.center).padding(.horizontal, 14)
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, 22)
            }
            Section {
                NavigationLink { IOSLockCodeSetupView().pulseSwipeBack() } label: {
                    Text("开启锁定码").foregroundStyle(PulsePalette.accent).frame(maxWidth: .infinity, alignment: .center)
                }
            }
            Section { Text("如果您忘记锁定码，只能卸载并重新安装应用。重新安装不会删除服务器上的聊天数据，但本机未上传的内容可能无法恢复。").font(.footnote).foregroundStyle(PulsePalette.muted) }
        }
        .listStyle(.insetGrouped)
    }
}

private struct IOSLockCodeSetupView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appLock: AppLockManager
    @State private var kind: AppPasscodeKind = .fourDigit
    @State private var code = ""
    @State private var confirmation = ""
    @State private var error = ""

    var body: some View {
        Form {
            Section("锁定码类型") {
                Button { kind = .fourDigit } label: { choiceRow("四位数字密码", subtitle: "输入 4 位数字", selected: kind == .fourDigit) }
                Button { kind = .custom } label: { choiceRow("自定义密码", subtitle: "使用 4 至 32 位密码", selected: kind == .custom) }
            }
            Section("设置锁定码") {
                SecureField(kind == .fourDigit ? "新锁定码（4 位数字）" : "新锁定码", text: $code)
                    .keyboardType(kind == .fourDigit ? .numberPad : .default)
                SecureField("再次输入锁定码", text: $confirmation)
                    .keyboardType(kind == .fourDigit ? .numberPad : .default)
            }
            if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
            Section {
                Button("完成") { save() }.frame(maxWidth: .infinity, alignment: .center).disabled(code.isEmpty || confirmation.isEmpty)
            }
        }
        .navigationTitle("开启锁定码")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func choiceRow(_ title: String, subtitle: String, selected: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) { Text(title).foregroundStyle(PulsePalette.ink); Text(subtitle).font(.caption).foregroundStyle(PulsePalette.muted) }
            Spacer()
            if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(PulsePalette.accent) }
        }
    }

    private func save() {
        guard code == confirmation else { error = AppLockError.passcodesDoNotMatch.localizedDescription; return }
        do { try appLock.setPasscode(code, kind: kind); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}

private struct IOSLockCodeManagementView: View {
    @EnvironmentObject private var appLock: AppLockManager
    @State private var showingDisable = false
    @State private var showingFaceIDError = false
    @State private var faceIDError = ""
    private struct LockOption: Identifiable {
        let seconds: Int
        let title: String
        var id: Int { seconds }
    }
    private let lockOptions = [
        LockOption(seconds: 0, title: "停用"),
        LockOption(seconds: 60, title: "离开 1 分钟后"),
        LockOption(seconds: 300, title: "离开 5 分钟后"),
        LockOption(seconds: 3600, title: "离开 1 小时后"),
        LockOption(seconds: 18000, title: "离开 5 小时后")
    ]

    var body: some View {
        List {
            Section {
                NavigationLink { IOSChangeLockCodeView().pulseSwipeBack() } label: { Label("更改锁定码", systemImage: "key.fill") }
                Button(role: .destructive) { showingDisable = true } label: { Label("关闭锁定码", systemImage: "lock.open.fill") }
            }

            Section("自动锁定") {
                ForEach(lockOptions) { option in
                    Button { appLock.setAutoLock(seconds: option.seconds) } label: {
                        HStack { Text(option.title).foregroundStyle(PulsePalette.ink); Spacer(); if appLock.autoLockSeconds == option.seconds { Image(systemName: "checkmark").foregroundStyle(PulsePalette.accent) } }
                    }
                }
            }

            Section {
                Toggle(isOn: Binding(get: { appLock.faceIDEnabled }, set: { value in
                    if value {
                        Task { if !(await appLock.enableFaceID()) { faceIDError = appLock.faceIDAvailable ? "Face ID 验证未通过。" : "这台设备不支持 Face ID。"; showingFaceIDError = true } }
                    } else { appLock.disableFaceID() }
                })) { Label("使用 Face ID 解锁", systemImage: "faceid") }
                    .disabled(!appLock.faceIDAvailable)
            } footer: {
                Text(appLock.faceIDAvailable ? "启用后，打开应用时可以使用 Face ID 解锁。" : "这台设备没有可用的 Face ID，无法启用此功能。")
            }
        }
        .listStyle(.insetGrouped)
        .alert("Face ID", isPresented: $showingFaceIDError) { Button("知道了") {} } message: { Text(faceIDError) }
        .pulseSheet(isPresented: $showingDisable) { IOSDisableLockCodeView() }
    }
}

private struct IOSDisableLockCodeView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appLock: AppLockManager
    @State private var code = ""
    @State private var error = ""

    var body: some View {
        PulseNavigationStack {
            Form {
                Section { Text("请输入当前锁定码，确认后将关闭应用锁定功能。你可以之后重新开启。\n\n关闭后，Face ID 和自动锁定设置也会一并清除。").foregroundStyle(PulsePalette.muted) }
                Section { SecureField("当前锁定码", text: $code).keyboardType(appLock.passcodeKind == .fourDigit ? .numberPad : .default) }
                if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
                Section { Button("关闭锁定码", role: .destructive) { disable() }.frame(maxWidth: .infinity, alignment: .center) }
            }
            .navigationTitle("关闭锁定码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }

    private func disable() {
        guard appLock.verify(code) else { error = AppLockError.invalidCurrentPasscode.localizedDescription; return }
        appLock.removePasscode()
        dismiss()
    }
}

private struct IOSChangeLockCodeView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appLock: AppLockManager
    @State private var current = ""
    @State private var newCode = ""
    @State private var confirmation = ""
    @State private var kind: AppPasscodeKind = .fourDigit
    @State private var error = ""

    var body: some View {
        Form {
            Section("当前锁定码") { SecureField("当前锁定码", text: $current).keyboardType(appLock.passcodeKind == .fourDigit ? .numberPad : .default) }
            Section("新锁定码类型") {
                Button { kind = .fourDigit } label: { choiceRow("四位数字密码", kind == .fourDigit) }
                Button { kind = .custom } label: { choiceRow("自定义密码", kind == .custom) }
            }
            Section("新锁定码") {
                SecureField("新锁定码", text: $newCode).keyboardType(kind == .fourDigit ? .numberPad : .default)
                SecureField("再次输入新锁定码", text: $confirmation).keyboardType(kind == .fourDigit ? .numberPad : .default)
            }
            if !error.isEmpty { Section { Text(error).foregroundStyle(PulsePalette.danger) } }
            Section { Button("保存") { save() }.frame(maxWidth: .infinity, alignment: .center) }
        }
        .navigationTitle("更改锁定码")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { kind = appLock.passcodeKind }
    }

    private func choiceRow(_ title: String, _ selected: Bool) -> some View {
        HStack { Text(title).foregroundStyle(PulsePalette.ink); Spacer(); if selected { Image(systemName: "checkmark").foregroundStyle(PulsePalette.accent) } }
    }

    private func save() {
        guard newCode == confirmation else { error = AppLockError.passcodesDoNotMatch.localizedDescription; return }
        do { try appLock.changePasscode(current: current, newCode: newCode, kind: kind); dismiss() }
        catch { error = error.localizedDescription }
    }
}
