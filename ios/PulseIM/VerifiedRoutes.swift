import Foundation
import CryptoKit
import CoreFoundation

extension Notification.Name { static let pulseRouteChanged = Notification.Name("pulse.route.changed.v1") }

struct VerifiedRoute: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let apiURL: URL
    let webSocketURL: URL
    let mediaURL: URL
    let sort: Int
}

/// Samples and cooldown use monotonic time, independently of wall-clock policy expiry.
struct RouteLatencyPolicy {
    private var poorSamples = 0
    private var candidateID: String?
    private var candidateSamples = 0
    private var changedAt: TimeInterval?

    mutating func reset() { poorSamples = 0; candidateID = nil; candidateSamples = 0 }
    mutating func routeChanged(now: TimeInterval) { reset(); changedAt = now }
    mutating func observe(currentMS: Int?, now: TimeInterval) -> Bool {
        if changedAt.map({ now - $0 < 60 }) == true || currentMS.map({ $0 < 1500 }) == true {
            reset(); return false
        }
        poorSamples = min(3, poorSamples + 1)
        return poorSamples >= 3
    }
    mutating func consider(id: String?, delayMS: Int?, currentMS: Int?) -> String? {
        guard let id, let delayMS, delayMS <= 1000,
              currentMS.map({ $0 - delayMS >= 300 && delayMS * 100 <= $0 * 65 }) ?? true else {
            candidateID = nil; candidateSamples = 0; return nil
        }
        candidateSamples = candidateID == id ? candidateSamples + 1 : 1
        candidateID = id
        return candidateSamples >= 2 ? id : nil
    }
}

private struct RouteOptimizationSnapshot {
    let current: VerifiedRoute
    let alternatives: [VerifiedRoute]
    let epoch: UInt64
    let generation: UInt64
}

enum RouteFailure: LocalizedError {
    case invalid(String)
    var errorDescription: String? { switch self { case .invalid(let text): return text } }
}

private final class RouteNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = RouteNoRedirect()
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum RouteHTTP {
    enum Traffic: Sendable, Equatable { case standard, message, media }
    private static let standardSession = makeSession(connections: 4)
    private static let messageSession = makeSession(connections: 2)
    private static let mediaSession = makeSession(connections: 4)

    /// A recall must not queue behind history, read receipts or large uploads.
    static func traffic(for request: URLRequest) -> Traffic {
        guard request.httpMethod == "POST", let path = request.url?.path else { return .standard }
        return path.hasSuffix("/messages") || path.hasSuffix("/messages/recall") ? .message : .standard
    }

    private static func makeSession(connections: Int) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpMaximumConnectionsPerHost = connections
        // Each operation has its own absolute deadline below. Keep the pool
        // alive between operations without extending an individual request.
        configuration.timeoutIntervalForResource = 3600
        return URLSession(configuration: configuration)
    }

    /// Bound unverified responses while streaming; never forward bearer credentials on redirects.
    static func data(for request: URLRequest, maximum: Int = 16 * 1024 * 1024, traffic: Traffic = .standard) async throws -> (Data, HTTPURLResponse) {
        guard maximum > 0 else { throw RouteFailure.invalid("线路响应大小限制无效") }
        return try await withThrowingTaskGroup(of: (Data, HTTPURLResponse).self) { group in
            group.addTask { try await read(request, maximum: maximum, traffic: traffic) }
            group.addTask {
                try await Task.sleep(for: .seconds(max(0.001, request.timeoutInterval)))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw CancellationError() }
            return result
        }
    }

    private static func read(_ request: URLRequest, maximum: Int, traffic: Traffic) async throws -> (Data, HTTPURLResponse) {
        let session: URLSession
        switch traffic { case .standard: session = standardSession; case .message: session = messageSession; case .media: session = mediaSession }
        let (bytes, response) = try await session.bytes(for: request, delegate: RouteNoRedirect.shared)
        return try await withTaskCancellationHandler {
            var complete = false
            defer { if !complete { bytes.task.cancel() } }
            guard let http = response as? HTTPURLResponse, response.expectedContentLength <= maximum else { throw RouteFailure.invalid("线路响应过大或格式无效") }
            var data = Data()
            if response.expectedContentLength > 0 { data.reserveCapacity(min(maximum, Int(response.expectedContentLength))) }
            for try await byte in bytes {
                if data.count & 1023 == 0 { try Task.checkCancellation() }
                guard data.count < maximum else { throw RouteFailure.invalid("线路响应过大") }
                data.append(byte)
            }
            try Task.checkCancellation(); complete = true
            return (data, http)
        } onCancel: { bytes.task.cancel() }
    }
}

