import Foundation
import CryptoKit

/// Automatic reminders use a rolling 24-hour window, independent of notice text
/// and login-token renewal. Banner rendering and explicit opening have no gate.
struct GroupNoticeReminderHistory {
    static let interval: TimeInterval = 24 * 60 * 60
    private let defaults: UserDefaults
    private let key: String

    init?(endpoint: String, userID: Int, groupID: Int, defaults: UserDefaults = .standard) {
        let server = endpoint.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !server.isEmpty, userID > 0, groupID > 0 else { return nil }
        let identity = "\(server)\u{0}\(userID)\u{0}\(groupID)"
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        self.key = "pulse_group_notice_last_presented_v1_" + digest
        self.defaults = defaults
    }

    func shouldPresentAutomatically(at date: Date = Date()) -> Bool {
        let now = date.timeIntervalSince1970
        guard now.isFinite, now > 0 else { return false }
        guard let last = (defaults.object(forKey: key) as? NSNumber)?.doubleValue, last.isFinite, last > 0 else { return true }
        return now - last >= Self.interval
    }

    /// Call only when the dialog actually appears, including explicit openings.
    /// Merely loading metadata or preparing a blocked presentation consumes nothing.
    @discardableResult func markPresented(at date: Date = Date()) -> Bool {
        let time = date.timeIntervalSince1970
        guard time.isFinite, time > 0 else { return false }
        defaults.set(time, forKey: key)
        return true
    }
}
