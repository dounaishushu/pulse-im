import Foundation

enum IOSExploreURL {
    static func parse(_ raw: String) -> URL? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return url
    }
}

struct IOSExploreEntry: Identifiable, Equatable {
    let id: String
    let name: String
    let url: URL

    static func make(_ links: [ClientExternalLink]) -> [IOSExploreEntry] {
        var urls = Set<String>(), identities = Set<String>()
        return links.enumerated().compactMap { index, link in
            guard let url = IOSExploreURL.parse(link.url), urls.insert(url.absoluteString).inserted else { return nil }
            let base = link.id > 0 ? "configured-\(link.id)" : "position-\(index)"
            let id = identities.insert(base).inserted ? base : "\(base)-position-\(index)"
            let name = link.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return IOSExploreEntry(id: id, name: name.isEmpty ? "探索" : name, url: url)
        }
    }
    static func selected(_ id: String?, in entries: [IOSExploreEntry]) -> IOSExploreEntry? {
        entries.first(where: { $0.id == id }) ?? entries.first
    }
}

enum IOSExploreLoadFailure {
    static func isCancellation(_ failure: Error) -> Bool {
        let error = failure as NSError
        return error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled
    }
    static func message(_ failure: Error) -> String {
        let error = failure as NSError
        guard error.domain == NSURLErrorDomain else { return "网页加载失败，请稍后重试" }
        switch error.code {
        case NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid:
            return "网站安全证书验证失败，请联系网站管理员修复后重试"
        case NSURLErrorSecureConnectionFailed:
            return "无法与网站建立安全连接，请联系网站管理员"
        case NSURLErrorAppTransportSecurityRequiresSecureConnection:
            return "网站连接不符合系统安全要求，请联系管理员检查链接"
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
            return "网络连接已断开，请联网后重试"
        case NSURLErrorTimedOut:
            return "网页加载超时，请重试"
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorCannotConnectToHost:
            return "无法连接网站，请检查网络或联系管理员核对地址"
        case NSURLErrorHTTPTooManyRedirects:
            return "网页跳转异常，请联系网站管理员"
        default:
            return "网页加载失败，请稍后重试"
        }
    }
}
