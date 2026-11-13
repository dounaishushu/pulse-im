import Foundation

enum RegistrationRules {
    static func accountError(_ account: String, password: String) -> String? {
        guard account.range(of: "^[A-Za-z][A-Za-z0-9]{4,9}\\z", options: .regularExpression) != nil, account.range(of: "[0-9]", options: .regularExpression) != nil else {
            return "用户名需5到10位，以字母开头，包含字母和数字"
        }
        guard (8...16).contains(password.utf8.count),
              password.range(of: "[A-Za-z]", options: .regularExpression) != nil,
              password.range(of: "[0-9]", options: .regularExpression) != nil,
              !password.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) else {
            return "密码需8~16位，包含字母和数字，不能有空格"
        }
        return nil
    }
    static func nicknameError(_ value: String) -> String? {
        (2...32).contains(value.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count) ? nil : "昵称需要2~32个字符"
    }
    static func isCaptchaCode(_ value: String, goV2: Bool = false) -> Bool {
        value.range(of: goV2 ? "^[A-Za-z0-9]{5}\\z" : "^[0-9]{4}\\z", options: .regularExpression) != nil
    }
}

/// Monotonic deadlines and request generations keep old images from authorizing
/// a newer form or a different server. Verification consumes the local proof.
struct RegistrationCaptchaState {
    struct Proof: Equatable { let id: String; let endpoint: String; let deadline: TimeInterval }
    private(set) var generation: UInt = 0
    private(set) var proof: Proof?
    @discardableResult mutating func invalidate() -> UInt { generation &+= 1; proof = nil; return generation }
    mutating func install(id: String, endpoint: String, ttl: Int, requestedAt: TimeInterval, now: TimeInterval, generation request: UInt) -> Bool {
        guard request == generation,
              id.range(of: "^[a-f0-9]{64}\\z", options: .regularExpression) != nil,
              !endpoint.isEmpty, (1...120).contains(ttl), requestedAt.isFinite, now.isFinite,
              requestedAt <= now, requestedAt + Double(ttl) > now else { return false }
        proof = Proof(id: id, endpoint: endpoint, deadline: requestedAt + Double(ttl)); return true
    }
    func valid(endpoint: String, now: TimeInterval) -> Bool {
        guard let proof else { return false }; return proof.endpoint == endpoint && now.isFinite && now < proof.deadline
    }
    mutating func consume(endpoint: String, now: TimeInterval) -> Proof? {
        let value = valid(endpoint: endpoint, now: now) ? proof : nil
        invalidate(); return value
    }
}
