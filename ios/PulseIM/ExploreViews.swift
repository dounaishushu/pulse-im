import SwiftUI
import WebKit
import Security

/// External pages use account-isolated website data and no app credentials.
@MainActor fileprivate final class IOSExploreBrowser: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    let rootURL: URL
    @Published private(set) var loading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var error = ""
    private var active = false
    private var visibilityID: UUID?
    private var hasCommittedPage = false
    private var navigation: WKNavigation?
    private var failedURL: URL?
    private var backObservation: NSKeyValueObservation?

    init(url: URL, dataStore: WKWebsiteDataStore) {
        rootURL = url
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.allowsBackForwardNavigationGestures = false
    }
    func start(visibility: UUID = UUID()) {
        visibilityID = visibility
        guard !active else { return }
        active = true; webView.navigationDelegate = self; webView.uiDelegate = self
        webView.setAllMediaPlaybackSuspended(false, completionHandler: nil)
        backObservation = webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active else { return }
                self.canGoBack = view.canGoBack
            }
        }
        if !hasCommittedPage { home() }
    }
    func stop(visibility: UUID? = nil) {
        guard visibility == nil || visibility == visibilityID else { return }
        active = false; visibilityID = nil; navigation = nil
        backObservation?.invalidate(); backObservation = nil
        // Keep the weak delegates installed so scripts in the retained document
        // cannot navigate while the page is inactive (decidePolicy cancels).
        webView.stopLoading(); webView.setAllMediaPlaybackSuspended(true, completionHandler: nil)
        loading = false
        #if os(iOS)
        webView.endEditing(true)
        #endif
    }
    private func load(_ request: URLRequest) {
        guard active, let url = request.url, IOSExploreURL.parse(url.absoluteString) != nil else { return }
        error = ""; failedURL = nil; loading = true
        navigation = webView.load(request)
    }
    private func request(_ url: URL) -> URLRequest {
        URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
    }
    func back() {
        guard active, webView.canGoBack else { return }
        error = ""; failedURL = nil; loading = true; navigation = webView.goBack()
    }
    func home() { load(request(rootURL)) }
    func reload() {
        guard active else { return }
        if let failedURL { load(request(failedURL)) }
        else {
            error = ""; loading = true
            navigation = webView.reloadFromOrigin() ?? webView.load(request(rootURL))
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard active, let url = action.request.url else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == false && url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        guard IOSExploreURL.parse(url.absoluteString) != nil else { decisionHandler(.cancel); return }
        if action.targetFrame == nil {
            decisionHandler(.cancel)
            // Keep POST bodies and the website's request semantics for new-window links.
            load(action.request)
        } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard active, rootURL.scheme?.lowercased() == "https", space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              space.host.caseInsensitiveCompare(rootURL.host ?? "") == .orderedSame,
              space.port == (rootURL.port ?? 443), let original = space.serverTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        IOSExploreCertificateTrust.evaluateSupplemented(original, host: space.host) { [weak self] trusted in
            Task { @MainActor [weak self] in
                guard let self, self.active else { completionHandler(.cancelAuthenticationChallenge, nil); return }
                if let trusted { completionHandler(.useCredential, URLCredential(trust: trusted)) }
                else { completionHandler(.performDefaultHandling, nil) }
            }
        }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation value: WKNavigation!) {
        guard active else { return }
        navigation = value; error = ""; loading = true; canGoBack = webView.canGoBack
    }
    func webView(_ webView: WKWebView, didFinish value: WKNavigation!) {
        guard active, value === navigation else { return }
        hasCommittedPage = true
        loading = false; error = ""; failedURL = nil; canGoBack = webView.canGoBack
    }
    func webView(_ webView: WKWebView, didCommit value: WKNavigation!) {
        guard active, value === navigation else { return }
        hasCommittedPage = true
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard active else { decisionHandler(.cancel); return }
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            failedURL = http.url; error = "网站返回错误（\(http.statusCode)），请稍后重试"; loading = false; canGoBack = webView.canGoBack
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }
    private func failed(_ value: WKNavigation?, _ failure: Error) {
        guard active, value === navigation, !IOSExploreLoadFailure.isCancellation(failure) else { return }
        let info = (failure as NSError).userInfo
        failedURL = (info[NSURLErrorFailingURLErrorKey] as? URL).flatMap { IOSExploreURL.parse($0.absoluteString) } ?? webView.url ?? rootURL
        error = IOSExploreLoadFailure.message(failure); loading = false; canGoBack = webView.canGoBack
    }
    func webView(_ webView: WKWebView, didFail value: WKNavigation!, withError error: Error) { failed(value, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation value: WKNavigation!, withError error: Error) { failed(value, error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // A retained page can lose its WebKit process while another tab is open.
        // Preserve the retry state so returning never exposes a silent blank view.
        failedURL = webView.url ?? rootURL; error = "页面已停止，请点击重试"; loading = false
    }
}

/// Owned by the tab container, not the conditional Explore view. Retain only the
/// selected browser so tab switches preserve DOM/sessionStorage without keeping
/// a web process for every configured entry.
@MainActor final class IOSExploreSession: ObservableObject {
    @Published var selectedID: String?
    private struct Page: Equatable { let account: IOSExploreAccountScope; let entryID: String; let url: URL }
    private let defaults: UserDefaults
    private var page: Page?
    private var current: IOSExploreBrowser?
    private var profile: IOSExploreWebsiteProfile?
    private var dataStore: WKWebsiteDataStore?

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    fileprivate func browser(for entry: IOSExploreEntry, account: IOSExploreAccountScope) -> IOSExploreBrowser {
        let next = Page(account: account, entryID: entry.id, url: entry.url)
        if page == next, let current { return current }
        current?.stop()
        let browser = IOSExploreBrowser(url: entry.url, dataStore: websiteData(for: account.websiteProfile))
        page = next; current = browser
        return browser
    }

    private func websiteData(for profile: IOSExploreWebsiteProfile) -> WKWebsiteDataStore {
        if self.profile == profile, let dataStore { return dataStore }
        let store: WKWebsiteDataStore
        if #available(iOS 17.0, macOS 14.0, *) {
            store = WKWebsiteDataStore(forIdentifier: profile.identifier(defaults: defaults))
        } else {
            // iOS 16 cannot create separate persistent WebKit profiles. Keep
            // its store for this account's tab lifetime, never share .default().
            store = .nonPersistent()
        }
        self.profile = profile; dataStore = store
        return store
    }
}

#if os(iOS)
@MainActor private struct IOSExploreWebSurface: UIViewRepresentable {
    let browser: IOSExploreBrowser
    func makeUIView(context: Context) -> WKWebView { browser.webView }
    // Equal configuration refreshes preserve navigation, cookies and form state.
    func updateUIView(_ view: WKWebView, context: Context) {}
}

@MainActor private struct IOSExplorePage: View {
    @Environment(\.pulseTabBack) private var tabBack
    let entry: IOSExploreEntry
    let entries: [IOSExploreEntry]
    let select: (String) -> Void
    /// False means a changed account/URL will create its own new browser.
    let refreshConfiguration: () async -> Bool
    let configurationError: String
    @StateObject private var browser: IOSExploreBrowser
    @State private var visibilityID = UUID()
    @State private var refreshing = false
    @State private var refreshTask: Task<Void, Never>?

    init(entry: IOSExploreEntry, entries: [IOSExploreEntry], browser: IOSExploreBrowser, select: @escaping (String) -> Void,
         configurationError: String, refreshConfiguration: @escaping () async -> Bool) {
        self.entry = entry; self.entries = entries; self.select = select
        self.configurationError = configurationError; self.refreshConfiguration = refreshConfiguration
        _browser = StateObject(wrappedValue: browser)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ScrollView(.horizontal) {
                    HStack(spacing: 4) {
                        ForEach(entries) { item in
                            Button { select(item.id) } label: {
                                Text(item.name).font(.system(size: 15, weight: item.id == entry.id ? .semibold : .regular))
                                    .foregroundStyle(item.id == entry.id ? PulsePalette.accent : PulsePalette.muted)
                                    .padding(.horizontal, 12).frame(minHeight: 44)
                                    .background(item.id == entry.id ? PulsePalette.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                            }.buttonStyle(.plain).accessibilityIdentifier("explore_entry_\(item.id)")
                        }
                    }
                }.scrollIndicators(.hidden)
                HStack(spacing: 0) {
                    Button { browser.home() } label: { Label("首页", systemImage: "house").frame(width: 44, height: 44).contentShape(Rectangle()) }
                        .accessibilityIdentifier("explore_home")
                    Button { refresh() } label: { Label("刷新", systemImage: "arrow.clockwise").frame(width: 44, height: 44).contentShape(Rectangle()) }
                        .disabled(refreshing).accessibilityIdentifier("explore_refresh")
                }.labelStyle(.iconOnly).font(.system(size: 19)).fixedSize(horizontal: true, vertical: false)
            }.padding(.horizontal, 8).frame(height: 48).background(PulsePalette.surface)
                .accessibilityIdentifier("explore_tab_toolbar")
            if !configurationError.isEmpty {
                Text(configurationError).font(.caption).foregroundStyle(PulsePalette.danger)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 8)
            }
            ZStack(alignment: .topTrailing) {
                IOSExploreWebSurface(browser: browser)
                if browser.loading && browser.error.isEmpty { ProgressView().accessibilityLabel("页面加载中").padding(12) }
                if !browser.error.isEmpty {
                    VStack(spacing: 14) {
                        Image(systemName: "wifi.exclamationmark").font(.title)
                        Text(browser.error).multilineTextAlignment(.center).accessibilityIdentifier("explore_load_error")
                        Button("重新加载") { refresh() }.buttonStyle(PulseSmallButtonStyle()).disabled(refreshing)
                    }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(PulsePalette.background)
                }
            }
        }
        .pulseSwipeBack(enabled: browser.canGoBack || tabBack.enabled, identity: browser.webView.url?.absoluteString ?? "explore") {
            if browser.canGoBack { browser.back() } else { tabBack.perform() }
        }
        .task { browser.start(visibility: visibilityID) }
        .onDisappear { refreshTask?.cancel(); refreshing = false; browser.stop(visibility: visibilityID) }
    }
    private func refresh() {
        guard !refreshing else { return }
        refreshing = true
        refreshTask = Task {
            let unchanged = await refreshConfiguration()
            guard !Task.isCancelled else { return }
            if unchanged { browser.reload() }
            refreshing = false
        }
    }
}

