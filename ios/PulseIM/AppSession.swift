import Foundation
import Combine
import Security

@MainActor final class AppSession: ObservableObject {
    @Published var token: String? = SessionTokenStore.load()
    @Published var user: User?
    @Published private(set) var savedAccounts: [SavedAccount] = SessionTokenStore.accounts()
    @Published private(set) var changingAccount = false
    @Published private(set) var conversations: [Conversation] = []
    @Published private(set) var messageRecallRevision = 0
    private var messageRecallsOwner = ""
    private var messageRecalls: [Int: Message] = [:]
    @Published var contacts: [Contact] = []
    @Published private(set) var contactNames: [Int: ContactNameRecord] = [:]
    private var contactNamesOwner = ""
    private var contactNamesTask: Task<Void, Never>?
    private var contactNamesQueued = false
    private var contactNamesLastRefresh: TimeInterval = -100
    private var contactNamesRevision = 0

    private var contactNamesScope: String {
        guard let token, let user else { return "" }
        return "\(APIClient.shared.endpointIdentity)\n\(user.id)\n\(token)"
    }
    func contactDisplayName(userID: Int, fallback: String) -> String {
        if userID == user?.id { return user?.nickname ?? fallback }
        if !contactNamesScope.isEmpty, contactNamesOwner == contactNamesScope, let record = contactNames[userID] { return record.displayName }
        return fallback
    }
    func rememberContactName(userID: Int, nickname: String, remark: String) {
        guard userID > 0, !contactNamesScope.isEmpty else { return }
        if contactNamesOwner != contactNamesScope { contactNames = [:]; contactNamesOwner = contactNamesScope }
        contactNamesRevision += 1
        contactNames[userID] = ContactNameRecord(userId: userID, nickname: nickname, remark: remark)
        if contactNamesTask != nil { contactNamesQueued = true }
    }
    func refreshContactNames(force: Bool = false) {
        let scope = contactNamesScope
        guard !scope.isEmpty, appActive else { return }
        if contactNamesTask != nil { if force { contactNamesQueued = true }; return }
        if !force, contactNamesOwner == scope, ProcessInfo.processInfo.systemUptime - contactNamesLastRefresh < 30 { return }
        if contactNamesOwner != scope { contactNames = [:]; contactNamesOwner = scope }
        let client = APIClient.shared.captureSession(); let revision = contactNamesRevision
        contactNamesTask = Task { [weak self] in
            guard let self else { return }
            do {
                let rows = try await client.contactNames()
                if self.contactNamesScope == scope, !Task.isCancelled, !self.contactNamesQueued, self.contactNamesRevision == revision {
                    self.contactNames = Dictionary(uniqueKeysWithValues: rows.map { ($0.userId, $0) })
                    let known = Set(rows.map(\.userId)); self.contacts = self.contacts.filter { known.contains($0.userId) }
                    self.contactNamesLastRefresh = ProcessInfo.processInfo.systemUptime
                }
            } catch { if self.contactNamesScope == scope { self.contactNamesLastRefresh = ProcessInfo.processInfo.systemUptime - 25 } }
            self.contactNamesTask = nil
            let again = self.contactNamesQueued; self.contactNamesQueued = false
            if again || self.contactNamesScope != scope { self.refreshContactNames(force: true) }
        }
    }
    @Published private(set) var friendRequestInbox = IOSFriendRequestInbox()
    @Published private(set) var handlingFriendRequestIDs = Set<Int>()
    @Published private(set) var pendingFriendRequestCount = 0
    private var friendRequestBadgeState = IOSFriendRequestBadgeState()
    private var friendBadgeTask: Task<Void, Error>?
    private var friendBadgeTaskID = UUID()
    private var friendBadgeQueued = false
    var pendingFriendRequests: [ContactRequest] { friendRequestInbox.pending }
    private var friendRequestRefreshTask: Task<Void, Error>?
    private var friendRequestRefreshID = UUID()
    private var friendRequestRefreshQueued = false
    @Published var error = ""
    @Published var rememberedLoginNotice = ""
    @Published var activeAnnouncement: ClientAnnouncement?
    @Published private(set) var chatNotice = ""
    @Published private(set) var groupMemberLimit = 500
    @Published private(set) var showGroupMemberCount = true
    @Published private(set) var exploreLinks: [ClientExternalLink] = []
    @Published private(set) var clientConfigError = ""
    private var clientConfigRevision = UUID()
    @Published private(set) var latestVersion = "1.0.0"
    @Published private(set) var forceUpdate = false
    @Published var notificationConversation: Conversation?
    private var friendChatObserver: NSObjectProtocol?
    private var friendChatTask: Task<Void, Never>?
    private var friendChatOperation = UUID()
    private var friendChatQueued = false
    @Published private(set) var updateURL: URL?
    @Published private(set) var updateDescription = ""
    @Published private(set) var restoringSession = false
    @Published private(set) var restoreMessage = ""
    var updateAvailable: Bool { Self.newer(latestVersion, than: APIClient.appVersion) }
    var updateRequired: Bool { forceUpdate && updateAvailable }
    private var routeObserver: NSObjectProtocol?
    private var responseObserver: NSObjectProtocol?
    private var blockedObserver: NSObjectProtocol?
    private var pushObserver: NSObjectProtocol?
    private var pushSessionTask: Task<Void, Never>?
    private var pushSessionID = UUID()
    private var authenticationRevision = UUID()
    private var loginAttemptRevision = UUID()
    private var accountOperationID: UUID?
    private var activeServerIdentity = APIClient.shared.serverIdentity
    private var profileRevision = UUID()
    private var profileSaveID: UUID?
    private var authenticationLoadTask: Task<Void, Never>?
    private var restoreAttempt: UUID?
    private var restoreRetryTask: Task<Void, Never>?
    private var restoreRetryDelay = 2
    private var inbox: RealtimeClient?
    private var inboxRevision = UUID()
    private var inboxRefreshTask: Task<Void, Never>?
    private var inboxPollTask: Task<Void, Never>?
    private var conversationRefreshTask: Task<Void, Error>?
    private var conversationRefreshID = UUID()
    private var conversationRefreshQueued = false
    private var lastConversationRefreshAt: TimeInterval = 0
    private var conversationRefreshFailed = false
    private var appActive = true
    private var routeMonitorTask: Task<Void, Never>?
    var isSignedIn: Bool { token != nil && user != nil }

