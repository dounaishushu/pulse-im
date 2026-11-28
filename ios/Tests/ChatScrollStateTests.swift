import Foundation

@main struct ChatScrollStateTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw Failure.assertion(message) }
    }
    static func main() throws {
        let navigation = UUID()
        var state = ChatLatestScrollState()
        try check(state.allowsKeyboardCorrection(mayScroll: true, navigationProtected: false), "keyboard restoration must not wait for a sent message or an existing follow task")
        try check(!state.allowsKeyboardCorrection(mayScroll: false, navigationProtected: false), "inactive chat must not react to another screen's keyboard")
        try check(!state.allowsKeyboardCorrection(mayScroll: true, navigationProtected: true), "keyboard must retain an explicitly located history message")
        try check(!state.needsLayoutCorrection(bottomY: 900, viewportHeight: 600, navigation: navigation,
            mayScroll: true, navigationProtected: false), "a reader position must not move before a follow request")
        guard let initial = state.follow(navigation: navigation) else { throw Failure.assertion("initial follow rejected") }
        try check(state.accepts(initial, navigation: navigation, mayScroll: true, navigationProtected: false), "current follow request rejected")
        for (bottom, viewport) in [(1000.0, 600.0), (600.0, 300.0), (1500.0, 600.0)] {
            try check(state.needsLayoutCorrection(bottomY: bottom, viewportHeight: viewport, navigation: navigation,
                mayScroll: true, navigationProtected: false), "late media, keyboard or new row failed to retain bottom")
        }
        try check(!state.needsLayoutCorrection(bottomY: 600, viewportHeight: 600, navigation: navigation,
            mayScroll: true, navigationProtected: false), "a settled viewport must not create a correction loop")
        try check(!state.needsLayoutCorrection(bottomY: 601, viewportHeight: 600, navigation: navigation,
            mayScroll: true, navigationProtected: false), "subpixel rounding must not create a correction loop")
        try check(!state.needsLayoutCorrection(bottomY: 400, viewportHeight: 600, navigation: navigation,
            mayScroll: true, navigationProtected: false), "short histories must remain at the top")
        try check(state.needsLayoutCorrection(bottomY: -280, viewportHeight: 300, navigation: navigation,
            mayScroll: true, navigationProtected: false), "keyboard overscroll left every message above the visible viewport")
        try check(!state.needsLayoutCorrection(bottomY: -1, viewportHeight: 300, navigation: navigation,
            mayScroll: true, navigationProtected: false), "subpixel rounding above the viewport must not create a correction loop")
        try check(!state.needsLayoutCorrection(bottomY: .infinity, viewportHeight: 600, navigation: navigation,
            mayScroll: true, navigationProtected: false), "unmeasured geometry must not scroll")
        try check(!state.needsLayoutCorrection(bottomY: 900, viewportHeight: 0, navigation: navigation,
            mayScroll: true, navigationProtected: false), "zero-height viewport must not scroll")
        state.beginReaderGesture()
        let pausedRevision = state.revision
        state.beginReaderGesture()
        try check(state.revision == pausedRevision, "each drag update must not recreate the pause")
        try check(!state.accepts(initial, navigation: navigation, mayScroll: true, navigationProtected: false), "a drag failed to cancel queued scrolling")
        try check(state.follow(navigation: navigation) == nil, "a new message or late ACK restarted following while reading history")
        try check(!state.allowsKeyboardCorrection(mayScroll: true, navigationProtected: false), "opening the keyboard while reading history must not jump to latest")
        try check(!state.observeReaderPosition(bottomY: 600, viewportHeight: 600), "following resumed before the reader finished dragging")
        state.endReaderGesture()
        for bottom in [-280.0, -3.0, 800.0, 3000.0, .infinity] {
            try check(!state.observeReaderPosition(bottomY: bottom, viewportHeight: 600), "new messages or delayed media resumed following above the bottom")
        }
        try check(!state.observeReaderPosition(bottomY: 0, viewportHeight: 0), "unmeasured geometry cleared the reader pause")
        state.pause()
        try check(state.readerPaused && state.follow(navigation: navigation) == nil, "backgrounding or opening a photo lost the reader pause")
        try check(!state.allowsKeyboardCorrection(mayScroll: true, navigationProtected: false), "returning from background must keep the reader's history pause")
        try check(state.observeReaderPosition(bottomY: 601, viewportHeight: 600), "manually reaching the bottom must resume following")
        guard let resumed = state.follow(navigation: navigation) else { throw Failure.assertion("bottom follow rejected") }
        try check(!state.accepts(initial, navigation: navigation, mayScroll: true, navigationProtected: false), "a superseded layout request was accepted")
        try check(state.accepts(resumed, navigation: navigation, mayScroll: true, navigationProtected: false), "following did not resume at the bottom")
        try check(!state.accepts(resumed, navigation: UUID(), mayScroll: true, navigationProtected: false), "navigation change reused an old scroll request")
        try check(!state.accepts(resumed, navigation: navigation, mayScroll: false, navigationProtected: false), "inactive account or photo preview still scrolled")
        try check(!state.accepts(resumed, navigation: navigation, mayScroll: true, navigationProtected: true), "scrolling overrode a located history message")
        state.beginReaderGesture(); state.endReaderGesture(); state.resumeForUserAction()
        try check(state.allowsKeyboardCorrection(mayScroll: true, navigationProtected: false), "explicit send or return-to-bottom must enable keyboard restoration again")
        guard let outgoing = state.follow(navigation: navigation) else { throw Failure.assertion("explicit send or return-to-bottom rejected") }
        try check(state.accepts(outgoing, navigation: navigation, mayScroll: true, navigationProtected: false), "an explicit user send failed to resume following")
        try check(ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: 51, mayScroll: true, navigationProtected: false, readingHistory: false), "new messages at the bottom must follow")
        try check(!ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: 51, mayScroll: true, navigationProtected: false, readingHistory: true), "live or sync messages must not pull down history")
        for newest in [49, 50] {
            try check(!ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: newest, mayScroll: true, navigationProtected: false, readingHistory: false), "older pages or metadata refresh must not jump to the bottom")
        }
        try check(!ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: 51, mayScroll: true, navigationProtected: true, readingHistory: false), "a sync response overrode explicit history navigation")
        try check(!ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: 51, mayScroll: false, navigationProtected: false, readingHistory: false), "an inactive conversation followed new messages")
        print("PASS: incoming and sync messages preserve history; explicit sends, bottom gestures, layout and scope isolation")
    }
}