@MainActor struct ExploreView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var browsing: IOSExploreSession
    private struct PageScope: Hashable { let account: IOSExploreAccountScope; let entryID: String; let url: String }
    private var entries: [IOSExploreEntry] { IOSExploreEntry.make(session.exploreLinks) }
    private var selected: IOSExploreEntry? { IOSExploreEntry.selected(browsing.selectedID, in: entries) }
    private var scope: IOSExploreAccountScope { IOSExploreAccountScope(userID: session.user?.id ?? 0, token: session.token ?? "", endpoint: APIClient.shared.endpointIdentity, server: APIClient.shared.serverIdentity) }

    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 0) {
                if let selected, session.isSignedIn, !appLock.isLocked, !session.updateRequired, scenePhase != .background {
                    let owner = scope
                    IOSExplorePage(entry: selected, entries: entries, browser: browsing.browser(for: selected, account: owner), select: { browsing.selectedID = $0 }, configurationError: session.clientConfigError) {
                        await session.loadClientConfig()
                        return scope == owner && self.selected?.id == selected.id && self.selected?.url == selected.url
                    }
                    .id(PageScope(account: owner, entryID: selected.id, url: selected.url.absoluteString))
                } else if entries.isEmpty {
                    EmptyState(icon: "bag", title: session.exploreLinks.isEmpty ? "暂无探索入口" : "探索入口配置无效", message: session.clientConfigError.isEmpty ? "请联系管理员检查页面配置" : session.clientConfigError).padding(.top, 80)
                    Button("重新加载入口") { Task { await session.loadClientConfig() } }.buttonStyle(PulseSmallButtonStyle())
                    Spacer()
                } else { Color.clear }
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(PulsePalette.background)
            .toolbar(.hidden, for: .navigationBar)
            .task { await session.loadClientConfig() }
            .pulseOnChange(of: session.token) { _ in browsing.selectedID = nil }
        }
    }
}
#endif
