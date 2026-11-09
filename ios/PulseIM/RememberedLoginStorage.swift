import Foundation
import Security

struct RememberedLoginKeychain: RememberedLoginPersistence {
    private let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.pulseim.remembered-logins", kSecAttrAccount as String: "credentials-v1"]
    func read() throws -> Data? {
        var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw RememberedLoginError.unavailable }
        return data
    }
    func write(_ data: Data) throws {
        let values: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let added = query.merging(values) { _, value in value }
            guard SecItemAdd(added as CFDictionary, nil) == errSecSuccess else { throw RememberedLoginError.unavailable }
        } else if status != errSecSuccess { throw RememberedLoginError.unavailable }
    }
}
@MainActor enum IOSRememberedLogins {
    static let repository = RememberedLoginRepository(persistence: RememberedLoginKeychain())
    static func accounts(server: String) throws -> [RememberedLoginAccount] { try repository.read().accounts(server: server) }
    static func credential(id: String, server: String) throws -> RememberedLoginSecret { try repository.read().credential(id: id, server: server) }
    static func remove(server: String, id: String? = nil, account: String? = nil) throws { try repository.remove(server: server, id: id, account: account) }
    static func save(server: String, user: User, account: String, password: String) throws {
        try repository.save(server: server, userID: user.id, account: account, password: password, nickname: user.nickname, avatarURL: user.avatarURL ?? "")
    }
}