    init() {
        routeObserver = NotificationCenter.default.addObserver(forName: .pulseRouteChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.objectWillChange.send() }
        }
        Task { _ = await VerifiedRoutes.shared.refresh() }
        monitorRoutes(active: true)

        blockedObserver = NotificationCenter.default.addObserver(forName: .pulseSessionBlocked, object: nil, queue: .main) { [weak self] notification in
            let kind = notification.object as? String
            let blockedToken = notification.userInfo?["session_token"] as? String
            let blockedEndpoint = notification.userInfo?["endpoint_identity"] as? String
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard blockedToken == nil || self.token == blockedToken, blockedEndpoint == nil || APIClient.shared.endpointIdentity == blockedEndpoint else { return }
                if kind == "auth.revoked" { self.signOut(); self.error = "登录状态已失效，请重新登录" }
                else {
                    let endpoint = APIClient.shared.endpointIdentity
                    await self.loadClientConfig()
                    guard endpoint == APIClient.shared.endpointIdentity else { return }
                    self.forceUpdate = true
                }
            }
        }
        responseObserver = NotificationCenter.default.addObserver(forName: .pulsePushOpened, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.openPendingNotification() }
        }
        friendChatObserver = NotificationCenter.default.addObserver(forName: .pulseFriendshipReady, object: nil, queue: .main) { [weak self] notification in
            let event = notification.object as? FriendChatEvent
            let sourceToken = notification.userInfo?["session_token"] as? String
            let sourceEndpoint = notification.userInfo?["endpoint_identity"] as? String
            Task { @MainActor [weak self] in
                guard let self, self.token == sourceToken, APIClient.shared.endpointIdentity == sourceEndpoint else { return }
                self.refreshFriendChats(offered: event)
                self.refreshFriendRequestBadges()
            }
        }
        pushObserver = NotificationCenter.default.addObserver(forName: .pulsePushTokenUpdated, object: nil, queue: .main) { [weak self] notification in
            guard let value = notification.object as? String else { return }
            Task { @MainActor [weak self] in
                guard let self, self.isSignedIn else { return }
                await self.registerPushDeviceIfAvailable(token: value)
            }
        }
    }

    deinit {
        if let friendChatObserver { NotificationCenter.default.removeObserver(friendChatObserver) }
        friendChatTask?.cancel()
        friendRequestRefreshTask?.cancel()
        friendBadgeTask?.cancel()
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        authenticationLoadTask?.cancel()
        restoreRetryTask?.cancel()
        routeMonitorTask?.cancel()
        inboxRefreshTask?.cancel(); inboxPollTask?.cancel(); conversationRefreshTask?.cancel()
        if let pushObserver { NotificationCenter.default.removeObserver(pushObserver) }
        if let responseObserver { NotificationCenter.default.removeObserver(responseObserver) }
        if let blockedObserver { NotificationCenter.default.removeObserver(blockedObserver) }
    }

    @discardableResult func signIn(phone: String, password: String, twoStepCode: String = "", addingAccount: Bool = false, expectedToken: String? = nil, rememberPassword: Bool? = nil) async -> Bool {
        guard !changingAccount else { error = "正在登录或切换账号，请稍候"; return false }
        guard addingAccount ? (isSignedIn && token == expectedToken) : !isSignedIn else { error = "当前账号已改变，请重新打开添加账号"; return false }
        let account = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        if addingAccount, let profile = user,
           [profile.username, profile.phone].compactMap({ $0 }).contains(where: { !$0.isEmpty && $0.caseInsensitiveCompare(account) == .orderedSame }) {
            error = "该账号已是当前账号，无需重复添加"; return false
        }
        restoreRetryTask?.cancel(); restoreRetryTask = nil
        error = ""
        let ownerToken = token, ownerUserID = user?.id
        let attempt = UUID(); loginAttemptRevision = attempt; accountOperationID = attempt; changingAccount = true
        defer { if accountOperationID == attempt { accountOperationID = nil; changingAccount = false } }
        let client = APIClient.shared.captureAnonymousSession()
        do {
            let result = try await client.login(phone: account, password: password, twoStepCode: twoStepCode)
            client.token = result.accessToken
            try validateLoginAttempt(attempt, ownerToken: ownerToken, ownerUserID: ownerUserID, client: client)
            let profile = try await client.me()
            try validateLoginAttempt(attempt, ownerToken: ownerToken, ownerUserID: ownerUserID, client: client)
            guard profile.id == result.userId, result.userId > 0, !result.accessToken.isEmpty else { throw APIClientError.invalidResponse }
            try commitAuthentication(result.accessToken, user: profile, client: client)
            if let rememberPassword { rememberAuthenticatedLogin(account: account, password: password, remember: rememberPassword) }
            startAuthenticationRefresh(client: client, refreshProfile: false)
            return true
        } catch {
            if client.token != nil, client.token != token { Task { try? await client.logout() } }
            if loginAttemptRevision == attempt, token == ownerToken, !(error is CancellationError) { self.error = error.localizedDescription }
            return false
        }
    }

    func rememberAuthenticatedLogin(account: String, password: String, remember: Bool) {
        guard isSignedIn, let user else { return }
        do {
            if remember { try IOSRememberedLogins.save(server: activeServerIdentity, user: user, account: account, password: password) }
            else { try IOSRememberedLogins.remove(server: activeServerIdentity, account: account) }
        } catch { rememberedLoginNotice = "已登录，但未能保存记住密码的设置。请解锁设备并检查本机存储后重试。" }
    }

    @discardableResult func switchAccount(_ account: SavedAccount) async -> Bool {
        guard !changingAccount else { error = "正在登录或切换账号，请稍候"; return false }
        if isSignedIn, user?.id == account.userID, activeServerIdentity == account.server { return true }
        let ownerToken = token, ownerUserID = user?.id
        let attempt = UUID(); loginAttemptRevision = attempt; accountOperationID = attempt; changingAccount = true; error = ""
        defer { if accountOperationID == attempt { accountOperationID = nil; changingAccount = false } }
        let client = APIClient.shared.captureAnonymousSession()
        var credential: SavedAccountCredential?
        do {
            guard account.server == client.serverIdentity else { throw APIClientError.server("该账号属于其他服务器，请返回原服务器登录") }
            let saved = try SessionTokenStore.credential(id: account.id, server: account.server); credential = saved; client.token = saved.token
            let profile = try await client.me()
            try validateLoginAttempt(attempt, ownerToken: ownerToken, ownerUserID: ownerUserID, client: client)
            guard profile.id == saved.account.userID else { throw APIClientError.invalidResponse }
            try commitAuthentication(saved.token, user: profile, client: client)
            startAuthenticationRefresh(client: client, refreshProfile: false)
            return true
        } catch {
            guard loginAttemptRevision == attempt, token == ownerToken, !(error is CancellationError) else { return false }
            if let credential, (error as? APIClientError)?.expiredSessionMessage != nil {
                do {
                    savedAccounts = try SessionTokenStore.remove(id: credential.account.id, expectedToken: credential.token)
                    self.error = "该账号登录已失效，请点击添加账号重新登录"
                } catch { self.error = error.localizedDescription }
            } else { self.error = error.localizedDescription }
            return false
        }
    }

    private func validateLoginAttempt(_ attempt: UUID, ownerToken: String?, ownerUserID: Int?, client: APIClient) throws {
        guard loginAttemptRevision == attempt, token == ownerToken, user?.id == ownerUserID, !Task.isCancelled else { throw CancellationError() }
        guard client.endpointIdentity == APIClient.shared.endpointIdentity else { throw APIClientError.server("服务器线路已切换，请重新登录") }
    }

    func restore() async {
        guard !isSignedIn, restoreAttempt == nil, let savedToken = token else { return }
        let attempt = UUID(); authenticationRevision = attempt
        restoreAttempt = attempt; restoringSession = true; restoreMessage = ""
        restoreRetryTask?.cancel(); restoreRetryTask = nil
        defer { if restoreAttempt == attempt { restoreAttempt = nil; restoringSession = false } }
        let client = APIClient.shared.captureAnonymousSession(); client.token = savedToken
        do {
            let profile = try await client.me()
            try validateAuthenticationAttempt(attempt, client: client)
            guard token == savedToken else { return }
            try commitAuthentication(savedToken, user: profile, client: client)
            restoreRetryDelay = 2
            startAuthenticationRefresh(client: client, refreshProfile: false)
        } catch {
            guard authenticationRevision == attempt, token == savedToken, !(error is CancellationError) else { return }
            // A response for a different route must not clear the saved account.
            guard client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
            if let message = (error as? APIClientError)?.expiredSessionMessage {
                signOut(); self.error = message
                return
            }
            // Timeouts, transport/decoding failures and service errors do not
            // prove a saved credential invalid. Keep it locked away from the UI
            // until /auth/me succeeds, and retry without asking for a password.
            restoreMessage = "暂时无法连接，已保留登录状态，网络恢复后会自动重试。"
            guard appActive, !updateRequired else { return }
            let delay = restoreRetryDelay; restoreRetryDelay = min(30, delay * 2)
            restoreRetryTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                guard let self, !Task.isCancelled, self.appActive, self.authenticationRevision == attempt, self.token == savedToken, !self.isSignedIn else { return }
                self.restoreRetryTask = nil
                await self.restore()
            }
        }
    }

    /// Registration has already created an account. Optional follow-up requests must
    /// never turn its successful response into a second registration attempt.
    func acceptRegistration(result: LoginData, username: String, nickname: String, client: APIClient, addingAccount: Bool = false, expectedToken: String? = nil) throws {
        let authenticatedClient = client.captureAnonymousSession(); authenticatedClient.token = result.accessToken
        guard addingAccount ? (isSignedIn && token == expectedToken) : !isSignedIn else {
            Task { try? await authenticatedClient.logout() }
            throw APIClientError.server("账号已创建，但当前账号已改变，请使用新账号重新登录")
        }
        guard client.endpointIdentity == APIClient.shared.endpointIdentity else {
            Task { try? await authenticatedClient.logout() }
            throw APIClientError.server("账号已创建，但服务器线路已切换，请返回原线路登录")
        }
        guard result.userId > 0, !result.accessToken.isEmpty else { throw APIClientError.invalidResponse }
        let profile = User(id: result.userId, nickname: nickname.trimmingCharacters(in: .whitespacesAndNewlines), phone: nil, avatarURL: result.avatarURL, username: username.trimmingCharacters(in: .whitespacesAndNewlines), birthday: nil, birthdayChangeCount: 0, gender: nil, signature: nil, status: "active", internalStaff: false, formalEmployee: false, publicID: result.publicID)
        do { try commitAuthentication(result.accessToken, user: profile, client: authenticatedClient) }
        catch {
            Task { try? await authenticatedClient.logout() }
            throw APIClientError.server("账号已创建，但无法安全保存登录状态，请返回登录页使用新账号登录")
        }
        startAuthenticationRefresh(client: authenticatedClient, refreshProfile: true)
    }

    private func validateAuthenticationAttempt(_ attempt: UUID, client: APIClient) throws {
        guard authenticationRevision == attempt, !Task.isCancelled else { throw CancellationError() }
        guard client.endpointIdentity == APIClient.shared.endpointIdentity else { throw APIClientError.server("服务器线路已切换，请重新登录") }
    }

    private func commitAuthentication(_ value: String, user profile: User, client: APIClient) throws {
        guard client.endpointIdentity == APIClient.shared.endpointIdentity, profile.id > 0, !value.isEmpty else { throw APIClientError.invalidResponse }
        let previousToken = token
        let previous = user.flatMap { profile in previousToken.map { SessionTokenStore.makeCredential($0, profile: profile, server: activeServerIdentity) } }
        // Persist both credentials atomically before changing any visible account.
        let accounts = try SessionTokenStore.activate(value, profile: profile, server: client.serverIdentity, preserving: previous)
        if previousToken != value {
            AvatarImageCache.shared.clear(); IOSChatImageCache.shared.clear()
            Task { await IOSLocalChatStore.shared.bind(""); await IOSLocalMediaCache.shared.cancel() }
        }
        restoreRetryTask?.cancel(); restoreRetryTask = nil; restoreMessage = ""
        authenticationLoadTask?.cancel()
        authenticationRevision = UUID(); loginAttemptRevision = UUID()
        conversations = []; contacts = []; notificationConversation = nil
        friendRequestInbox.reset(); friendRequestBadgeState.reset(); pendingFriendRequestCount = 0; handlingFriendRequestIDs = []
        activeAnnouncement = nil; chatNotice = ""; exploreLinks = []; clientConfigError = ""; clientConfigRevision = UUID()
        savedAccounts = accounts; activeServerIdentity = client.serverIdentity
        if let owner = UserDefaults.standard.object(forKey: "pulse_notification_user_id") as? Int, owner != profile.id {
            UserDefaults.standard.removeObject(forKey: "pulse_pending_notification")
        }
        APIClient.shared.token = value
        profileRevision = UUID(); profileSaveID = nil
        user = profile; token = value; error = ""
        AvatarImageCache.shared.prefetch(profile.avatarURL, client: client)
        UserDefaults.standard.set(profile.id, forKey: "pulse_notification_user_id")
        startInbox()
        Task { [weak self] in await self?.registerPushDeviceIfAvailable(client: client) }
    }

    /// Message mutation menus use the current server switch, never a cached login flag.
    func verifyInternalStaffForMessageActions() async throws -> Bool {
        guard let expectedToken = token, let expectedActor = user?.id else { return false }
        let revision = authenticationRevision
        let profileVersion = profileRevision
        let client = APIClient.shared.captureSession()
        let profile = try await client.me()
        guard !Task.isCancelled, token == expectedToken, authenticationRevision == revision,
              user?.id == expectedActor, profile.id == expectedActor,
              client.endpointIdentity == APIClient.shared.endpointIdentity else { throw CancellationError() }
        if profileRevision == profileVersion, profileSaveID == nil { user = profile }
        return profile.internalStaff
    }

    func canEditProfile(client: APIClient, userID: Int) -> Bool {
        isSignedIn && userID > 0 && user?.id == userID && token == client.token
            && client.endpointIdentity == APIClient.shared.endpointIdentity
    }

    /// Every editor commits through the captured account; a stale /me cannot undo it.
    func saveProfile(nickname: String, avatarURL: String, username: String? = nil, birthday: String? = nil,
                     gender: String? = nil, signature: String? = nil, avatarData: Data? = nil,
                     client suppliedClient: APIClient? = nil, userID suppliedUserID: Int? = nil) async throws {
        let client = suppliedClient ?? APIClient.shared.captureSession()
        let userID = suppliedUserID ?? user?.id ?? 0
        guard canEditProfile(client: client, userID: userID) else { throw CancellationError() }
        guard profileSaveID == nil else { throw APIClientError.server("资料正在保存，请稍候") }
        let operation = UUID(), authentication = authenticationRevision
        profileSaveID = operation; profileRevision = UUID()
        defer { if profileSaveID == operation { profileSaveID = nil; profileRevision = UUID() } }
        let profile = try await client.updateProfile(userID: userID, nickname: nickname, avatarURL: avatarURL,
                                                   username: username, birthday: birthday, gender: gender, signature: signature)
        guard !Task.isCancelled, authenticationRevision == authentication, profileSaveID == operation,
              canEditProfile(client: client, userID: userID) else { throw CancellationError() }
        if let avatarData { AvatarImageCache.shared.seed(avatarData, rawURL: profile.avatarURL, client: client) }
        user = profile
        AvatarImageCache.shared.prefetch(profile.avatarURL, client: client)
    }

    private func startAuthenticationRefresh(client: APIClient, refreshProfile: Bool) {
        let revision = authenticationRevision
        let sessionToken = token
        authenticationLoadTask = Task { [weak self] in
            guard let self else { return }
            func isCurrent() -> Bool { !Task.isCancelled && self.authenticationRevision == revision && self.token == sessionToken && client.endpointIdentity == APIClient.shared.endpointIdentity }
            if refreshProfile {
                let version = self.profileRevision
                if let profile = try? await client.me(), isCurrent(), profile.id == self.user?.id,
                   self.profileRevision == version, self.profileSaveID == nil {
                    self.user = profile
                    AvatarImageCache.shared.prefetch(profile.avatarURL, client: client)
                }
            }
            guard isCurrent() else { return }
            try? await self.refreshConversations()
            guard isCurrent() else { return }
            if let items = try? await client.contacts(), isCurrent() { self.contacts = items }
            guard isCurrent() else { return }
            await self.loadClientConfig()
            guard isCurrent() else { return }
            await self.registerPushDeviceIfAvailable(client: client)
            guard isCurrent() else { return }
            await self.openPendingNotification()
        }
    }

    func signOut() {
        do {
            try SessionTokenStore.clear(expectedToken: token)
            savedAccounts = SessionTokenStore.accounts()
        } catch { self.error = error.localizedDescription; return }
        loginAttemptRevision = UUID(); accountOperationID = nil; changingAccount = false
        restoreRetryTask?.cancel(); restoreRetryTask = nil; restoreAttempt = nil; restoringSession = false; restoreMessage = ""
        authenticationRevision = UUID(); authenticationLoadTask?.cancel(); authenticationLoadTask = nil
        profileRevision = UUID(); profileSaveID = nil
        AvatarImageCache.shared.clear()
        IOSChatImageCache.shared.clear()
        Task { await IOSLocalChatStore.shared.bind(""); await IOSLocalMediaCache.shared.cancel() }
        stopInbox()
        let client = APIClient.shared.captureSession()
        client.token = token
        let pushToken = UserDefaults.standard.string(forKey: "pulse_apns_device_token")
        if token != nil {
            let predecessor = pushSessionTask
            pushSessionID = UUID()
            pushSessionTask = Task {
                await predecessor?.value
                if let pushToken { try? await client.unregisterNotificationDevice(token: pushToken) }
                try? await client.logout()
            }
        }
        token = nil; user = nil; conversations = []; contacts = []; notificationConversation = nil
        friendRequestInbox.reset(); friendRequestBadgeState.reset(); pendingFriendRequestCount = 0; handlingFriendRequestIDs = []
        activeAnnouncement = nil; chatNotice = ""; exploreLinks = []; clientConfigError = ""; clientConfigRevision = UUID(); APIClient.shared.token = nil; UserDefaults.standard.removeObject(forKey: "pulse_notification_user_id")
        UserDefaults.standard.removeObject(forKey: "pulse_pending_notification")
    }

    func setAppActive(_ active: Bool) {
        guard appActive != active else { return }
        appActive = active
        monitorRoutes(active: active)
        if active {
            Task { _ = await VerifiedRoutes.shared.refresh() }
            startInbox()
            if !isSignedIn, token != nil { Task { await restore() } }
        } else { stopInbox(); restoreRetryTask?.cancel(); restoreRetryTask = nil }
    }

    private func monitorRoutes(active: Bool) {
        routeMonitorTask?.cancel(); routeMonitorTask = nil
        VerifiedRoutes.shared.invalidateOptimization()
        guard active else { return }
        routeMonitorTask = Task {
            do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            var refreshedAt = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled {
                _ = await VerifiedRoutes.shared.optimize()
                guard !Task.isCancelled else { return }
                if ProcessInfo.processInfo.systemUptime - refreshedAt >= 300 {
                    _ = await VerifiedRoutes.shared.refresh(); refreshedAt = ProcessInfo.processInfo.systemUptime
                }
                do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            }
        }
    }

    private func stopInbox() {
        friendBadgeTaskID = UUID(); friendBadgeTask?.cancel(); friendBadgeTask = nil; friendBadgeQueued = false
        friendRequestRefreshID = UUID(); friendRequestRefreshTask?.cancel(); friendRequestRefreshTask = nil; friendRequestRefreshQueued = false
        friendChatOperation = UUID(); friendChatTask?.cancel(); friendChatTask = nil; friendChatQueued = false
        inboxRevision = UUID(); inbox?.close(); inbox = nil
        inboxRefreshTask?.cancel(); inboxRefreshTask = nil
        inboxPollTask?.cancel(); inboxPollTask = nil
        conversationRefreshID = UUID(); conversationRefreshTask?.cancel(); conversationRefreshTask = nil; conversationRefreshQueued = false
        lastConversationRefreshAt = 0
        conversationRefreshFailed = false
    }

    private func startInbox() {
        stopInbox()
        guard appActive, isSignedIn, let token else { return }
        let revision = inboxRevision
        let endpoint = APIClient.shared.endpointIdentity
        inbox = RealtimeClient(token: token, onConversationUpdate: { [weak self] _ in
            guard let self, self.inboxRevision == revision else { return }
            self.conversationDidChange()
        }, onReady: { [weak self] in
            guard let self, self.inboxRevision == revision else { return }
            // The acknowledgement defines the live boundary. Fetch after it to
            // recover messages committed before the inbox subscription existed.
            self.conversationDidChange(); self.refreshFriendChats(); self.refreshFriendRequestBadges()
            self.refreshContactNames(force: true)
        }, onNotificationUpdate: { [weak self] in
            guard let self, self.inboxRevision == revision else { return }
            self.refreshFriendChats(); self.refreshFriendRequestBadges()
            self.refreshContactNames(force: true)
            self.conversationDidChange()
        })
        inbox?.connect()
        refreshFriendChats()
        refreshFriendRequestBadges()
        inboxPollTask = Task { [weak self] in
            guard let self else { return }
            try? await self.refreshConversations()
            var friendCheckAt = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled, self.appActive, self.token == token, self.inboxRevision == revision, APIClient.shared.endpointIdentity == endpoint {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard !Task.isCancelled, self.appActive, self.token == token, self.inboxRevision == revision else { return }
                if ProcessInfo.processInfo.systemUptime - friendCheckAt >= 5 {
                    friendCheckAt = ProcessInfo.processInfo.systemUptime; self.refreshFriendChats(); self.refreshFriendRequestBadges()
                }
                let delay: TimeInterval = self.inbox?.connected == true && !self.conversationRefreshFailed ? 30 : 3
                self.refreshContactNames()
                if ProcessInfo.processInfo.systemUptime - self.lastConversationRefreshAt >= delay { try? await self.refreshConversations() }
            }
        }
    }

    private func refreshFriendRequestBadges() {
        Task { [weak self] in try? await self?.refreshFriendRequestBadge() }
        if friendRequestRefreshTask != nil { friendRequestRefreshQueued = true; return }
        Task { [weak self] in try? await self?.refreshFriendRequests() }
    }

    /// Both tab and entry badges can refresh even when request rows fail or are slow.
    func refreshFriendRequestBadge() async throws {
        guard appActive, isSignedIn, !updateRequired, let token, let actor = user?.id else { return }
        if let pending = friendBadgeTask { friendBadgeQueued = true; try await pending.value; return }
        let client = APIClient.shared.captureSession(), request = UUID(), authentication = authenticationRevision, inboxVersion = inboxRevision
        friendBadgeTaskID = request
        let pending = Task { [weak self] in
            guard let self else { return }
            var passes = 0
            repeat {
                self.friendBadgeQueued = false
                let snapshot = self.friendRequestBadgeState.beginRefresh()
                let count: Int
                do { count = try await client.friendRequestSummary() }
                catch {
                    try Task.checkCancellation()
                    // Older servers still use the complete received-request API.
                    let rows = try await client.receivedRequests()
                    var inbox = IOSFriendRequestInbox(); inbox.replace(with: rows, revision: inbox.refreshRevision); count = inbox.count
                }
                guard !Task.isCancelled, self.appActive, self.authenticationRevision == authentication, self.inboxRevision == inboxVersion,
                      self.friendBadgeTaskID == request, self.token == token, self.user?.id == actor, !self.updateRequired,
                      client.endpointIdentity == APIClient.shared.endpointIdentity else { throw CancellationError() }
                if self.friendRequestBadgeState.apply(count, revision: snapshot) {
                    if self.pendingFriendRequestCount != count { self.pendingFriendRequestCount = count }
                } else { self.friendBadgeQueued = true }
                passes += 1
            } while self.friendBadgeQueued && passes < 2
        }
        friendBadgeTask = pending
        defer {
            if friendBadgeTaskID == request {
                friendBadgeTask = nil
                if friendBadgeQueued { friendBadgeQueued = false; Task { [weak self] in try? await self?.refreshFriendRequestBadge() } }
            }
        }
        try await pending.value
    }

    func refreshFriendRequests() async throws {
        guard appActive, isSignedIn, !updateRequired, let token, let actor = user?.id else { return }
        if let pending = friendRequestRefreshTask {
            friendRequestRefreshQueued = true
            try await pending.value
            return
        }
        let client = APIClient.shared.captureSession(), request = UUID()
        let authentication = authenticationRevision, inboxVersion = inboxRevision
        friendRequestRefreshID = request
        let pending = Task { [weak self] in
            guard let self else { return }
            var passes = 0
            repeat {
                self.friendRequestRefreshQueued = false
                let snapshot = self.friendRequestInbox.refreshRevision
                let badgeSnapshot = self.friendRequestBadgeState.beginRefresh()
                let rows = try await client.receivedRequests()
                guard !Task.isCancelled, self.appActive, self.authenticationRevision == authentication,
                      self.inboxRevision == inboxVersion, self.friendRequestRefreshID == request,
                      self.token == token, self.user?.id == actor, !self.updateRequired,
                      client.endpointIdentity == APIClient.shared.endpointIdentity else { throw CancellationError() }
                var next = self.friendRequestInbox
                if next.replace(with: rows, revision: snapshot) {
                    // Polling an unchanged count/list must not invalidate every chat view.
                    if next != self.friendRequestInbox { self.friendRequestInbox = next }
                    if self.friendRequestBadgeState.apply(next.count, revision: badgeSnapshot), self.pendingFriendRequestCount != next.count {
                        self.pendingFriendRequestCount = next.count
                    }
                } else { self.friendRequestRefreshQueued = true }
                passes += 1
            } while self.friendRequestRefreshQueued && passes < 2
        }
        friendRequestRefreshTask = pending
        defer {
            if friendRequestRefreshID == request {
                friendRequestRefreshTask = nil
                if friendRequestRefreshQueued { friendRequestRefreshQueued = false; refreshFriendRequestBadges() }
            }
        }
        do { try await pending.value }
        catch {
            guard authenticationRevision == authentication, self.token == token, user?.id == actor,
                  client.endpointIdentity == APIClient.shared.endpointIdentity else { throw CancellationError() }
            throw error
        }
    }

    func handleFriendRequest(_ request: ContactRequest, action: String) async throws {
        guard isSignedIn, let token, let actor = user?.id, request.id > 0,
              ["accept", "reject"].contains(action) else { throw CancellationError() }
        guard !handlingFriendRequestIDs.contains(request.id) else { return }
        let client = APIClient.shared.captureSession(), authentication = authenticationRevision
        func current() -> Bool {
            self.authenticationRevision == authentication && self.token == token && self.user?.id == actor
                && client.endpointIdentity == APIClient.shared.endpointIdentity
        }
        handlingFriendRequestIDs.insert(request.id)
        defer { if authenticationRevision == authentication { handlingFriendRequestIDs.remove(request.id) } }
        do { try await client.handleContactRequest(id: request.id, action: action) }
        catch { guard current() else { throw CancellationError() }; throw error }
        guard current() else { throw CancellationError() }
        let wasPending = friendRequestInbox.pending.contains { $0.id == request.id }
        friendRequestInbox.resolve(request.id)
        if wasPending { friendRequestBadgeState.resolve(); pendingFriendRequestCount = friendRequestBadgeState.count }
        refreshFriendRequestBadges()
        if action == "accept" {
            // The successful action stays successful if a secondary list refresh fails.
            if let rows = try? await client.contacts(), current() { contacts = rows }
            guard current() else { return }
            try? await refreshConversations()
        }
    }

    // Accepted friendships update the conversation list without automatic navigation.
    func refreshFriendChats(offered: FriendChatEvent? = nil) {
        guard appActive, isSignedIn, !updateRequired, let token, let actor = user?.id else { return }
        if friendChatTask != nil { friendChatQueued = true; return }
        let client = APIClient.shared.captureSession(), operation = UUID()
        let key = "pulse_friend_chat_v1:\(client.serverIdentity):\(actor)"
        let cursor = UserDefaults.standard.integer(forKey: key)
        friendChatOperation = operation
        friendChatTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.friendChatOperation == operation {
                    self.friendChatTask = nil
                    if self.friendChatQueued { self.friendChatQueued = false; self.refreshFriendChats() }
                }
            }
            do {
                let rows: [FriendChatEvent]
                if let offered, offered.valid { rows = [offered] }
                else { rows = try await client.friendChats(afterID: cursor) }
                guard let event = rows.filter({ $0.valid && $0.id > cursor }).max(by: { $0.id < $1.id }) else { return }
                guard !Task.isCancelled, self.friendChatOperation == operation, self.appActive, self.token == token, self.user?.id == actor,
                      client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
                // Friend acceptance updates the inbox without navigating away
                // from the current chat, profile, picker or recording.
                try await self.refreshConversations()
                guard !Task.isCancelled, self.friendChatOperation == operation, self.appActive, self.token == token, self.user?.id == actor,
                      client.endpointIdentity == APIClient.shared.endpointIdentity, !self.updateRequired,
                      let consumed = IOSFriendChatListSync.consumedEventID(event,
                        afterID: UserDefaults.standard.integer(forKey: key), conversations: self.conversations) else { return }
                UserDefaults.standard.set(consumed, forKey: key)
            } catch { /* An unread device cursor is retried on the next live hint/timer. */ }
        }
    }

    /// Retain confirmed tombstones across chat navigation while disk work runs.
    func confirmedMessageRecalls(conversationID: Int) -> [Message] {
        guard !contactNamesScope.isEmpty, messageRecallsOwner == contactNamesScope else { return [] }
        return messageRecalls.values.filter { $0.conversationId == conversationID }
    }
    func confirmMessageRecall(_ message: Message, client: APIClient, actorID: Int?) {
        guard isSignedIn, token == client.token, user?.id == actorID,
              client.endpointIdentity == APIClient.shared.endpointIdentity,
              message.id > 0, message.conversationId > 0,
              message.recalledAt != nil || message.status == "recalled" else { return }
        let scope = contactNamesScope
        if messageRecallsOwner != scope { messageRecalls = [:]; messageRecallsOwner = scope }
        let tombstone = MessageReconciliation.tombstone(message)
        if messageRecalls[message.id] != tombstone { messageRecalls[message.id] = tombstone; messageRecallRevision += 1 }
        Task {
            guard contactNamesScope == scope else { return }
            try? await IOSLocalChatStore.shared.mergeEvent(client.avatarCacheNamespace, message: tombstone)
            guard contactNamesScope == scope else { return }
            await IOSLocalMediaCache.shared.clear()
        }
        conversationDidChange()
    }

    /// Also called for local send/read/recall results so the list need not wait
    /// for its own socket or a manual pull-to-refresh.
    func conversationDidChange() {
        guard appActive, isSignedIn else { return }
        conversationRefreshQueued = true
        guard inboxRefreshTask == nil else { return }
        let revision = inboxRevision
        inboxRefreshTask = Task { [weak self] in
            let sinceRefresh = ProcessInfo.processInfo.systemUptime - (self?.lastConversationRefreshAt ?? 0)
            do { try await Task.sleep(for: .seconds(max(0.12, 0.75 - sinceRefresh))) } catch { return }
            guard let self, !Task.isCancelled, self.inboxRevision == revision else { return }
            self.inboxRefreshTask = nil
            try? await self.refreshConversations()
        }
    }

    func conversationWasHidden(_ id: Int) {
        conversations.removeAll { $0.id == id }
        conversationDidChange()
    }

    /// All screens share one serialized refresh. A hint received while HTTP is
    /// in flight requests another pass; an older account/route can never commit.
    func refreshConversations() async throws {
        guard isSignedIn, let token else { return }
        if let pending = conversationRefreshTask {
            conversationRefreshQueued = true
            try await pending.value
            return
        }
        let client = APIClient.shared.captureSession()
        let authentication = authenticationRevision
        let request = UUID(); conversationRefreshID = request
        let pending = Task { [weak self] in
            guard let self else { return }
            var passes = 0
            repeat {
                self.conversationRefreshQueued = false
                let items = try await client.conversations()
                guard !Task.isCancelled, self.authenticationRevision == authentication, self.token == token,
                      self.conversationRefreshID == request, client.endpointIdentity == APIClient.shared.endpointIdentity else { throw CancellationError() }
                self.conversations = items
                self.conversationRefreshFailed = false
                passes += 1
            } while self.conversationRefreshQueued && passes < 2
        }
        conversationRefreshTask = pending
        defer {
            if conversationRefreshID == request {
                conversationRefreshTask = nil
                lastConversationRefreshAt = ProcessInfo.processInfo.systemUptime
                if conversationRefreshQueued { conversationDidChange() }
            }
        }
        do { try await pending.value }
        catch {
            if conversationRefreshID == request { conversationRefreshFailed = true }
            throw error
        }
    }

    func dismissAnnouncement() {
        guard let announcement = activeAnnouncement else { return }
        UserDefaults.standard.set("\(announcement.id)-\(announcement.revision)", forKey: "pulse_last_announcement")
        activeAnnouncement = nil
    }

    func loadClientConfig() async {
        let request = UUID(); clientConfigRevision = request
        let client = APIClient.shared.captureAnonymousSession()
        do {
            let config = try await client.clientConfig()
            guard !Task.isCancelled, clientConfigRevision == request, client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
            clientConfigError = ""
            chatNotice = config.chatNotice ?? ""
            groupMemberLimit = max(1, config.groupMemberLimit)
            showGroupMemberCount = config.showGroupMemberCount
            let mall = config.mallLinks.enumerated().map { ClientExternalLink(id: 10000 + $0.offset, name: $0.element.name, url: $0.element.url) }
            exploreLinks = config.exploreLinks + mall.filter { link in !config.exploreLinks.contains(where: { $0.url == link.url }) }
            latestVersion = config.latestVersion
            forceUpdate = config.forceUpdate
            updateURL = URL(string: config.iosDownloadURL).flatMap { $0.scheme == "https" && $0.host != nil ? $0 : nil }
            updateDescription = config.updateDescription
            guard let announcement = config.announcement, announcement.enabled, !announcement.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                activeAnnouncement = nil
                return
            }
            let token = "\(announcement.id)-\(announcement.revision)"
            if UserDefaults.standard.string(forKey: "pulse_last_announcement") != token { activeAnnouncement = announcement }
        } catch {
            guard !Task.isCancelled, clientConfigRevision == request, client.endpointIdentity == APIClient.shared.endpointIdentity else { return }
            // Keep the previous links, but make a failed refresh visible in Explore.
            clientConfigError = "暂时无法更新探索入口，请点击刷新重试"
        }
    }

    func openPendingNotification() async {
        guard isSignedIn, !updateRequired, let data = UserDefaults.standard.dictionary(forKey: "pulse_pending_notification"),
              let owner = data["user_id"] as? Int, let id = data["conversation_id"] as? Int,
              owner == user?.id, id > 0 else { return }
        let sessionToken = token; let client = APIClient.shared.captureSession()
        let endpoint = client.endpointIdentity
        do {
            try await client.openConversation(id: id)
            let conversation = try await client.conversationInfo(id: id)
            guard token == sessionToken, isSignedIn, endpoint == APIClient.shared.endpointIdentity else { return }
            notificationConversation = conversation
            UserDefaults.standard.removeObject(forKey: "pulse_pending_notification")
        } catch { if token == sessionToken, endpoint == APIClient.shared.endpointIdentity { self.error = error.localizedDescription } }
    }
    static func newer(_ remote: String, than local: String) -> Bool {
        func parts(_ value: String) -> [Int] { value.replacingOccurrences(of: "v", with: "").split(whereSeparator: { $0 == "." || $0 == "-" }).map { Int($0) ?? 0 } }
        let a = parts(remote); let b = parts(local)
        for i in 0..<max(a.count, b.count) { let left = i < a.count ? a[i] : 0; let right = i < b.count ? b[i] : 0; if left != right { return left > right } }
        return false
    }
    private func registerPushDeviceIfAvailable(client: APIClient? = nil) async { await registerPushDeviceIfAvailable(token: UserDefaults.standard.string(forKey: "pulse_apns_device_token") ?? "", client: client) }
    private func registerPushDeviceIfAvailable(token pushToken: String, client: APIClient? = nil) async {
        let captured = client ?? APIClient.shared.captureSession()
        guard !pushToken.isEmpty, !Task.isCancelled, captured.token == token, isSignedIn,
              captured.endpointIdentity == APIClient.shared.endpointIdentity else { return }
        let predecessor = pushSessionTask, operation = UUID()
        pushSessionID = operation
        let pending = Task { [weak self] in
            // Let the previous request finish before rebinding this physical push
            // token. A delayed A registration/logout cannot overwrite B or A again.
            await predecessor?.value
            guard let self, self.isSignedIn, self.token == captured.token,
                  captured.endpointIdentity == APIClient.shared.endpointIdentity else { return }
            try? await captured.registerNotificationDevice(token: pushToken)
        }
        pushSessionTask = pending
        await pending.value
        if pushSessionID == operation { pushSessionTask = nil }
    }
}

