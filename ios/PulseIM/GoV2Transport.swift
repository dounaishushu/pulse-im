import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum GoV2Error: LocalizedError {
    case invalidResponse, unsupported, membershipChanged
    case http(Int, String)
    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "服务器返回的数据无法识别"
        case .unsupported: return "当前服务暂未开放此功能"
        case .membershipChanged: return "群成员身份已变化，请重新加载聊天记录"
        case .http(let status, let code):
            let labels = ["forbidden": "当前操作不被允许，请检查隐私、拉黑或群权限", "unauthorized": "登录状态已过期，请重新登录。", "invalid_request": "请求参数无效", "not_found": "目标不存在或已不可访问", "rate_limited": "操作过于频繁，请稍后重试", "conflict": "数据已更新，请刷新后重试", "request_conflict": "数据已更新，请刷新后重试", "busy": "服务繁忙，请稍后重试"]
            return labels[code] ?? "请求失败（HTTP \(status)，\(code)）"
        }
    }
}

/// A request never follows redirects or uses PHP discovery/cookies. Mutating
/// requests are retried only by the caller, with the same idempotency key.
final class GoV2Transport {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil; config.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: config, delegate: GoV2NoRedirect(), delegateQueue: nil)
    }()
    let baseURL: URL
    let token: String?
    init(baseURL: URL, token: String?) throws {
        guard Self.validBase(baseURL) else { throw GoV2Error.invalidResponse }
        self.baseURL = baseURL; self.token = token
    }
    static func validBase(_ url: URL) -> Bool {
        ["http", "https"].contains(url.scheme ?? "") && url.host != nil && url.user == nil && url.password == nil && url.query == nil && url.fragment == nil && url.path.hasSuffix("/api/v2")
    }
    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: baseURL.absoluteString + path), url.host == baseURL.host else { throw GoV2Error.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method; request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token, !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await Self.session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, data.count <= 4 * 1024 * 1024 else { throw GoV2Error.invalidResponse }
        let object = data.isEmpty ? nil : (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if !(200..<300).contains(http.statusCode) {
            let code = (object?["error"] as? [String: Any])?["code"] as? String ?? "request_failed"
            if code == "membership_changed" { throw GoV2Error.membershipChanged }
            throw GoV2Error.http(http.statusCode, code)
        }
        if http.statusCode == 204 { guard data.isEmpty else { throw GoV2Error.invalidResponse }; return [:] }
        guard let object else { throw GoV2Error.invalidResponse }
        return object
    }
    func socketURL() async throws -> URL {
        let response = try await request("/realtime/tickets", method: "POST", body: [:])
        guard let ticket = response["ticket"] as? String, !ticket.isEmpty,
              var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw GoV2Error.invalidResponse }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.path += "/realtime"; parts.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        guard let url = parts.url else { throw GoV2Error.invalidResponse }; return url
    }
}
final class GoV2NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Only entity lookup keys are numeric. Message IDs remain per-conversation
/// Int64 sequences and wire requests always carry the server UUID.
final class GoV2IDs {
    private static let registryLock = NSLock()
    private static var registry: [String: GoV2IDs] = [:]
    static func shared(_ server: String) throws -> GoV2IDs {
        registryLock.lock(); defer { registryLock.unlock() }
        if let existing = registry[server] { return existing }
        let result = try GoV2IDs(server: server, defaults: .standard)
        registry[server] = result; return result
    }
    private let lock = NSLock()
    private let defaults: UserDefaults
    private let key: String
    private var values: [String: [String: Int]]
    private var reverse: [String: [Int: String]] = [:]
    init(server: String, defaults: UserDefaults) throws {
        self.defaults = defaults
        key = "pulse.go-v2.ids." + Data(server.utf8).base64EncodedString()
        if let data = defaults.data(forKey: key) {
            guard let saved = try? JSONDecoder().decode([String: [String: Int]].self, from: data) else { throw GoV2Error.invalidResponse }
            values = saved
        } else { values = [:] }
        for (kind, items) in values {
            guard items.allSatisfy({ UUID(uuidString: $0.key) != nil && $0.value > 0 }), Set(items.values).count == items.count else { throw GoV2Error.invalidResponse }
            reverse[kind] = Dictionary(uniqueKeysWithValues: items.map { ($0.value, $0.key) })
        }
    }
    func local(_ kind: String, _ wire: String) throws -> Int {
        guard let uuid = UUID(uuidString: wire) else { throw GoV2Error.invalidResponse }
        let normalized = uuid.uuidString.lowercased()
        lock.lock(); defer { lock.unlock() }
        if let value = values[kind]?[normalized] { return value }
        let last = values[kind]?.values.max() ?? 0
        guard last < Int.max else { throw GoV2Error.invalidResponse }
        let next = last + 1
        var updated = values; updated[kind, default: [:]][normalized] = next
        let data = try JSONEncoder().encode(updated)
        defaults.set(data, forKey: key)
        values = updated; reverse[kind, default: [:]][next] = normalized
        return next
    }
    func wire(_ kind: String, _ local: Int) throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard local > 0, let value = reverse[kind]?[local] else { throw GoV2Error.invalidResponse }; return value
    }
}

/// Shared only by captures of the same server and login. A monotonically newer
/// membership wins even if an older HTTP response arrives later.
final class GoV2Context {
    private let lock = NSLock()
    private var memberships: [Int: Int] = [:]
    func membership(_ cid: Int, version: Int) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard version > 0 else { throw GoV2Error.invalidResponse }
        if let old = memberships[cid], old > version { throw GoV2Error.membershipChanged }
        let changed = memberships[cid] != nil && memberships[cid] != version
        memberships[cid] = version; return changed
    }
    func version(_ cid: Int) -> Int? { lock.lock(); defer { lock.unlock() }; return memberships[cid] }
    func requireVersion(_ cid: Int, _ expected: Int) throws {
        lock.lock(); defer { lock.unlock() }
        guard expected > 0, memberships[cid] == expected else { throw GoV2Error.membershipChanged }
    }
}
