import Foundation
import UIKit
import Security
import CryptoKit

/// A phone-local identity, independent of accounts and login/media caches.
/// ThisDeviceOnly prevents a restored backup from cloning the binding to a new phone.
private enum MobileDeviceIdentity {
    private static let lock = NSLock()
    private static var cached: String?
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.pulseim.mobile-device.v1", kSecAttrAccount as String: "phone",
        kSecAttrSynchronizable as String: false]

    static func id() throws -> String {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        func read() throws -> String? {
            var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &item)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let data = item as? Data, let digest = String(data: data, encoding: .utf8),
                  digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                throw APIClientError.server("无法读取设备标识，请解锁手机后重试")
            }
            return "ios_" + digest
        }
        if let stored = try read() { cached = stored; return stored }
        let digest = SHA256.hash(data: Data(("pulse-mobile-device-v1:" + UUID().uuidString).utf8)).map { String(format: "%02x", $0) }.joined()
        var item = query; item[kSecValueData as String] = Data(digest.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem, let stored = try read() else {
            throw APIClientError.server("无法保存设备标识，请解锁手机后重试")
        }
        cached = stored; return stored
    }
}

enum APIClientError: LocalizedError {
    case invalidResponse
    case server(String)
    case sessionExpired(String)
    var errorDescription: String? {
        switch self { case .invalidResponse: return "服务器返回的数据无法识别"; case .server(let message), .sessionExpired(let message): return message }
    }
    var expiredSessionMessage: String? {
        switch self {
        case .sessionExpired(let message): return message
        case .server(let message) where ["请先登录。", "登录状态已过期，请重新登录。", "用户账号不可用。"].contains(message): return message
        default: return nil
        }
    }
}

