import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Runs the actual iOS Foundation adapter against an isolated Go instance. The
/// supplied file contains only disposable fixture accounts; never use production.
@main struct GoV2Integration {
    struct Config: Decodable { let base: String; let prefix: String; let password: String; let taskCode: String? }
    struct Account { let adapter: GoV2Adapter; let login: LoginData }
    struct Page<T: Decodable>: Decodable { let items: [T] }
    enum Failure: Error { case assertion(String) }
    static func check(_ value: Bool, _ text: String) throws { if !value { throw Failure.assertion(text) } }
    static func decoded<T: Decodable>(_ type: T.Type, _ api: GoV2Adapter, _ path: String, _ method: String = "GET", _ body: [String: Any] = [:]) async throws -> T {
        do { return try JSONDecoder().decode(type, from: await api.request(path: path, method: method, body: body)) }
        catch { print("Request failed: " + method + " " + path.components(separatedBy: "?")[0]); throw error }
    }
    static func raw(_ api: GoV2Adapter, _ path: String, _ method: String = "GET", _ body: [String: Any] = [:]) async throws -> [String: Any] {
        do { return try JSONSerialization.jsonObject(with: await api.request(path: path, method: method, body: body)) as! [String: Any] }
        catch { print("Request failed: " + method + " " + path.components(separatedBy: "?")[0]); throw error }
    }
    static func reject(_ status: Int, _ action: () async throws -> Void) async throws {
        do { try await action() } catch GoV2Error.http(let value, _) where value == status { return }
        throw Failure.assertion("expected HTTP \(status)")
    }
    static func send(_ api: GoV2Adapter, _ cid: Int, _ text: String, request: String = "ios-probe-" + UUID().uuidString) async throws -> Message {
        try await decoded(Message.self, api, "/messages", "POST", ["conversation_id": cid, "type": "text", "body": ["text": text], "request_id": request])
    }
    static func history(_ api: GoV2Adapter, _ cid: Int) async throws -> IOSChatHistoryPage {
        try await decoded(IOSChatHistoryPage.self, api, "/messages/history?conversation_id=\(cid)&size=50")
    }
    static func main() async {
        do { try await run() }
        catch {
            if let failure = error as? GoV2Error { print("FAIL: " + (failure.errorDescription ?? "API failure")) }
            else if case Failure.assertion(let message) = error { print("FAIL: " + message) }
            else { let failure = error as NSError; print("FAIL: \(failure.domain) code \(failure.code)") }
            exit(1)
        }
    }
    static func run() async throws {
        let config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let base = URL(string: config.base)!
        guard base.host == "127.0.0.1", base.scheme == "http", config.prefix.hasPrefix("clientios") else { throw Failure.assertion("isolated local fixtures required") }
        var passed: [String] = [] { didSet { print("PASS: " + passed.last!) } }
        func login(_ suffix: String, device: String = "ios-probe") async throws -> Account {
            let anonymous = try GoV2Adapter(baseURL: base, token: nil, context: GoV2Context())
            let value = try await decoded(LoginData.self, anonymous, "/auth/login", "POST", ["phone": config.prefix + suffix, "password": config.password, "device_id": device, "two_step_code": ""])
            return Account(adapter: try GoV2Adapter(baseURL: base, token: value.accessToken, context: GoV2Context()), login: value)
        }
        let a = try await login("a"), b = try await login("b"), c = try await login("c"), d = try await login("d")
        let me = try await decoded(User.self, a.adapter, "/auth/me")
        try check(me.id == a.login.userId && me.internalStaff && !me.formalEmployee, "user privileges are independent")
        let cfg = try await raw(a.adapter, "/client/config")
        try check(cfg["registration_enabled"] as? Bool == true && cfg["push_enabled"] as? Bool == false, "fixture capability flags")
        passed.append("login and typed profile/config contracts")

        let imageURL = URL(string: "https://images.example.invalid/api/v2/media-grants/" + String(repeating: "a", count: 64) + "/content")!
        try check(GoV2MediaURLs.preview(imageURL).path.hasSuffix("/preview"), "Go image bubbles use previews")
        let unrelatedURL = URL(string: "https://images.example.invalid/original.jpg")!
        try check(GoV2MediaURLs.preview(unrelatedURL) == unrelatedURL, "unrelated image URLs are preserved")
        passed.append("Go preview paths preserve original links and reject unrelated URLs")

        let suite = "pulse-ios-probe-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let wire = UUID().uuidString.lowercased()
        let first = try GoV2IDs(server: config.base, defaults: defaults).local("user", wire)
        let reopened = try GoV2IDs(server: config.base, defaults: defaults)
        try check(try reopened.wire("user", first) == wire, "UUID mapping survives reload")
        let other = try GoV2IDs(server: config.base + "-other", defaults: defaults)
        do { _ = try other.wire("user", first); throw Failure.assertion("server map leaked") } catch GoV2Error.invalidResponse { }
        let membership = GoV2Context()
        _ = try membership.membership(1, version: 3)
        do { _ = try membership.membership(1, version: 2); throw Failure.assertion("local membership version regressed") }
        catch GoV2Error.membershipChanged { }
        try check(membership.version(1) == 3, "failed old response preserves current membership")
        try membership.requireVersion(1, 3)
        do { try membership.requireVersion(1, 2); throw Failure.assertion("old page rendered after newer membership response") }
        catch GoV2Error.membershipChanged { }
        passed.append("persistent UUID mapping and server isolation")

        let found = try await decoded(Page<SearchUser>.self, a.adapter, "/contacts/search?q=" + config.prefix + "b")
        try check(found.items.first?.id == b.login.userId, "account search projection")
        let chat = try await decoded(Conversation.self, a.adapter, "/conversations/direct", "POST", ["user_id": b.login.userId])
        let otherChat = try await decoded(Conversation.self, a.adapter, "/conversations/direct", "POST", ["user_id": c.login.userId])
        let request = "ios-probe-" + UUID().uuidString
        let m = try await send(a.adapter, chat.id, "first", request: request)
        let duplicate = try await send(a.adapter, chat.id, "first", request: request)
        let m2 = try await send(a.adapter, otherChat.id, "independent")
        try check(m.id == duplicate.id && m.goWireID == duplicate.goWireID && m.id == m2.id && m.goWireID != m2.goWireID, "per-conversation seq and durable idempotency")
        try check(try await decoded(Page<Contact>.self, a.adapter, "/contacts?page=1&size=50").items.isEmpty, "temporary chat must not create friendship")
        let profile = try await decoded(ContactProfile.self, a.adapter, "/contacts/profile?user_id=\(b.login.userId)")
        try check(profile.userId == b.login.userId && profile.isContact == false, "authorized peer profile")
        passed.append("temporary chat, independent sequences, idempotency and peer profile")

        let editBody: [String: Any] = ["conversation_id": chat.id, "message_id": m.id, "wire_message_id": m.goWireID!, "expected_version": String(m.goVersion!), "text": "edited"]
        let edited = try await decoded(Message.self, a.adapter, "/messages/edit", "POST", editBody)
        try check(edited.goVersion == 2 && edited.editedAt != nil && edited.createdAt == m.createdAt, "edit time separate from monotonic version")
        try check(MessageReconciliation.preferred(current: edited, incoming: m) == edited, "late response cannot overwrite an edit")
        try await reject(409) { _ = try await raw(a.adapter, "/messages/edit", "POST", editBody) }
        let forward = try IOSMessageForwarding.body(edited)
        let forwarded = try await decoded(Message.self, a.adapter, "/messages", "POST", ["conversation_id": otherChat.id, "type": "text", "body": forward.mapValues { $0.anyValue }, "request_id": "ios-forward-" + UUID().uuidString])
        try check(forwarded.body["text"]?.stringValue == "edited", "forward validates source on server")
        _ = try await raw(a.adapter, "/messages/recall", "POST", ["conversation_id": chat.id, "message_id": m.id, "wire_message_id": m.goWireID!])
        try check(try await history(b.adapter, chat.id).items.isEmpty, "recalled source removed")
        try check(try await history(c.adapter, otherChat.id).items.contains(where: { $0.goWireID == m2.goWireID }), "same seq in another conversation survives recall")
        try await reject(403) { _ = try await raw(a.adapter, "/messages", "POST", ["conversation_id": otherChat.id, "type": "text", "body": forward.mapValues { $0.anyValue }, "request_id": "ios-forward-" + UUID().uuidString]) }
        passed.append("edit CAS/version ordering, source-authorized forwarding and scoped recall")

        let privacy = try await decoded(GoContactPrivacy.self, b.adapter, "/go/privacy")
        _ = try await raw(b.adapter, "/go/privacy", "PATCH", ["expected_version": privacy.version, "temporary_chat": ["visibility": "nobody", "allow": [], "deny": []]])
        try await reject(403) { _ = try await send(a.adapter, chat.id, "denied") }
        let aw = try a.adapter.ids.wire("user", a.login.userId)
        let rule: [String: Any] = ["visibility": "nobody", "allow": [aw], "deny": []]
        _ = try await raw(b.adapter, "/go/privacy", "PATCH", ["expected_version": try await decoded(GoContactPrivacy.self, b.adapter, "/go/privacy").version, "temporary_chat": rule])
        _ = try await send(a.adapter, chat.id, "allowed by exception")
        _ = try await raw(b.adapter, "/blocks", "POST", ["user_id": a.login.userId])
        try await reject(403) { _ = try await send(a.adapter, chat.id, "blocked") }
        try await reject(403) { _ = try await send(b.adapter, chat.id, "reverse blocked") }
        let blocked = try await raw(b.adapter, "/blocks")
        try check((blocked["items"] as? [[String: Any]])?.count == 1, "block list")
        _ = try await raw(b.adapter, "/blocks/unblock", "POST", ["user_id": a.login.userId])
        _ = try await send(a.adapter, chat.id, "unblocked")
        let bPolicy = try await decoded(GoContactPrivacy.self, b.adapter, "/go/privacy")
        try check(!bPolicy.canManageGroupInvites, "ordinary users cannot change protected invite policy")
        try await reject(403) { _ = try await raw(b.adapter, "/go/privacy", "PATCH", ["expected_version": bPolicy.version, "group_invites": rule]) }
        passed.append("temporary-chat privacy, exceptions, bidirectional block and protected invites")

        let group = try await decoded(Conversation.self, a.adapter, "/conversations/groups", "POST", ["name": "iOS isolated group", "member_ids": [], "allow_member_add_friend": true])
        _ = try await raw(a.adapter, "/conversations/groups/settings", "POST", ["conversation_id": group.id, "is_pinned": true])
        let pinned = try await decoded(GroupProfile.self, a.adapter, "/conversations/groups/profile?conversation_id=\(group.id)")
        try check(pinned.isPinned, "group settings persist pin without a notification setting")
        _ = try await raw(a.adapter, "/conversations/groups/settings", "POST", ["conversation_id": group.id, "is_pinned": false, "notifications_muted": true])
        let unpinned = try await decoded(GroupProfile.self, a.adapter, "/conversations/groups/profile?conversation_id=\(group.id)")
        try check(!unpinned.isPinned && unpinned.notificationsMuted, "group settings persist both preferences")
        passed.append("group pin and notification preferences through shipping adapter")
        let old = try await send(a.adapter, group.id, "before invitations")
        for (who, allow) in [(b, false), (c, true)] {
            _ = try await raw(a.adapter, "/conversations/members", "POST", ["conversation_id": group.id, "user_id": who.login.userId, "allow_history": allow])
        }
        try check(try await history(b.adapter, group.id).items.isEmpty, "unchecked invite excludes previous messages")
        try check(try await history(c.adapter, group.id).items.contains(where: { $0.id == old.id }), "checked invite grants history")
        let beforeRejoin = try await history(c.adapter, group.id)
        _ = try await raw(a.adapter, "/conversations/members", "POST", ["conversation_id": group.id, "user_id": c.login.userId, "allow_history": false])
        try check(try await history(c.adapter, group.id).membershipVersion == beforeRejoin.membershipVersion, "repeat invite keeps membership version")
        _ = try await raw(c.adapter, "/conversations/leave", "POST", ["conversation_id": group.id])
        _ = try await raw(a.adapter, "/conversations/members", "POST", ["conversation_id": group.id, "user_id": c.login.userId, "allow_history": false])
        let afterRejoin = try await history(c.adapter, group.id)
        try check(afterRejoin.items.isEmpty && afterRejoin.membershipVersion! > beforeRejoin.membershipVersion!, "rejoin narrows history and advances membership")
        do {
            _ = try await raw(c.adapter, "/messages/sync?conversation_id=\(group.id)&floor_id=0&after_id=0&snapshot_max_id=\(old.id)&membership_version=\(beforeRejoin.membershipVersion!)")
            throw Failure.assertion("stale snapshot membership accepted")
        } catch GoV2Error.membershipChanged { }
        passed.append("checked/unchecked/repeated invites and rejoin snapshot rejection")

        _ = try await raw(a.adapter, "/conversations/members/mute", "POST", ["conversation_id": group.id, "user_id": b.login.userId, "minutes": -1])
        try await reject(403) { _ = try await send(b.adapter, group.id, "muted") }
        _ = try await raw(a.adapter, "/conversations/members/mute", "POST", ["conversation_id": group.id, "user_id": b.login.userId, "minutes": 0])
        let visible = try await send(b.adapter, group.id, "after unmute")
        try await reject(403) { _ = try await raw(a.adapter, "/messages/edit", "POST", ["conversation_id": group.id, "message_id": visible.id, "wire_message_id": visible.goWireID!, "expected_version": String(visible.goVersion!), "text": "staff cannot rewrite another sender"]) }
        let ownCorrection = try await decoded(Message.self, b.adapter, "/messages/edit", "POST", ["conversation_id": group.id, "message_id": visible.id, "wire_message_id": visible.goWireID!, "expected_version": String(visible.goVersion!), "text": "own correction"])
        try check(ownCorrection.goVersion == 2 && ownCorrection.senderId == b.login.userId, "ordinary sender can edit own message")
        passed.append("own-message editing for ordinary users and denial for internal staff editing others")
        let details = try await decoded(GroupProfile.self, a.adapter, "/conversations/groups/profile?conversation_id=\(group.id)")
        try check(details.canManage && details.isOwner && details.memberCount == 3, "group details")
        let code = try await decoded(GoInviteCode.self, a.adapter, "/go/invite-code", "POST", ["conversation_id": group.id])
        _ = try await raw(d.adapter, "/conversations/groups/join", "POST", ["invite_code": code.inviteCode])
        try check(try await history(d.adapter, group.id).items.isEmpty, "code join cannot grant previous history")
        passed.append("permanent mute/unmute, group profile, invite rotation and code join")

        let deletion = try await decoded(PersonalMessageDeletion.self, b.adapter, "/messages/delete", "POST", ["conversation_id": group.id, "message_ids": [visible.id], "wire_message_ids": [visible.goWireID!]])
        try check(deletion.userId == b.login.userId && deletion.conversationId == group.id, "personal deletion receipt")
        try check(try await history(b.adapter, group.id).items.isEmpty, "personal deletion hides only the reader")
        try check(try await history(c.adapter, group.id).items.contains(where: { $0.id == visible.id }), "other member retains message")
        let clear = try await decoded(ConversationHistoryClearResult.self, c.adapter, "/messages/clear-history", "POST", ["conversation_id": group.id])
        try check(clear.clearedBeforeMessageId >= visible.id, "clear boundary")
        let next = try await send(a.adapter, group.id, "after clear")
        let tail = try await history(c.adapter, group.id)
        try check(tail.items.map(\.id) == [next.id], "clear preserves only subsequent messages")
        _ = try await raw(c.adapter, "/messages/receipt", "POST", ["conversation_id": group.id, "through_message_id": next.id])
        let page1 = try await decoded(MessageSyncPage.self, a.adapter, "/messages/sync?conversation_id=\(group.id)&floor_id=0&after_id=0&limit=1")
        try check(page1.hasMore, "bounded snapshot starts")
        let page2 = try await decoded(MessageSyncPage.self, a.adapter, "/messages/sync?conversation_id=\(group.id)&floor_id=0&after_id=\(page1.nextAfterId)&snapshot_max_id=\(page1.snapshotMaxId)&membership_version=\(page1.membershipVersion!)&limit=100")
        try check(!page2.hasMore && page2.snapshotMaxId == page1.snapshotMaxId, "bounded snapshot completes")
        passed.append("personal delete/clear, read receipt and versioned snapshot pagination")

        _ = try await raw(c.adapter, "/contact-requests", "POST", ["to_user_id": d.login.userId, "message": "hello"])
        let inbox = try await decoded(IOSFriendRequestPage.self, d.adapter, "/contact-requests?direction=received&page=1&size=50")
        try check(inbox.items.count == 1 && inbox.items[0].userId == c.login.userId, "friend request projection")
        _ = try await raw(d.adapter, "/contact-requests/handle", "POST", ["request_id": inbox.items[0].id, "action": "accept"])
        try check(try await decoded(Page<Contact>.self, c.adapter, "/contacts?page=1&size=50").items.count == 1, "accepted friendship directory")
        _ = try await raw(c.adapter, "/contacts/remark", "POST", ["user_id": d.login.userId, "remark": "iOS fixture remark", "group_name": "iOS fixture group"])
        let names = try await raw(c.adapter, "/contacts/names?page=1&size=50")
        let named = (names["items"] as? [[String: Any]])?.first
        try check(named?["remark"] as? String == "iOS fixture remark" && named?["group_name"] as? String == "iOS fixture group", "directory retains viewer contact metadata")
        _ = try await raw(c.adapter, "/contacts/remove", "POST", ["user_id": d.login.userId])
        passed.append("friend request, decision, list and removal contracts")

        let updatedGroup = try await decoded(GroupProfile.self, a.adapter, "/conversations/groups/profile", "POST", ["conversation_id": group.id, "name": "changed", "description": "fixture", "announcement": "notice", "allow_member_add_friend": false])
        try check(updatedGroup.name == "changed" && updatedGroup.allowMemberAddFriend == false, "group settings persisted")
        let restrictedMembers = try await decoded(Page<GroupMember>.self, b.adapter, "/conversations/members?conversation_id=\(group.id)")
        try check(restrictedMembers.items.allSatisfy { ["owner", "admin"].contains($0.role) }, "restricted roster")
        _ = try await raw(a.adapter, "/conversations/members/role", "POST", ["conversation_id": group.id, "user_id": b.login.userId, "role": "admin"])
        let admin = try await decoded(GroupProfile.self, b.adapter, "/conversations/groups/profile?conversation_id=\(group.id)")
        try check(admin.canManage && admin.myRole == "admin", "admin assignment")
        _ = try await raw(a.adapter, "/conversations/groups/transfer", "POST", ["conversation_id": group.id, "user_id": b.login.userId])
        let owner = try await decoded(GroupProfile.self, b.adapter, "/conversations/groups/profile?conversation_id=\(group.id)")
        try check(owner.isOwner, "ownership transfer")
        _ = try await raw(b.adapter, "/conversations/members/remove", "POST", ["conversation_id": group.id, "user_id": c.login.userId])
        try await reject(403) { _ = try await history(c.adapter, group.id) }
        _ = try await raw(b.adapter, "/conversations/groups/dissolve", "POST", ["conversation_id": group.id])
        try await reject(403) { _ = try await history(a.adapter, group.id) }
        passed.append("group settings, restricted roster, roles, transfer, kick and dissolve")

        let extra = try await login("a", device: "ios-probe-second")
        let sessions = try await decoded(Page<SessionInfo>.self, a.adapter, "/auth/sessions")
        let second = sessions.items.first { !$0.isCurrent }!
        _ = try await raw(a.adapter, "/auth/sessions/revoke", "POST", ["session_id": second.id])
        try await reject(401) { _ = try await raw(extra.adapter, "/auth/me") }
        let configPage = try await raw(a.adapter, "/client/config")
        try check(configPage["protocol"] as? String == "pulse-v2", "Go public configuration")
        let taskPage = try await decoded(WorkTaskPage.self, a.adapter, "/work-tasks")
        if let code = config.taskCode, let task = taskPage.items.first {
            let started = try await decoded(WorkTaskPayload.self, a.adapter, "/work-tasks/start", "POST", ["task_id":task.id,"verification_code":code])
            let answers = Dictionary(uniqueKeysWithValues: started.questions.map { ($0.questionUUID, true) })
            let saved = try await decoded(WorkTaskPayload.self, a.adapter, "/work-tasks/answers", "POST", ["record_id":started.record.id,"answers":answers])
            try check(saved.questions.allSatisfy { $0.answer == true }, "task answer keys remain stable")
            let submitted = try await decoded(WorkTaskPayload.self, a.adapter, "/work-tasks/submit", "POST", ["record_id":started.record.id,"answers":answers])
            try check(submitted.hasCompleteSettlement, "complete settlement reaches shipping models")
            let restored = try await decoded(WorkTaskPayload.self, a.adapter, "/work-tasks/record?id=\(started.record.id)")
            try check(restored.hasCompleteSettlement, "settlement remains available after reload")
            passed.append("task start, answer save, grading, wages and settlement reload")
        }
        _ = try await raw(a.adapter, "/auth/settings")
        _ = try await raw(a.adapter, "/auth/security")
        _ = try await raw(a.adapter, "/messages/pins?conversation_id=\(otherChat.id)")
        _ = try await raw(a.adapter, "/messages/shared?conversation_id=\(otherChat.id)&page=1&size=30&type=all")
        for path in ["/uploads"] {
            do { _ = try await raw(a.adapter, path); throw Failure.assertion("unsupported operation succeeded") }
            catch GoV2Error.unsupported { }
        }
        passed.append("device revoke, 204, task/security/media contracts and explicit unsupported operations")

        let url = try await b.adapter.transport.socketURL()
        var limitations: [String] = []
        #if os(Linux)
        // Linux Foundation's bundled libcurl has no WebSocket support. Export
        // only the single-use ticket to the ignored fixture directory so the
        // separate protocol probe can consume it; never include it in reports.
        let ticketFile = URL(fileURLWithPath: CommandLine.arguments[1]).deletingLastPathComponent().appendingPathComponent("ws-ticket.txt")
        try url.absoluteString.write(to: ticketFile, atomically: true, encoding: .utf8)
        limitations.append("iOS URLSessionWebSocketTask lifecycle requires Xcode/iPhone; Linux libcurl does not implement WebSocket")
        #else
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let ws = session.webSocketTask(with: url); ws.resume()
        let ready = try await ws.receive()
        guard case .string(let readyText) = ready else { throw Failure.assertion("missing WS ready") }
        try check(readyText.contains("ready"), "single-use ticket ready")
        _ = try await send(a.adapter, chat.id, "websocket hint")
        let hint = try await ws.receive()
        guard case .string(let hintText) = hint else { throw Failure.assertion("missing WS hint") }
        try check(hintText.contains("changed"), "realtime hint")
        ws.cancel(with: .normalClosure, reason: nil)
        passed.append("URLSession WebSocket ticket handshake and committed message hint")

        #endif

        _ = try await raw(d.adapter, "/auth/password", "POST", ["current_password": config.password, "new_password": config.password + "_new"])
        try await reject(401) { _ = try await raw(d.adapter, "/auth/me") }
        passed.append("password change invalidates existing sessions")
        let logoutAccount = try await login("c", device: "ios-logout")
        _ = try await raw(logoutAccount.adapter, "/auth/logout", "POST")
        try await reject(401) { _ = try await raw(logoutAccount.adapter, "/auth/me") }
        let summary: [String: Any] = ["result": "passed", "scenarios": passed, "scenario_count": passed.count, "unverified": limitations, "scope": "compiled iOS Foundation adapter + real isolated Go/PostgreSQL/Redis; no SwiftUI/device run"]
        let report = try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: report, as: UTF8.self))
    }
}
