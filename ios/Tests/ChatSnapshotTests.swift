import Foundation

/// Runs the production reconciliation and page validation without UIKit/accounts.
@main struct ChatSnapshotTests {
    enum Failure: Error { case assertion(String) }
    static var passed = 0
    static func check(_ value: Bool, _ label: String) throws {
        guard value else { throw Failure.assertion(label) }
        passed += 1; print("PASS: " + label)
    }
    static func message(_ id: Int, cid: Int = 1, text: String = "original", version: Int = 1) -> Message {
        Message(id: id, conversationId: cid, senderId: 2, type: "text",
                body: ["text": .string(text), "_go_version": .string(String(version))],
                createdAt: "2026-11-28T10:00:00Z", recalledAt: nil, editedAt: nil,
                status: "sent", senderName: nil, senderAvatarURL: nil)
    }
    static func page(_ ids: [Int], cid: Int = 1, upper: Int = 20, next: Int = 20, more: Bool = false, cutoff: Int = 0) -> MessageSyncPage {
        MessageSyncPage(conversationId: cid, items: ids.map { message($0, cid: cid) },
                        snapshotMaxId: upper, nextAfterId: next, hasMore: more,
                        clearedBeforeMessageId: cutoff, membershipVersion: 1)
    }
    static func reject(_ value: MessageSyncPage, after: Int = 0, floor: Int = 10, upper: Int? = nil, _ label: String) throws {
        do {
            _ = try value.validated(conversationID: 1, afterID: after, floorID: floor, snapshotMaxID: upper)
        } catch IOSChatHistoryFailure.invalidPage { try check(true, label); return }
        throw Failure.assertion(label)
    }
    static func main() throws {
        let current = [message(5), message(10), message(15), message(20), message(21), message(25)]
        func reconcile(_ rows: [Message], events: [Message] = [], maximum: Int = 20, cutoff: Int = 0) -> [Message] {
            MessageReconciliation.snapshot(current: current, items: rows, events: events,
                conversationID: 1, floorID: 10, maximumID: maximum, clearedBefore: cutoff)
        }
        let complete = reconcile([message(10), message(20)])
        try check(complete.map(\.id) == [5, 10, 20, 21, 25], "preserve older history and sends above snapshot; delete only missing covered row")
        try check(reconcile([]).map(\.id) == [5, 21, 25], "empty snapshot cannot erase messages outside its boundary")
        try check(reconcile([], maximum: 0).map(\.id) == current.map(\.id), "zero upper boundary cannot empty an already populated chat")
        try check(reconcile([], cutoff: 22).map(\.id) == [25], "authoritative clear still removes all rows through its boundary")
        try check(reconcile([message(10)], events: [message(15), message(23)]).map(\.id) == [5, 10, 15, 21, 23, 25], "socket and send acknowledgements racing with HTTP survive")
        let removed = MessageReconciliation.tombstone(message(25))
        try check(!reconcile([], events: [removed]).contains(where: { $0.id == 25 }), "explicit recall still removes a message above snapshot")
        let edited = message(10, text: "edited", version: 2)
        try check(reconcile([message(10)], events: [edited]).first(where: { $0.id == 10 }) == edited, "concurrent edit wins over snapshot")
        try check(!reconcile([message(12, cid: 2)], events: [message(30, cid: 2)]).contains(where: { $0.conversationId != 1 }), "another conversation cannot enter reconciliation")

        let first = try page([10, 12], next: 12, more: true).validated(conversationID: 1, afterID: 0, floorID: 10, snapshotMaxID: nil)
        let last = try page([15, 20]).validated(conversationID: 1, afterID: first.nextAfterId, floorID: 10, snapshotMaxID: first.snapshotMaxId)
        try check(first.items.map(\.id) + last.items.map(\.id) == [10, 12, 15, 20], "complete multi-page snapshot retains one stable boundary")
        _ = try page([]).validated(conversationID: 1, afterID: 12, floorID: 10, snapshotMaxID: 20)
        try check(true, "empty terminal page is valid when all remaining messages are hidden")
        try reject(page([10], cid: 2), "reject another conversation")
        try reject(page([10], upper: 21, next: 21), upper: 20, "reject changed snapshot boundary")
        try reject(page([10], upper: 9, next: 9), "reject row above snapshot")
        try reject(page([9]), "reject row below requested floor")
        try reject(page([10, 10]), "reject duplicate rows")
        try reject(page([12, 10]), "reject unordered rows")
        try reject(page([10]), after: 10, "reject repeated page")
        try reject(page([], next: 0, more: true), "reject empty non-terminal page")
        try reject(page([10], next: 10, more: true), after: 10, "reject non-progressing page")
        try reject(page([10], next: 15, more: true), "reject cursor past last item while more pages remain")
        try reject(page([10], next: 10), "reject truncated terminal page")
        try reject(page([10], next: 21), "reject cursor above snapshot")
        try reject(page([20], next: 20, more: true), "reject more pages beyond upper boundary")
        try reject(page([10], cutoff: -1), "reject negative clear boundary")
        try reject(page([]), after: -1, "reject negative input cursor")
        try reject(page([]), floor: -1, "reject negative input floor")
        try reject(page(Array(10...110), upper: 110, next: 110), "reject oversized page")
        print("PASS: \(passed) chat snapshot checks")
    }
}
