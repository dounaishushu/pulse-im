import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Runs the shipping adapter against chat-delta-fixture.py, without real accounts.
@main struct ChatDeltaTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: Bool, _ label: String) throws { if !value { throw Failure.assertion(label) } }
    static func control(_ base: URL, _ path: String) async throws -> [String: Int] {
        let (data, _) = try await URLSession.shared.data(from: URL(string: base.absoluteString + path)!)
        return try JSONDecoder().decode([String: Int].self, from: data)
    }
    static func main() async {
        do { try await run() } catch { print("FAIL: \(error)"); exit(1) }
    }
    static func run() async throws {
        let base = URL(string: CommandLine.arguments[1])!
        guard base.host == "127.0.0.1", base.scheme == "http" else { throw Failure.assertion("isolated fixture required") }
        let wire = "10000000-0000-4000-8000-000000000001"
        var passed = 0
        func make(_ mode: String) async throws -> (GoV2Adapter, Int) {
            _ = try await control(base, "/test-mode?mode=" + mode)
            let context = GoV2Context()
            let api = try GoV2Adapter(baseURL: base, token: "isolated-delta-test", context: context)
            let cid = try api.ids.local("conversation", wire)
            _ = try context.membership(cid, version: 1)
            return (api, cid)
        }
        func delta(_ api: GoV2Adapter, _ cid: Int) async throws -> IOSChatDelta {
            try JSONDecoder().decode(IOSChatDelta.self, from: await api.request(path: "/messages/delta?conversation_id=\(cid)&events=1000&personal=7&membership=1"))
        }
        for mode in ["empty", "append", "paged", "edited", "revoked", "deleted", "cleared", "reminder", "long-gap", "cutoff-race"] {
            let (api, cid) = try await make(mode), result = try await delta(api, cid)
            let stats = try await control(base, "/test-stats")
            try check(stats["history"] == 0, "\(mode): adapter delta must never read history")
            switch mode {
            case "empty":
                try check(result.items.isEmpty && !result.needsSnapshot && result.cursor.events == 1000, "empty delta")
                try check(stats["sync"] == 1 && stats["personal"] == 1 && stats["info"] == 1, "idle work stays constant regardless of retained history")
            case "append":
                try check(result.items.map(\.id).sorted() == [1001, 1002, 1003] && !result.needsSnapshot, "created rows")
                try check(result.cursor.events == 1003, "later metadata must not advance past unseen concurrent sends")
            case "paged":
                try check(result.items.count == 200 && result.cursor.events == 1200 && stats["sync"] == 2, "bounded snapshot pagination")
            case "edited", "revoked", "deleted", "cleared":
                try check(result.needsSnapshot && result.items.isEmpty, "destructive changes require authoritative snapshot, including old quotes")
            case "reminder":
                try check(!result.needsSnapshot && result.cursor.personal == 8, "reminder does not reload message bodies")
            case "long-gap":
                try check(result.needsSnapshot && result.cursor.events == 5001 && stats["sync"] == 1, "long offline gaps use a checkpoint preceding the fallback snapshot")
            case "cutoff-race":
                try check(result.items.isEmpty && result.clearedBeforeMessageID == 1003, "a concurrent clear fences all earlier creates")
            default: break
            }
            passed += 1; print("PASS: " + mode)
        }
        for mode in ["wrong-chat", "non-progress", "bad-sequence", "changed-upper", "bad-personal", "membership", "late-membership", "denied"] {
            let (api, cid) = try await make(mode)
            var rejected = false
            do { _ = try await delta(api, cid) }
            catch GoV2Error.invalidResponse where ["wrong-chat", "non-progress", "bad-sequence", "changed-upper", "bad-personal"].contains(mode) { rejected = true }
            catch GoV2Error.membershipChanged where ["membership", "late-membership"].contains(mode) { rejected = true }
            catch GoV2Error.http(403, _) where mode == "denied" { rejected = true }
            try check(rejected, "\(mode): invalid or unauthorized data was accepted")
            passed += 1; print("PASS: rejected " + mode)
        }
        let (api, cid) = try await make("empty")
        let data = try await api.request(path: "/conversations/info?conversation_id=\(cid)")
        let conversation = try JSONDecoder().decode(Conversation.self, from: data)
        try check(conversation.goDeltaCursor == IOSChatDeltaCursor(events: 1000, personal: 7, membership: 1), "directory cursor seeds history catch-up")
        passed += 1
        print("PASS: \(passed) chat delta checks")
    }
}
