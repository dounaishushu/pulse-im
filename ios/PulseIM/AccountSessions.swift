import Foundation

/// Display metadata only. Passwords, permissions and chat data are never saved here.
struct SavedAccount: Codable, Equatable, Identifiable {
    let server: String
    let userID: Int
    var account: String
    var nickname: String
    var id: String { server + "\n" + String(userID) }
}

struct SavedAccountCredential: Codable, Equatable {
    var account: SavedAccount
    var token: String
}

enum AccountSessionError: Error, LocalizedError {
    case invalidArchive, unavailable, missingAccount, staleAccount
    var errorDescription: String? {
        switch self {
        case .invalidArchive: return "保存的账号资料无法读取，请联系管理员"
        case .unavailable: return "无法安全读取或保存账号，请解锁设备后重试"
        case .missingAccount: return "该账号已退出，请重新添加账号"
        case .staleAccount: return "账号状态已改变，请重新操作"
        }
    }
}

struct AccountSessionArchive: Codable, Equatable {
    var version = 1
    private(set) var entries: [SavedAccountCredential] = []
    private(set) var activeID: String?

    func validate() throws {
        guard version == 1, Set(entries.map { $0.account.id }).count == entries.count,
              activeID == nil || entries.contains(where: { $0.account.id == activeID }) else { throw AccountSessionError.invalidArchive }
        for entry in entries {
            guard entry.account.userID > 0, !entry.token.isEmpty, entry.token.utf8.count <= 8192,
                  let url = URL(string: entry.account.server), let scheme = url.scheme, ["https", "http"].contains(scheme),
                  url.host != nil, url.user == nil, url.password == nil, url.fragment == nil else { throw AccountSessionError.invalidArchive }
        }
    }

    func active(server: String) -> SavedAccountCredential? {
        entries.first { $0.account.id == activeID && $0.account.server == server }
    }
    func credential(id: String, server: String) -> SavedAccountCredential? {
        entries.first { $0.account.id == id && $0.account.server == server }
    }
    func accounts(server: String) -> [SavedAccount] {
        entries.filter { $0.account.server == server }.map { $0.account }
    }
    mutating func activate(_ credential: SavedAccountCredential, preserving current: SavedAccountCredential? = nil) throws {
        if let current, current.account.id != credential.account.id { upsert(current) }
        upsert(credential); activeID = credential.account.id
        try validate()
    }
    @discardableResult mutating func remove(id: String, expectedToken: String) -> Bool {
        guard let index = entries.firstIndex(where: { $0.account.id == id && $0.token == expectedToken }) else { return false }
        entries.remove(at: index)
        if activeID == id { activeID = nil }
        return true
    }
    private mutating func upsert(_ credential: SavedAccountCredential) {
        entries.removeAll { $0.account.id == credential.account.id }
        entries.insert(credential, at: 0)
    }
}

protocol AccountSessionPersistence {
    func read() throws -> Data?
    /// Atomic replacement: failure must leave the previously saved value intact.
    func write(_ data: Data) throws
}

/// One atomic Keychain item commits both the active credential and saved accounts.
/// Re-read on every change so a stale response cannot replace a newer credential.
struct AccountSessionRepository {
    let persistence: AccountSessionPersistence
    func read() throws -> AccountSessionArchive? {
        guard let data = try persistence.read() else { return nil }
        guard data.count <= 2_097_152, let archive = try? JSONDecoder().decode(AccountSessionArchive.self, from: data) else { throw AccountSessionError.invalidArchive }
        try archive.validate(); return archive
    }
    @discardableResult func activate(_ credential: SavedAccountCredential, preserving current: SavedAccountCredential? = nil) throws -> AccountSessionArchive {
        var archive = try read() ?? AccountSessionArchive()
        try archive.activate(credential, preserving: current)
        let data = try JSONEncoder().encode(archive)
        guard data.count <= 2_097_152 else { throw AccountSessionError.unavailable }
        try persistence.write(data)
        return archive
    }
    @discardableResult func remove(id: String, expectedToken: String) throws -> AccountSessionArchive {
        var archive = try read() ?? AccountSessionArchive()
        if archive.remove(id: id, expectedToken: expectedToken) { try persistence.write(JSONEncoder().encode(archive)) }
        return archive
    }
    func clearActive(expectedToken: String) throws {
        var archive = try read() ?? AccountSessionArchive()
        if let entry = archive.entries.first(where: { $0.account.id == archive.activeID && $0.token == expectedToken }) {
            archive.remove(id: entry.account.id, expectedToken: expectedToken)
        }
        // Persist an empty archive too: a legacy token must never be resurrected.
        try persistence.write(JSONEncoder().encode(archive))
    }
}
