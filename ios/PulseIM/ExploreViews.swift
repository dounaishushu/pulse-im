import SwiftUI
import WebKit
import Security

/// External pages use isolated website data, default TLS trust and no app credentials.
@MainActor private final class IOSExploreBrowser: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    let rootURL: URL
    @Published private(set) var loading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var error = ""
    private var active = false
    private var navigation: WKNavigation?
    private var failedURL: URL?
    private var backObservation: NSKeyValueObservation?

    init(url: URL) {
        rootURL = url
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.allowsBackForwardNavigationGestures = false
    }
    func start() {
        guard !active else { return }
        active = true; webView.navigationDelegate = self; webView.uiDelegate = self
        backObservation = webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active else { return }
                self.canGoBack = view.canGoBack
            }
        }
        home()
    }
    func stop() {
        active = false; navigation = nil
        backObservation?.invalidate(); backObservation = nil
        webView.stopLoading(); webView.navigationDelegate = nil; webView.uiDelegate = nil
        webView.loadHTMLString("", baseURL: nil)
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
        loading = false; error = ""; failedURL = nil; canGoBack = webView.canGoBack
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
        guard active else { return }
        failedURL = webView.url ?? rootURL; error = "页面已停止，请点击重试"; loading = false
    }
}

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
    @State private var refreshing = false
    @State private var refreshTask: Task<Void, Never>?

    init(entry: IOSExploreEntry, entries: [IOSExploreEntry], select: @escaping (String) -> Void,
         configurationError: String, refreshConfiguration: @escaping () async -> Bool) {
        self.entry = entry; self.entries = entries; self.select = select
        self.configurationError = configurationError; self.refreshConfiguration = refreshConfiguration
        _browser = StateObject(wrappedValue: IOSExploreBrowser(url: entry.url))
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
        .task { browser.start() }
        .onDisappear { refreshTask?.cancel(); refreshing = false; browser.stop() }
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

struct ExploreView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedID: String?
    private struct Scope: Hashable { let userID: Int; let token: String; let endpoint: String }
    private struct PageScope: Hashable { let account: Scope; let entryID: String; let url: String }
    private var entries: [IOSExploreEntry] { IOSExploreEntry.make(session.exploreLinks) }
    private var selected: IOSExploreEntry? { IOSExploreEntry.selected(selectedID, in: entries) }
    private var scope: Scope { Scope(userID: session.user?.id ?? 0, token: session.token ?? "", endpoint: APIClient.shared.endpointIdentity) }

    var body: some View {
        PulseNavigationStack {
            VStack(spacing: 0) {
                if let selected, session.isSignedIn, !appLock.isLocked, !session.updateRequired, scenePhase != .background {
                    let owner = scope
                    IOSExplorePage(entry: selected, entries: entries, select: { selectedID = $0 }, configurationError: session.clientConfigError) {
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
            .pulseOnChange(of: session.token) { _ in selectedID = nil }
        }
    }
}
