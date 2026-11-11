import Foundation

/// Converts the retained view contracts to the UUID API. Unsupported operations
/// throw before issuing a request; no legacy transport fallback is possible.
final class GoV2Adapter {
    let transport: GoV2Transport
    let ids: GoV2IDs
    let context: GoV2Context
    init(baseURL: URL, token: String?, context: GoV2Context) throws {
        transport = try GoV2Transport(baseURL: baseURL, token: token)
        ids = try GoV2IDs.shared(baseURL.absoluteString); self.context = context
    }
    private func string(_ object: [String: Any], _ key: String) throws -> String {
        guard let value = object[key] as? String else { throw GoV2Error.invalidResponse }; return value
    }
    private func number(_ value: Any?) throws -> Int {
        if let s = value as? String, let n = Int(s), n >= 0 { return n }
        if let n = value as? Int, n >= 0 { return n }
        throw GoV2Error.invalidResponse
    }
    private func object(_ parent: [String: Any], _ key: String) throws -> [String: Any] {
        guard let value = parent[key] as? [String: Any] else { throw GoV2Error.invalidResponse }; return value
    }
    private func rows(_ parent: [String: Any]) throws -> [[String: Any]] {
        if parent["items"] is NSNull { return [] }
        guard let value = parent["items"] as? [[String: Any]] else { throw GoV2Error.invalidResponse }; return value
    }
    private func escape(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? "" }
    private func get(_ path: String) async throws -> [String: Any] { try await transport.request(path) }
    private func mutate(_ path: String, _ method: String = "POST", _ body: [String: Any] = [:]) async throws -> [String: Any] { try await transport.request(path, method: method, body: method == "DELETE" ? nil : body) }
    private func uid() async throws -> Int { try ids.local("user", string(try await get("/me"), "user_id")) }
    private func user(_ raw: [String: Any]) throws -> [String: Any] {
        var result = raw
        let id = try ids.local("user", string(raw, "id"))
        let account = try string(raw, "account")
        result["id"] = id; result["user_id"] = id; result["username"] = account
        result["nickname"] = raw["nickname"] as? String ?? account
        // These legacy fields are not authoritative Go capabilities. Unknown
        // employment/online state must never grant privileges or claim presence.
        result["formal_employee"] = false; result["online"] = false
        result["last_seen_hidden"] = true; result["remark"] = ""
        return result
    }
    private func displayTime(_ value: String) throws -> String {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let simple = ISO8601DateFormatter()
        guard let date = parser.date(from: value) ?? simple.date(from: value) else { throw GoV2Error.invalidResponse }
        // Existing chat labels take the HH:mm substring; retain device local time.
        let out = DateFormatter(); out.locale = Locale(identifier: "en_US_POSIX"); out.timeZone = .current; out.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return out.string(from: date)
    }
    func message(_ raw: [String: Any]) throws -> [String: Any] {
        let wire = try string(raw, "id"), version = try number(raw["version"])
        guard UUID(uuidString: wire) != nil, version > 0 else { throw GoV2Error.invalidResponse }
        let seq = try number(raw["seq"]); guard seq > 0 else { throw GoV2Error.invalidResponse }
        let removed = raw["revoked"] as? Bool == true
        let created = try displayTime(string(raw, "created_at")), updated = try displayTime(string(raw, "updated_at"))
        return ["id": seq, "conversation_id": try ids.local("conversation", string(raw, "conversation_id")),
                "sender_id": try ids.local("user", string(raw, "sender_id")), "type": "text",
                "body": ["text": removed ? "" : try string(raw, "body"), "request_id": try string(raw, "request_id"), "_go_wire_id": wire, "_go_version": String(version)],
                "created_at": created, "edited_at": version > 1 ? updated as Any : NSNull(),
                "recalled_at": removed ? updated as Any : NSNull(), "status": removed ? "recalled" : "sent"]
    }
    private func conversation(_ raw: [String: Any]) throws -> [String: Any] {
        let cid = try ids.local("conversation", string(raw, "id")), kind = try string(raw, "kind")
        let state = try object(raw, "state"), version = try number(raw["membership_version"])
        _ = try context.membership(cid, version: version)
        let role = raw["my_role"] as? String ?? "member", manages = ["owner", "admin"].contains(role)
        var result = raw
        result["id"] = cid; result["type"] = kind
        result["name"] = kind == "direct" ? raw["peer_name"] : raw["title"]
        if let peer = raw["peer_id"] as? String, !peer.isEmpty { result["peer_user_id"] = try ids.local("user", peer) }
        result["last_message"] = try (raw["last_message"] as? [String: Any]).map(message) ?? NSNull()
        result["can_publish"] = kind != "channel" || manages
        result["unread_count"] = max(try number(raw["unread_count"]), state["reminder"] as? Bool == true ? 1 : 0)
        result["cleared_before_message_id"] = max(try number(state["clear_seq"]), try number(raw["visible_from_seq"]) - 1)
        result["membership_version"] = version; result["status"] = "active"; result["all_muted"] = raw["mute_all"]
        result["send_disabled_reason"] = raw["can_send"] as? Bool == true ? "" : raw["my_muted"] as? Bool == true ? "member_muted" : raw["mute_all"] as? Bool == true && !manages ? "group_muted" : "peer_unavailable"
        return result
    }
    private func info(_ cid: Int) async throws -> [String: Any] { try conversation(await get("/conversations/" + ids.wire("conversation", cid))) }
    private func group(_ cid: Int) async throws -> [String: Any] {
        let raw = try await get("/groups/" + ids.wire("conversation", cid)), current = try await info(cid)
        let role = try string(raw, "my_role"), manages = ["owner", "admin"].contains(role)
        var result = raw
        result["conversation_id"] = cid; result["name"] = raw["title"]
        result["owner_id"] = try ids.local("user", string(raw, "owner_id"))
        result["can_manage"] = manages; result["is_owner"] = role == "owner"
        result["allow_member_add_friend"] = raw["block_member_friend_requests"] as? Bool == false
        result["members_visibility"] = manages || raw["block_member_friend_requests"] as? Bool == false ? "all" : "managers"
        result["notifications_muted"] = false; result["is_pinned"] = false
        result["can_send"] = current["can_send"]; result["send_disabled_reason"] = current["send_disabled_reason"]; result["all_muted"] = raw["mute_all"]
        return result
    }
    private func all(_ path: String) async throws -> [Any] {
        var result: [Any] = [], after = "", seen = Set<String>()
        for _ in 0..<1000 {
            let page = try await get(path + (path.contains("?") ? "&" : "?") + "after=" + escape(after))
            guard let items = page["items"] as? [Any] else { if page["items"] is NSNull { return result }; throw GoV2Error.invalidResponse }
            result += items
            let next = page["next_after"] as? String ?? ""
            if next.isEmpty { return result }
            guard !items.isEmpty, seen.insert(next).inserted else { throw GoV2Error.invalidResponse }; after = next
        }
        throw GoV2Error.invalidResponse
    }
    func request(path: String, method: String = "GET", body: [String: Any] = [:]) async throws -> Data {
        guard let components = URLComponents(string: path) else { throw GoV2Error.invalidResponse }
        var q: [String: String] = [:]
        for item in components.queryItems ?? [] { guard q[item.name] == nil else { throw GoV2Error.invalidResponse }; q[item.name] = item.value ?? "" }
        func input(_ key: String) throws -> Int { try number(body[key] ?? q[key]) }
        func cid() throws -> Int { try input("conversation_id") }
        func cw() throws -> String { try ids.wire("conversation", cid()) }
        func target() throws -> String { try ids.wire("user", input("user_id")) }
        func receipt(_ status: String = "ok") async throws -> [String: Any] {
            var value: [String: Any] = ["status": status]
            if let raw = body["conversation_id"] { value["conversation_id"] = raw }
            if let raw = body["user_id"] { value["user_id"] = raw; value["blocked_id"] = raw }
            return value
        }
        let data: [String: Any]
        switch components.path {
        case "/client/config": data = try await get("/client/config")
        case "/auth/login":
            guard (body["two_step_code"] as? String ?? "").isEmpty else { throw GoV2Error.unsupported }
            var raw = try await mutate("/auth/login", "POST", ["account": try string(body, "phone"), "password": try string(body, "password"), "device_id": try string(body, "device_id")])
            raw["user_id"] = try ids.local("user", string(raw, "user_id")); data = raw
        case "/auth/me": data = try user(await get("/me/profile"))
        case "/auth/logout": _ = try await mutate("/auth/logout"); data = ["status": "ok"]
        case "/auth/password": _ = try await mutate("/auth/password", "PUT", body); data = ["status": "ok"]
        case "/auth/sessions":
            data = ["items": try rows(await get("/auth/sessions")).map { raw -> [String: Any] in
                var item = raw; item["id"] = try ids.local("session", string(raw, "id")); item["device_type"] = raw["device_id"]; item["is_current"] = raw["current"]; return item
            }]
        case "/auth/sessions/revoke": _ = try await mutate("/auth/sessions/" + ids.wire("session", input("session_id")), "DELETE"); data = ["status": "ok"]
        case "/go/privacy": data = method == "GET" ? try await get("/me/privacy") : try await mutate("/me/privacy", "PATCH", body)
        case "/auth/settings":
            guard method == "GET" else { throw GoV2Error.unsupported }
            let raw = try await get("/me/privacy")
            data = ["can_manage_privacy": raw["can_manage_group_invites"] as? Bool == true, "invite_visibility": try string(object(raw, "group_invites"), "visibility")]
        case "/contacts/search":
            guard q["public_id"] == nil else { throw GoV2Error.unsupported }
            let account = q["q"] ?? q["username"] ?? ""
            var matches: [[String: Any]] = []
            do { matches = [try user(await get("/users/by-account/" + escape(account)))] }
            catch GoV2Error.http(404, _) { }
            data = ["items": matches, "total": matches.count, "page": 1, "size": 1]
        case "/contacts", "/contacts/names":
            var page = try await get("/client/friend-page?page=\(q["page"] ?? "1")&size=\(q["size"] ?? "50")")
            page["items"] = try rows(page).map(user); data = page
        case "/contacts/profile":
            let origin = try q["context_conversation_id"].map { "?conversation_id=" + (try ids.wire("conversation", number($0))) } ?? ""
            let wire = try target()
            var profile = try user(await get("/client/users/" + wire + origin))
            profile["blocked_by_me"] = try await all("/blocks").contains { ($0 as? String) == wire }
            data = profile
        case "/contacts/remove": _ = try await mutate("/friends/" + target(), "DELETE"); data = try await receipt("removed")
        case "/contacts/force-add":
            _ = try await mutate("/friends/direct-add", "POST", ["target_id": try target()])
            data = ["status": "accepted", "forced": true, "user_id": try input("user_id")]
        case "/contact-requests":
            if method == "GET" {
                let direction = q["direction"] == "sent" ? "outgoing" : "incoming"
                var page = try await get("/client/friend-request-page?direction=\(direction)&page=\(q["page"] ?? "1")&size=\(q["size"] ?? "50")")
                page["items"] = try rows(page).map { raw -> [String: Any] in
                    var row = raw
                    row["id"] = try ids.local("request", string(raw, "id")); row["user_id"] = try ids.local("user", string(raw, direction == "incoming" ? "requester_id" : "target_id"))
                    row["nickname"] = raw[direction == "incoming" ? "requester_account" : "target_account"]; row["message"] = raw["note"]
                    return row
                }; data = page
            } else {
                guard body["card_message_id"] == nil else { throw GoV2Error.unsupported }
                var patch: [String: Any] = ["target_id": try ids.wire("user", input("to_user_id")), "note": body["message"] as? String ?? ""]
                if body["context_conversation_id"] != nil { patch["context_conversation_id"] = try ids.wire("conversation", input("context_conversation_id")) }
                let result = try await mutate("/friend-requests", "POST", patch)
                _ = try ids.local("request", string(result, "id"))
                data = ["status": "pending"]
            }
        case "/contact-requests/handle":
            let action = try string(body, "action"); guard ["accept", "reject"].contains(action) else { throw GoV2Error.invalidResponse }
            _ = try await mutate("/friend-requests/" + ids.wire("request", input("request_id")) + "/decision", "PUT", ["accept": action == "accept"])
            data = ["status": action == "accept" ? "accepted" : "rejected"]
        case "/conversations":
            var page = try await get("/client/conversation-page?page=\(q["page"] ?? "1")&size=\(q["size"] ?? "50")&kind=" + escape(q["type"] ?? ""))
            page["items"] = try rows(page).map(conversation); data = page
        case "/conversations/info": data = try await info(cid())
        case "/conversations/open": _ = try await info(cid()); data = ["conversation_id": try cid(), "status": "visible"]
        case "/conversations/direct":
            let raw = try await mutate("/conversations/direct", "POST", ["peer_id": try target()])
            data = try await info(ids.local("conversation", string(raw, "id")))
        case "/conversations/groups":
            guard (body["avatar_url"] as? String ?? "").isEmpty else { throw GoV2Error.unsupported }
            let raw = try await mutate("/groups", "POST", ["title": try string(body, "name"), "initial_members": try (body["member_ids"] as? [Int] ?? []).map { try ids.wire("user", $0) }, "block_member_friend_requests": body["allow_member_add_friend"] as? Bool == false])
            var result = try await info(ids.local("conversation", string(raw, "id")))
            result["invite_code"] = raw["invite_code"]; data = result
        case "/conversations/groups/join":
            guard body["conversation_id"] == nil else { throw GoV2Error.unsupported }
            let raw = try await mutate("/groups/join", "POST", ["invite_code": try string(body, "invite_code")])
            data = ["conversation_id": try ids.local("conversation", string(raw, "id")), "user_id": try await uid(), "status": "joined"]
        case "/conversations/groups/profile":
            if method != "GET" {
                guard (body["avatar_url"] as? String ?? "").isEmpty else { throw GoV2Error.unsupported }
                var patch: [String: Any] = ["title": try string(body, "name"), "description": body["description"] as? String ?? "", "announcement": body["announcement"] as? String ?? ""]
                if let value = body["allow_member_add_friend"] as? Bool { patch["block_member_friend_requests"] = !value }
                _ = try await mutate("/groups/" + cw(), "PATCH", patch)
            }; data = try await group(cid())
        case "/conversations/members":
            if method == "GET" {
                let items = try await all("/groups/" + cw() + "/member-profiles")
                data = ["conversation_id": try cid(), "items": try items.map { value -> [String: Any] in
                    guard let raw = value as? [String: Any] else { throw GoV2Error.invalidResponse }
                    var member = try user(raw); member["muted_until"] = raw["muted"] as? Bool == true ? "9999-12-31 23:59:59" as Any : NSNull(); return member
                }]
            } else {
                guard let history = body["allow_history"] as? Bool else { throw GoV2Error.invalidResponse }
                _ = try await mutate("/groups/" + cw() + "/members", "POST", ["target_id": try target(), "allow_history": history]); data = try await receipt("joined")
            }
        case "/conversations/members/remove": _ = try await mutate("/groups/" + cw() + "/members/" + target(), "DELETE"); data = try await receipt("removed")
        case "/conversations/members/role": _ = try await mutate("/groups/" + cw() + "/members/" + target() + "/role", "PUT", ["role": try string(body, "role")]); data = try await receipt()
        case "/conversations/members/mute":
            guard let minutes = body["minutes"] as? Int, [-1, 0].contains(minutes) else { throw GoV2Error.unsupported }
            _ = try await mutate("/groups/" + cw() + "/members/" + target() + "/muted", "PUT", ["muted": minutes == -1]); data = try await receipt()
        case "/conversations/groups/transfer": _ = try await mutate("/groups/" + cw() + "/transfer", "POST", ["target_id": try target()]); data = try await receipt()
        case "/conversations/groups/dissolve": _ = try await mutate("/groups/" + cw(), "DELETE"); data = try await receipt()
        case "/conversations/leave":
            let viewer = try await uid(); _ = try await mutate("/groups/" + cw() + "/members/" + ids.wire("user", viewer), "DELETE")
            data = ["conversation_id": try cid(), "user_id": viewer, "status": "left"]
        case "/go/invite-code": data = try await mutate("/groups/" + cw() + "/invite-code/rotate")
        case "/blocks":
            if method == "GET" {
                data = ["items": try await all("/blocks").map { value -> [String: Any] in
                    guard let value = value as? String else { throw GoV2Error.invalidResponse }
                    return ["blocked_id": try ids.local("user", value), "nickname": "已屏蔽用户"]
                }]
            } else { _ = try await mutate("/blocks/" + target(), "PUT"); data = try await receipt() }
        case "/blocks/unblock": _ = try await mutate("/blocks/" + target(), "DELETE"); data = try await receipt()
        case "/messages":
            let payload = try object(body, "body")
            guard body["type"] as? String == "text", payload["reply_to_id"] == nil, payload["mention_user_ids"] == nil, payload["mention_all"] as? Bool != true else { throw GoV2Error.unsupported }
            var send: [String: Any] = ["request_id": try string(body, "request_id")]
            if let source = payload["_source_wire_id"] as? String { guard UUID(uuidString: source) != nil else { throw GoV2Error.invalidResponse }; send["source_message_id"] = source }
            else { send["body"] = try string(payload, "text") }
            data = try message(object(await mutate("/conversations/" + cw() + "/messages", "POST", send), "message"))
        case "/messages/history", "/messages/sync":
            let sync = components.path == "/messages/sync", conversationID = try cid()
            var url = "/conversations/" + (try cw()) + "/history?limit=\(q["size"] ?? q["limit"] ?? "50")&order=\(sync ? "asc" : "desc")"
            if sync {
                url += "&after_seq=\(q["after_id"] ?? "0")&floor_seq=\(q["floor_id"] ?? "0")"
                if let upper = q["snapshot_max_id"] {
                    guard let supplied = q["membership_version"], let version = Int(supplied), version > 0 else { throw GoV2Error.membershipChanged }
                    url += "&snapshot_max_seq=\(upper)&membership_version=\(version)"
                }
            } else if let before = q["max_id"] { url += "&before_seq=\(before)" }
            let raw = try await get(url), version = try number(raw["membership_version"])
            _ = try context.membership(conversationID, version: version)
            data = ["conversation_id": conversationID, "items": try rows(raw).map(message), "has_more": raw["has_more"] as? Bool == true,
                    "snapshot_max_id": try number(raw["snapshot_max_seq"]), "next_after_id": try number(raw["next_after_seq"]),
                    "cleared_before_message_id": max(try number(raw["clear_seq"]), try number(raw["visible_from_seq"]) - 1), "membership_version": version]
        case "/messages/receipt":
            let sequence = try input("through_message_id")
            _ = try await mutate("/conversations/" + cw() + "/read", "PUT", ["seq": String(sequence)])
            data = ["conversation_id": try cid(), "through_message_id": sequence, "status": "read"]
        case "/messages/clear-history":
            let current = try await get("/conversations/" + cw())
            let result = try await mutate("/conversations/" + cw() + "/clear", "PUT", ["through_seq": try string(current, "message_seq")])
            data = ["conversation_id": try cid(), "cleared_before_message_id": try number(result["clear_seq"])]
        case "/messages/delete":
            guard let wires = body["wire_message_ids"] as? [String], let sequences = body["message_ids"] as? [Int], wires.count == sequences.count, !wires.isEmpty else { throw GoV2Error.invalidResponse }
            _ = try await mutate("/conversations/" + cw() + "/personal-deletions", "POST", ["message_ids": wires])
            data = ["conversation_id": try cid(), "user_id": try await uid(), "message_ids": sequences]
        case "/messages/recall", "/messages/edit":
            let wire = try string(body, "wire_message_id"); guard UUID(uuidString: wire) != nil else { throw GoV2Error.invalidResponse }
            let url = "/conversations/" + (try cw()) + "/messages/" + wire
            if components.path == "/messages/recall" {
                let recalled = try message(await mutate(url, "DELETE"))
                guard try number(recalled["id"]) == input("message_id"), recalled["status"] as? String == "recalled" else { throw GoV2Error.invalidResponse }
                data = ["message_id": try input("message_id"), "status": "recalled"]
            } else { data = try message(await mutate(url, "PATCH", ["body": try string(body, "text"), "expected_version": try string(body, "expected_version")])) }
        default: throw GoV2Error.unsupported
        }
        return try JSONSerialization.data(withJSONObject: data)
    }
}