private struct VerifiedRoutePolicy: @unchecked Sendable {
    let revision: Int64
    let issued: Int64
    let expires: Int64
    let routes: [VerifiedRoute]
    let discovery: [URL]
    let envelope: [String: Any]
}

private actor RouteWork {
    private var refreshing: Task<Bool, Never>?
    private var failing: Task<Bool, Never>?
    func refresh(_ manager: VerifiedRoutes) async -> Bool {
        if let refreshing { return await refreshing.value }
        let task = Task { await manager.performRefresh() }; refreshing = task
        let result = await task.value; refreshing = nil; return result
    }
    func failover(_ manager: VerifiedRoutes, failed: URL) async -> Bool {
        if manager.current.apiURL != failed { return true }
        if let failing { return await failing.value }
        let task = Task { await manager.performFailover(failed: failed) }; failing = task
        let result = await task.value; failing = nil; return result
    }
}

/// The logical account namespace stays fixed when a verified transport endpoint changes.
final class VerifiedRoutes: @unchecked Sendable {
    static let productionKey = ""
    static let shared: VerifiedRoutes = {
        let api = Bundle.main.object(forInfoDictionaryKey: "PulseAPIBaseURL") as? String ?? "https://im.example.com/api"
        let ws = Bundle.main.object(forInfoDictionaryKey: "PulseWebSocketURL") as? String ?? "wss://im.example.com/ws"
        let key = Bundle.main.object(forInfoDictionaryKey: "PulseRoutePublicKey") as? String ?? productionKey
        let cluster = Bundle.main.object(forInfoDictionaryKey: "PulseRouteClusterID") as? String ?? "pulse-im-new-install"
        let packaged = Bundle.main.object(forInfoDictionaryKey: "PulseRouteSeeds") as? [[String: Any]] ?? []
        let seeds = packaged.contains(where: { $0["api_url"] as? String == api }) ? packaged : []
        let discovery = seeds.isEmpty ? [] : Bundle.main.object(forInfoDictionaryKey: "PulseRouteDiscoveryURLs") as? [String] ?? []
        return VerifiedRoutes(api: URL(string: api)!, webSocket: URL(string: ws)!, publicKey: Data(base64Encoded: key)!, cluster: cluster, seedRoutes: seeds, discoveryURLs: discovery)
    }()
    let logicalAPI: URL
    private let cluster: String
    private let keyData: Data
    private let keyID: String
    private let defaults: UserDefaults
    private let cacheKey: String
    private let lock = NSLock()
    private let work = RouteWork()
    private let allowLocal: Bool
    private let monotonic: () -> TimeInterval
    private let seed: VerifiedRoute
    private var seeds: [VerifiedRoute] = []
    private var seedDiscovery: [URL] = []
    private var active: VerifiedRoute
    private var available: [VerifiedRoute]
    private var preferredID = ""
    private var revision: Int64 = -1
    private var expires: Int64 = 0
    private var envelope: [String: Any]?
    private var discovery: [URL] = []
    private var delays: [String: Int] = [:]
    private var lastError = ""
    private var optimizationEpoch: UInt64 = 0
    private var sampledEpoch: UInt64?
    private var configurationGeneration: UInt64 = 0
    private var optimizing = false
    private var latencyPolicy = RouteLatencyPolicy()
    var current: VerifiedRoute { expireIfNeeded(); return locked { active } }
    var routes: [VerifiedRoute] { expireIfNeeded(); return locked { available } }
    var preferred: String { locked { preferredID } }
    var error: String { locked { lastError } }
    func latency(_ id: String) -> Int? { locked { delays[id] } }
    private func locked<T>(_ action: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try action() }

