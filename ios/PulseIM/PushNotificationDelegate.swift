import UIKit
import UserNotifications
import AudioToolbox

final class PushNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "pulse_apns_device_token")
        NotificationCenter.default.post(name: .pulsePushTokenUpdated, object: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        #if DEBUG
        print("\(PulseApp.name) APNs registration failed: \(error.localizedDescription)")
        #endif
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let userInfo = notification.request.content.userInfo
        let recipient = (userInfo["user_id"] as? Int) ?? Int(userInfo["user_id"] as? String ?? "")
        if let recipient, recipient != UserDefaults.standard.integer(forKey: "pulse_notification_user_id") {
            completionHandler([])
            return
        }
        guard PulseNotificationStore.shouldPresent(userInfo) else {
            completionHandler([])
            return
        }

        let isReplacement = (userInfo["pulse_redacted_replacement"] as? Bool) ?? false
        if !isReplacement && (PulseNotificationStore.shouldHidePreview(userInfo) || PulseNotificationStore.shouldHideName()) {
            scheduleForegroundReplacement(for: notification, center: center)
            completionHandler([])
            return
        }

        let category = PulseNotificationStore.category(from: userInfo)
        var options: UNNotificationPresentationOptions = [.banner]

        let isMuted = (userInfo["notifications_muted"] as? Bool) ?? (userInfo["muted"] as? Bool) ?? false
        let includeMuted = PulseNotificationStore.bool(forKey: "pulse_badge_muted", defaultValue: true)
        let includeChannels = PulseNotificationStore.bool(forKey: "pulse_badge_channels", defaultValue: true)
        let includePublicGroups = PulseNotificationStore.bool(forKey: "pulse_badge_public_groups", defaultValue: true)
        let isPublicGroup = (userInfo["is_public"] as? Bool) ?? (userInfo["public"] as? Bool) ?? false
        let shouldUpdateBadge = (!isMuted || includeMuted)
            && (category != .channel || includeChannels)
            && (category != .group || !isPublicGroup || includePublicGroups)
        if shouldUpdateBadge { options.insert(.badge) }

        if !isReplacement && PulseNotificationStore.shouldPlaySound(userInfo) {
            PulseNotificationTonePlayer.shared.play(named: PulseNotificationStore.soundName(userInfo))
        }
        if !isReplacement && PulseNotificationStore.bool(forKey: "pulse_in_app_vibration", defaultValue: false) {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }

        completionHandler(options)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let data = response.notification.request.content.userInfo
        func integer(_ key: String) -> Int? { if let value = data[key] as? Int { return value }; if let value = data[key] as? String { return Int(value) }; return nil }
        if let owner = integer("user_id"), let conversation = integer("conversation_id"), owner > 0, conversation > 0 {
            UserDefaults.standard.set(["user_id": owner, "conversation_id": conversation], forKey: "pulse_pending_notification")
            NotificationCenter.default.post(name: .pulsePushOpened, object: nil)
        }
        completionHandler()
    }

    private func scheduleForegroundReplacement(for notification: UNNotification, center: UNUserNotificationCenter) {
        let original = notification.request.content
        let content = UNMutableNotificationContent()
        content.title = PulseNotificationStore.shouldHideName() ? PulseApp.name : original.title
        content.body = PulseNotificationStore.shouldHidePreview(original.userInfo) ? "你有一条新消息" : original.body
        content.sound = nil
        content.badge = original.badge
        var userInfo = original.userInfo
        userInfo["pulse_redacted_replacement"] = true
        content.userInfo = userInfo
        let request = UNNotificationRequest(identifier: "pulse-redacted-\(UUID().uuidString)", content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false))
        center.add(request)
    }
}

extension Notification.Name {
    static let pulseSessionBlocked = Notification.Name("pulseSessionBlocked")
    static let pulsePushOpened = Notification.Name("pulsePushOpened")
    static let pulsePushTokenUpdated = Notification.Name("pulsePushTokenUpdated")
}