private struct KeychainAccountPersistence: AccountSessionPersistence {
    private let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.pulseim.session", kSecAttrAccount as String: "account-sessions-v1"]
    func read() throws -> Data? {
        var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw AccountSessionError.unavailable }
        return data
    }
    func write(_ data: Data) throws {
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var record = query; attributes.forEach { record[$0.key] = $0.value }
            guard SecItemAdd(record as CFDictionary, nil) == errSecSuccess else { throw AccountSessionError.unavailable }
        } else if status != errSecSuccess { throw AccountSessionError.unavailable }
    }
}

private enum SessionTokenStore {
    private static let repository = AccountSessionRepository(persistence: KeychainAccountPersistence())
    private static let legacyQuery: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.pulseim.session", kSecAttrAccount as String: "access-token"]
    static func load() -> String? {
        do {
            if let archive = try repository.read() { return archive.active(server: APIClient.shared.serverIdentity)?.token }
            var request = legacyQuery; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            if status == errSecSuccess, let data = result as? Data { return String(data: data, encoding: .utf8) }
            guard status == errSecItemNotFound else { return nil }
            if let legacy = UserDefaults.standard.string(forKey: "pulse_token") {
                var record = legacyQuery; record[kSecValueData as String] = Data(legacy.utf8)
                record[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                guard SecItemAdd(record as CFDictionary, nil) == errSecSuccess else { return nil }
                UserDefaults.standard.removeObject(forKey: "pulse_token")
                return legacy
            }
            return nil
        } catch { return nil }
    }
    static func accounts() -> [SavedAccount] { (try? repository.read()?.accounts(server: APIClient.shared.serverIdentity)) ?? [] }
    static func makeCredential(_ token: String, profile: User, server: String) -> SavedAccountCredential {
        SavedAccountCredential(account: SavedAccount(server: server, userID: profile.id, account: profile.username ?? profile.phone ?? "", nickname: profile.nickname), token: token)
    }
    static func activate(_ token: String, profile: User, server: String, preserving current: SavedAccountCredential?) throws -> [SavedAccount] {
        let archive = try repository.activate(makeCredential(token, profile: profile, server: server), preserving: current)
        // Never remove the old credential until the complete new archive is durable.
        SecItemDelete(legacyQuery as CFDictionary); UserDefaults.standard.removeObject(forKey: "pulse_token")
        return archive.accounts(server: server)
    }
    static func credential(id: String, server: String) throws -> SavedAccountCredential {
        guard let credential = try repository.read()?.credential(id: id, server: server) else { throw AccountSessionError.missingAccount }
        return credential
    }
    static func remove(id: String, expectedToken: String) throws -> [SavedAccount] {
        try repository.remove(id: id, expectedToken: expectedToken).accounts(server: APIClient.shared.serverIdentity)
    }
    static func clear(expectedToken: String?) throws {
        if let expectedToken { try repository.clearActive(expectedToken: expectedToken) }
        SecItemDelete(legacyQuery as CFDictionary); UserDefaults.standard.removeObject(forKey: "pulse_token")
    }
}
