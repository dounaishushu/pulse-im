import Foundation

struct RememberedLoginAccount: Codable, Equatable, Identifiable {
    let id: String
    let server: String
    let userID: Int
    let account: String
    let nickname: String
    let avatarURL: String
}
struct RememberedLoginSecret: Codable, Equatable, CustomDebugStringConvertible, CustomStringConvertible {
    let metadata: RememberedLoginAccount
    let password: String
    var debugDescription: String { "RememberedLoginSecret(<redacted>)" }
    var description: String { debugDescription }
}
enum RememberedLoginError: Error, LocalizedError {
    case invalid, unavailable, missing
    var errorDescription: String? {
        switch self {
        case .invalid: return "保存的账号密码无法读取，请手动登录"
        case .unavailable: return "无法安全保存账号密码，请解锁设备后重试"
        case .missing: return "该保存账号已移除，请重新选择"
        }
    }
}
enum RememberedLoginScope {
    static func server(_ raw: String) throws -> String {
        guard var components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else { throw RememberedLoginError.invalid }
        components.scheme = components.scheme?.lowercased(); components.host = host.lowercased()
        guard var value = components.url?.absoluteString else { throw RememberedLoginError.invalid }
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
}
struct RememberedLoginArchive: Codable, Equatable {
    static let limit = 10
    var version = 1
    private(set) var entries: [RememberedLoginSecret] = []
    func validate() throws {
        guard version == 1, entries.count <= Self.limit,
              Set(entries.map { $0.metadata.id }).count == entries.count,
              Set(entries.map { $0.metadata.server + "\n" + String($0.metadata.userID) }).count == entries.count else { throw RememberedLoginError.invalid }
        for entry in entries {
            let row = entry.metadata
            guard !row.id.isEmpty, row.id.count <= 80, row.userID > 0,
                  try RememberedLoginScope.server(row.server) == row.server,
                  !row.account.isEmpty, row.account.count <= 128, row.nickname.count <= 128, row.avatarURL.count <= 4096,
                  !entry.password.isEmpty, entry.password.utf8.count <= 4096 else { throw RememberedLoginError.invalid }
        }
    }
    func accounts(server: String) throws -> [RememberedLoginAccount] {
        let scope = try RememberedLoginScope.server(server)
        return entries.filter { $0.metadata.server == scope }.map(\.metadata)
    }
    func credential(id: String, server: String) throws -> RememberedLoginSecret {
        let scope = try RememberedLoginScope.server(server)
        guard let entry = entries.first(where: { $0.metadata.id == id && $0.metadata.server == scope }) else { throw RememberedLoginError.missing }
        return entry
    }
    mutating func save(server: String, userID: Int, account: String, password: String, nickname: String, avatarURL: String) throws {
        let scope = try RememberedLoginScope.server(server), name = account.trimmingCharacters(in: .whitespacesAndNewlines)
        guard userID > 0, !name.isEmpty, name.count <= 128, !password.isEmpty, password.utf8.count <= 4096 else { throw RememberedLoginError.invalid }
        func matches(_ entry: RememberedLoginSecret) -> Bool { entry.metadata.server == scope && (entry.metadata.userID == userID || entry.metadata.account.caseInsensitiveCompare(name) == .orderedSame) }
        let id = entries.first(where: matches)?.metadata.id ?? UUID().uuidString
        let metadata = RememberedLoginAccount(id: id, server: scope, userID: userID, account: name, nickname: String(nickname.prefix(128)), avatarURL: String(avatarURL.prefix(4096)))
        let remaining = entries.filter { !matches($0) }
        entries = Array(([RememberedLoginSecret(metadata: metadata, password: password)] + remaining).prefix(Self.limit))
        try validate()
    }
    @discardableResult mutating func remove(server: String, id: String? = nil, account: String? = nil) throws -> Bool {
        let scope = try RememberedLoginScope.server(server), name = account?.trimmingCharacters(in: .whitespacesAndNewlines)
        let count = entries.count
        entries.removeAll { entry in
            entry.metadata.server == scope && (entry.metadata.id == id || (name?.isEmpty == false && entry.metadata.account.caseInsensitiveCompare(name!) == .orderedSame))
        }
        return entries.count != count
    }
}
protocol RememberedLoginPersistence {
    func read() throws -> Data?
    func write(_ data: Data) throws
}
struct RememberedLoginRepository {
    let persistence: RememberedLoginPersistence
    func read() throws -> RememberedLoginArchive {
        guard let data = try persistence.read() else { return RememberedLoginArchive() }
        guard data.count <= 131072, let archive = try? JSONDecoder().decode(RememberedLoginArchive.self, from: data) else { throw RememberedLoginError.invalid }
        try archive.validate(); return archive
    }
    func save(server: String, userID: Int, account: String, password: String, nickname: String, avatarURL: String) throws {
        var archive = try read()
        try archive.save(server: server, userID: userID, account: account, password: password, nickname: nickname, avatarURL: avatarURL)
        let data = try JSONEncoder().encode(archive)
        guard data.count <= 131072 else { throw RememberedLoginError.invalid }
        try persistence.write(data)
    }
    func remove(server: String, id: String? = nil, account: String? = nil) throws {
        var archive = try read()
        if try archive.remove(server: server, id: id, account: account) { try persistence.write(JSONEncoder().encode(archive)) }
    }
}
