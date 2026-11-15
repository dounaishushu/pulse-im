import Foundation

/// A live-message follow intent survives layout changes until a reader gesture
/// or navigation change supersedes it. Layout clamping alone never cancels it.
struct ChatLatestScrollState {
    private(set) var revision = UUID()
    private(set) var navigation: UUID?
    private(set) var followsLatest = false

    mutating func follow(navigation: UUID) -> UUID {
        revision = UUID(); self.navigation = navigation; followsLatest = true
        return revision
    }

    mutating func pause() {
        revision = UUID(); navigation = nil; followsLatest = false
    }

    func accepts(_ request: UUID, navigation: UUID, mayScroll: Bool, navigationProtected: Bool) -> Bool {
        followsLatest && revision == request && self.navigation == navigation && mayScroll && !navigationProtected
    }

    func needsLayoutCorrection(bottomY: Double, viewportHeight: Double, navigation: UUID,
                               mayScroll: Bool, navigationProtected: Bool) -> Bool {
        accepts(revision, navigation: navigation, mayScroll: mayScroll, navigationProtected: navigationProtected)
            && bottomY.isFinite && viewportHeight.isFinite && viewportHeight > 0 && bottomY > viewportHeight + 2
    }

    static func shouldFollowNewMessage(previousLastID: Int, newestID: Int, mayScroll: Bool, navigationProtected: Bool) -> Bool {
        mayScroll && !navigationProtected && newestID > previousLastID
    }
}
