import SwiftUI

@main
struct PulseIMApp: App {
    @UIApplicationDelegateAdaptor(PushNotificationDelegate.self) private var pushDelegate
    @StateObject private var session = AppSession()
    @StateObject private var appLock = AppLockManager()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(session).environmentObject(appLock)
        }
    }
}
