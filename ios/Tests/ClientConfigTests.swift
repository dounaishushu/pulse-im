import Foundation

/// Offline regression checks using the production adapter, typed decoder and
/// Explore entry builder. No account, server or external website is contacted.
@main struct ClientConfigTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: Bool, _ message: String) throws {
        if !value { throw Failure.assertion(message) }
    }
    static func decode(_ raw: [String: Any]) throws -> ClientConfig {
        let mapped = GoV2Adapter.clientConfiguration(raw)
        return try JSONDecoder().decode(ClientConfig.self, from: JSONSerialization.data(withJSONObject: mapped))
    }
    static func main() throws {
        var passed = 0
        func test(_ name: String, _ body: () throws -> Void) throws {
            try body(); passed += 1; print("PASS " + name)
        }
        let links: [[String: Any]] = (1...3).map { index in
            ["id": "navigation-\(index)", "title": "入口\(index)", "url": "https://entry\(index).example.test:\(10000 + index)", "sort_order": index - 1]
        }
        let fixture: [String: Any] = [
            "protocol": "pulse-v2", "announcement": ["body": "官方公告", "title": "提示", "enabled": false],
            "announcement_version": "7", "navigation": links, "shops": links,
            "group_member_limit": 500, "display": ["show_group_count": false],
            "releases": ["ios": ["latest": "1.2.3", "url": "https://download.example.test/ios", "notes": "更新说明", "force": true]],
            "registration_avatar_required": true, "registration": ["per_ip_limit": 3]
        ]
        try test("disabled Go announcement still decodes with all configured Explore entries") {
            let config = try decode(fixture)
            try check(config.exploreLinks.count == 3 && config.mallLinks.count == 3, "configured links lost")
            try check(config.announcement?.enabled == false, "disabled announcement was enabled")
            try check(config.announcement?.id == 1 && config.announcement?.revision == 7, "announcement identity/version missing")
            try check(config.announcement?.content == "官方公告" && config.chatNotice == "官方公告", "body mapping missing")
            let entries = IOSExploreEntry.make(config.exploreLinks + config.mallLinks)
            try check(entries.count == 3 && entries.map(\.name) == ["入口1", "入口2", "入口3"], "Explore entries were filtered or reordered")
            try check(IOSExploreEntry.selected(nil, in: entries)?.url == entries.first?.url, "Explore has no initial selection")
        }
        try test("enabled announcement maps content and changed version") {
            var raw = fixture
            raw["announcement"] = ["body": "更新后的公告", "title": "新提示", "enabled": true]
            raw["announcement_version"] = "8"
            let config = try decode(raw)
            try check(config.announcement?.enabled == true && config.announcement?.title == "新提示", "enabled announcement lost")
            try check(config.announcement?.content == "更新后的公告" && config.announcement?.revision == 8, "announcement change not propagated")
            try check(config.exploreLinks.count == 3, "announcement update removed Explore entries")
        }
        try test("missing announcement does not prevent configuration decoding") {
            var raw = fixture; raw.removeValue(forKey: "announcement"); raw.removeValue(forKey: "announcement_version")
            let config = try decode(raw)
            try check(config.announcement?.enabled == false && config.announcement?.content == "", "missing announcement became visible")
            try check(config.announcement?.revision == 1 && config.exploreLinks.count == 3, "safe announcement default missing")
        }
        try test("null announcement does not hide configured Explore entries") {
            var raw = fixture; raw["announcement"] = NSNull(); raw["announcement_version"] = NSNull()
            let config = try decode(raw)
            try check(config.exploreLinks.count == 3 && config.announcement?.enabled == false, "null announcement blocked Explore")
        }
        try test("integer and unavailable announcement versions use the expected revision") {
            for (input, expected) in [(9 as Any, 9), ("not-a-version" as Any, 1), (NSNull() as Any, 1)] {
                var raw = fixture; raw["announcement_version"] = input
                try check(decode(raw).announcement?.revision == expected, "incorrect revision fallback")
            }
        }
        try test("iOS release, registration and group display policy stay intact") {
            let config = try decode(fixture)
            try check(config.latestVersion == "1.2.3" && config.forceUpdate, "release gate lost")
            try check(config.iosDownloadURL == "https://download.example.test/ios" && config.updateDescription == "更新说明", "release details lost")
            try check(config.groupMemberLimit == 500 && !config.showGroupMemberCount, "group display policy lost")
            try check(config.registerRequireAvatar && config.maxRegisterAccountsPerIP == 3, "registration policy lost")
        }
        try test("valid empty configuration decodes without inventing Explore entries") {
            let config = try decode([:])
            try check(config.exploreLinks.isEmpty && config.mallLinks.isEmpty && IOSExploreEntry.make(config.exploreLinks).isEmpty, "unconfigured links were invented")
        }
        try test("invalid Explore URLs remain filtered while valid entries can open") {
            var raw = fixture
            raw["navigation"] = links + [["title": "invalid", "url": "javascript:alert(1)"]]
            let config = try decode(raw)
            try check(IOSExploreEntry.make(config.exploreLinks).count == 3, "invalid Explore URL accepted")
        }
        print("RESULT passed=\(passed)")
    }
}
