import Foundation

@main struct ChatScrollStateTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw Failure.assertion(message) }
    }
    static func main() throws {
        let navigation = UUID()
        var state = ChatLatestScrollState()
        try check(!state.needsLayoutCorrection(bottomY: 900, viewportHeight: 600, navigation: navigation,
            mayScroll: true, navigationProtected: false), "a reader position must not move before a follow request")
        let initial = state.follow(navigation: navigation)
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
        try check(!state.needsLayoutCorrection(bottomY: .infinity, viewportHeight: 600, navigation: navigation,
            mayScroll: true, navigationProtected: false), "unmeasured geometry must not scroll")
        try check(!state.needsLayoutCorrection(bottomY: 900, viewportHeight: 0, navigation: navigation,
            mayScroll: true, navigationProtected: false), "zero-height viewport must not scroll")
        state.pause()
        try check(!state.accepts(initial, navigation: navigation, mayScroll: true, navigationProtected: false), "a drag failed to cancel queued scrolling")
        let resumed = state.follow(navigation: navigation)
        try check(!state.accepts(initial, navigation: navigation, mayScroll: true, navigationProtected: false), "a superseded layout request was accepted")
        try check(state.accepts(resumed, navigation: navigation, mayScroll: true, navigationProtected: false), "new messages must restart following after a drag")
        try check(!state.accepts(resumed, navigation: UUID(), mayScroll: true, navigationProtected: false), "navigation change reused an old scroll request")
        try check(!state.accepts(resumed, navigation: navigation, mayScroll: false, navigationProtected: false), "inactive account or photo preview still scrolled")
        try check(!state.accepts(resumed, navigation: navigation, mayScroll: true, navigationProtected: true), "scrolling overrode a located history message")
        try check(ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: 51, mayScroll: true, navigationProtected: false), "own and incoming new messages must follow from any viewport position")
        for newest in [49, 50] {
            try check(!ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: newest, mayScroll: true, navigationProtected: false), "older pages or metadata refresh must not jump to the bottom")
        }
        try check(!ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: 51, mayScroll: true, navigationProtected: true), "a sync response overrode explicit history navigation")
        try check(!ChatLatestScrollState.shouldFollowNewMessage(previousLastID: 50, newestID: 51, mayScroll: false, navigationProtected: false), "an inactive conversation followed new messages")
        print("PASS: live messages, late layout, reader gestures, stale requests and account/navigation isolation")
    }
}
