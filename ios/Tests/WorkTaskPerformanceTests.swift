import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Adapter and decoding regression checks against synthetic loopback data only.
@main struct WorkTaskPerformanceTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: Bool, _ message: String) throws {
        if !value { throw Failure.assertion(message) }
    }
    static func stats(_ base: URL) async throws -> [String: Int] {
        let url = base.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("stats")
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode([String: Int].self, from: data)
    }
    static func main() async {
        do { try await run() } catch { print("FAIL: \(error)"); exit(1) }
    }
    static func run() async throws {
        let base = URL(string: CommandLine.arguments[1])!
        try check(base.host == "127.0.0.1" && base.scheme == "http" && base.path == "/api/v2", "isolated fixture required")
        let context = GoV2Context()
        let api = try GoV2Adapter(baseURL: base, token: "isolated-work-performance", context: context)
        let recordID = try api.ids.local("record", "22222222-2222-4222-8222-222222222222")
        let data = try await api.request(path: "/work-tasks/record?id=\(recordID)")
        let payload = try JSONDecoder().decode(WorkTaskPayload.self, from: data)
        try check(payload.questions.count == 24 && payload.questions.allSatisfy { !($0.mediaID ?? "").isEmpty }, "question identities lost")
        let initial = try await stats(base)
        try check(initial["grant_batches"] == 1 && initial["single_grants"] == 0, "initial question authorization was not batched")
        print("PASS 24 questions decode with media IDs and one batch authorization")

        let progress = try await api.request(path: "/work-tasks/progress", method: "POST", body: ["record_id": recordID, "answers": [payload.questions[0].id: false]])
        let receipt = try JSONDecoder().decode([String: Int].self, from: progress)
        try check(receipt["record_id"] == recordID && receipt.count == 1, "progress did not return an acknowledgement")
        let saved = try await stats(base)
        try check(saved["grant_batches"] == 1 && saved["saved_answers"] == 1, "saving progress reloaded all image authorizations")
        let reloaded = try JSONDecoder().decode(WorkTaskPayload.self, from: await api.request(path: "/work-tasks/record?id=\(recordID)"))
        try check(reloaded.questions[0].answer == false, "false answer was lost")
        print("PASS progress save preserves false without authorizing all images again")

        let mediaID = payload.questions[0].mediaID!
        context.saveMedia(mediaID, url: payload.questions[0].imageURL, seconds: 0)
        let fresh = try await api.request(path: "/work-tasks/image", method: "POST", body: ["media_id": mediaID])
        let access = try JSONDecoder().decode([String: String].self, from: fresh)
        let renewed = try await stats(base)
        try check(!(access["url"] ?? "").isEmpty && renewed["grant_batches"] == 2, "expired current image authorization was not renewed")
        print("PASS current image can renew an expired grant")

        let oldQuestion = Data(#"{"question_uuid":"legacy-question","image_url":"/legacy.png","answer":false}"#.utf8)
        let old = try JSONDecoder().decode(WorkQuestion.self, from: oldQuestion)
        try check(old.mediaID == nil && old.answer == false, "legacy task question decoding broke")
        print("PASS legacy task question remains compatible without media_id")
        print("RESULT passed=4 failed=0")
    }
}
