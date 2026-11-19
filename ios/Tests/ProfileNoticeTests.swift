import Foundation

/// Offline checks against production models and the Go profile adapter.
@main struct ProfileNoticeTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: Bool, _ message: String) throws {
        if !value { throw Failure.assertion(message) }
    }
    static func main() throws {
        var passed = 0
        func test(_ name: String, _ action: () throws -> Void) throws {
            try action(); passed += 1; print("PASS " + name)
        }
        let current: [String: Any] = ["version": "9", "nickname": "群组管理员", "account": "admin001",
                                      "birthday": "2000-01-02", "gender": "male", "bio": "个人简介"]
        try test("selecting female sends the Go enum and preserves the profile version") {
            let patch = try GoV2Adapter.profilePatch(current: current, requested: [
                "nickname": "群组管理员", "username": "admin001", "birthday": "2000-01-02",
                "gender": "女", "signature": "个人简介", "avatar_url": "https://fixture.invalid/avatar.png"])
            try check(patch["gender"] as? String == "female" && patch["expected_version"] as? String == "9", "female/version mapping failed")
            try check(patch.count == 2 && patch["account"] == nil && patch["avatar_url"] == nil, "unchanged or unsupported fields were sent")
        }
        try test("all picker choices map to accepted Go values") {
            try check(try IOSProfileGender.serverValue("男") == "male", "male mapping")
            try check(try IOSProfileGender.serverValue("保密") == "unspecified", "private mapping")
            try check(try IOSProfileGender.serverValue(" FEMALE ") == "female", "existing server enum mapping")
            try check(try IOSProfileGender.serverValue("") == "unspecified", "empty legacy value mapping")
        }
        try test("reopening a saved profile selects the corresponding Chinese picker row") {
            try check(IOSProfileGender.display("male") == "男" && IOSProfileGender.display("female") == "女", "picker labels mismatch")
            try check(IOSProfileGender.display("unspecified") == "保密" && IOSProfileGender.display(nil) == "保密", "private picker row mismatch")
            try check(IOSProfileGender.matches("女", "female") && !IOSProfileGender.matches("男", "female"), "saved gender validation mismatch")
        }
        try test("saving an unchanged legacy account does not consume an account change") {
            var legacy = current; legacy["account"] = "Legacy.Name"
            let patch = try GoV2Adapter.profilePatch(current: legacy, requested: ["username": "Legacy.Name", "gender": "male"])
            try check(patch.count == 1 && patch["account"] == nil, "unchanged legacy account was rewritten")
        }
        try test("an explicit account change is normalized and only changed fields are written") {
            let patch = try GoV2Adapter.profilePatch(current: current, requested: ["username": " NewUser ", "signature": "新的简介"])
            try check(patch["account"] as? String == "newuser" && patch["bio"] as? String == "新的简介", "changed field mapping")
            try check(patch.count == 3 && patch["gender"] == nil && patch["birthday"] == nil, "unrequested fields were overwritten")
        }
        try test("invalid gender and invalid profile versions fail before mutation") {
            var rejected = 0
            do { _ = try GoV2Adapter.profilePatch(current: current, requested: ["gender": "invalid"]) } catch { rejected += 1 }
            do { _ = try GoV2Adapter.profilePatch(current: [:], requested: ["gender": "女"]) } catch { rejected += 1 }
            do { _ = try GoV2Adapter.profilePatch(current: current, requested: ["gender": false]) } catch { rejected += 1 }
            do { _ = try GoV2Adapter.profilePatch(current: ["version": "0"], requested: ["gender": "女"]) } catch { rejected += 1 }
            try check(rejected == 4, "invalid payload was silently accepted")
        }
        try test("chat notice replaces every app-name placeholder using the actual display name") {
            try check(ClientNoticeTemplate.render("欢迎来到{app_name}！{app_name}公告", appName: "小猿口算") == "欢迎来到小猿口算！小猿口算公告", "notice placeholder remains")
            try check(ClientNoticeTemplate.render("欢迎来到{{app_name}}", appName: "新的应用名") == "欢迎来到新的应用名", "alternate placeholder or custom name failed")
        }
        try test("literal text, unknown placeholders and special characters are preserved") {
            try check(ClientNoticeTemplate.render("普通公告 {user_name}", appName: "应用") == "普通公告 {user_name}", "unrelated content was changed")
            try check(ClientNoticeTemplate.render("{app_name}", appName: "$1 & 应用") == "$1 & 应用", "name was interpreted as markup")
        }
        try test("announcement rendering retains enable state and dismissal identity") {
            let data = Data(#"{"id":7,"title":"{app_name}公告","content":"欢迎来到{app_name}","enabled":false,"revision":42,"updated_at":"2026-11-20"}"#.utf8)
            let raw = try JSONDecoder().decode(ClientAnnouncement.self, from: data)
            let rendered = raw.rendered(appName: "小猿口算")
            try check(rendered.title == "小猿口算公告" && rendered.content == "欢迎来到小猿口算", "announcement text was not rendered")
            try check(!rendered.enabled && rendered.id == 7 && rendered.revision == 42 && rendered.updatedAt == raw.updatedAt, "announcement state was modified")
        }
        print("RESULT passed=\(passed) failed=0")
    }
}
