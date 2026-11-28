import AppKit

// Appended to the unmodified production ExploreViews.swift by the runner so
// these checks exercise its actual fileprivate browser, not a mock or copy.
@main @MainActor struct ExploreSessionWebKitTests {
    enum Failure: Error { case assertion(String) }
    static var passed = 0

    static func check(_ value: Bool, _ label: String) throws {
        guard value else { throw Failure.assertion(label) }
        passed += 1; print("PASS: " + label)
    }

    static func waitForPage(_ browser: IOSExploreBrowser, path: String) async throws {
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline {
            if !browser.error.isEmpty { throw Failure.assertion(browser.error) }
            if !browser.loading, browser.webView.url?.path == path,
               (try? await browser.webView.evaluateJavaScript("document.readyState")) as? String == "complete" { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw Failure.assertion("Timed out waiting for fixture page " + path)
    }

    static func stats(_ base: URL) async throws -> [String: Int] {
        let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("stats"))
        return try JSONDecoder().decode([String: Int].self, from: data)
    }

    static func main() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let args = CommandLine.arguments
        guard args.count == 4, let base = URL(string: args[2]), let defaults = UserDefaults(suiteName: args[3]) else {
            throw Failure.assertion("Expected phase, loopback URL and unique test defaults suite")
        }
        let a = IOSExploreAccountScope(userID: 7, token: "fixture-token", endpoint: "fixture-route-1", server: "https://backend-a.example.invalid/api/v2")
        let b = IOSExploreAccountScope(userID: 8, token: "fixture-token-b", endpoint: a.endpoint, server: a.server)
        let c = IOSExploreAccountScope(userID: a.userID, token: a.token, endpoint: "fixture-route-c", server: "https://backend-b.example.invalid/api/v2")
        let profiles = [a.websiteProfile, b.websiteProfile, c.websiteProfile]
        if args[1] == "cleanup" {
            for profile in profiles {
                let store = WKWebsiteDataStore(forIdentifier: profile.identifier(defaults: defaults))
                await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            }
            defaults.removePersistentDomain(forName: args[3])
            return
        }
        let entry = IOSExploreEntry(id: "mall", name: "Mall", url: base)
        let session = IOSExploreSession(defaults: defaults)
        session.selectedID = entry.id
        let browser = session.browser(for: entry, account: a)
        try check(browser.webView.configuration.websiteDataStore.isPersistent, "supported systems use a persistent WebKit profile")

        if args[1] == "seed" {
            browser.start()
            try await waitForPage(browser, path: "/")
            _ = try await browser.webView.evaluateJavaScript("document.getElementById('sign-in').click(); true")
            try await waitForPage(browser, path: "/account")
            _ = try await browser.webView.evaluateJavaScript("localStorage.setItem('mall-login', 'persisted'); sessionStorage.setItem('tab-marker', 'retained'); document.getElementById('draft').value = 'unsent draft'; true")
            let before = try await stats(base)
            browser.stop()
            _ = try await browser.webView.evaluateJavaScript("window.location.href = '/'; true")
            try await Task.sleep(for: .milliseconds(200))
            try check(try await stats(base) == before, "inactive cached documents cannot navigate in the background")
            let returned = session.browser(for: entry, account: a)
            try check(returned === browser, "returning from another app tab reuses the same browser")
            try check(session.selectedID == entry.id, "selected mall entry survives app tab switches")
            returned.start()
            try await Task.sleep(for: .milliseconds(200))
            try check(returned.webView.url?.path == "/account", "returning does not navigate to the mall login/home page")
            let local = try await returned.webView.evaluateJavaScript("localStorage.getItem('mall-login')") as? String
            let temporary = try await returned.webView.evaluateJavaScript("sessionStorage.getItem('tab-marker')") as? String
            let draft = try await returned.webView.evaluateJavaScript("document.getElementById('draft').value") as? String
            try check(local == "persisted" && temporary == "retained" && draft == "unsent draft", "localStorage, sessionStorage and DOM survive suspend/resume")
            try check(try await stats(base) == before, "switching app tabs does not issue another website request")
            let renamed = IOSExploreEntry(id: entry.id, name: "Renamed Mall", url: entry.url)
            try check(session.browser(for: renamed, account: a) === browser, "a configuration title change preserves the browser")
            let firstVisibility = UUID(), nextVisibility = UUID()
            browser.start(visibility: firstVisibility)
            browser.start(visibility: nextVisibility)
            browser.stop(visibility: firstVisibility)
            browser.reload()
            try check(browser.loading, "a late disappearance from the old page cannot stop its replacement")
            try await waitForPage(browser, path: "/account")
            browser.stop()
            browser.start()
            try check(try await browser.webView.evaluateJavaScript("sessionStorage.getItem('tab-marker')") as? String == "retained", "background/lock suspension does not blank the document")
            browser.stop()
            browser.webViewWebContentProcessDidTerminate(browser.webView)
            browser.start()
            try check(!browser.error.isEmpty, "WebKit termination while another tab is open retains a visible retry state")
            browser.reload()
            try await waitForPage(browser, path: "/account")
            try check(browser.error.isEmpty, "retrying the retained page restores its logged-in account")

            let revised = IOSExploreAccountScope(userID: a.userID, token: "new-fixture-token", endpoint: "fixture-route-2", server: a.server)
            try check(revised.websiteProfile.identifier(defaults: defaults) == a.websiteProfile.identifier(defaults: defaults), "IM token/endpoint revisions do not change the persistent website profile")
            try check(Set(profiles.map { $0.identifier(defaults: defaults) }).count == 3, "different users and servers receive separate website stores")
            for account in [b, c] {
                let other = session.browser(for: entry, account: account)
                other.start()
                try await waitForPage(other, path: "/")
                try check(try await other.webView.evaluateJavaScript("localStorage.getItem('mall-login')") is NSNull, "another user/server cannot read the mall login storage")
                let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
                    other.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
                }
                try check(!cookies.contains(where: { $0.name == "mall_session" }), "another user/server cannot reuse the mall login cookie")
                other.stop()
            }
        } else if args[1] == "verify" {
            browser.start()
            try await waitForPage(browser, path: "/account")
            try check(try await browser.webView.evaluateJavaScript("localStorage.getItem('mall-login')") as? String == "persisted", "a fresh OS process restores the persistent mall storage and login cookie")
            try check(try await browser.webView.evaluateJavaScript("sessionStorage.getItem('tab-marker')") is NSNull, "restart verification uses a new document, not the retained browser from seed")
            browser.stop()
        } else { throw Failure.assertion("Unknown test phase") }
        print("PASS: \(passed) WebKit session checks (\(args[1]))")
    }
}
