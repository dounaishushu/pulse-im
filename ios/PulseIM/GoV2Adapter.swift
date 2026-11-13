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
    private func asyncMap<T, U>(_ values: [T], _ transform: (T) async throws -> U) async throws -> [U] {
        var output: [U] = []; output.reserveCapacity(values.count)
        for value in values { output.append(try await transform(value)) }
        return output
    }
    private func rows(_ parent: [String: Any]) throws -> [[String: Any]] {
        if parent["items"] is NSNull { return [] }
        guard let value = parent["items"] as? [[String: Any]] else { throw GoV2Error.invalidResponse }; return value
    }
    private func escape(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? "" }
    private func get(_ path: String) async throws -> [String: Any] { try await transport.request(path) }
    private func mutate(_ path: String, _ method: String = "POST", _ body: [String: Any] = [:]) async throws -> [String: Any] { try await transport.request(path, method: method, body: method == "DELETE" ? nil : body) }
    private func cachedMedia(_ id: String) -> String? {
        context.cachedMedia(id)
    }
    private func saveMedia(_ id: String, url: String, seconds: Int) {
        context.saveMedia(id, url: url, seconds: seconds)
    }
    private func rememberMessage(_ cid: Int, seq: Int, wire: String) {
        context.rememberMessage(cid, seq: seq, wire: wire)
    }
    private func wireMessage(_ cid: Int, seq: Int) throws -> String {
        guard let wire = context.messageWire(cid, seq: seq) else { throw GoV2Error.invalidResponse }
        return wire
    }
    private func mediaURL(_ id: String) async throws -> String {
        if let cached = cachedMedia(id) { return cached }
        guard UUID(uuidString: id) != nil else { throw GoV2Error.invalidResponse }
        let grant = try await mutate("/media/" + id + "/grants")
        let path = try string(grant, "content_path")
        guard path.range(of: "^/api/v2/media-grants/[a-f0-9]{64}/content$", options: .regularExpression) != nil,
              let url = URL(string: path, relativeTo: transport.endpointURL)?.absoluteURL.absoluteString else { throw GoV2Error.invalidResponse }
        saveMedia(id, url: url, seconds: grant["expires_in"] as? Int ?? 120)
        return url
    }
    private var replyContexts: [String: [String: Any]] = [:]
    private func hydrate(_ rows: [[String: Any]]) async throws {
        let replies = rows.filter { ($0["reply_to_id"] as? String)?.isEmpty == false && $0["revoked"] as? Bool != true }
        let groups = Dictionary(grouping: replies, by: { $0["conversation_id"] as? String ?? "" })
        for (conversation, children) in groups {
            let result = try await mutate("/conversations/" + conversation + "/reply-contexts", "POST", ["message_ids": try children.map { try string($0,"id") }])
            for row in try self.rows(result) {
                replyContexts[try string(row,"message_id")] = row
                if let parent = row["message"] as? [String: Any] {
                    rememberMessage(try ids.local("conversation",conversation),seq:try number(parent["seq"]),wire:try string(parent,"id"))
                    if let content = parent["content"] as? [String:Any], let media = content["media"] as? [String:Any], let id = media["id"] as? String { _ = try? await mediaURL(id) }
                }
            }
        }
        var seen = Set<String>()
        for row in rows {
            guard let content = row["content"] as? [String: Any], let media = content["media"] as? [String: Any], let id = media["id"] as? String, seen.insert(id).inserted else { continue }
            _ = try? await mediaURL(id)
        }
    }
    private func hydrateUsers(_ rows: [[String: Any]]) async {
        for row in rows {
            if let avatar = row["avatar_id"] as? String, !avatar.isEmpty { _ = try? await mediaURL(avatar) }
        }
    }
    private func profile(_ path: String) async throws -> [String: Any] {
        let raw = try await get(path)
        if let avatar = raw["avatar_id"] as? String, !avatar.isEmpty { _ = try? await mediaURL(avatar) }
        return raw
    }
    private func legacySettings(_ raw: [String: Any], profile: [String: Any]) throws -> [String: Any] {
        func rule(_ key: String) throws -> [String: Any] { try object(raw, key) }
        func localIDs(_ key: String, _ effect: String) throws -> [Int] {
            try (rule(key)[effect] as? [String] ?? []).map { try ids.local("user", $0) }
        }
        return ["can_manage_privacy": raw["can_manage_group_invites"] as? Bool == true,
                "phone_visibility": try string(rule("phone"), "visibility"),
                "phone_search_visibility": try string(rule("phone_search"), "visibility"),
                "last_seen_visibility": try string(rule("last_seen"), "visibility"),
                "voice_call_visibility": try string(rule("voice_call"), "visibility"),
                "invite_visibility": try string(rule("group_invites"), "visibility"),
                "voice_call_peer_to_peer": raw["voice_call_peer_to_peer"] as? String ?? "everyone",
                "show_active_sessions": raw["show_active_sessions"] as? Bool == true,
                "account_auto_delete_days": profile["inactivity_days"] as? Int ?? 180,
                "privacy_exceptions": ["phone_visibility_always": try localIDs("phone", "allow"),
                                       "phone_search_always": try localIDs("phone_search", "allow"),
                                       "last_seen_never": try localIDs("last_seen", "deny"),
                                       "voice_call_never": try localIDs("voice_call", "deny"),
                                       "invite_never": try localIDs("group_invites", "deny")]]
    }
    private func workRecord(_ raw: [String: Any]) async throws -> [String: Any] {
        let rawQuestions = raw["questions"] as? [[String: Any]] ?? []
        let answers = raw["answers"] as? [String: Any] ?? [:]
        let results = raw["results"] as? [String: Any] ?? [:]
        let mappedQuestions = try await asyncMap(rawQuestions) { question -> [String: Any] in
            let wireID = try string(question, "id")
            let code = question["code"] as? String ?? wireID
            let media = question["media_id"] as? String ?? ""
            let image = media.isEmpty ? (question["image_url"] as? String ?? "") : (try await mediaURL(media))
            return ["question_uuid": code, "image_url": image,
                    "answer": answers[wireID] ?? NSNull(),
                    "correct_answer": question["correct"] ?? NSNull(),
                    "reviewed_correct": results[wireID] ?? NSNull()]
        }
        let rawTaskID = try string(raw, "task_id"), rawUserID = try string(raw, "user_id")
        let correct = try number(raw["correct_count"]), total = try number(raw["total"])
        let submittedAt = try (raw["submitted_at"] as? String).map { try displayTime($0) } ?? ""
        let reviewedAt = try (raw["reviewed_at"] as? String).map { try displayTime($0) } ?? ""
        let avatarURL: String
        if let avatar = raw["avatar_id"] as? String, !avatar.isEmpty { avatarURL = (try? await mediaURL(avatar)) ?? "" } else { avatarURL = "" }
        let record: [String: Any] = ["id": try ids.local("record", string(raw, "id")),
            "task_id": try ids.local("task", rawTaskID), "user_id": try ids.local("user", rawUserID),
            "nickname": raw["nickname"] as? String ?? "", "avatar_url": avatarURL, "task_name": raw["task_name"] as? String ?? "",
            "task_date": try string(raw, "task_date"), "employee_type": try string(raw, "employee_type"),
            "status": try string(raw, "status"), "status_label": raw["status"] as? String ?? "",
            "start_at": try displayTime(string(raw, "started_at")),
            "submitted_at": submittedAt, "reviewed_at": reviewedAt,
            "duration_seconds": try number(raw["duration_seconds"]), "total_questions": total,
            "correct_count": correct, "wrong_count": total - correct,
            "unit_price": Double(raw["unit_price"] as? String ?? "0") ?? 0,
            "wage": Double(raw["wage"] as? String ?? "0") ?? 0, "review_note": raw["review_note"] as? String ?? ""]
        return ["record": record, "questions": mappedQuestions]
    }
    private func workTaskPage() async throws -> [String: Any] {
        let page = try await get("/tasks?page=1&size=100"), rows = page["items"] as? [[String: Any]] ?? []
        let now = DateFormatter(); now.locale = Locale(identifier: "en_US_POSIX"); now.timeZone = TimeZone(identifier: "Asia/Shanghai"); now.dateFormat = "HH:mm:ss"
        let items = try await asyncMap(rows) { row -> [String: Any] in
            let rawID = try string(row, "id")
            var record: [String: Any]?
            if let rawRecord = row["record"] as? [String:Any] { record = try await self.workRecord(rawRecord) }
            let rawStatus = row["record_status"] as? String ?? ""
            let open = row["open_time"] as? String ?? "00:00:00"
            let status = rawStatus.isEmpty ? (now.string(from: Date()) < open ? "not_started" : "available") : rawStatus
            var item = row
            item["id"] = try ids.local("task", rawID)
            item["status"] = status
            item["status_label"] = status == "reviewed" ? "已完成" : status == "in_progress" ? "继续答题" : status == "pending_review" ? "待审核" : status == "not_started" ? "未开始" : "开始答题"
            item["open_time"] = String(open.prefix(5))
            item["record"] = record?["record"] ?? NSNull()
            item["intern_unit_price"] = Double(row["intern_unit_price"] as? String ?? "0") ?? 0
            item["formal_unit_price"] = Double(row["formal_unit_price"] as? String ?? "0") ?? 0
            return item
        }
        return ["date": page["date"] as? String ?? "", "employee_type": page["employee_type"] as? String ?? "intern", "items": items]
    }
    private func uid() async throws -> Int { try ids.local("user", string(try await get("/me"), "user_id")) }
    private func user(_ raw: [String: Any]) throws -> [String: Any] {
        var result = raw
        let id = try ids.local("user", string(raw, "id"))
        let account = try string(raw, "account")
        result["id"] = id; result["user_id"] = id; result["username"] = account
        result["nickname"] = raw["nickname"] as? String ?? account
        // These legacy fields are not authoritative Go capabilities. Unknown
        // employment/online state must never grant privileges or claim presence.
        result["formal_employee"] = raw["formal_employee"] as? Bool == true
        result["online"] = raw["online"] as? Bool == true
        result["last_seen_hidden"] = raw["last_seen"] is NSNull || raw["last_seen"] == nil
        result["remark"] = raw["remark"] as? String ?? ""
        result["signature"] = raw["bio"] as? String ?? ""
        if let avatar = raw["avatar_id"] as? String, !avatar.isEmpty { result["avatar_url"] = cachedMedia(avatar) ?? "" }
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
        let cid = try ids.local("conversation", string(raw, "conversation_id"))
        rememberMessage(cid, seq: seq, wire: wire)
        let removed = raw["revoked"] as? Bool == true
        let created = try displayTime(string(raw, "created_at")), updated = try displayTime(string(raw, "updated_at"))
        let kind = raw["kind"] as? String ?? "text"
        let content = raw["content"] as? [String: Any] ?? [:]
        var body = content
        body["text"] = removed ? "" : try string(raw, "body")
        body["request_id"] = try string(raw, "request_id")
        body["_go_wire_id"] = wire; body["_go_version"] = String(version)
        if let media = content["media"] as? [String: Any] {
            if let id = media["id"] as? String { body["url"] = cachedMedia(id) ?? "" }
            body["_go_media_id"] = media["id"]
            body["mime"] = media["mime"]; body["size"] = try number(media["bytes"])
            body["name"] = media["filename"]; body["width"] = media["width"]
            body["height"] = media["height"]; body["duration_ms"] = try number(media["duration_ms"])
            body["original"] = media["original"]
        }
        if let contact = content["contact"] as? [String: Any], let id = contact["id"] as? String {
            body["user_id"] = try ids.local("user", id)
            body["nickname"] = contact["nickname"]; body["username"] = contact["account"]
            body["public_id"] = contact["public_id"]
        }
        if let mentions = content["mentions"] as? [String] { body["mention_user_ids"] = try mentions.map { try ids.local("user",$0) } }
        if let reply = replyContexts[wire], !removed {
            let seq = try number(reply["reply_seq"]); body["reply_to_id"] = seq
            var quote: [String: Any] = ["id":seq,"unavailable":true]
            if let parent = reply["message"] as? [String: Any] {
                let kind = parent["kind"] as? String ?? "text", content = parent["content"] as? [String: Any] ?? [:]
                quote = ["id":seq,"unavailable":false,"sender_id":try ids.local("user",string(parent,"sender_id")),"sender_name":"会话成员","type":kind == "audio" ? "voice" : kind == "contact" ? "contact_card" : kind,"text":parent["body"] as? String ?? "消息"]
                if let media = content["media"] as? [String: Any], let id = media["id"] as? String, kind == "image" { quote["thumbnail_url"] = cachedMedia(id) ?? "" }
            }
            body["reply_to"] = quote
        }
        return ["id": seq, "conversation_id": cid,
                "sender_id": try ids.local("user", string(raw, "sender_id")), "type": kind == "audio" ? "voice" : kind == "contact" ? "contact_card" : kind,
                "body": body,
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
        result["is_pinned"] = raw["pinned"] as? Bool == true
        result["notifications_muted"] = raw["muted_notifications"] as? Bool == true
        result["is_archived"] = raw["archived"] as? Bool == true
        if let avatar = raw["avatar_id"] as? String, !avatar.isEmpty { result["avatar_url"] = cachedMedia(avatar) ?? "" }
        if let peer = raw["peer_id"] as? String, !peer.isEmpty { result["peer_user_id"] = try ids.local("user", peer) }
        result["last_message"] = try (raw["last_message"] as? [String: Any]).map(message) ?? NSNull()
        result["can_publish"] = kind != "channel" || manages
        result["unread_count"] = max(try number(raw["unread_count"]), state["reminder"] as? Bool == true ? 1 : 0)
        result["cleared_before_message_id"] = max(try number(state["clear_seq"]), try number(raw["visible_from_seq"]) - 1)
        result["membership_version"] = version; result["status"] = "active"; result["all_muted"] = raw["mute_all"]
        result["send_disabled_reason"] = raw["can_send"] as? Bool == true ? "" : raw["my_muted"] as? Bool == true ? "member_muted" : raw["mute_all"] as? Bool == true && !manages ? "group_muted" : "peer_unavailable"
        return result
    }
    private func info(_ cid: Int) async throws -> [String: Any] {
        let raw = try await get("/conversations/" + ids.wire("conversation", cid))
        if let avatar = raw["avatar_id"] as? String, !avatar.isEmpty { _ = try? await mediaURL(avatar) }
        if let last = raw["last_message"] as? [String: Any] { try await hydrate([last]) }
        return try conversation(raw)
    }
    private func group(_ cid: Int) async throws -> [String: Any] {
        let raw = try await get("/groups/" + ids.wire("conversation", cid)), current = try await info(cid)
        if let avatar = raw["avatar_id"] as? String, !avatar.isEmpty { _ = try? await mediaURL(avatar) }
        let role = try string(raw, "my_role"), manages = ["owner", "admin"].contains(role)
        var result = raw
        result["conversation_id"] = cid; result["name"] = raw["title"]
        if let avatar = raw["avatar_id"] as? String, !avatar.isEmpty { result["avatar_url"] = cachedMedia(avatar) ?? "" }
        result["owner_id"] = try ids.local("user", string(raw, "owner_id"))
        result["can_manage"] = manages; result["is_owner"] = role == "owner"
        result["allow_member_add_friend"] = raw["block_member_friend_requests"] as? Bool == false
        result["members_visibility"] = manages || raw["block_member_friend_requests"] as? Bool == false ? "all" : "managers"
        result["notifications_muted"] = current["notifications_muted"]
        result["is_pinned"] = current["is_pinned"]
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
            guard next != after, seen.insert(next).inserted else { throw GoV2Error.invalidResponse }; after = next
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
        case "/client/config":
            let raw = try await get("/client/config"), releases = raw["releases"] as? [String: Any] ?? [:]
            let platform = releases["ios"] as? [String: Any] ?? [:]
            var mapped = raw
            mapped["chat_notice"] = raw["announcement"].flatMap { ($0 as? [String: Any])?["body"] }
            mapped["group_member_limit"] = raw["group_member_limit"] ?? 500
            mapped["explore_links"] = ((raw["navigation"] as? [[String: Any]]) ?? []).map { ["name": $0["title"] ?? "", "url": $0["url"] ?? ""] }
            mapped["show_group_member_count"] = (raw["display"] as? [String: Any])?["show_group_count"] ?? true
            mapped["latest_version"] = platform["latest"] ?? "1.0.0"
            mapped["ios_download_url"] = platform["url"] ?? ""
            mapped["update_description"] = platform["notes"] ?? ""
            mapped["force_update"] = platform["force"] ?? false
            mapped["register_require_avatar"] = raw["registration_avatar_required"] ?? false
            mapped["max_register_accounts_per_ip"] = (raw["registration"] as? [String: Any])?["per_ip_limit"] ?? 0
            mapped["mall_links"] = ((raw["shops"] as? [[String: Any]]) ?? []).map { ["name": $0["title"] ?? "", "url": $0["url"] ?? ""] }
            data = mapped
        case "/client/routes":
            let config = try await get("/client/config"), routes = (config["routes"] as? [[String: Any]] ?? []).filter { $0["enabled"] as? Bool == true }
            data = ["items": routes.enumerated().map { index, route in ["id": index + 1, "name": route["name"] ?? "", "url": route["api_url"] ?? "", "sort": route["sort_order"] ?? 0, "status": "active", "ws_url": route["ws_url"] ?? "", "media_url": route["media_url"] ?? ""] as [String: Any] }]
        case "/work-tasks": data = try await workTaskPage()
        case "/work-tasks/start":
            let taskID = try ids.wire("task", input("task_id"))
            data = try await workRecord(mutate("/tasks/" + taskID + "/start", "POST", ["code": try string(body, "verification_code")]))
        case "/work-tasks/record":
            let recordID = try ids.wire("record", input("id"))
            data = try await workRecord(get("/task-records/" + recordID))
        case "/work-tasks/answers", "/work-tasks/submit":
            let recordID = try ids.wire("record", input("record_id")), raw = try await get("/task-records/" + recordID)
            let sourceQuestions = raw["questions"] as? [[String: Any]] ?? [], requested = body["answers"] as? [String: Bool] ?? [:]
            let byCode = Dictionary(uniqueKeysWithValues: sourceQuestions.map { (String(describing: $0["code"] ?? $0["id"] ?? ""), String(describing: $0["id"] ?? "")) })
            var answers: [String: Bool] = [:]
            for (code, answer) in requested { guard let wireID = byCode[code], !wireID.isEmpty else { throw GoV2Error.invalidResponse }; answers[wireID] = answer }
            let submitted = components.path == "/work-tasks/submit"
            let updated = try await mutate("/task-records/" + recordID + (submitted ? "/submit" : "/answers"), "PUT", ["answers": answers, "expected_version": try string(raw, "version")])
            data = try await workRecord(updated)
        case "/client/diagnostics":
            let raw = try await mutate("/client/diagnostics", "POST", ["platform": "ios", "version": body["app_version"] as? String ?? "1.0", "report": body])
            data = ["report_id": try string(raw, "id"), "status": "uploaded"]
        case "/auth/register-challenge":
            let raw = try await get("/auth/captcha")
            data = ["challenge_id": try string(raw, "id"), "image_data_url": try string(raw, "image"),
                    "code_length": 5, "expires_in": try number(raw["expires_in"])]
        case "/auth/register":
            let account = body["username"] as? String ?? body["phone"] as? String ?? "", avatar = body["avatar_data_url"] as? String ?? body["avatar_url"] as? String ?? ""
            var input: [String: Any] = ["account": account.range(of: "^[0-9+ -]{6,32}$", options: .regularExpression) == nil ? account : "",
                                        "phone": account.range(of: "^[0-9+ -]{6,32}$", options: .regularExpression) == nil ? "" : account,
                                        "nickname": try string(body, "nickname"),
                                        "password": try string(body, "password"), "captcha_id": try string(body, "captcha_id"),
                                        "captcha_code": try string(body, "captcha_code")]
            if !avatar.isEmpty {
                let prefix = ["data:image/jpeg;base64,": "jpg", "data:image/png;base64,": "png", "data:image/webp;base64,": "webp"].first { avatar.hasPrefix($0.key) }
                guard let prefix else { throw GoV2Error.invalidResponse }
                input["avatar_filename"] = "registration." + prefix.value
                input["avatar_base64"] = String(avatar.dropFirst(prefix.key.count))
            }
            let registered = try await mutate("/auth/register", "POST", input)
            let wire = try string(registered, "id")
            var login = try await mutate("/auth/login", "POST", ["account": account, "password": try string(body, "password"),
                                                                  "device_id": try string(body, "device_id"),
                                                                  "device_name": body["device_name"] as? String ?? "", "platform": "ios"])
            login["user_id"] = try ids.local("user", wire)
            login["public_id"] = wire.replacingOccurrences(of: "-", with: "").uppercased()
            login["avatar_url"] = ""
            data = login
        case "/auth/login":
            var raw = try await mutate("/auth/login", "POST", ["account": try string(body, "phone"), "password": try string(body, "password"), "device_id": try string(body, "device_id"), "device_name": body["device_name"] as? String ?? "", "platform": "ios", "second_factor": body["two_step_code"] as? String ?? ""])
            raw["user_id"] = try ids.local("user", string(raw, "user_id")); data = raw
        case "/auth/me": data = try user(await profile("/me/profile"))
        case "/auth/profile":
            let current = try await profile("/me/profile")
            var patch: [String: Any] = ["expected_version": try string(current, "version")]
            for (old, next) in [("nickname", "nickname"), ("username", "account"), ("birthday", "birthday"),
                                ("gender", "gender"), ("signature", "bio")] {
                if let value = body[old] { patch[next] = value }
            }
            if patch.count > 1 { _ = try await mutate("/me/profile", "PATCH", patch) }
            if let avatar = body["avatar_url"] as? String, avatar.hasPrefix("pulse-media:") {
                let id = String(avatar.dropFirst("pulse-media:".count)); guard UUID(uuidString: id) != nil else { throw GoV2Error.invalidResponse }
                let latest = try await get("/me/profile")
                _ = try await mutate("/me/avatar", "PUT", ["media_id": id, "expected_version": try string(latest, "version")])
            }
            data = try user(await profile("/me/profile"))
        case "/auth/logout": _ = try await mutate("/auth/logout"); data = ["status": "ok"]
        case "/notifications/devices/register":
            #if DEBUG
            let environment = "sandbox"
            #else
            let environment = "production"
            #endif
            _ = try await mutate("/me/push-device", "PUT", ["platform": "ios", "token": try string(body, "device_token"), "environment": environment])
            data = ["status": "registered"]
        case "/notifications/devices/unregister":
            _ = try await mutate("/me/push-device", "DELETE"); data = ["status": "unregistered"]
        case "/notifications/devices":
            let raw = try await get("/me/push-devices")
            data = ["items": try rows(raw).map { item -> [String: Any] in
                var result = item; result["id"] = try ids.local("push_device", string(item, "id")); return result
            }]
        case "/auth/password": _ = try await mutate("/auth/password", "PUT", body); data = ["status": "ok"]
        case "/auth/sessions":
            data = ["items": try rows(await get("/auth/sessions")).map { raw -> [String: Any] in
                var item = raw; item["id"] = try ids.local("session", string(raw, "id")); item["device_type"] = raw["device_id"]; item["is_current"] = raw["current"]; return item
            }]
        case "/auth/sessions/revoke": _ = try await mutate("/auth/sessions/" + ids.wire("session", input("session_id")), "DELETE"); data = ["status": "ok"]
        case "/go/privacy": data = method == "GET" ? try await get("/me/privacy") : try await mutate("/me/privacy", "PATCH", body)
        case "/auth/security":
            if method == "GET" { data = try await get("/me/security") }
            else {
                let action = try string(body, "action")
                let payload: [String: Any] = ["action": action, "login_password": body["login_password"] as? String ?? "",
                    "current": body["current"] as? String ?? body["current_code"] as? String ?? "",
                    "next": body["next"] as? String ?? body["new_password"] as? String ?? ""]
                data = try await mutate("/me/security", "PUT", payload)
            }
        case "/auth/settings":
            let current = try await get("/me/privacy"), me = try await get("/me/profile")
            if method != "GET" {
                var patch: [String: Any] = ["expected_version": try string(current, "version")]
                for (old, scope) in [("phone_visibility", "phone"), ("phone_search_visibility", "phone_search"),
                                     ("last_seen_visibility", "last_seen"), ("voice_call_visibility", "voice_call"),
                                     ("invite_visibility", "group_invites")] {
                    if let value = body[old] as? String { var rule = try object(current, scope); rule["visibility"] = value; patch[scope] = rule }
                }
                if let exceptions = body["privacy_exceptions"] as? [String: [Int]] {
                    for (old, scope, effect) in [("phone_visibility_always", "phone", "allow"), ("phone_search_always", "phone_search", "allow"),
                                                 ("last_seen_never", "last_seen", "deny"), ("voice_call_never", "voice_call", "deny"),
                                                 ("invite_never", "group_invites", "deny")] {
                        if let values = exceptions[old] {
                            var rule = try (patch[scope] as? [String: Any]) ?? object(current, scope)
                            rule[effect] = try values.map { try ids.wire("user", $0) }; patch[scope] = rule
                        }
                    }
                }
                if let value = body["voice_call_peer_to_peer"] { patch["voice_call_peer_to_peer"] = value }
                if let value = body["show_active_sessions"] { patch["show_active_sessions"] = value }
                if patch.count > 1 { _ = try await mutate("/me/privacy", "PATCH", patch) }
                if let days = body["account_auto_delete_days"] as? Int {
                    _ = try await mutate("/me/profile", "PATCH", ["inactivity_days": days, "expected_version": try string(me, "version")])
                }
            }
            let refreshed = try await get("/me/privacy"), refreshedProfile = try await get("/me/profile")
            data = try legacySettings(refreshed, profile: refreshedProfile)
        case "/contacts/search":
            let publicID = q["public_id"]
            if let publicID, !PublicUserIdentity.isValid(publicID) { throw GoV2Error.invalidResponse }
            let account = q["q"] ?? q["username"] ?? ""
            var matches: [[String: Any]] = []
            do { matches = [try user(await profile(publicID.map { "/public-users/" + escape($0) } ?? "/users/by-account/" + escape(account)))] }
            catch GoV2Error.http(404, _) { }
            data = ["items": matches, "total": matches.count, "page": 1, "size": 1]
        case "/contacts", "/contacts/names":
            var page = try await get("/client/friend-page?page=\(q["page"] ?? "1")&size=\(q["size"] ?? "50")")
            let contacts = try rows(page); await hydrateUsers(contacts); page["items"] = try contacts.map(user); data = page
        case "/contacts/profile":
            let origin = try q["context_conversation_id"].map { "?conversation_id=" + (try ids.wire("conversation", number($0))) } ?? ""
            let wire = try target()
            var profile = try user(await self.profile("/profiles/" + wire + origin))
            profile["blocked_by_me"] = try await all("/blocks").contains { ($0 as? String) == wire }
            data = profile
        case "/contacts/internal-profile":
            let query = try q["context_conversation_id"].map { "?conversation_id=" + (try ids.wire("conversation", number($0))) } ?? ""
            let raw = try await get("/staff/users/" + target() + query), logins = raw["logins"] as? [[String: Any]] ?? [], last = logins.first ?? [:]
            data = ["user_id": try ids.local("user", string(raw, "id")), "nickname": raw["nickname"] ?? "",
                    "phone": raw["phone"] ?? "", "register_ip": raw["registration_ip"] ?? "",
                    "last_login_ip": last["ip"] ?? "", "last_login_at": last["created_at"] ?? "",
                    "last_login_device": last["device_name"] ?? "", "public_id": raw["public_id"] ?? ""]
        case "/contacts/legacy-profile": data = try user(await profile("/public-users/legacy/" + String(input("legacy_user_id"))))
        case "/contacts/card-profile":
            let conversation = try input("conversation_id"), cidWire = try ids.wire("conversation", conversation)
            let message = try wireMessage(conversation, seq: input("message_id"))
            let raw = try await get("/conversations/" + cidWire + "/messages/" + message + "/contact")
            let cardUser = try user(object(raw, "user"))
            var result = cardUser
            result["is_contact"] = raw["is_contact"] as? Bool == true
            result["can_add_friend"] = raw["can_add_friend"] as? Bool == true
            result["add_friend_restriction"] = raw["add_friend_restriction"] ?? NSNull()
            result["source_conversation_id"] = conversation
            result["source_message_id"] = try input("message_id")
            data = result
        case "/contacts/common-groups":
            let peer = try target()
            let contextID: String?
            if let rawContext = q["context_conversation_id"] { contextID = try ids.wire("conversation", number(rawContext)) } else { contextID = nil }
            let query = contextID.flatMap { "&conversation_id=" + $0 } ?? ""
            var result = try await get("/profiles/" + peer + "/common-groups?page=" + (q["page"] ?? "1") + "&size=" + (q["size"] ?? "20") + query)
            result["items"] = try rows(result).map { row -> [String: Any] in
                return ["id": try ids.local("conversation", string(row, "id")), "type": "group", "name": row["title"] ?? "", "status": "active"]
            }
            data = result
        case "/contacts/remark":
            let peer = try target(), current = try await profile("/profiles/" + peer)
            _ = try await mutate("/friends/" + peer + "/metadata", "PUT", ["remark": body["remark"] as? String ?? current["remark"] as? String ?? "",
                "group_name": body["group_name"] as? String ?? current["group_name"] as? String ?? "",
                "expected_version": String(try number(current["contact_version"]))])
            data = ["user_id": try input("user_id"), "remark": body["remark"] as? String ?? current["remark"] as? String ?? "",
                    "group_name": body["group_name"] as? String ?? current["group_name"] as? String ?? ""]
        case "/contacts/remove": _ = try await mutate("/friends/" + target(), "DELETE"); data = try await receipt("removed")
        case "/contacts/force-add":
            _ = try await mutate("/friends/direct-add", "POST", ["target_id": try target()])
            data = ["status": "accepted", "forced": true, "user_id": try input("user_id")]
        case "/contact-requests":
            if method == "GET" {
                let direction = q["direction"] == "sent" ? "outgoing" : "incoming"
                var page = try await get("/client/friend-request-page?direction=\(direction)&page=\(q["page"] ?? "1")&size=\(q["size"] ?? "50")&status=" + escape(q["status"] ?? ""))
                page["items"] = try rows(page).map { raw -> [String: Any] in
                    var row = raw
                    row["id"] = try ids.local("request", string(raw, "id")); row["user_id"] = try ids.local("user", string(raw, direction == "incoming" ? "requester_id" : "target_id"))
                    row["nickname"] = raw[direction == "incoming" ? "requester_account" : "target_account"]; row["message"] = raw["note"]
                    return row
                }; data = page
            } else {
                var patch: [String: Any] = ["target_id": try ids.wire("user", input("to_user_id")), "note": body["message"] as? String ?? ""]
                if body["context_conversation_id"] != nil { patch["context_conversation_id"] = try ids.wire("conversation", input("context_conversation_id")) }
                if body["card_message_id"] != nil {
                    let conversation = try input("card_conversation_id"), message = try wireMessage(conversation, seq: input("card_message_id"))
                    patch["card_conversation_id"] = try ids.wire("conversation", conversation); patch["card_message_id"] = message
                }
                let result = try await mutate("/friend-requests", "POST", patch)
                var receipt: [String: Any] = ["request_id": try ids.local("request", string(result, "id")), "status": try string(result, "status")]
                if let conversation = result["conversation_id"] as? String, !conversation.isEmpty { receipt["conversation_id"] = try ids.local("conversation", conversation) }
                data = receipt
            }
        case "/contact-requests/handle":
            let action = try string(body, "action"); guard ["accept", "reject"].contains(action) else { throw GoV2Error.invalidResponse }
            _ = try await mutate("/friend-requests/" + ids.wire("request", input("request_id")) + "/decision", "PUT", ["accept": action == "accept"])
            data = ["status": action == "accept" ? "accepted" : "rejected"]
        case "/notifications/friend-chats":
            var result = try await get("/friend-chats?after_id=" + escape(q["after_id"] ?? "0"))
            result["items"] = try rows(result).map { row -> [String: Any] in
                var item = row
                item["id"] = try number(row["id"])
                item["conversation_id"] = try ids.local("conversation", string(row, "conversation_id"))
                item["peer_user_id"] = try ids.local("user", string(row, "peer_user_id"))
                return item
            }
            data = result
        case "/conversations":
            var page = try await get("/client/conversation-page?page=\(q["page"] ?? "1")&size=\(q["size"] ?? "50")&kind=" + escape(q["type"] ?? ""))
            for row in try rows(page) {
                if let avatar = row["avatar_id"] as? String, !avatar.isEmpty { _ = try? await mediaURL(avatar) }
                if let last = row["last_message"] as? [String: Any] { try await hydrate([last]) }
            }
            page["items"] = try rows(page).map(conversation); data = page
        case "/conversations/subscriptions":
            data = ["items": try await all("/client/conversations").map { value -> [String: Any] in
                guard let row = value as? [String: Any] else { throw GoV2Error.invalidResponse }
                let last = row["last_message"] as? [String: Any]
                return ["conversation_id": try ids.local("conversation", string(row, "id")), "last_message_id": try last.map { try number($0["seq"]) } ?? 0]
            }]
        case "/conversations/info": data = try await info(cid())
        case "/conversations/open":
            let conversation = try await info(cid())
            if conversation["is_hidden"] as? Bool == true {
                _ = try await mutate("/conversations/" + cw() + "/preferences", "PATCH", ["hidden": false, "expected_version": String(try number(conversation["preference_version"]))])
            }
            data = ["conversation_id": try cid(), "status": "visible"]
        case "/conversations/settings", "/conversations/hide":
            let current = try await info(cid())
            var patch: [String: Any] = ["expected_version": String(try number(current["preference_version"]))]
            for (old, next) in [("is_pinned", "pinned"), ("notifications_muted", "muted_notifications"), ("is_archived", "archived")] {
                if let value = body[old] as? Bool { patch[next] = value }
            }
            if components.path == "/conversations/hide" { patch["hidden"] = true }
            if patch.count > 1 { _ = try await mutate("/conversations/" + cw() + "/preferences", "PATCH", patch) }
            if components.path == "/conversations/hide" { data = ["conversation_id": try cid(), "status": "hidden"] }
            else { data = try await info(cid()) }
        case "/conversations/direct":
            let raw = try await mutate("/conversations/direct", "POST", ["peer_id": try target()])
            data = try await info(ids.local("conversation", string(raw, "id")))
        case "/conversations/groups":
            var input: [String: Any] = ["title": try string(body, "name"), "initial_members": try (body["member_ids"] as? [Int] ?? []).map { try ids.wire("user", $0) }, "block_member_friend_requests": body["allow_member_add_friend"] as? Bool == false]
            if let avatar = body["avatar_url"] as? String, avatar.hasPrefix("pulse-media:") {
                let id = String(avatar.dropFirst("pulse-media:".count)); guard UUID(uuidString: id) != nil else { throw GoV2Error.invalidResponse }
                input["avatar_id"] = id
            }
            let raw = try await mutate("/groups", "POST", input)
            var result = try await info(ids.local("conversation", string(raw, "id")))
            result["invite_code"] = raw["invite_code"]; data = result
        case "/conversations/channels":
            let raw = try await mutate("/channels", "POST", ["title": try string(body, "name")])
            let id = try ids.local("conversation", string(raw, "id"))
            var patch: [String: Any] = [:]
            if let description = body["description"] as? String { patch["description"] = description }
            if !patch.isEmpty { _ = try await mutate("/groups/" + ids.wire("conversation", id), "PATCH", patch) }
            if let avatar = body["avatar_url"] as? String, avatar.hasPrefix("pulse-media:") {
                _ = try await mutate("/groups/" + ids.wire("conversation", id) + "/avatar", "PUT", ["media_id": String(avatar.dropFirst("pulse-media:".count))])
            }
            var result = try await info(id); result["invite_code"] = raw["invite_code"]; data = result
        case "/conversations/favorites":
            let raw = try await mutate("/conversations/saved", "POST")
            data = try await info(ids.local("conversation", string(raw, "id")))
        case "/conversations/groups/join":
            let route: String, payload: [String: Any]
            if body["group_number"] != nil {
                route="/groups/join-by-number";payload=["number":String(try input("group_number")),"invite_code":body["invite_code"] as? String ?? ""]
            } else if body["conversation_id"] != nil {
                let value = try input("conversation_id"), numberText = String(value)
                let groupNumber = (try? ids.wire("conversation", value)) ?? numberText
                route = "/groups/join-by-number"; payload = ["number": groupNumber, "invite_code": body["invite_code"] as? String ?? ""]
            } else { route = "/groups/join"; payload = ["invite_code": try string(body, "invite_code")] }
            let raw = try await mutate(route, "POST", payload)
            data = ["conversation_id": try ids.local("conversation", string(raw, "id")), "user_id": try await uid(), "status": "joined"]
        case "/conversations/channels/follow":
            var payload: [String: Any]
            if let invite = body["invite_code"] as? String, !invite.isEmpty { payload = ["invite_code": invite] }
            else {
                let value = try input("conversation_id"), numberText = String(value)
                payload = ["conversation_id": (try? ids.wire("conversation", value)) ?? numberText]
            }
            let raw = try await mutate("/channels/follow", "POST", payload)
            data = ["conversation_id": try ids.local("conversation", string(raw, "id")), "status": "joined"]
        case "/conversations/groups/profile":
            if method != "GET" {
                var patch: [String: Any] = [:]
                if let name = body["name"] as? String { patch["title"] = name }
                if let description = body["description"] as? String { patch["description"] = description }
                if let announcement = body["announcement"] as? String { patch["announcement"] = announcement }
                if let value = body["allow_member_add_friend"] as? Bool { patch["block_member_friend_requests"] = !value }
                if !patch.isEmpty { _ = try await mutate("/groups/" + cw(), "PATCH", patch) }
                if let avatar = body["avatar_url"] as? String, avatar.hasPrefix("pulse-media:") {
                    let id = String(avatar.dropFirst("pulse-media:".count)); guard UUID(uuidString: id) != nil else { throw GoV2Error.invalidResponse }
                    _ = try await mutate("/groups/" + cw() + "/avatar", "PUT", ["media_id": id])
                }
            }; data = try await group(cid())
        case "/conversations/groups/settings":
            if let muted = body["all_muted"] as? Bool { _ = try await mutate("/groups/" + cw() + "/mute-all", "PUT", ["muted": muted]) }
            if body["notifications_muted"] != nil || body["is_pinned"] != nil {
                let current = try await info(cid())
                var preferences: [String: Any] = ["expected_version": String(try number(current["preference_version"]))]
                if let muted = body["notifications_muted"] as? Bool { preferences["muted_notifications"] = muted }
                if let pinned = body["is_pinned"] as? Bool { preferences["pinned"] = pinned }
                _ = try await mutate("/conversations/" + cw() + "/preferences", "PATCH", preferences)
            }
            data = try await group(cid())
        case "/conversations/groups/mention-members":
            let page = max(1, try input("page")), size = 100
            let members = try await all("/groups/" + cw() + "/search-members?q=" + escape(q["q"] ?? ""))
            await hydrateUsers(members.compactMap { $0 as? [String: Any] })
            let details = try await get("/groups/" + cw()), manager = ["owner", "admin"].contains(details["my_role"] as? String ?? "")
            let mapped = try members.map { value -> [String: Any] in
                guard let raw = value as? [String: Any] else { throw GoV2Error.invalidResponse }
                var item = try user(raw); item["role"] = raw["role"] ?? "member"; item["user_id"] = item["id"]; return item
            }
            let start = min(mapped.count, (page - 1) * size), end = min(mapped.count, start + size)
            data = ["conversation_id": try cid(), "items": Array(mapped[start..<end]), "page": page, "size": size, "total": mapped.count, "can_search": manager, "can_mention_all": manager]
        case "/conversations/members":
            if method == "GET" {
                let items = try await all("/groups/" + cw() + "/member-profiles")
                await hydrateUsers(items.compactMap { $0 as? [String: Any] })
                data = ["conversation_id": try cid(), "items": try items.map { value -> [String: Any] in
                    guard let raw = value as? [String: Any] else { throw GoV2Error.invalidResponse }
                    var member = try user(raw)
                    if let until = raw["muted_until"] as? String, !until.isEmpty { member["muted_until"] = until }
                    else if raw["muted_permanent"] as? Bool == true { member["muted_until"] = "9999-12-31 23:59:59" }
                    else { member["muted_until"] = NSNull() }
                    member["muted_permanent"] = raw["muted_permanent"] as? Bool == true; member["is_muted"] = raw["muted"] as? Bool == true; return member
                }]
            } else {
                guard let history = body["allow_history"] as? Bool else { throw GoV2Error.invalidResponse }
                _ = try await mutate("/groups/" + cw() + "/members", "POST", ["target_id": try target(), "allow_history": history]); data = try await receipt("joined")
            }
        case "/conversations/members/remove": _ = try await mutate("/groups/" + cw() + "/members/" + target(), "DELETE"); data = try await receipt("removed")
        case "/conversations/members/role": _ = try await mutate("/groups/" + cw() + "/members/" + target() + "/role", "PUT", ["role": try string(body, "role")]); data = try await receipt()
        case "/conversations/members/mute":
            guard let minutes = body["minutes"] as? Int, [-1,0].contains(minutes) else { throw GoV2Error.invalidResponse }
            _ = try await mutate("/groups/" + cw() + "/members/" + target() + "/muted", "PUT", ["muted": minutes == -1])
            let roster = try await all("/groups/" + cw() + "/member-profiles"), targetID = try input("user_id")
            let member = roster.compactMap { $0 as? [String: Any] }.first { (try? ids.local("user", string($0, "id"))) == targetID }
            var result = try await receipt(); result["muted_until"] = member?["muted_until"] ?? NSNull(); result["muted_permanent"] = member?["muted_permanent"] as? Bool == true; result["is_muted"] = member?["muted"] as? Bool == true; data = result
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
            } else { _ = try await mutate("/blocks/" + target(), "PUT", ["reason": body["reason"] as? String ?? ""]); data = try await receipt() }
        case "/blocks/candidates":
            let blocked = Set(try await all("/blocks").compactMap { $0 as? String })
            let page = max(1, try input("page")), size = min(100, max(1, try input("size")))
            var users = try await get("/client/friend-page?page=\(page)&size=\(size)")
            let rows = try self.rows(users).filter { row in
                guard let id = row["id"] as? String else { return false }
                return !blocked.contains(id)
            }
            users["items"] = try rows.map { row -> [String: Any] in
                var item = try user(row); item["user_id"] = item["id"]; return item
            }
            data = users
        case "/blocks/unblock": _ = try await mutate("/blocks/" + target(), "DELETE"); data = try await receipt()
        case "/messages/search":
            var params = URLComponents(); params.queryItems = [URLQueryItem(name: "q", value: q["q"] ?? ""), URLQueryItem(name: "limit", value: "50")]
            if let raw = q["conversation_id"], let value = Int(raw), value > 0 { params.queryItems?.append(URLQueryItem(name: "conversation_id", value: try ids.wire("conversation", value))) }
            if let date = q["date"], !date.isEmpty {
                guard date.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil,
                      let start = ISO8601DateFormatter().date(from: date + "T00:00:00+08:00") else { throw GoV2Error.invalidResponse }
                params.queryItems?.append(URLQueryItem(name: "from", value: date + "T00:00:00+08:00"))
                params.queryItems?.append(URLQueryItem(name: "to", value: ISO8601DateFormatter().string(from: start.addingTimeInterval(86400))))
            }
            let pageNumber = Int(q["page"] ?? "1") ?? 1, size = min(100,Int(q["size"] ?? "50") ?? 50)
            guard (1...100).contains(pageNumber), size > 0 else { throw GoV2Error.invalidResponse }
            params.queryItems = (params.queryItems ?? []).filter { $0.name != "limit" } + [URLQueryItem(name:"limit",value:String(size))]
            if let raw = q["sender_id"], let id = Int(raw), id > 0 { params.queryItems?.append(URLQueryItem(name:"sender_id",value:try ids.wire("user",id))) }
            if let kind = q["type"], !kind.isEmpty { params.queryItems?.append(URLQueryItem(name:"kind",value:kind == "voice" ? "audio" : kind == "contact_card" ? "contact" : kind)) }
            var result: [String:Any] = ["items": [[String:Any]]()]
            for page in 1...pageNumber {
                result = try await get("/messages/search?" + (params.percentEncodedQuery ?? ""))
                if page == pageNumber { break }
                guard let next = result["next_before"] as? String, !next.isEmpty else { result = ["items": [[String:Any]]()]; break }
                params.queryItems = (params.queryItems ?? []).filter { $0.name != "before_id" } + [URLQueryItem(name:"before_id",value:next)]
            }
            let found = try rows(result); try await hydrate(found)
            data = ["items": try found.map { row -> [String: Any] in
                let msg = try message(row)
                return msg
            }]
        case "/messages/locate":
            let wire = try wireMessage(cid(), seq: input("message_id"))
            let target = try await get("/conversations/" + cw() + "/messages/" + wire)
            let seq = try number(target["seq"])
            let prefix = "/conversations/" + (try cw()) + "/history?limit=25"
            let older = try await get(prefix + "&before_seq=\(seq)")
            let newer = try await get(prefix + "&after_seq=\(seq)&order=asc")
            let items = try rows(older) + [target] + rows(newer)
            try await hydrate(items)
            data = ["target_id": seq, "items": try items.map(message)]
        case "/messages/shared":
            let page = try input("page"), size = min(50, try input("size"))
            guard page > 0, size > 0, page <= 100 else { throw GoV2Error.invalidResponse }
            var before = "0", items: [[String: Any]] = [], hasMore = false
            for index in 1...page {
                let response = try await get("/conversations/" + cw() + "/shared-media?kind=" + escape(q["type"] ?? "all") + "&limit=\(size)&before_seq=" + before)
                if index == page { items = try rows(response); hasMore = response["has_more"] as? Bool == true; break }
                if response["has_more"] as? Bool != true { break }
                before = response["next_before_seq"] as? String ?? "0"
                if before == "0" { break }
            }
            try await hydrate(items)
            let current = try await info(cid())
            data = ["conversation_id": try cid(), "cleared_before_message_id": current["cleared_before_message_id"] ?? 0,
                    "items": try items.map(message), "total": (page-1)*size+items.count+(hasMore ? 1 : 0), "has_more":hasMore, "page": page, "size": size]
        case "/messages":
            let payload = try object(body, "body")
            let type = try string(body, "type")
            guard ["text", "image", "video", "voice", "file", "contact_card", "shake"].contains(type) else { throw GoV2Error.invalidResponse }
            var send: [String: Any] = ["request_id": try string(body, "request_id")]
            if let source = payload["_source_wire_id"] as? String { guard UUID(uuidString: source) != nil else { throw GoV2Error.invalidResponse }; send["source_message_id"] = source }
            else {
                let kind = type == "voice" ? "audio" : type == "contact_card" ? "contact" : type
                send["kind"] = kind; send["body"] = payload["text"] as? String ?? ""
                if ["image", "video", "audio", "file"].contains(kind) {
                    let value = try string(payload, "url")
                    guard value.hasPrefix("pulse-media:"), let id = UUID(uuidString: String(value.dropFirst("pulse-media:".count))) else { throw GoV2Error.invalidResponse }
                    send["media_id"] = id.uuidString.lowercased()
                }
                if kind == "contact" { send["card_user_id"] = try ids.wire("user", number(payload["user_id"])) }
                if let reply = payload["reply_to_id"] { send["reply_to_id"] = try wireMessage(cid(), seq: number(reply)) }
                if payload["mention_all"] as? Bool == true { send["mention_all"] = true }
                if let mentions = payload["mention_user_ids"] as? [Int], !mentions.isEmpty {
                    send["mentions"] = try mentions.map { try ids.wire("user", $0) }
                }
            }
            let sent = try object(await mutate("/conversations/" + cw() + "/messages", "POST", send), "message")
            try await hydrate([sent]); data = try message(sent)
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
            try await hydrate(try rows(raw))
            try context.requireVersion(conversationID, version)
            data = ["conversation_id": conversationID, "items": try rows(raw).map(message), "has_more": raw["has_more"] as? Bool == true,
                    "snapshot_max_id": try number(raw["snapshot_max_seq"]), "next_after_id": try number(raw["next_after_seq"]),
                    "cleared_before_message_id": max(try number(raw["clear_seq"]), try number(raw["visible_from_seq"]) - 1), "membership_version": version]
        case "/messages/pins":
            let result = try await get("/conversations/" + cw() + "/pins")
            let items = try rows(result)
            try await hydrate(items)
            data = ["conversation_id": try cid(), "items": try items.map { raw -> [String: Any] in
                var item = try message(raw)
                if var pin = raw["pin"] as? [String: Any], let actor = pin["pinned_by"] as? String {
                    pin["pinned_by"] = try ids.local("user", actor)
                    item["pin"] = pin
                }
                return item
            }, "limit": 20]
        case "/messages/pin", "/messages/unpin":
            let wire = try wireMessage(cid(), seq: input("message_id"))
            _ = try await mutate("/conversations/" + cw() + "/pins/" + wire, components.path == "/messages/pin" ? "PUT" : "DELETE")
            var result = try await get("/conversations/" + cw() + "/pins")
            let items = try rows(result)
            try await hydrate(items)
            result["conversation_id"] = try cid(); result["limit"] = 20
            result["items"] = try items.map { raw -> [String: Any] in
                var item = try message(raw)
                if var pin = raw["pin"] as? [String: Any], let actor = pin["pinned_by"] as? String {
                    pin["pinned_by"] = try ids.local("user", actor); item["pin"] = pin
                }
                return item
            }
            data = result
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
