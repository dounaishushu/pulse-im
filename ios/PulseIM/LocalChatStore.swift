import Foundation
import CryptoKit
import Security
import SQLite3

struct IOSLocalChatAccessDenied: LocalizedError {
    var errorDescription: String? { "当前会话不可访问，请刷新会话列表" }
    static func matches(_ error: Error) -> Bool {
        if error is IOSLocalChatAccessDenied { return true }
        if let value = error as? GoV2Error, case .membershipChanged = value { return true }
        if let value = error as? APIClientError, case .sessionExpired = value { return true }
        return false
    }
}

/// Private indexed archive. Only requested pages enter the view's working set.
actor IOSLocalChatStore {
    static let shared = IOSLocalChatStore()
    struct Ticket { let scope: String; let conversation: Int; let revision: Int; let generation: Int; let barrier: Int }
    struct Page { let items: [Message]; let cursor: Int?; let complete: Bool; let cutoff: Int }
    private struct Meta { var revision = 0; var cursor: Int?; var complete = false; var cutoff = 0; var barrier = 0; var upper = 0; var bridge: Int?; var resume: Int?; var resumeComplete = false }
    private enum Value { case text(String), integer(Int), data(Data), null }
    private var database: OpaquePointer?
    private var secret: SymmetricKey?
    private var generation = 0
    private var owner = ""
    private var archiveTask: Task<Void, Never>?
    private var queue: [(APIClient, Int, String, Int)] = []
    private func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    func bind(_ namespace: String) { if owner != namespace { generation += 1; archiveTask?.cancel(); archiveTask = nil; queue = []; owner = namespace } }
    private func open() throws -> OpaquePointer {
        if let database { return database }
        let fm = FileManager.default
        let directory = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LocalChat", isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var excluded = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try excluded.setResourceValues(values)
        var pointer: OpaquePointer?
        guard sqlite3_open_v2(directory.appendingPathComponent("messages-v1.sqlite").path, &pointer, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let pointer else { throw APIClientError.server("本地聊天记录暂不可用") }
        database = pointer
        sqlite3_busy_timeout(pointer, 3000)
        try execute("PRAGMA journal_mode=WAL")
        try execute("CREATE TABLE IF NOT EXISTS messages(scope TEXT NOT NULL,cid INTEGER NOT NULL,id INTEGER NOT NULL,edited TEXT NOT NULL,removed INTEGER NOT NULL,rev INTEGER NOT NULL,data BLOB,PRIMARY KEY(scope,cid,id))")
        try execute("CREATE TABLE IF NOT EXISTS meta(scope TEXT NOT NULL,cid INTEGER NOT NULL,rev INTEGER NOT NULL DEFAULT 0,cursor INTEGER,complete INTEGER NOT NULL DEFAULT 0,cutoff INTEGER NOT NULL DEFAULT 0,barrier INTEGER NOT NULL DEFAULT 0,upper_id INTEGER NOT NULL DEFAULT 0,bridge INTEGER,resume INTEGER,resume_complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,cid))")
        try execute("CREATE TABLE IF NOT EXISTS go_membership(scope TEXT NOT NULL,cid INTEGER NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(scope,cid))")
        return pointer
    }
    private func statement<T>(_ sql: String, _ values: [Value] = [], _ body: (OpaquePointer) throws -> T) throws -> T {
        let db = try open(); var query: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &query, nil) == SQLITE_OK, let query else { throw APIClientError.server("本地聊天记录读取失败") }
        defer { sqlite3_finalize(query) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            switch value {
            case .integer(let number): sqlite3_bind_int64(query, index, Int64(number))
            case .text(let string): _ = string.withCString { sqlite3_bind_text(query, index, $0, -1, transient) }
            case .data(let data): _ = data.withUnsafeBytes { sqlite3_bind_blob(query, index, $0.baseAddress, Int32(data.count), transient) }
            case .null: sqlite3_bind_null(query, index)
            }
        }
        return try body(query)
    }
    private func execute(_ sql: String, _ values: [Value] = []) throws {
        try statement(sql, values) { query in let result = sqlite3_step(query); guard result == SQLITE_DONE || result == SQLITE_ROW else { throw APIClientError.server("本地聊天记录保存失败") } }
    }
    private func key() throws -> SymmetricKey {
        if let secret { return secret }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "pulse.local-chat.v1", kSecAttrAccount as String: "device", kSecReturnData as String: true]
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        let data: Data
        if status == errSecSuccess, let saved = result as? Data, saved.count == 32 { data = saved }
        else {
            guard status == errSecItemNotFound else { throw APIClientError.server("请解锁手机后读取本地聊天记录") }
            data = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
            let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "pulse.local-chat.v1", kSecAttrAccount as String: "device", kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, kSecValueData as String: data]
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw APIClientError.server("无法保存本地聊天密钥") }
        }
        let value = SymmetricKey(data: data); secret = value; return value
    }
    private func metadata(_ scope: String, _ cid: Int) throws -> Meta {
        try statement("SELECT rev,cursor,complete,cutoff,barrier,upper_id,bridge,resume,resume_complete FROM meta WHERE scope=? AND cid=?", [.text(scope), .integer(cid)]) { q in
            guard sqlite3_step(q) == SQLITE_ROW else { return Meta() }
            return Meta(revision: Int(sqlite3_column_int64(q, 0)), cursor: sqlite3_column_type(q, 1) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(q, 1)), complete: sqlite3_column_int(q, 2) == 1, cutoff: Int(sqlite3_column_int64(q, 3)), barrier: Int(sqlite3_column_int64(q, 4)), upper: Int(sqlite3_column_int64(q, 5)), bridge: sqlite3_column_type(q, 6) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(q, 6)), resume: sqlite3_column_type(q, 7) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(q, 7)), resumeComplete: sqlite3_column_int(q, 8) == 1)
        }
    }
    func ticket(_ namespace: String, _ cid: Int) throws -> Ticket {
        guard owner == namespace, !namespace.isEmpty, cid > 0 else { throw CancellationError() }
        let scope = hash(namespace), meta = try metadata(scope, cid)
        return Ticket(scope: scope, conversation: cid, revision: meta.revision, generation: generation, barrier: meta.barrier)
    }
    func read(_ namespace: String, _ cid: Int, before: Int = Int.max, limit: Int = 50) throws -> Page {
        let t = try ticket(namespace, cid), meta = try metadata(t.scope, cid), deviceKey = try key()
        let items: [Message] = try statement("SELECT id,data FROM messages WHERE scope=? AND cid=? AND id>? AND id<=? AND removed=0 ORDER BY id DESC LIMIT ?", [.text(t.scope), .integer(cid), .integer(meta.cutoff), .integer(before), .integer(min(100, max(1, limit)))]) { q in
            var result: [Message] = []
            while sqlite3_step(q) == SQLITE_ROW {
                let id = Int(sqlite3_column_int64(q, 0)), length = Int(sqlite3_column_bytes(q, 1))
                guard length > 28, length < 1024 * 1024 + 64, let bytes = sqlite3_column_blob(q, 1) else { continue }
                do {
                    let box = try AES.GCM.SealedBox(combined: Data(bytes: bytes, count: length))
                    let raw = try AES.GCM.open(box, using: deviceKey, authenticating: Data("\(t.scope):\(cid):\(id)".utf8))
                    let message = try JSONDecoder().decode(Message.self, from: raw)
                    if message.id == id && message.conversationId == cid { result.append(message) }
                } catch { /* Corrupt rows are recovered by the next server synchronization. */ }
            }
            return Array(result.reversed())
        }
        return Page(items: items, cursor: meta.cursor, complete: meta.complete, cutoff: meta.cutoff)
    }
    /// Ticket acquisition and mutation share one actor turn, before later reads.
    func mergeEvent(_ namespace: String, message: Message) throws {
        let t = try ticket(namespace, message.conversationId)
        try merge(t, items: [message], event: true)
    }
    func merge(_ t: Ticket, items: [Message], floor: Int? = nil, maximum: Int? = nil, cutoff: Int = 0, cursor: Int? = nil, complete: Bool = false, event: Bool = false, latest: Bool = false) throws {
        guard generation == t.generation, items.count <= 500, items.allSatisfy({ $0.id > 0 && $0.conversationId == t.conversation }) else { return }
        var meta = try metadata(t.scope, t.conversation); guard meta.barrier == t.barrier else { return }
        let deviceKey = try key(), cid = t.conversation, scope = t.scope
        try execute("BEGIN IMMEDIATE")
        do {
            meta.revision += 1; meta.cutoff = max(meta.cutoff, cutoff)
            for message in items where message.id > meta.cutoff {
                let removed = message.recalledAt != nil || ["deleted", "recalled"].contains(message.status ?? "")
                let skip: Bool = try statement("SELECT edited,removed,rev FROM messages WHERE scope=? AND cid=? AND id=?", [.text(scope), .integer(cid), .integer(message.id)]) { q in
                    guard sqlite3_step(q) == SQLITE_ROW, !removed else { return false }
                    let edited = sqlite3_column_text(q, 0).map { String(cString: $0) } ?? ""
                    return sqlite3_column_int(q, 1) == 1 || edited > (message.storageVersion) || (!event && Int(sqlite3_column_int64(q, 2)) > t.revision)
                }
                if skip { continue }
                var data: Value = .null
                if !removed {
                    let raw = try JSONEncoder().encode(message); guard raw.count <= 1024 * 1024 else { continue }
                    let cipher = try AES.GCM.seal(raw, using: deviceKey, authenticating: Data("\(scope):\(cid):\(message.id)".utf8))
                    guard let combined = cipher.combined else { continue }; data = .data(combined)
                }
                try execute("INSERT OR REPLACE INTO messages(scope,cid,id,edited,removed,rev,data) VALUES(?,?,?,?,?,?,?)", [.text(scope), .integer(cid), .integer(message.id), .text(message.storageVersion), .integer(removed ? 1 : 0), .integer(meta.revision), data])
            }
            if let floor, let maximum, maximum >= floor {
                let exclusion = items.isEmpty ? "" : " AND id NOT IN (" + items.map { String($0.id) }.joined(separator: ",") + ")"
                try execute("UPDATE messages SET removed=1,data=NULL,rev=? WHERE scope=? AND cid=? AND id>=? AND id<=? AND rev<=?" + exclusion, [.integer(meta.revision), .text(scope), .integer(cid), .integer(floor), .integer(maximum), .integer(t.revision)])
            }
            try execute("DELETE FROM messages WHERE scope=? AND cid=? AND id<=?", [.text(scope), .integer(cid), .integer(meta.cutoff)])
            if let cursor {
                let previousCursor = meta.cursor, previousComplete = meta.complete
                meta.cursor = min(previousCursor ?? cursor, cursor); meta.complete = previousComplete || complete
                if latest, !items.isEmpty, !complete, meta.upper > 0, (items.map(\.id).min() ?? 0) > meta.upper {
                    if meta.bridge == nil { meta.bridge = meta.upper; meta.resume = previousCursor; meta.resumeComplete = previousComplete }
                    meta.cursor = cursor; meta.complete = false
                } else if !latest, let bridge = meta.bridge, cursor <= bridge {
                    meta.cursor = meta.resume ?? cursor; meta.complete = meta.resumeComplete || complete; meta.bridge = nil; meta.resume = nil; meta.resumeComplete = false
                }
                if latest { meta.upper = max(meta.upper, items.map(\.id).max() ?? 0) }
            }
            try execute("INSERT OR REPLACE INTO meta(scope,cid,rev,cursor,complete,cutoff,barrier,upper_id,bridge,resume,resume_complete) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [.text(scope), .integer(cid), .integer(meta.revision), meta.cursor.map { .integer($0) } ?? .null, .integer(meta.complete ? 1 : 0), .integer(meta.cutoff), .integer(meta.barrier), .integer(meta.upper), meta.bridge.map { .integer($0) } ?? .null, meta.resume.map { .integer($0) } ?? .null, .integer(meta.resumeComplete ? 1 : 0)])
            try execute("COMMIT")
        } catch { try? execute("ROLLBACK"); throw error }
    }
    /// Persist the current membership before allowing cached data to be reused.
    func authorizeGo(_ namespace: String, _ cid: Int, version: Int, cutoff: Int) throws {
        guard version > 0, cutoff >= 0 else { throw GoV2Error.invalidResponse }
        let t = try ticket(namespace, cid)
        let previous: Int? = try statement("SELECT version FROM go_membership WHERE scope=? AND cid=?", [.text(t.scope), .integer(cid)]) { q in
            sqlite3_step(q) == SQLITE_ROW ? Int(sqlite3_column_int64(q, 0)) : nil
        }
        if let previous, previous > version { throw GoV2Error.membershipChanged }
        if previous != version { try clearConversation(namespace, cid, cutoff: cutoff) }
        try execute("INSERT OR REPLACE INTO go_membership(scope,cid,version) VALUES(?,?,?)", [.text(t.scope), .integer(cid), .integer(version)])
        if cutoff > 0 { try merge(ticket(namespace, cid), items: [], cutoff: cutoff) }
    }
    func savePage(_ t: Ticket, page: IOSChatHistoryPage, maximum: Int = Int.max, cutoff: Int = 0) throws {
        try merge(t, items: page.items, floor: page.items.map(\.id).min() ?? cutoff + 1, maximum: maximum == Int.max ? page.items.map(\.id).max() ?? Int.max : maximum, cutoff: cutoff, cursor: page.nextMaxID, complete: !page.hasMore, latest: maximum == Int.max)
    }
    func clearConversation(_ namespace: String, _ cid: Int, cutoff: Int = 0) throws {
        let t = try ticket(namespace, cid); generation += 1; archiveTask?.cancel(); archiveTask = nil; queue = []
        try execute("BEGIN IMMEDIATE")
        do {
            try execute("DELETE FROM messages WHERE scope=? AND cid=?", [.text(t.scope), .integer(cid)])
            try execute("INSERT OR REPLACE INTO meta(scope,cid,rev,cutoff,barrier) VALUES(?,?,?,?,?)", [.text(t.scope), .integer(cid), .integer(t.revision + 1), .integer(cutoff), .integer(t.barrier + 1)])
            try execute("COMMIT")
        } catch { try? execute("ROLLBACK"); throw error }
    }
    func enqueue(_ client: APIClient, conversationID: Int) {
        let namespace = client.avatarCacheNamespace
        guard namespace == owner, queue.count < 32, !queue.contains(where: { $0.1 == conversationID && $0.2 == namespace }) else { return }
        queue.append((client, conversationID, namespace, generation))
        if archiveTask == nil { archiveTask = Task { await self.pump() } }
    }
    private func pump() async {
        let started = generation
        while !queue.isEmpty, !Task.isCancelled, generation == started {
            let (client, cid, namespace, expected) = queue.removeFirst()
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
                var local = try read(namespace, cid, limit: 1)
                while !local.complete, let cursor = local.cursor, cursor > 0, namespace == owner, generation == expected, !Task.isCancelled {
                    let t = try ticket(namespace, cid), page = try await client.historyPage(conversationID: cid, maximumID: cursor)
                    guard namespace == owner, generation == expected, !Task.isCancelled else { break }
                    if let version = page.membershipVersion {
                        try authorizeGo(namespace, cid, version: version, cutoff: page.clearedBeforeMessageID ?? 0)
                        guard generation == expected else { break }
                    }
                    try savePage(t, page: page, maximum: cursor, cutoff: max(local.cutoff, page.clearedBeforeMessageID ?? 0))
                    if !page.hasMore || page.nextMaxID >= cursor { break }
                    try await Task.sleep(nanoseconds: 150_000_000); local = try read(namespace, cid, limit: 1)
                }
            } catch {
                if IOSLocalChatAccessDenied.matches(error), namespace == owner, generation == expected {
                    try? clearConversation(namespace, cid); await IOSLocalMediaCache.shared.clear()
                }
            }
        }
        if generation == started { archiveTask = nil }
    }
}
