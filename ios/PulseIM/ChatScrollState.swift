import Foundation

/// A live-message follow intent survives layout changes until a reader gesture
/// or navigation change supersedes it. Layout clamping alone never cancels it.
struct ChatLatestScrollState {
    private(set) var revision = UUID()
    private(set) var navigation: UUID?
    private(set) var followsLatest = false
    private(set) var readerPaused = false
    private(set) var readerDragging = false

    mutating func follow(navigation: UUID) -> UUID? {
        guard !readerPaused else { return nil }
        revision = UUID(); self.navigation = navigation; followsLatest = true
        return revision
    }

    mutating func pause() {
        revision = UUID(); navigation = nil; followsLatest = false; readerDragging = false
    }

    mutating func beginReaderGesture() {
        guard !readerDragging else { return }
        pause(); readerPaused = true; readerDragging = true
    }

    mutating func endReaderGesture() { readerDragging = false }

    mutating func resumeForUserAction() {
        pause(); readerPaused = false
    }

    mutating func observeReaderPosition(bottomY: Double, viewportHeight: Double) -> Bool {
        guard readerPaused, !readerDragging, bottomY.isFinite, viewportHeight.isFinite,
              viewportHeight > 0, bottomY <= viewportHeight + 2 else { return false }
        readerPaused = false
        return true
    }

    func accepts(_ request: UUID, navigation: UUID, mayScroll: Bool, navigationProtected: Bool) -> Bool {
        followsLatest && !readerPaused && revision == request && self.navigation == navigation && mayScroll && !navigationProtected
    }

    func needsLayoutCorrection(bottomY: Double, viewportHeight: Double, navigation: UUID,
                               mayScroll: Bool, navigationProtected: Bool) -> Bool {
        accepts(revision, navigation: navigation, mayScroll: mayScroll, navigationProtected: navigationProtected)
            && bottomY.isFinite && viewportHeight.isFinite && viewportHeight > 0 && bottomY > viewportHeight + 2
    }

    static func shouldFollowNewMessage(previousLastID: Int, newestID: Int, mayScroll: Bool,
                                       navigationProtected: Bool, readingHistory: Bool) -> Bool {
        mayScroll && !navigationProtected && !readingHistory && newestID > previousLastID
    }
}
