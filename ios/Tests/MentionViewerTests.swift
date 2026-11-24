import Foundation

/// Actual Foundation adapter against the same isolated fixture as Android.
@main struct MentionViewerTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure.assertion(message) }
    }
    static func main() async throws {
        guard let base = URL(string: CommandLine.arguments[1]), base.scheme == "http", base.host == "127.0.0.1" else {
            throw Failure.assertion("loopback fixture required")
        }
        var passed = 0
        for viewer in 1...3 {
            let api = try GoV2Adapter(baseURL: base, token: "mention-viewer-\(viewer)", context: GoV2Context())
            let actor = try api.ids.local("user", String(format: "%08d", viewer) + "-eeee-4eee-8eee-eeeeeeeeeeee")
            let target = try api.ids.local("user", "00000002-eeee-4eee-8eee-eeeeeeeeeeee")
            let author = try api.ids.local("user", "00000001-eeee-4eee-8eee-eeeeeeeeeeee")
            let cid = try api.ids.local("conversation", "00009000-eeee-4eee-8eee-eeeeeeeeeeee")
            let contacts = try JSONDecoder().decode(ContactNamePage.self, from: await api.request(path: "/contacts/names?page=1&size=100", method: "GET", body: [:]))
            var names = Dictionary(uniqueKeysWithValues: contacts.items.map { ($0.userId, $0) })
            var nickname = viewer == 1 ? "发送者昵称" : viewer == 2 ? "被提及者昵称" : "旁观者昵称"
            let resolve: (Int, String) -> String = { id, fallback in
                if id == actor { return nickname }
                guard let record = names[id], !record.displayName.isEmpty else { return fallback }
                return record.displayName
            }
            let page = try JSONDecoder().decode(IOSChatHistoryPage.self, from: await api.request(path: "/messages/history?conversation_id=\(cid)&size=20", method: "GET", body: [:]))
            let message = try require(page.items.first { $0.id == 1 })
            let quote = try require(page.items.first { $0.id == 2 }?.replyReference)
            let raw = message.body, rawQuote = quote.body
            let expected = viewer == 1 ? "@发送方私有备注 你好" : viewer == 2 ? "@被提及者昵称 你好" : "@旁观者自己的备注 你好"
            try check(IOSMentionDisplay.text(message.body, name: resolve) == expected, "viewer \(viewer) saw another account's private note")
            try check(quote.displayText(name: resolve) == expected, "hydrated reply did not retain immutable mention identity")
            let authorName = viewer == 1 ? "发送者昵称" : viewer == 2 ? "接收方给作者的备注" : "旁观者给作者的备注"
            try check(resolve(quote.senderId, quote.senderName) == authorName, "quote author ignored the viewing account's note")
            try check(quote.senderId == author, "reply source identity changed")
            passed += 1
            if viewer == 2 { nickname = "我现在的新昵称" }
            else { names[target] = ContactNameRecord(userId: target, nickname: "被提及者昵称", remark: "新的个人备注") }
            let changed = viewer == 2 ? "@我现在的新昵称 你好" : "@新的个人备注 你好"
            try check(IOSMentionDisplay.text(message.body, name: resolve) == changed && quote.displayText(name: resolve) == changed, "live naming changes were cached into message text")
            if viewer != 2 {
                names[target] = ContactNameRecord(userId: target, nickname: "被提及者昵称", remark: "")
                try check(quote.displayText(name: resolve) == "@被提及者昵称 你好", "cleared note reappeared from the sender's text")
            }
            try check(message.body == raw && quote.body == rawQuote, "displaying a note changed shared message or quote data")
            names = [:]
            let noNotes = viewer == 2 ? "@我现在的新昵称 你好" : "@被提及者昵称 你好"
            try check(IOSMentionDisplay.text(message.body, name: resolve) == noNotes, "another account's notes survived a cleared directory")
            passed += 1
        }
        let body: [String: JSONValue] = ["text": .string("@特殊[备注]($)+ 你好 mail@特殊[备注]($)+"), "mention_user_ids": .array([.number(2)]),
            "mention_users": .array([.object(["user_id": .number(2), "nickname": .string("公开昵称"), "labels": .array([.string("特殊[备注]($)+")])])])]
        try check(IOSMentionDisplay.text(body, name: { _, _ in "本人备注" }) == "@本人备注 你好 mail@特殊[备注]($)+", "literal labels or token boundaries were not respected")
        try check(IOSMentionDisplay.text(["text": .string("手写 @昵称")], name: { _, _ in "不应替换" }) == "手写 @昵称", "unverified text was rewritten")
        let hidden = try require(MessageReplyReference(value: .object(["id": .number(1), "unavailable": .bool(true), "text": .string("隐藏内容"), "sender_name": .string("隐藏备注")])))
        try check(hidden.senderId == 0 && hidden.body.isEmpty && hidden.displayText(name: { _, _ in "隐藏备注" }) == "原消息已不可用", "unavailable reply exposed its source")
        var legacy = body
        legacy["mentions"] = .array([.string("00000002-eeee-4eee-8eee-eeeeeeeeeeee")])
        legacy["mention_users"] = .array([.object(["user_id": .string("00000002-eeee-4eee-8eee-eeeeeeeeeeee"), "nickname": .string("公开昵称"), "labels": .array([.string("特殊[备注]($)+")])])])
        try check(IOSMentionDisplay.text(legacy, name: { _, _ in "本人备注" }) == "@本人备注 你好 mail@特殊[备注]($)+", "older cached UUID metadata was not resolved by its local target")
        let unicode: [String: JSONValue] = ["text": .string("🙂\u{00A0}@备注\u{FEFF}下一句\n@备注"), "mention_user_ids": .array([.number(2)]),
            "mention_users": .array([.object(["user_id": .number(2), "nickname": .string("公开昵称"), "labels": .array([.string("备注")])])])]
        try check(IOSMentionDisplay.text(unicode, name: { _, _ in "本人备注" }) == "🙂\u{00A0}@本人备注\u{FEFF}下一句\n@本人备注", "Unicode boundaries changed the mention identity")
        passed += 4
        print("PASS \(passed) iOS viewer-specific mention/reply checks")
    }
    static func require<T>(_ value: T?) throws -> T {
        guard let value else { throw Failure.assertion("missing fixture value") }
        return value
    }
}
