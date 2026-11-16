import Foundation

/// Executes the actual Foundation adapter against media-performance-fixture.py.
/// No production endpoint, credentials, UIKit, signing or Xcode are required.
@main struct MediaPerformanceTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: Bool, _ message: String) throws { if !value { throw Failure.assertion(message) } }
    static let wire = "11111111-1111-4111-8111-111111111111"
    static func object(_ data: Data) throws -> [String: Any] { try JSONSerialization.jsonObject(with: data) as! [String: Any] }
    static func history(_ api: GoV2Adapter) async throws -> [String: Any] {
        let cid = try api.ids.local("conversation", wire)
        return try object(await api.request(path: "/messages/history?conversation_id=\(cid)&size=50"))
    }
    static func run() async throws {
        guard CommandLine.arguments.count == 2, let base = URL(string: CommandLine.arguments[1]), base.host == "127.0.0.1", base.scheme == "http" else { throw Failure.assertion("local contract fixture required") }
        let control = try GoV2Transport(baseURL: base, token: nil)
        func mode(_ value: String) async throws { _ = try await control.request("/test-mode", method: "POST", body: ["mode": value]) }
        func stats() async throws -> [String: Any] { try await control.request("/test-stats") }
        func adapter(_ context: GoV2Context = GoV2Context(), token: String = "fixture-A") throws -> GoV2Adapter { try GoV2Adapter(baseURL: base, token: token, context: context) }
        func open(_ api: GoV2Adapter) async throws -> [String: Any] {
            let cid = try api.ids.local("conversation", wire)
            let data = try await api.request(path: "/conversations/open", method: "POST", body: ["conversation_id": cid])
            let typed = try JSONDecoder().decode(Conversation.self, from: data)
            try check(typed.id == cid, "public API decodes the full Conversation contract")
            return try object(data)
        }
        try await mode("normal")
        let api = try adapter(), cid = try api.ids.local("conversation", wire)
        let opened = try await open(api)
        try check(opened["id"] as? Int == cid && opened["type"] as? String == "direct", "atomic open returns authoritative identity")
        try check(try await stats()["info"] as? Int == 0, "new endpoint avoids redundant info read")
        let saved = try object(await api.request(path: "/conversations/favorites", method: "POST"))
        try check(saved["type"] as? String == "favorites", "saved maps to favorites")
        print("PASS: authoritative open and saved/favorites mapping")

        try await mode("summary")
        let recovered = try await open(api)
        try check(recovered["id"] as? Int == cid && recovered["membership_version"] as? Int == 1, "summary refetched as full info")
        try check(try await stats()["info"] as? Int == 1, "summary triggers authoritative read")
        try await mode("wrong-id")
        do { _ = try await open(api); throw Failure.assertion("wrong conversation accepted") }
        catch GoV2Error.invalidResponse { }
        try check(try await stats()["info"] as? Int == 0, "wrong identity is rejected without rewriting")
        print("PASS: incomplete summary recovery and wrong identity rejection")

        try await mode("legacy")
        let legacy = try await open(api)
        let legacyStats = try await stats()
        try check(legacy["is_hidden"] as? Bool == false && legacy["is_pinned"] as? Bool == true && legacy["notifications_muted"] as? Bool == true, "legacy hidden restore preserves unrelated preferences")
        try check(legacyStats["patch"] as? Int == 2, "legacy conflict recovers by rereading current version")
        print("PASS: old endpoint fallback and hidden-version conflict recovery")

        try await mode("normal")
        let cold = try adapter()
        let page = try await history(cold), messages = page["items"] as! [[String: Any]]
        let visible = messages.filter { (($0["body"] as? [String: Any])?["url"] as? String)?.isEmpty == false }
        let unavailable = messages.filter { ($0["body"] as? [String: Any])?["media_unavailable"] as? Bool == true }
        let coldStats = try await stats()
        try check(messages.count == 34 && visible.count == 33 && unavailable.count == 1, "one denied attachment does not break the history")
        try check(coldStats["batch"] as? Int == 1 && coldStats["single"] as? Int == 0 && coldStats["last_batch_ids"] as? Int == 34, "34 media IDs use one deduplicated batch")
        _ = try await history(cold)
        // 已成功的授权直接复用，被拒绝的附件短暂退避，避免每次刷新都重复请求。
        try check(try await stats()["batch"] as? Int == 1, "cached grants and short denial backoff are reused")
        print("PASS: batch history hydration, optional 403 and grant reuse")

        try await mode("normal")
        let shared = GoV2Context(), first = try adapter(shared), second = try adapter(shared)
        async let firstPage = history(first)
        async let secondPage = history(second)
        _ = try await (firstPage, secondPage)
        try check(try await stats()["batch"] as? Int == 1, "concurrent captures share media authorization")
        print("PASS: simultaneous histories share one media authorization")

        try await mode("normal")
        let cancelContext = GoV2Context(), cancelledAPI = try adapter(cancelContext), survivorAPI = try adapter(cancelContext)
        let cancelled = Task { try await history(cancelledAPI) }
        let survivor = Task { try await history(survivorAPI) }
        try await Task.sleep(nanoseconds: 40_000_000); cancelled.cancel()
        do { _ = try await cancelled.value; throw Failure.assertion("cancelled history was returned") }
        catch is CancellationError { }
        catch let error as URLError where error.code == .cancelled { }
        let surviving = try await survivor.value
        let survivorStats = try await stats()
        try check((surviving["items"] as? [Any])?.count == 34 && survivorStats["batch"] as? Int == 1, "one cancellation preserves the other consumer")
        print("PASS: cancelled history cannot cancel another consumer")

        try await mode("normal")
        let accountA = try adapter(), accountB = try adapter(token: "fixture-B")
        let pageA = try await history(accountA), pageB = try await history(accountB)
        func firstURL(_ page: [String: Any]) -> String? { ((page["items"] as? [[String: Any]])?.first?["body"] as? [String: Any])?["url"] as? String }
        let accountStats = try await stats()
        try check(firstURL(pageA) != firstURL(pageB) && accountStats["batch"] as? Int == 2, "account contexts never reuse another login's grant")
        print("PASS: account-scoped media grant isolation")

        try await mode("unauthorized")
        do { _ = try await history(adapter()); throw Failure.assertion("401 was hidden") }
        catch GoV2Error.http(401, _) { }
        try await mode("old-grants")
        let oldPage = try await history(adapter())
        let oldStats = try await stats()
        try check((oldPage["items"] as? [Any])?.count == 34 && oldStats["single"] as? Int == 34, "old grant endpoint fallback")
        print("PASS: 401 propagation and old grant endpoint fallback")

        let cache = GoV2Context(), media = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let grant = try GoV2MediaGrant.parse(["content_path": "/api/v2/media-grants/" + String(repeating: "a", count: 64) + "/content", "expires_in": 120], endpoint: base)
        cache.saveMedia(media, url: grant.url!, seconds: grant.seconds)
        try check(cache.cachedMedia(media) != nil && GoV2Context().cachedMedia(media) == nil, "upload grant belongs only to captured login")
        cache.saveMedia(media, url: grant.url!, seconds: 5)
        try check(cache.cachedMedia(media) == nil, "near-expiry grants cannot be reused")
        do { _ = try GoV2MediaGrant.parse(["content_path": "https://elsewhere.invalid/content", "expires_in": 120], endpoint: base); throw Failure.assertion("external grant accepted") }
        catch GoV2Error.invalidResponse { }
        print("PASS: inline access path, account and expiry validation")
    }
    static func main() async {
        do { try await run(); print("PASS: all iOS media/conversation contract checks") }
        catch { print("FAIL: \(error)"); exit(1) }
    }
}