    init(api: URL, webSocket: URL, publicKey: Data, cluster: String, defaults: UserDefaults = .standard, allowLocal: Bool = false, seedRoutes: [[String: Any]] = [], discoveryURLs: [String] = [], monotonic: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.logicalAPI = api; self.keyData = publicKey; self.cluster = cluster; self.defaults = defaults
        self.monotonic = monotonic
        #if DEBUG
        self.allowLocal = true
        #else
        self.allowLocal = allowLocal
        #endif
        self.keyID = SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined().prefix(24).description
        self.cacheKey = "pulse_verified_routes_v1:" + cluster + ":" + api.absoluteString
        var origin = URLComponents(url: api, resolvingAgainstBaseURL: false)!; origin.path = "/storage"; origin.query = nil; origin.fragment = nil
        let seed = VerifiedRoute(id: "seed-main", name: "主线路", apiURL: api, webSocketURL: webSocket, mediaURL: origin.url!, sort: 0)
        self.seed = seed; self.active = seed; self.available = [seed]
        seeds = (try? seedRoutes.map { try parseRoute($0) }) ?? []
        if seeds.isEmpty { seeds = [seed] }
        active = seeds[0]; available = seeds
        seedDiscovery = (try? discoveryURLs.map { try endpoint($0) }) ?? []
        if let cached = defaults.data(forKey: cacheKey), let saved = try? JSONSerialization.jsonObject(with: cached) as? [String: Any], let signed = saved["envelope"] as? [String: Any] {
            if let policy = try? verify(signed) {
                install(policy)
                locked { preferredID = saved["preferred"] as? String ?? ""; active = available.first(where: { $0.id == saved["current"] as? String }) ?? available[0]; persistLocked() }
            } else if let expired = try? verify(signed, expiredDiscoveryOnly: true) {
                discovery = expired.discovery; revision = expired.revision
            }
        }
    }
    func owns(_ api: URL) -> Bool { api.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == logicalAPI.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    private func base64(_ value: Any?) throws -> Data {
        guard let text = value as? String, text.count <= 360000, let bytes = Data(base64Encoded: text) else { throw RouteFailure.invalid("线路签名格式无效") }; return bytes
    }
    private func integer(_ data: [String: Any], _ field: String) throws -> Int64 {
        guard let value = data[field] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, value.doubleValue == Double(value.int64Value), abs(value.doubleValue) <= 9_007_199_254_740_991 else { throw RouteFailure.invalid("线路版本格式无效") }
        return value.int64Value
    }
    private func endpoint(_ value: Any?, webSocket: Bool = false, media: Bool = false) throws -> URL {
        guard let text = value as? String, text.count <= 2048, let parts = URLComponents(string: text), let host = parts.host?.lowercased(), parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { throw RouteFailure.invalid("线路地址无效") }
        let expected = webSocket ? "wss" : "https"
        let loopback = ["localhost", "127.0.0.1", "10.0.2.2", "::1"].contains(host)
        guard parts.scheme == expected || (allowLocal && loopback && parts.scheme == (webSocket ? "ws" : "http")) else { throw RouteFailure.invalid("线路必须使用安全连接") }
        guard allowLocal || (host.contains(".") && !host.allSatisfy({ $0.isNumber || $0 == "." }) && !["localhost", "local", "test", "invalid", "example.com", "example.org", "example.net"].contains(where: { host == $0 || host.hasSuffix("." + $0) })) else { throw RouteFailure.invalid("线路域名无效") }
        if media && parts.path.split(separator: "/").last != "storage" { throw RouteFailure.invalid("附件入口路径必须以 /storage 结尾") }
        guard let url = URL(string: text.trimmingCharacters(in: CharacterSet(charactersIn: "/"))) else { throw RouteFailure.invalid("线路地址无效") }; return url
    }
    private func verify(_ signed: [String: Any], expiredDiscoveryOnly: Bool = false) throws -> VerifiedRoutePolicy {
        guard signed["algorithm"] as? String == "ES256-DER", signed["key_id"] as? String == keyID else { throw RouteFailure.invalid("线路清单来自未受信任的签名者") }
        let bytes = try base64(signed["payload"]); guard bytes.count <= 262144 else { throw RouteFailure.invalid("线路清单过大") }
        let key = try P256.Signing.PublicKey(derRepresentation: keyData)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: base64(signed["signature"]))
        guard key.isValidSignature(signature, for: bytes), let data = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw RouteFailure.invalid("线路清单签名校验失败") }
        let now = Int64(Date().timeIntervalSince1970)
        let nextRevision = try integer(data, "revision"), issued = try integer(data, "issued_at"), until = try integer(data, "expires_at")
        guard try integer(data, "version") == 1, data["cluster_id"] as? String == cluster, nextRevision >= max(1, locked { revision }) else { throw RouteFailure.invalid("线路业务标识或版本无效") }
        guard issued <= now + 300, expiredDiscoveryOnly || until > now, until > issued, until - issued <= 604800 else { throw RouteFailure.invalid("线路清单已过期") }
        guard let items = data["routes"] as? [[String: Any]], (1...32).contains(items.count), let sources = data["discovery_urls"] as? [String], sources.count <= 32 else { throw RouteFailure.invalid("线路清单数量无效") }
        let routes = try items.map { try parseRoute($0) }
        guard Set(routes.map(\.id)).count == routes.count, Set(routes.map(\.apiURL)).count == routes.count else { throw RouteFailure.invalid("线路重复") }
        return VerifiedRoutePolicy(revision: nextRevision, issued: issued, expires: until, routes: routes.sorted { $0.sort < $1.sort }, discovery: try sources.map { try endpoint($0) }, envelope: signed)
    }
    private func parseRoute(_ row: [String: Any]) throws -> VerifiedRoute {
        guard let name = row["name"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 64, let id = row["id"], id is String || id is NSNumber else { throw RouteFailure.invalid("线路名称无效") }
        return VerifiedRoute(id: String(describing: id), name: name, apiURL: try endpoint(row["api_url"] ?? row["url"]), webSocketURL: try endpoint(row["ws_url"], webSocket: true), mediaURL: try endpoint(row["media_url"], media: true), sort: (row["sort"] as? NSNumber)?.intValue ?? 0)
    }
    private func persistLocked() {
        guard let envelope, let data = try? JSONSerialization.data(withJSONObject: ["envelope": envelope, "preferred": preferredID, "current": active.id]) else { return }
        defaults.set(data, forKey: cacheKey)
    }
    private func notify() { DispatchQueue.main.async { NotificationCenter.default.post(name: .pulseRouteChanged, object: self) } }
    private func install(_ policy: VerifiedRoutePolicy) {
        let changed = locked { () -> Bool in
            let previous = active
            available = policy.routes; discovery = policy.discovery; revision = policy.revision; expires = policy.expires; envelope = policy.envelope
            active = available.first(where: { $0.id == previous.id && $0.apiURL == previous.apiURL }) ?? available.first(where: { $0.apiURL == previous.apiURL }) ?? available[0]
            configurationGeneration &+= 1
            if previous != active { latencyPolicy.routeChanged(now: monotonic()) }
            lastError = ""; persistLocked(); return previous != active
        }
        if changed { notify() }
    }
    private func json(_ url: URL, maximum: Int = 393216) async throws -> [String: Any] {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpShouldHandleCookies = false; request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await RouteHTTP.data(for: request, maximum: maximum)
        guard (200..<300).contains(response.statusCode), let data = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw RouteFailure.invalid("线路服务暂不可用") }; return data
    }
    func refresh() async -> Bool { expireIfNeeded(); return await work.refresh(self) }
    fileprivate func performRefresh() async -> Bool {
        let candidates = locked { [active.apiURL.appendingPathComponent("client/route-manifest")] + discovery + seedDiscovery + seeds.map { $0.apiURL.appendingPathComponent("client/route-manifest") } }
        var seen = Set<URL>(); let sources = candidates.filter { seen.insert($0).inserted }.prefix(8)
        let results = await withTaskGroup(of: VerifiedRoutePolicy?.self, returning: [VerifiedRoutePolicy].self) { group in
            for source in sources { group.addTask { do { let response = try await self.json(source); return try self.verify(response["data"] as? [String: Any] ?? response) } catch { return nil } } }
            var valid: [VerifiedRoutePolicy] = []; for await result in group { if let result { valid.append(result) } }; return valid
        }
        guard let latest = results.max(by: { $0.revision == $1.revision ? $0.issued < $1.issued : $0.revision < $1.revision }) else { locked { lastError = "暂时无法更新线路，继续使用已保存线路" }; return false }
        install(latest); return true
    }
    func probe(_ route: VerifiedRoute) async throws -> Int {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let url = URL(string: route.apiURL.absoluteString + "/client/route-probe?nonce=" + nonce)!
        let start = ProcessInfo.processInfo.systemUptime; let response = try await json(url, maximum: 4096)
        guard response["ok"] as? Bool == true, let data = response["data"] as? [String: Any], data["ready"] as? Bool == true, data["cluster_id"] as? String == cluster, data["nonce"] as? String == nonce else { throw RouteFailure.invalid("线路暂不可接管或不属于当前业务") }
        let delay = max(0, Int((ProcessInfo.processInfo.systemUptime - start) * 1000)); locked { delays[route.id] = delay }; return delay
    }
    func invalidateOptimization() { locked { optimizationEpoch &+= 1 } }
    func select(_ id: String) async throws {
        invalidateOptimization()
        guard let route = routes.first(where: { $0.id == id }) else { throw RouteFailure.invalid("请先更新线路") }
        let deadline = locked { expires }
        _ = try await probe(route)
        expireIfNeeded()
        let changed = try locked { () throws -> Bool in
            guard deadline == 0 || deadline > Int64(Date().timeIntervalSince1970) else { throw RouteFailure.invalid("线路清单已过期，请更新线路") }
            guard available.contains(route) else { throw RouteFailure.invalid("线路配置已更新，请重新选择") }
            let previous = active
            active = route; preferredID = route.id; lastError = ""; configurationGeneration &+= 1
            latencyPolicy.routeChanged(now: monotonic()); persistLocked(); return previous != active
        }
        if changed { notify() }
    }

    /// No bearer, write replay, promotion or UI work occurs in the latency sampler.
    func optimize() async -> Bool {
        guard !Task.isCancelled else { return false }
        let started = locked { () -> Bool in
            guard !optimizing else { return false }; optimizing = true; return true
        }
        guard started else { return false }
        defer { locked { optimizing = false } }
        expireIfNeeded()
        let snapshot = locked { () -> RouteOptimizationSnapshot? in
            if sampledEpoch != optimizationEpoch { latencyPolicy.reset(); sampledEpoch = optimizationEpoch }
            guard !Task.isCancelled, available.count > 1 else { return nil }
            return RouteOptimizationSnapshot(current: active, alternatives: available.filter { $0 != active }, epoch: optimizationEpoch, generation: configurationGeneration)
        }
        guard let snapshot else { return false }
        let delay = try? await probe(snapshot.current)
        let scan = locked { () -> Bool in
            guard optimizationValidLocked(snapshot) else { return false }
            return latencyPolicy.observe(currentMS: delay, now: monotonic())
        }
        guard scan else { return false }
        var measured: [(VerifiedRoute, Int)] = []
        for offset in stride(from: 0, to: snapshot.alternatives.count, by: 8) {
            guard locked({ optimizationValidLocked(snapshot) }) else { return false }
            let batch = Array(snapshot.alternatives[offset..<min(offset + 8, snapshot.alternatives.count)])
            let results = await withTaskGroup(of: (VerifiedRoute, Int)?.self, returning: [(VerifiedRoute, Int)].self) { group in
                for route in batch { group.addTask {
                    guard !Task.isCancelled, let latency = try? await self.probe(route) else { return nil }
                    return (route, latency)
                } }
                var valid: [(VerifiedRoute, Int)] = []
                for await result in group { if let result { valid.append(result) } }; return valid
            }
            measured.append(contentsOf: results)
        }
        let switched = locked { () -> Bool in
            guard optimizationValidLocked(snapshot) else { return false }
            let best = measured.filter { available.contains($0.0) }.min { a, b in a.1 == b.1 ? a.0.sort < b.0.sort : a.1 < b.1 }
            guard let selected = latencyPolicy.consider(id: best?.0.id, delayMS: best?.1, currentMS: delay), let target = best?.0, target.id == selected else { return false }
            active = target; lastError = ""; configurationGeneration &+= 1
            latencyPolicy.routeChanged(now: monotonic()); persistLocked(); return true
        }
        if switched { notify() }; return switched
    }
    private func optimizationValidLocked(_ snapshot: RouteOptimizationSnapshot) -> Bool {
        !Task.isCancelled && optimizationEpoch == snapshot.epoch && configurationGeneration == snapshot.generation &&
            active == snapshot.current && (expires == 0 || expires > Int64(Date().timeIntervalSince1970))
    }
    func failover(failed: URL) async -> Bool { await work.failover(self, failed: failed) }
    fileprivate func performFailover(failed: URL) async -> Bool {
        if await tryAlternates(failed: failed) { return true }
        _ = await refresh()
        if current.apiURL != failed, (try? await probe(current)) != nil { return true }
        return await tryAlternates(failed: failed)
    }
    private func tryAlternates(failed: URL) async -> Bool {
        let candidates = routes.filter { $0.apiURL != failed }.sorted { a, b in a.id == preferred ? true : b.id == preferred ? false : a.sort < b.sort }
        for offset in stride(from: 0, to: candidates.count, by: 8) {
            let batch = Array(candidates[offset..<min(offset + 8, candidates.count)])
            let valid = await withTaskGroup(of: String?.self, returning: Set<String>.self) { group in
                for route in batch { group.addTask { (try? await self.probe(route)) == nil ? nil : route.id } }
                var ids = Set<String>(); for await id in group { if let id { ids.insert(id) } }; return ids
            }
            if current.apiURL != failed { return true }
            expireIfNeeded()
            let switched = locked { () -> Bool in
                guard active.apiURL == failed, expires == 0 || expires > Int64(Date().timeIntervalSince1970),
                      let route = batch.first(where: { valid.contains($0.id) && available.contains($0) }) else { return false }
                active = route; configurationGeneration &+= 1; latencyPolicy.routeChanged(now: monotonic()); persistLocked(); return true
            }
            if switched { notify(); return true }
        }
        return false
    }
    func mediaURL(_ raw: URL) -> URL {
        var original = URLComponents(url: raw, resolvingAgainstBaseURL: false)
        let decoded = original?.path ?? ""
        let path: String
        if decoded.hasSuffix("/media") { path = original?.queryItems?.first(where: { $0.name == "path" })?.value ?? "" }
        else if let range = decoded.range(of: "/storage/") { path = String(decoded[range.upperBound...]) }
        else { return raw }
        let pattern = "^(?:uploads/[0-9]{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{32}\\.[a-z0-9]{1,8}|work-questions/[0-9]{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{64}\\.(?:jpg|png|gif|webp))$"
        guard path.range(of: pattern, options: .regularExpression) != nil else { return raw }
        var target = URLComponents(url: current.mediaURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        target?.queryItems = original?.queryItems?.filter { $0.name != "path" }; original = nil
        return target?.url ?? raw
    }
    func authorizesMedia(_ url: URL) -> Bool {
        let target = current.mediaURL
        return url.scheme == target.scheme && url.host == target.host && url.port == target.port && url.path.hasPrefix(target.path + "/") && mediaURL(url) == url
    }
    private func expireIfNeeded() {
        let changed = locked { () -> Bool in
            guard expires > 0, expires <= Int64(Date().timeIntervalSince1970) else { return false }
            let previous = active; active = seeds[0]; available = seeds; expires = 0; envelope = nil
            configurationGeneration &+= 1; latencyPolicy.routeChanged(now: monotonic())
            lastError = "保存的线路已过期，正在尝试更新"; return previous != active
        }
        if changed { notify() }
    }
}