final class APIClient {
    static let shared = APIClient()
    private var baseURL: URL
    private var endpointRevision = UUID()
    private var goContext = GoV2Context()
    var isGoV2: Bool { GoV2Transport.validBase(baseURL) }
    var token: String? { didSet { if token != oldValue { goContext = GoV2Context() } } }
    var webSocketToken: String { token ?? "" }
    var webSocketURL: URL {
        if isGoV2 { var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!; parts.scheme = baseURL.scheme == "https" ? "wss" : "ws"; parts.path += "/realtime"; return parts.url! }
        guard let value = Bundle.main.object(forInfoDictionaryKey: "PulseWebSocketURL") as? String, let url = URL(string: value), Self.allowedEndpoint(url, websocket: true) else { preconditionFailure("Configure a valid WSS endpoint for Release") }
        return VerifiedRoutes.shared.owns(baseURL) ? VerifiedRoutes.shared.current.webSocketURL : url
    }
    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }
    static func allowedEndpoint(_ url: URL, websocket: Bool = false) -> Bool {
        #if DEBUG
        let schemes = websocket ? ["ws", "wss"] : ["http", "https"]
        #else
        let schemes = websocket ? ["wss"] : ["https"]
        guard let host = url.host?.lowercased(), host.contains("."), !host.contains(":"), !host.allSatisfy({ $0.isNumber || $0 == "." }),
              !["localhost", "local", "lan", "internal", "test", "invalid", "example", "example.com", "example.org", "example.net"].contains(where: { host == $0 || host.hasSuffix("." + $0) }),
              host.split(separator: ".").allSatisfy({ String($0).range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil }) else { return false }
        #endif
        return url.host != nil && url.user == nil && url.password == nil && url.query == nil && url.fragment == nil && schemes.contains(url.scheme ?? "")
    }
    private init(baseURL: URL, token: String?, endpointRevision: UUID, context: GoV2Context) { self.baseURL = baseURL; self.token = token; self.endpointRevision = endpointRevision; self.goContext = context }
    /// A route revision also rejects a challenge when the user switches away and back.
    var endpointIdentity: String { baseURL.absoluteString + "#" + endpointRevision.uuidString }
    /// Persistent per-server preferences must survive route revisions and relogin.
    var serverIdentity: String { baseURL.absoluteString }
    /// Stable across launches; only its SHA-256 digest is used for disk filenames.
    var avatarCacheNamespace: String { baseURL.absoluteString + "|" + webSocketToken }
    func captureSession() -> APIClient { APIClient(baseURL: baseURL, token: token, endpointRevision: endpointRevision, context: goContext) }
    func captureAnonymousSession() -> APIClient { APIClient(baseURL: baseURL, token: nil, endpointRevision: endpointRevision, context: GoV2Context()) }
    func conversationInfo(id: Int) async throws -> Conversation { try await send(path: "/conversations/info?conversation_id=\(id)") }
    func logout() async throws { let _: SessionActionResult = try await send(path: "/auth/logout", method: "POST", body: [:]) }
    private func notifyUpgrade(_ response: HTTPURLResponse) {
        guard endpointIdentity == Self.shared.endpointIdentity else { return }
        if response.statusCode == 426 { NotificationCenter.default.post(name: .pulseSessionBlocked, object: "client.update_required") }
    }
    private func clientHeaders(_ request: inout URLRequest) {
        request.setValue("ios", forHTTPHeaderField: "X-Client-Platform")
        request.setValue(Self.appVersion, forHTTPHeaderField: "X-Client-Version")
    }

    private init() {
        // Route choices now come only from the verified policy; account identity remains the packaged business origin.
        var configured = (Bundle.main.object(forInfoDictionaryKey: "PulseAPIBaseURL") as? String) ?? "http://127.0.0.1:18080/api/v2"
        #if DEBUG
        if let saved = UserDefaults.standard.string(forKey: "pulse.go-v2.debug-endpoint"), let candidate = URL(string: saved), GoV2Transport.validBase(candidate), Self.allowedEndpoint(candidate) { configured = saved }
        #endif
        let fallback = (Bundle.main.object(forInfoDictionaryKey: "PulseAPIBaseURL") as? String) ?? ""
        guard let url = URL(string: configured), Self.allowedEndpoint(url), GoV2Transport.validBase(url) else {
            guard let safe = URL(string: fallback), Self.allowedEndpoint(safe), GoV2Transport.validBase(safe) else { preconditionFailure("Configure production HTTPS/WSS endpoints before Release") }
            baseURL = safe; return
        }
        baseURL = url
    }

    var baseURLDescription: String { baseURL.host.map { "\($0)\(baseURL.port.map { ":\($0)" } ?? "")" } ?? baseURL.absoluteString }
    @discardableResult func switchBaseURL(_ value: String) -> Bool {
        // Kept for source compatibility. The route picker validates/probes asynchronously.
        let normalized = value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if isGoV2 {
            #if DEBUG
            guard token == nil, let candidate = URL(string: normalized), GoV2Transport.validBase(candidate), Self.allowedEndpoint(candidate) else { return false }
            baseURL = candidate; endpointRevision = UUID(); goContext = GoV2Context()
            UserDefaults.standard.set(normalized, forKey: "pulse.go-v2.debug-endpoint")
            return true
            #else
            return false
            #endif
        }
        return VerifiedRoutes.shared.owns(baseURL) && VerifiedRoutes.shared.current.apiURL.absoluteString == normalized
    }

    func mediaURL(_ value: String) -> URL? {
        guard let url = AvatarURLIdentity.resolve(value, baseURL: baseURL) else { return nil }; return VerifiedRoutes.shared.owns(baseURL) ? VerifiedRoutes.shared.mediaURL(url) : url
    }

    func login(phone: String, password: String, twoStepCode: String = "") async throws -> LoginData { try await send(path: "/auth/login", method: "POST", body: ["phone": phone, "password": password, "device_type": "ios", "two_step_code": twoStepCode, "device_id": try MobileDeviceIdentity.id(), "device_name": UIDevice.current.model]) }
    func registerChallenge() async throws -> RegistrationChallenge {
        try await send(path: "/auth/register-challenge?format=digits4", includeAuthorization: false, timeout: 12, noStore: true)
    }
    func register(username: String, password: String, nickname: String, captchaID: String, captchaCode: String, avatarData: Data) async throws -> LoginData {
        guard !captchaID.isEmpty, !captchaCode.isEmpty else { throw APIClientError.server("请先填写图形验证码") }
        return try await send(path: "/auth/register", method: "POST", body: ["username": username, "password": password, "nickname": nickname, "device_type": "ios", "captcha_id": captchaID, "captcha_code": captchaCode, "registration_form": "single_page_v1", "avatar_data_url": "data:image/jpeg;base64," + avatarData.base64EncodedString(), "device_id": try MobileDeviceIdentity.id(), "device_name": UIDevice.current.model], includeAuthorization: false, timeout: 20, noStore: true)
    }
    func me() async throws -> User { try await send(path: "/auth/me", timeout: 12, noStore: true) }
    func registerNotificationDevice(token: String) async throws { let _: NotificationDeviceResult = try await send(path: "/notifications/devices/register", method: "POST", body: ["platform": "ios", "device_token": token]) }
    func unregisterNotificationDevice(token: String, sessionToken: String? = nil) async throws { let _: NotificationDeviceResult = try await send(path: "/notifications/devices/unregister", method: "POST", body: ["device_token": token], bearerToken: sessionToken) }
    func notificationDevices() async throws -> [NotificationDevice] { let response: NotificationDevicePage = try await send(path: "/notifications/devices"); return response.items }
    func uploadDiagnostics() async throws -> DiagnosticsData {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let body: [String: Any] = [
            "platform": "ios",
            "app_name": PulseApp.name,
            "app_version": version,
            "model": UIDevice.current.model,
            "sdk": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
            "events": [["event": "diagnostics.upload", "status": "success", "at": Int(Date().timeIntervalSince1970)]]
        ]
        return try await send(path: "/client/diagnostics", method: "POST", body: body)
    }
    func updateProfile(userID: Int, nickname: String, avatarURL: String, username: String? = nil, birthday: String? = nil, gender: String? = nil, signature: String? = nil) async throws -> User {
        var body: [String: Any] = ["nickname": nickname, "avatar_url": avatarURL]
        if let username { body["username"] = username }
        if let birthday { body["birthday"] = birthday }
        if let gender { body["gender"] = gender }
        if let signature { body["signature"] = signature }
        let receipt: ProfileUpdateReceipt = try await send(path: "/auth/profile", method: "POST", body: body, timeout: 20, noStore: true)
        guard receipt.id == userID else { throw APIClientError.invalidResponse }
        try Task.checkCancellation()
        // Read authoritative permissions and persisted fields. The save receipt
        // does not contain the mandatory permission flags on older servers.
        let profile = try await me()
        guard ProfileSaveValidation.matches(profile, userID: userID, nickname: nickname, avatarURL: avatarURL,
                                          username: username, birthday: birthday, gender: gender, signature: signature,
                                          resolve: mediaURL) else {
            throw APIClientError.server("资料保存后核对未通过，请重试；当前选择的头像已保留")
        }
        return profile
    }
    func userSettings() async throws -> UserSettings { try await send(path: "/auth/settings") }
    func updateUserSettings(_ patch: [String: Any]) async throws -> UserSettings { try await send(path: "/auth/settings", method: "POST", body: patch) }
    func changePassword(current: String, newPassword: String) async throws { let _: PasswordResult = try await send(path: "/auth/password", method: "POST", body: ["current_password": current, "new_password": newPassword]) }
    func sessions() async throws -> [SessionInfo] { let response: SessionPage = try await send(path: "/auth/sessions"); return response.items }
    func revokeSession(id: Int) async throws { let _: SessionActionResult = try await send(path: "/auth/sessions/revoke", method: "POST", body: ["session_id": id]) }
    func blockedUsers() async throws -> [BlockedUser] { let response: BlockPage = try await send(path: "/blocks?page=1&size=50"); return response.items }
    func blockCandidates(keyword: String = "") async throws -> [BlockCandidate] {
        if isGoV2 {
            return try await contacts().filter { keyword.isEmpty || $0.nickname.localizedCaseInsensitiveContains(keyword) || ($0.username ?? "").localizedCaseInsensitiveContains(keyword) }.map {
                BlockCandidate(userId: $0.userId, nickname: $0.nickname, username: $0.username, avatarURL: $0.avatarURL, publicID: nil)
            }
        }
        var path = "/blocks/candidates?kind=contacts&page=1&size=50"
        let value = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { path += "&q=\(value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value)" }
        let response: BlockCandidatePage = try await send(path: path)
        return response.items
    }
    func blockUser(userID: Int, reason: String = "") async throws { let _: BlockActionResult = try await send(path: "/blocks", method: "POST", body: ["user_id": userID, "reason": reason]) }
    func unblock(userID: Int) async throws { let _: BlockActionResult = try await send(path: "/blocks/unblock", method: "POST", body: ["user_id": userID]) }
    func clientConfig() async throws -> ClientConfig { try await send(path: "/client/config", includeAuthorization: false, timeout: 12, noStore: true) }
    func workTasks() async throws -> WorkTaskPage { try await send(path: "/work-tasks", timeout: 12, noStore: true) }
    func startWorkTask(taskID: Int, verificationCode: String) async throws -> WorkTaskPayload { try await send(path: "/work-tasks/start", method: "POST", body: ["task_id": taskID, "verification_code": verificationCode], timeout: 20, noStore: true) }
    func workTaskRecord(id: Int) async throws -> WorkTaskPayload {
        let result: WorkTaskPayload = try await send(path: "/work-tasks/record?id=\(id)", timeout: 20, noStore: true)
        guard result.record.id == id, result.record.status == "in_progress" || result.hasCompleteSettlement else { throw APIClientError.server("未能取得完整结算结果，请重试") }
        return result
    }
    func saveWorkTaskAnswers(recordID: Int, answers: [String: Bool]) async throws -> WorkTaskPayload { try await send(path: "/work-tasks/answers", method: "POST", body: ["record_id": recordID, "answers": answers]) }
    func submitWorkTask(recordID: Int, answers: [String: Bool]) async throws -> WorkTaskPayload {
        let result: WorkTaskPayload = try await send(path: "/work-tasks/submit", method: "POST", body: ["record_id": recordID, "answers": answers], timeout: 30, noStore: true)
        guard result.record.id == recordID, result.hasCompleteSettlement else { throw APIClientError.server("未能取得完整结算结果，请重试提交") }
        return result
    }
    func workImageURL(_ raw: String) -> URL? {
        guard !raw.isEmpty, let url = URL(string: raw, relativeTo: baseURL)?.absoluteURL else { return nil }
        if url.host == "127.0.0.1" || url.host == "localhost", var parts = URLComponents(url: url, resolvingAgainstBaseURL: true) {
            parts.scheme = baseURL.scheme; parts.host = baseURL.host; parts.port = baseURL.port
            return parts.url
        }
        return url
    }
    func clientRoutes() async throws -> [ClientRoute] { let page: ClientRoutePage = try await send(path: "/client/routes", bearerToken: nil); return page.items }
    func conversations(type: String? = nil) async throws -> [Conversation] {
        let suffix = type.flatMap { $0.isEmpty ? nil : "&type=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
        var page = 1, items: [Conversation] = [], seen = Set<Int>()
        while true {
            let response: ConversationPage = try await send(path: "/conversations?page=\(page)&size=50\(suffix)", timeout: 12, noStore: true)
            guard response.page == nil || response.page == page else { throw APIClientError.invalidResponse }
            let additions = response.items.filter { seen.insert($0.id).inserted }
            items.append(contentsOf: additions)
            guard let total = response.total, items.count < total else { return items }
            guard !additions.isEmpty else { throw APIClientError.invalidResponse }
            page += 1
        }
    }
    func forwardingConversations(page: Int) async throws -> IOSForwardConversationPage {
        try await send(path: "/conversations?page=\(max(1, page))&size=50", timeout: 12, noStore: true)
    }
    func createDirectConversation(userID: Int) async throws -> Conversation { try await send(path: "/conversations/direct", method: "POST", body: ["user_id": userID], timeout: 12, noStore: true) }
    func favoriteConversation() async throws -> Conversation { try await send(path: "/conversations/favorites", method: "POST") }
    func updateConversationNotification(conversationID: Int, muted: Bool) async throws -> Conversation {
        try await send(path: "/conversations/settings", method: "POST", body: ["conversation_id": conversationID, "notifications_muted": muted])
    }
    func createGroup(name: String, memberIDs: [Int] = [], allowMemberAddFriend: Bool = true, avatarURL: String? = nil) async throws -> Conversation {
        var body: [String: Any] = ["name": name, "member_ids": memberIDs, "allow_member_add_friend": allowMemberAddFriend]
        if let avatarURL, !avatarURL.isEmpty { body["avatar_url"] = avatarURL }
        return try await send(path: "/conversations/groups", method: "POST", body: body)
    }
    func joinGroup(inviteCode: String) async throws { let _: GroupJoinResult = try await send(path: "/conversations/groups/join", method: "POST", body: ["invite_code": inviteCode]) }
    func joinGroup(conversationID: Int) async throws { let _: GroupJoinResult = try await send(path: "/conversations/groups/join", method: "POST", body: ["conversation_id": conversationID]) }
    func createChannel(name: String, avatarURL: String? = nil, description: String = "") async throws -> Conversation {
        var body: [String: Any] = ["name": name, "description": description]
        if let avatarURL, !avatarURL.isEmpty { body["avatar_url"] = avatarURL }
        return try await send(path: "/conversations/channels", method: "POST", body: body)
    }
    func createCustomerService(name: String) async throws -> Conversation { try await send(path: "/conversations/customer-service", method: "POST", body: ["name": name]) }
    func conversationMembers(id: Int) async throws -> [GroupMember] { let response: ConversationMemberPage = try await send(path: "/conversations/members?conversation_id=\(id)"); return response.items }
    func groupMentionMembers(id: Int, query: String, page: Int = 1) async throws -> GroupMentionPage {
        var components = URLComponents(); components.path = "/conversations/groups/mention-members"
        components.queryItems = [URLQueryItem(name: "conversation_id", value: String(id)), URLQueryItem(name: "q", value: query), URLQueryItem(name: "page", value: String(page))]
        guard let path = components.string else { throw URLError(.badURL) }
        return try await send(path: path)
    }
    func groupProfile(id: Int) async throws -> GroupProfile { try await send(path: "/conversations/groups/profile?conversation_id=\(id)") }
    func updateGroupProfile(conversationID: Int, name: String, avatarURL: String? = nil, description: String = "", announcement: String = "", allowMemberAddFriend: Bool? = nil) async throws -> GroupProfile { var body: [String: Any] = ["conversation_id": conversationID, "name": name, "description": description, "announcement": announcement]; if let avatarURL { body["avatar_url"] = avatarURL }; if let allowMemberAddFriend { body["allow_member_add_friend"] = allowMemberAddFriend }; return try await send(path: "/conversations/groups/profile", method: "POST", body: body) }
    func addConversationMember(conversationID: Int, userID: Int, allowHistory: Bool = false) async throws {
        var body: [String: Any] = ["conversation_id": conversationID, "user_id": userID]
        if isGoV2 { body["allow_history"] = allowHistory }
        let _: GroupActionResult = try await send(path: "/conversations/members", method: "POST", body: body)
    }
    func removeConversationMember(conversationID: Int, userID: Int) async throws { let _: GroupActionResult = try await send(path: "/conversations/members/remove", method: "POST", body: ["conversation_id": conversationID, "user_id": userID]) }
    func setConversationRole(conversationID: Int, userID: Int, role: String) async throws { let _: GroupActionResult = try await send(path: "/conversations/members/role", method: "POST", body: ["conversation_id": conversationID, "user_id": userID, "role": role]) }
    func muteConversationMember(conversationID: Int, userID: Int, minutes: Int) async throws { let _: GroupActionResult = try await send(path: "/conversations/members/mute", method: "POST", body: ["conversation_id": conversationID, "user_id": userID, "minutes": minutes]) }
    func transferGroup(conversationID: Int, userID: Int) async throws { let _: GroupStatusResult = try await send(path: "/conversations/groups/transfer", method: "POST", body: ["conversation_id": conversationID, "user_id": userID]) }
    func dissolveGroup(conversationID: Int) async throws { let _: GroupStatusResult = try await send(path: "/conversations/groups/dissolve", method: "POST", body: ["conversation_id": conversationID]) }
    func updateGroupSettings(conversationID: Int, notificationsMuted: Bool? = nil, isPinned: Bool? = nil) async throws -> GroupProfile { var body: [String: Any] = ["conversation_id": conversationID]; if let notificationsMuted { body["notifications_muted"] = notificationsMuted }; if let isPinned { body["is_pinned"] = isPinned }; return try await send(path: "/conversations/groups/settings", method: "POST", body: body) }
    func leaveConversation(id: Int) async throws { let _: LeaveConversationResult = try await send(path: "/conversations/leave", method: "POST", body: ["conversation_id": id]) }
    func hideConversation(id: Int) async throws {
        let result: ConversationVisibilityResult = try await send(path: "/conversations/hide", method: "POST", body: ["conversation_id": id])
        guard result.conversationId == id, result.status == "hidden" else { throw APIClientError.invalidResponse }
    }
    func clearConversationHistory(id: Int) async throws -> ConversationHistoryClearResult {
        let result: ConversationHistoryClearResult = try await send(path: "/messages/clear-history", method: "POST", body: ["conversation_id": id], timeout: 20, noStore: true)
        guard result.conversationId == id else { throw APIClientError.invalidResponse }
        return result
    }
    func openConversation(id: Int) async throws { let _: ConversationVisibilityResult = try await send(path: "/conversations/open", method: "POST", body: ["conversation_id": id]) }
    func markConversationRead(_ conversation: Conversation) async throws {
        let messages = try await history(conversationID: conversation.id)
        guard let throughID = messages.map(\.id).max() else { return }
        do { try await markConversationRead(conversationID: conversation.id, throughID: throughID) }
        catch {
            if Task.isCancelled || error is CancellationError { throw error }
            if let failure = error as? APIClientError, case .sessionExpired = failure { throw error }
            if isGoV2 { throw error }
            // Older servers retain the original per-message receipt contract.
            for message in messages {
                try Task.checkCancellation()
                do { try await markMessageRead(id: message.id) }
                catch { if let failure = error as? APIClientError, case .sessionExpired = failure { throw error } }
            }
        }
    }
    func contacts() async throws -> [Contact] {
        var items: [Contact] = []; var page = 1; var expectedTotal: Int?
        repeat {
            let result: ContactCardContactPage = try await send(path: "/contacts?page=\(page)&size=100", noStore: true)
            guard result.isValid(expectedPage: page), page <= 10000, expectedTotal == nil || expectedTotal == result.total else { throw APIClientError.invalidResponse }
            expectedTotal = result.total; items += result.items
            if !result.hasMore { break }; page += 1
        } while true
        guard items.count == expectedTotal, Set(items.map(\.userId)).count == items.count else { throw APIClientError.invalidResponse }
        return items
    }
    func contactNames() async throws -> [ContactNameRecord] {
        var items: [ContactNameRecord] = []; var page = 1; var expectedTotal: Int?
        repeat {
            let result: ContactNamePage = try await send(path: "/contacts/names?page=\(page)&size=100", timeout: 12, noStore: true)
            guard result.isValid(expectedPage: page), page <= 10000, expectedTotal == nil || expectedTotal == result.total else { throw APIClientError.invalidResponse }
            expectedTotal = result.total; items += result.items
            if !result.hasMore { break }; page += 1
        } while true
        guard items.count == expectedTotal, Set(items.map(\.userId)).count == items.count else { throw APIClientError.invalidResponse }
        return items
    }
    func contactCardContacts(page: Int) async throws -> ContactCardContactPage { try await send(path: "/contacts?page=\(max(1, page))&size=50") }
    private func contactContextQuery(_ groupContextConversationID: Int?) throws -> String {
        guard let groupContextConversationID else { return "" }
        guard groupContextConversationID > 0 else { throw APIClientError.server("来源群参数无效") }
        return "&context_conversation_id=\(groupContextConversationID)"
    }
    func contactProfile(userID: Int, groupContextConversationID: Int? = nil) async throws -> ContactProfile {
        guard userID > 0 else { throw APIClientError.server("联系人资料参数无效") }
        let context = try contactContextQuery(groupContextConversationID)
        let response: ContactProfile = try await send(path: "/contacts/profile?user_id=\(userID)\(context)", timeout: 12, noStore: true)
        guard response.userId == userID else { throw APIClientError.invalidResponse }
        return response
    }
    func commonContactGroups(userID: Int, page: Int = 1, size: Int = 20, groupContextConversationID: Int? = nil) async throws -> ContactCommonGroupsPage {
        guard userID > 0, page > 0, size > 0 else { throw APIClientError.server("共同群组参数无效") }
        let context = try contactContextQuery(groupContextConversationID)
        let response: ContactCommonGroupsPage = try await send(path: "/contacts/common-groups?user_id=\(userID)&page=\(page)&size=\(min(size, 50))\(context)", timeout: 12, noStore: true)
        guard response.page == page, response.size == min(size, 50) else { throw APIClientError.invalidResponse }
        return response
    }
    func removeContact(userID: Int) async throws { let _: ContactActionResult = try await send(path: "/contacts/remove", method: "POST", body: ["user_id": userID]) }
    func updateContactRemark(userID: Int, remark: String? = nil, groupName: String? = nil) async throws {
        guard userID > 0, remark != nil || groupName != nil else { throw APIClientError.server("没有需要保存的备注或分组") }
        var body: [String: Any] = ["user_id": userID]
        if let remark { body["remark"] = remark }; if let groupName { body["group_name"] = groupName }
        let _: ContactRemarkResult = try await send(path: "/contacts/remark", method: "POST", body: body, timeout: 12, noStore: true)
    }
    func searchUsers(keyword: String) async throws -> [SearchUser] {
        let username = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !username.isEmpty else { return [] }
        var components = URLComponents(); components.path = "/contacts/search"
        components.queryItems = [URLQueryItem(name: "q", value: username)]
        guard let path = components.string else { throw APIClientError.invalidResponse }
        let response: SearchUserPage = try await send(path: path)
        let matches = response.items.filter { $0.username?.caseInsensitiveCompare(username) == .orderedSame }
        return matches.count == 1 ? matches : []
    }
    func resolvePublicUserID(_ publicID: String) async throws -> Int {
        let response: PublicUserSearchPage = try await send(path: PublicUserIdentity.searchPath(publicID), timeout: 12, noStore: true)
        return try response.resolve(publicID: publicID).id
    }
    func receivedContactCardProfile(_ target: IOSReceivedContactCardTarget) async throws -> IOSReceivedContactCardProfile {
        let profile: IOSReceivedContactCardProfile = try await send(path: "/contacts/card-profile?user_id=\(target.userID)&conversation_id=\(target.conversationID)&message_id=\(target.messageID)", timeout: 12, noStore: true)
        guard profile.user.id == target.userID, profile.conversationID == target.conversationID, profile.messageID == target.messageID else { throw APIClientError.invalidResponse }
        return profile
    }
    func sendFriendRequest(userID: Int, groupContextConversationID: Int? = nil, contactCard: IOSReceivedContactCardTarget? = nil) async throws {
        var body: [String: Any] = ["to_user_id": userID, "message": "你好"]
        if let groupContextConversationID {
            guard groupContextConversationID > 0 else { throw APIClientError.server("来源群参数无效") }
            body["context_conversation_id"] = groupContextConversationID
        }
        if let contactCard {
            guard contactCard.userID == userID else { throw APIClientError.invalidResponse }
            body["card_conversation_id"] = contactCard.conversationID
            body["card_message_id"] = contactCard.messageID
        }
        let result: FriendRequestResult = try await send(path: "/contact-requests", method: "POST", body: body)
        publishFriendChat(result)
    }
    func forceAddContact(userID: Int) async throws {
        guard userID > 0 else { throw APIClientError.invalidResponse }
        let result: ForcedContactResult = try await send(path: "/contacts/force-add", method: "POST", body: ["user_id": userID])
        guard result.status == "accepted", result.forced, result.userID == userID else { throw APIClientError.invalidResponse }
    }
    func internalProfile(userID: Int, groupContextConversationID: Int? = nil) async throws -> InternalProfileData {
        guard userID > 0 else { throw APIClientError.server("联系人资料参数无效") }
        let context = try contactContextQuery(groupContextConversationID)
        return try await send(path: "/contacts/internal-profile?user_id=\(userID)\(context)", timeout: 12, noStore: true)
    }
    func receivedRequests() async throws -> [ContactRequest] {
        try await IOSFriendRequestPages.load { page, size in
            try await self.send(path: "/contact-requests?direction=received&status=pending&page=\(page)&size=\(size)", timeout: 12, noStore: true)
        }
    }
    func friendRequestSummary() async throws -> Int {
        if isGoV2 { return try await receivedRequests().filter { $0.status == "pending" }.count }
        let summary: IOSFriendRequestSummary = try await send(path: "/contact-requests/summary", timeout: 8, noStore: true)
        guard summary.pendingCount >= 0 else { throw APIClientError.invalidResponse }
        return summary.pendingCount
    }
    func handleContactRequest(id: Int, action: String) async throws {
        let result: FriendRequestResult = try await send(path: "/contact-requests/handle", method: "POST", body: ["request_id": id, "action": action])
        publishFriendChat(result)
    }
    func friendChats(afterID: Int) async throws -> [FriendChatEvent] {
        let response: FriendChatPage = try await send(path: "/notifications/friend-chats?after_id=\(max(0, afterID))", timeout: 12, noStore: true)
        return response.items
    }
    private func publishFriendChat(_ result: FriendRequestResult) {
        guard result.status == "accepted" else { return }
        NotificationCenter.default.post(name: .pulseFriendshipReady, object: result.friendChat,
            userInfo: ["session_token": token ?? "", "endpoint_identity": endpointIdentity])
    }
    func uploadMedia(data: Data, kind: String, filename: String, mime: String) async throws -> UploadData {
        if isGoV2 { throw GoV2Error.unsupported }
        guard !data.isEmpty, !filename.contains("\r"), !filename.contains("\n"), !filename.contains("\"") else { throw APIClientError.server("上传文件无效") }
        let boundary = "Pulse-\(UUID().uuidString)"
        var request = URLRequest(url: baseURL.appendingPathComponent("uploads"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: kind == "video" ? 180 : 60)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n\(kind)\r\n".utf8))
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        clientHeaders(&request)
        let (responseData, response) = try await routedUpload(request, body: body)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        notifyUpgrade(http)
        let result = try? JSONDecoder().decode(APIEnvelope<UploadData>.self, from: responseData)
        if http.statusCode == 401 { throw APIClientError.sessionExpired(result?.error?.message ?? "登录状态已过期，请重新登录。") }
        if http.statusCode == 413 { throw APIClientError.server(result?.error?.message ?? "文件超过服务器上传限制，请选择较小的文件后重试") }
        guard (200..<300).contains(http.statusCode), result?.ok == true, let upload = result?.data,
              mediaURL(upload.url) != nil else { throw APIClientError.server(result?.error?.message ?? "文件上传失败，请检查网络后重试") }
        return upload
    }

    func uploadAvatar(_ data: Data) async throws -> String {
        guard !data.isEmpty, data.count <= 1024 * 1024 else { throw APIClientError.server("头像处理失败，请重新选择图片") }
        let upload = try await uploadMedia(data: data, kind: "image", filename: "profile-\(UUID().uuidString).jpg", mime: "image/jpeg")
        guard upload.mime == nil || upload.mime == "image/jpeg", upload.size == nil || upload.size == data.count else { throw APIClientError.invalidResponse }
        return upload.url
    }

    func downloadAvatar(_ url: URL, retryRoute: Bool = true) async throws -> Data {
        let manager = VerifiedRoutes.shared
        let resolved = manager.mediaURL(url), failed = manager.current.apiURL
        let trusted = manager.owns(baseURL) && manager.authorizesMedia(resolved)
        var request = URLRequest(url: resolved, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        if trusted, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization"); clientHeaders(&request) }
        let result: (Data, HTTPURLResponse)
        do { result = try await RouteHTTP.data(for: request, maximum: 10 * 1024 * 1024, traffic: .media) }
        catch {
            if trusted, retryRoute, !Task.isCancelled, await manager.failover(failed: failed) { return try await downloadAvatar(url, retryRoute: false) }
            throw error
        }
        if trusted, retryRoute, [502, 503, 504].contains(result.1.statusCode), await manager.failover(failed: failed) { return try await downloadAvatar(url, retryRoute: false) }
        guard (200..<300).contains(result.1.statusCode) else { throw AvatarDownloadFailure.httpStatus(result.1.statusCode) }
        guard !result.0.isEmpty else { throw APIClientError.invalidResponse }
        return result.0
    }
    func sendMedia(conversationID: Int, type: String, upload: UploadData) async throws -> Message { try await send(path: "/messages", method: "POST", body: ["conversation_id": conversationID, "type": type, "body": ["url": upload.url, "mime": upload.mime, "size": upload.size], "request_id": "ios-media-\(UUID().uuidString)"]) }
    func historyPage(conversationID: Int, maximumID: Int = 0) async throws -> IOSChatHistoryPage {
        guard conversationID > 0, maximumID >= 0 else { throw APIClientError.invalidResponse }
        let upper = maximumID > 0 ? "&max_id=\(maximumID)" : ""
        let response: IOSChatHistoryPage = try await send(path: "/messages/history?conversation_id=\(conversationID)&page=1&size=50\(upper)", timeout: 12, noStore: true)
        return try response.validated(conversationID: conversationID, maximumID: maximumID)
    }
    func history(conversationID: Int) async throws -> [Message] { try await historyPage(conversationID: conversationID).chronological }
    func sharedMedia(conversationID: Int, page: Int = 1, size: Int = 30, type: String = "all") async throws -> SharedMediaPage {
        guard conversationID > 0, page > 0, size > 0, ["all", "image", "video", "file"].contains(type) else { throw APIClientError.server("共享媒体参数无效") }
        let response: SharedMediaPage = try await send(path: "/messages/shared?conversation_id=\(conversationID)&page=\(page)&size=\(min(size, 50))&type=\(type)", timeout: 12, noStore: true)
        guard response.conversationId == conversationID, response.page == page, response.size == min(size, 50) else { throw APIClientError.invalidResponse }
        return response
    }
    func messagePins(conversationID: Int) async throws -> MessagePinsSnapshot { try await send(path: "/messages/pins?conversation_id=\(conversationID)", timeout: 12, noStore: true) }
    func setMessagePin(conversationID: Int, messageID: Int, pinned: Bool) async throws -> MessagePinsSnapshot {
        try await send(path: pinned ? "/messages/pin" : "/messages/unpin", method: "POST", body: ["conversation_id": conversationID, "message_id": messageID], timeout: 12, noStore: true)
    }
    func locateMessage(conversationID: Int, messageID: Int) async throws -> MessageLocationPage { try await send(path: "/messages/locate?conversation_id=\(conversationID)&message_id=\(messageID)", timeout: 12, noStore: true) }
    func syncMessages(conversationID: Int, afterID: Int, floorID: Int, snapshotMaxID: Int?, membershipVersion: Int? = nil) async throws -> MessageSyncPage {
        let upper = (snapshotMaxID.map { "&snapshot_max_id=\($0)" } ?? "") + (membershipVersion.map { "&membership_version=\($0)" } ?? "")
        return try await send(path: "/messages/sync?conversation_id=\(conversationID)&after_id=\(afterID)&floor_id=\(floorID)&limit=100\(upper)", timeout: 12, noStore: true)
    }
    func downloadMedia(_ raw: String, fileName: String, maximumBytes: Int64 = 100 * 1024 * 1024, retryRoute: Bool = true) async throws -> URL {
        let captured = captureSession()
        let resolved = captured.mediaURL(raw)
        let sourcePath = resolved.flatMap { url in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value } ?? resolved?.path ?? ""
        let extensionName = (sourcePath as NSString).pathExtension.lowercased()
        let supported = ["mp4", "mov", "webm", "m4v", "mkv", "avi", "3gp", "mpeg", "mpg", "ogv", "wmv", "mp3", "m4a", "aac", "amr", "wav", "ogg", "opus", "flac", "caf"].contains(extensionName)
        if !supported { return try await captured.downloadMediaNetwork(raw, fileName: fileName, maximumBytes: maximumBytes, retryRoute: retryRoute) }
        do {
            return try await IOSLocalMediaCache.shared.file(client: captured, raw: raw, name: fileName, maximumBytes: maximumBytes) {
                try await captured.downloadMediaNetwork(raw, fileName: fileName, maximumBytes: maximumBytes, retryRoute: retryRoute)
            }
        } catch is CocoaError {
            return try await captured.downloadMediaNetwork(raw, fileName: fileName, maximumBytes: maximumBytes, retryRoute: retryRoute)
        } catch is POSIXError {
            return try await captured.downloadMediaNetwork(raw, fileName: fileName, maximumBytes: maximumBytes, retryRoute: retryRoute)
        }
    }
    private func downloadMediaNetwork(_ raw: String, fileName: String, maximumBytes: Int64, retryRoute: Bool) async throws -> URL {
        guard let url = mediaURL(raw), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { throw APIClientError.server("附件地址无效") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        let manager = VerifiedRoutes.shared, failed = VerifiedRoutes.shared.current.apiURL
        let trusted = manager.owns(baseURL) && manager.authorizesMedia(url)
        if trusted, let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            clientHeaders(&request)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        let guardDelegate = MediaDownloadRedirectGuard(maximumBytes: maximumBytes)
        let downloader = URLSession(configuration: configuration, delegate: guardDelegate, delegateQueue: nil)
        defer { downloader.finishTasksAndInvalidate() }
        let result: (URL, URLResponse)
        do { result = try await downloader.download(for: request) }
        catch {
            if guardDelegate.exceededLimit { throw APIClientError.server("附件超过\(maximumBytes / (1024 * 1024))MB，请在电脑端查看") }
            if trusted, retryRoute, !Task.isCancelled, await manager.failover(failed: failed) { return try await downloadMediaNetwork(raw, fileName: fileName, maximumBytes: maximumBytes, retryRoute: false) }
            throw error
        }
        let (temporary, response) = result
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        if trusted, retryRoute, [502, 503, 504].contains(http.statusCode), await manager.failover(failed: failed) { return try await downloadMediaNetwork(raw, fileName: fileName, maximumBytes: maximumBytes, retryRoute: false) }
        if [401, 403].contains(http.statusCode) { throw IOSChatMediaFailure.authorizationExpired }
        if [404, 410].contains(http.statusCode) { throw IOSChatMediaFailure.unavailable }
        guard (200..<300).contains(http.statusCode) else { throw IOSChatMediaFailure.httpStatus(http.statusCode) }
        try Task.checkCancellation()
        let attributes = try FileManager.default.attributesOfItem(atPath: temporary.path)
        guard ((attributes[.size] as? NSNumber)?.int64Value ?? 0) <= maximumBytes else { throw APIClientError.server("附件超过\(maximumBytes / (1024 * 1024))MB，请在电脑端查看") }
        let normalized = fileName.replacingOccurrences(of: "\\", with: "_")
        let name = (normalized as NSString).lastPathComponent.components(separatedBy: .controlCharacters).joined().prefix(180)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pulse-media-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let target = directory.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "附件" : String(name))
        do { try FileManager.default.moveItem(at: temporary, to: target); return target }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    static func removeDownloadedMedia(at url: URL) {
        let parent = url.deletingLastPathComponent()
        guard parent.lastPathComponent.hasPrefix("pulse-media-"), parent.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: parent)
    }
    func searchMessages(conversationID: Int, keyword: String, date: String? = nil) async throws -> [MessageSearchResult] {
        var path = "/messages/search?conversation_id=\(conversationID)&q=\(keyword.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? keyword)"
        if let date, !date.isEmpty { path += "&date=\(date.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? date)" }
        let response: MessageSearchPage = try await send(path: path)
        return response.items
    }
    func sendText(conversationID: Int, text: String) async throws -> Message { try await send(path: "/messages", method: "POST", body: ["conversation_id": conversationID, "type": "text", "body": ["text": text], "request_id": "ios-\(UUID().uuidString)"]) }
    func sendRawMessage(conversationID: Int, type: String, body: [String: Any], requestID: String = "ios-\(UUID().uuidString)") async throws -> Message {
        try await send(path: "/messages", method: "POST", body: ["conversation_id": conversationID, "type": type, "body": body, "request_id": requestID], timeout: 20, noStore: true)
    }
    func sendContactCard(conversationID: Int, userID: Int) async throws -> Message { try await sendRawMessage(conversationID: conversationID, type: "contact_card", body: ["user_id": userID]) }
    func sendShake(conversationID: Int) async throws -> Message { try await sendRawMessage(conversationID: conversationID, type: "shake", body: ["text": "窗口抖动"]) }
    func recallMessage(_ message: Message) async throws {
        let id = message.id
        let receipt: IOSMessageRecallReceipt = try await send(path: "/messages/recall", method: "POST", body: messageMutation(message), noStore: true)
        guard receipt.confirms(id) else { throw APIClientError.invalidResponse }
    }
    func deleteMessages(conversationID: Int, messages: [Message]) async throws -> PersonalMessageDeletion {
        guard !messages.isEmpty, messages.allSatisfy({ $0.conversationId == conversationID }) else { throw APIClientError.invalidResponse }
        var body: [String: Any] = ["conversation_id": conversationID, "message_ids": messages.map(\.id)]
        if isGoV2 { body["wire_message_ids"] = try messages.map { message -> String in guard let wire = message.goWireID else { throw APIClientError.invalidResponse }; return wire } }
        return try await send(path: "/messages/delete", method: "POST", body: body, timeout: 20, noStore: true)
    }
    private func messageMutation(_ message: Message) throws -> [String: Any] {
        var body: [String: Any] = ["message_id": message.id]
        if isGoV2 {
            guard let wire = message.goWireID, let version = message.goVersion else { throw APIClientError.invalidResponse }
            body["conversation_id"] = message.conversationId; body["wire_message_id"] = wire; body["expected_version"] = String(version)
        }; return body
    }
    func editMessage(_ message: Message, text: String) async throws -> Message {
        var body = try messageMutation(message); body["text"] = text
        return try await send(path: "/messages/edit", method: "POST", body: body)
    }
    func markMessageRead(id: Int) async throws { if isGoV2 { throw GoV2Error.invalidResponse }; let _: ReceiptResult = try await send(path: "/messages/receipt", method: "POST", body: ["message_id": id, "status": "read"], timeout: 12, noStore: true) }
    func markConversationRead(conversationID: Int, throughID: Int) async throws {
        let receipt: ConversationReadReceipt = try await send(path: "/messages/receipt", method: "POST", body: ["conversation_id": conversationID, "through_message_id": throughID, "status": "read"], timeout: 12, noStore: true)
        guard receipt.conversationID == conversationID, receipt.throughID == throughID, receipt.status == "read" else { throw APIClientError.invalidResponse }
    }
    func sendVoice(conversationID: Int, url: String, durationMs: Int, size: Int) async throws -> Message { try await send(path: "/messages", method: "POST", body: ["conversation_id": conversationID, "type": "voice", "body": ["url": url, "duration_ms": durationMs, "size": size], "request_id": "ios-voice-\(UUID().uuidString)"]) }
    func uploadVoice(data: Data) async throws -> String {
        if isGoV2 { throw GoV2Error.unsupported }
        guard !data.isEmpty, data.count <= 10 * 1024 * 1024 else { throw APIClientError.server("录音为空或超过10MB限制") }
        guard let format = IOSVoiceFileFormat.uploadType(data) else { throw APIClientError.server("录音格式无效，请重新录制") }
        let boundary = "Pulse-\(UUID().uuidString)"
        var request = URLRequest(url: baseURL.appendingPathComponent("uploads"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nvoice\r\n".utf8))
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(format.filename)\"\r\nContent-Type: \(format.mime)\r\n\r\n".utf8))
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        clientHeaders(&request)
        let (responseData, response) = try await routedUpload(request, body: body)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        notifyUpgrade(http)
        let envelope = try? JSONDecoder().decode(APIEnvelope<UploadData>.self, from: responseData)
        if http.statusCode == 401 { throw APIClientError.sessionExpired(envelope?.error?.message ?? "登录状态已过期，请重新登录。") }
        if http.statusCode == 413 { throw APIClientError.server("服务器拒绝了录音大小，请管理员检查上传限制") }
        guard (200..<300).contains(http.statusCode), envelope?.ok == true else {
            throw APIClientError.server(envelope?.error?.message ?? "语音上传失败（HTTP \(http.statusCode)），请重试")
        }
        guard let raw = envelope?.data?.url, let source = URL(string: raw, relativeTo: baseURL)?.absoluteURL,
              let url = mediaURL(source.absoluteString), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { throw APIClientError.server("服务器返回的语音地址无效") }
        return url.absoluteString
    }

    private func routedUpload(_ original: URLRequest, body: Data) async throws -> (Data, HTTPURLResponse) {
        var request = original; request.httpBody = body
        return try await routedData(request, replay: false)
    }

    private func routedData(_ original: URLRequest, replay: Bool) async throws -> (Data, HTTPURLResponse) {
        let manager = VerifiedRoutes.shared
        let traffic = RouteHTTP.traffic(for: original)
        guard manager.owns(baseURL), let originalURL = original.url, originalURL.absoluteString.hasPrefix(baseURL.absoluteString) else { return try await RouteHTTP.data(for: original, traffic: traffic) }
        let suffix = String(originalURL.absoluteString.dropFirst(baseURL.absoluteString.count))
        let failed = manager.current.apiURL
        func perform(_ endpoint: URL) async throws -> (Data, HTTPURLResponse) {
            var request = original
            guard let url = URL(string: endpoint.absoluteString + suffix) else { throw APIClientError.invalidResponse }
            request.url = url; request.httpShouldHandleCookies = false
            let result = try await RouteHTTP.data(for: request, traffic: traffic)
            if [502, 503, 504].contains(result.1.statusCode) { throw URLError(.badServerResponse) }
            return result
        }
        do { return try await perform(failed) }
        catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw error }
            guard error is URLError else { throw error }
            let changed = await manager.failover(failed: failed)
            if changed && replay { return try await perform(manager.current.apiURL) }
            if changed { throw RouteFailure.invalid("已切换备用线路，请确认操作结果后重试") }
            throw error
        }
    }

    func goPrivacyAccount(_ account: String) async throws -> GoPrivacyUser {
        guard isGoV2, let encoded = account.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) else { throw GoV2Error.invalidResponse }
        let data = try await GoV2Transport(baseURL: baseURL, token: token).request("/users/by-account/" + encoded)
        return try JSONDecoder().decode(GoPrivacyUser.self, from: JSONSerialization.data(withJSONObject: data))
    }
    func requireGoMembership(_ cid: Int, version: Int) throws { if isGoV2 { try goContext.requireVersion(cid, version) } }
    func goPrivacy() async throws -> GoContactPrivacy { try await send(path: "/go/privacy") }
    func updateGoPrivacy(_ body: [String: Any]) async throws -> GoContactPrivacy { try await send(path: "/go/privacy", method: "PATCH", body: body) }
    func rotateGoInviteCode(conversationID: Int) async throws -> GoInviteCode { try await send(path: "/go/invite-code", method: "POST", body: ["conversation_id": conversationID]) }
    func goWebSocketURL() async throws -> URL { try await GoV2Transport(baseURL: baseURL, token: token).socketURL() }
    func goConversationID(_ wire: String) throws -> Int { try GoV2IDs.shared(serverIdentity).local("conversation", wire) }

    private func send<T: Decodable>(path: String, method: String = "GET", body: Any? = nil, bearerToken: String? = nil, includeAuthorization: Bool = true, timeout: TimeInterval = 60, noStore: Bool = false) async throws -> T {
        if isGoV2 {
            do {
                let adapter = try GoV2Adapter(baseURL: baseURL, token: includeAuthorization ? bearerToken ?? token : nil, context: goContext)
                let data = try await adapter.request(path: path, method: method, body: body as? [String: Any] ?? [:])
                return try JSONDecoder().decode(T.self, from: data)
            } catch GoV2Error.http(401, _) {
                if includeAuthorization, (bearerToken ?? token) != nil { throw APIClientError.sessionExpired("登录状态已过期，请重新登录。") }
                throw APIClientError.server("账号或密码错误")
            } catch GoV2Error.http(403, _) where path.hasPrefix("/messages/history") || path.hasPrefix("/messages/sync") { throw IOSLocalChatAccessDenied() }
        }
        guard let url = URL(string: baseURL.absoluteString + path) else { throw APIClientError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: noStore ? .reloadIgnoringLocalCacheData : .useProtocolCachePolicy, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if includeAuthorization, let authToken = bearerToken ?? token { request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization") }
        if !includeAuthorization { request.httpShouldHandleCookies = false }
        if noStore {
            request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
            request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        clientHeaders(&request)
        let replay = method == "GET" || method == "HEAD" || (method == "POST" && path == "/messages" && !((body as? [String: Any])?["request_id"] as? String ?? "").isEmpty)
        let (data, response) = try await routedData(request, replay: replay)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        notifyUpgrade(http)
        if http.statusCode == 401, includeAuthorization, (bearerToken ?? token) != nil {
            let rejected = try? JSONDecoder().decode(APIEnvelope<T>.self, from: data)
            throw APIClientError.sessionExpired(rejected?.error?.message ?? "登录状态已过期，请重新登录。")
        }
        if http.statusCode == 403, path.hasPrefix("/messages/history") || path.hasPrefix("/messages/sync") { throw IOSLocalChatAccessDenied() }
        let envelope = try JSONDecoder().decode(APIEnvelope<T>.self, from: data)
        if !envelope.ok || !(200..<300).contains(http.statusCode) { throw APIClientError.server(envelope.error?.message ?? "请求失败") }
        guard let value = envelope.data else { throw APIClientError.invalidResponse }
        return value
    }
}

struct RegistrationChallenge: Decodable {
    let challengeID: String
    let imageDataURL: String
    let expiresIn: Int
    let codeLength: Int
    enum CodingKeys: String, CodingKey {
        case challengeID = "challenge_id", imageDataURL = "image_data_url", expiresIn = "expires_in", codeLength = "code_length"
    }
}

private struct ConversationPage: Decodable { let items: [Conversation]; let total: Int?; let page: Int? }
private struct MessagePage: Decodable { let items: [Message] }
private struct MessageSearchPage: Decodable { let items: [MessageSearchResult] }
private struct ContactPage: Decodable { let items: [Contact] }
private struct ContactActionResult: Decodable { let userId: Int; let status: String; enum CodingKeys: String, CodingKey { case userId = "user_id"; case status } }
private struct ContactRemarkResult: Decodable { let userId: Int; let remark: String?; let groupName: String?; enum CodingKeys: String, CodingKey { case userId = "user_id"; case remark; case groupName = "group_name" } }
private struct SearchUserPage: Decodable { let items: [SearchUser] }
private struct FriendChatPage: Decodable { let items: [FriendChatEvent] }
private struct FriendRequestResult: Decodable {
    let status: String
    let friendChat: FriendChatEvent?
    enum CodingKeys: String, CodingKey { case status; case friendChat = "friend_chat" }
}
extension Notification.Name { static let pulseFriendshipReady = Notification.Name("pulse.friendshipReady") }
private struct ForcedContactResult: Decodable {
    let status: String
    let forced: Bool
    let userID: Int
    enum CodingKeys: String, CodingKey { case status, forced; case userID = "user_id" }
}
private struct ConversationMemberPage: Decodable { let conversationId: Int; let items: [GroupMember]; enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case items } }
private struct LeaveConversationResult: Decodable { let conversationId: Int; let userId: Int; let status: String; enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case userId = "user_id"; case status } }
private struct ConversationVisibilityResult: Decodable { let conversationId: Int; let status: String; enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case status } }
private struct GroupActionResult: Decodable { let conversationId: Int; let userId: Int; let status: String?; let role: String?; enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case userId = "user_id"; case status, role } }
private struct GroupStatusResult: Decodable { let status: String }
private struct GroupJoinResult: Decodable { let conversationId: Int; let userId: Int; let status: String; enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case userId = "user_id"; case status } }
private struct ReceiptResult: Decodable { let messageId: Int; let userId: Int; let status: String; enum CodingKeys: String, CodingKey { case messageId = "message_id"; case userId = "user_id"; case status } }
private struct ConversationReadReceipt: Decodable {
    let conversationID: Int; let throughID: Int; let status: String
    enum CodingKeys: String, CodingKey { case conversationID = "conversation_id", throughID = "through_message_id", status }
}
private struct PasswordResult: Decodable { let status: String }
private struct SessionPage: Decodable { let items: [SessionInfo] }
private struct SessionActionResult: Decodable { let sessionId: Int?; let status: String; enum CodingKeys: String, CodingKey { case sessionId = "session_id"; case status } }
private struct BlockPage: Decodable { let items: [BlockedUser] }
private struct BlockCandidatePage: Decodable { let items: [BlockCandidate] }
private struct BlockActionResult: Decodable { let blockedId: Int; let status: String; enum CodingKeys: String, CodingKey { case blockedId = "blocked_id"; case status } }
struct NotificationDevice: Decodable, Identifiable { let id: Int; let platform: String; let createdAt: String; let lastUsedAt: String?; enum CodingKeys: String, CodingKey { case id, platform; case createdAt = "created_at"; case lastUsedAt = "last_used_at" } }
private struct NotificationDevicePage: Decodable { let items: [NotificationDevice] }
private struct NotificationDeviceResult: Decodable { let status: String }
struct DiagnosticsData: Decodable { let reportId: String; let status: String; enum CodingKeys: String, CodingKey { case reportId = "report_id"; case status } }
struct UploadData: Decodable, Sendable { let url: String; let mime: String?; let size: Int? }

private final class MediaDownloadRedirectGuard: NSObject, URLSessionDownloadDelegate {
    private let lock = NSLock()
    private var oversized = false
    private let maximumBytes: Int64
    init(maximumBytes: Int64 = 100 * 1024 * 1024) { self.maximumBytes = maximumBytes; super.init() }
    var exceededLimit: Bool { lock.lock(); defer { lock.unlock() }; return oversized }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > maximumBytes || totalBytesExpectedToWrite > maximumBytes {
            lock.lock(); oversized = true; lock.unlock(); downloadTask.cancel()
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) { }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
