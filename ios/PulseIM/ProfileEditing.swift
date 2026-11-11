import Foundation

enum AvatarDownloadFailure: Error {
    case httpStatus(Int)

    static func canRetry(_ error: Error) -> Bool {
        if let failure = error as? AvatarDownloadFailure {
            switch failure {
            case .httpStatus(let status): return [408, 429, 500, 502, 503, 504].contains(status)
            }
        }
        guard let failure = error as? URLError else { return false }
        return [.timedOut, .networkConnectionLost, .notConnectedToInternet,
                .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(failure.code)
    }
}

/// Shared across all avatar views. Cancelled off-screen requests leave the queue.
@MainActor final class AvatarLoadGate {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<UUID, Error>
    }
    private let limit: Int
    private var active = Set<UUID>()
    private var waiting: [Waiter] = []
    var activeCount: Int { active.count }
    var waitingCount: Int { waiting.count }

    init(limit: Int = 4) { precondition(limit > 0); self.limit = limit }

    func acquire() async throws -> UUID {
        try Task.checkCancellation()
        let id = UUID()
        let lease: UUID = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else if active.count < limit { active.insert(id); continuation.resume(returning: id) }
                else { waiting.append(Waiter(id: id, continuation: continuation)) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelWaiting(id) }
        }
        do { try Task.checkCancellation(); return lease }
        catch { release(lease); throw error }
    }

    func release(_ id: UUID) {
        guard active.remove(id) != nil else { return }
        if !waiting.isEmpty {
            let next = waiting.removeFirst()
            active.insert(next.id); next.continuation.resume(returning: next.id)
        }
    }

    private func cancelWaiting(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}

/// Upload/profile responses may use relative URLs and renew their access grant.
enum AvatarURLIdentity {
    private static let grantNames = Set(["media_expires", "media_signature", "media_session", "media_kind"])

    static func resolve(_ raw: String, baseURL: URL) -> URL? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let source = URL(string: value, relativeTo: baseURL)?.absoluteURL,
              ["http", "https"].contains(source.scheme?.lowercased() ?? ""), source.host != nil,
              source.user == nil, source.password == nil else { return nil }
        guard ["127.0.0.1", "localhost"].contains(source.host?.lowercased() ?? "") else { return source }
        guard var parts = URLComponents(url: source, resolvingAgainstBaseURL: false) else { return nil }
        parts.scheme = baseURL.scheme; parts.host = baseURL.host; parts.port = baseURL.port
        return parts.url
    }

    static func cacheKey(_ url: URL) -> String { identity(url, removing: ["media_expires", "media_signature"]) }
    static func contentKey(_ url: URL) -> String { identity(url, removing: grantNames) }

    static func newestGrant(current: URL, incoming: URL) -> URL {
        guard cacheKey(current) == cacheKey(incoming) else { return incoming }
        func expires(_ url: URL) -> Int64? {
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            guard grantNames.allSatisfy({ name in query.contains { $0.name == name && !($0.value ?? "").isEmpty } }) else { return nil }
            guard let value = query.first(where: { $0.name == "media_expires" })?.value else { return nil }
            return Int64(value)
        }
        if let old = expires(current), let new = expires(incoming), old > new { return current }
        return incoming
    }

    private static func identity(_ url: URL, removing names: Set<String>) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        let query = parts.queryItems ?? []
        // Never collapse an ordinary query parameter that merely resembles a grant.
        if grantNames.allSatisfy({ name in query.contains { $0.name == name && !($0.value ?? "").isEmpty } }) {
            parts.queryItems = query.filter { !names.contains($0.name) }
        }
        if let query = parts.queryItems {
            let ordered = query.sorted { $0.name == $1.name ? ($0.value ?? "") < ($1.value ?? "") : $0.name < $1.name }
            parts.queryItems = ordered.isEmpty ? nil : ordered
        }
        parts.fragment = nil
        return parts.string ?? url.absoluteString
    }
}

/// The legacy save endpoint deliberately returns a partial profile, not /auth/me.
struct ProfileUpdateReceipt: Decodable { let id: Int }

enum ProfileSaveValidation {
    static func matches(_ user: User, userID: Int, nickname: String, avatarURL: String,
                        username: String?, birthday: String?, gender: String?, signature: String?,
                        resolve: (String) -> URL?) -> Bool {
        guard userID > 0, user.id == userID, user.nickname == nickname else { return false }
        func avatarIdentity(_ raw: String?) -> String? {
            let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty { return "" }
            return resolve(value).map(AvatarURLIdentity.contentKey)
        }
        guard let expected = avatarIdentity(avatarURL), let actual = avatarIdentity(user.avatarURL), expected == actual else { return false }
        for (requested, saved) in [(username, user.username), (birthday, user.birthday), (gender, user.gender), (signature, user.signature)] {
            if let requested, requested.trimmingCharacters(in: .whitespacesAndNewlines) != (saved ?? "") { return false }
        }
        return true
    }
}

/// A late photo-library result must not replace a newer choice or permit an old save.
struct AvatarSelectionState {
    private(set) var revision = UUID()
    private(set) var isLoading = false
    private(set) var data: Data?
    private(set) var uploadURL: String?
    private(set) var error: String?
    var canSave: Bool { !isLoading && error == nil }

    mutating func begin() -> UUID {
        revision = UUID(); isLoading = true; data = nil; uploadURL = nil; error = nil
        return revision
    }
    @discardableResult mutating func finish(_ data: Data, revision expected: UUID) -> Bool {
        guard revision == expected, isLoading, !data.isEmpty else { return false }
        self.data = data; isLoading = false; error = nil; return true
    }
    mutating func fail(_ message: String, revision expected: UUID) {
        guard revision == expected, isLoading else { return }
        isLoading = false; error = message
    }
    mutating func uploaded(_ url: String, revision expected: UUID) {
        guard revision == expected, canSave, data != nil else { return }
        uploadURL = url
    }
    mutating func reset() { self = AvatarSelectionState() }
}
