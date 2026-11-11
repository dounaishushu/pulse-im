import Foundation

enum IOSPhotoGalleryFailure: Error { case invalidPage, unavailable }

/// Metadata only; downloaded images are held separately in a bounded cache.
/// Do not expose a gap between the tapped old image and the newest server page.
struct IOSPhotoGalleryIndex {
    let conversationID: Int
    private var initial: Message
    private var catalog: [Int: Message] = [:]
    private var excluded = Set<Int>()
    private(set) var selectedID: Int
    private(set) var clearedBefore: Int
    private(set) var nextPage = 1
    private(set) var hasMore = true
    private(set) var total = 0

    init?(initial: Message, clearedBefore: Int = 0) {
        guard initial.conversationId > 0, initial.id > max(0, clearedBefore),
              Self.isImage(initial) else { return nil }
        self.initial = initial; conversationID = initial.conversationId
        selectedID = initial.id; self.clearedBefore = max(0, clearedBefore)
    }
    static func isImage(_ message: Message) -> Bool {
        message.type == "image" && message.recalledAt == nil && message.status != "recalled"
            && message.body["url"]?.stringValue?.isEmpty == false
    }
    var reachedSelection: Bool { catalog[selectedID] != nil }
    var items: [Message] {
        if !reachedSelection { return [initial] }
        return catalog.values.sorted { $0.id < $1.id }
    }
    var needsMore: Bool {
        guard hasMore else { return false }
        guard reachedSelection else { return true }
        return (items.firstIndex { $0.id == selectedID } ?? 0) < 5
    }
    mutating func select(_ id: Int) {
        if items.contains(where: { $0.id == id }) { selectedID = id }
    }
    mutating func restart() {
        if let selected = catalog[selectedID] { initial = selected }
        catalog = [:]; nextPage = 1; hasMore = true; total = 0
    }
    /// A clear changes offset pagination. Restart at page one with its new floor.
    mutating func apply(_ page: SharedMediaPage) throws {
        guard page.conversationId == conversationID, page.page == nextPage,
              page.items.allSatisfy({ Self.isImage($0) && $0.conversationId == conversationID })
        else { throw IOSPhotoGalleryFailure.invalidPage }
        let advanced = page.clearedBeforeMessageId > clearedBefore
        try invalidate(clearedBefore: page.clearedBeforeMessageId, ids: [])
        if advanced, page.page > 1 {
            catalog = [:]; nextPage = 1; hasMore = true; return
        }
        if page.page == 1 { catalog = [:] }
        for image in page.visibleItems(clearedBefore: clearedBefore) where !excluded.contains(image.id) {
            catalog[image.id] = image
        }
        nextPage = page.page + 1; hasMore = page.hasMore; total = page.total
        if !hasMore, !reachedSelection { throw IOSPhotoGalleryFailure.unavailable }
    }
    mutating func invalidate(clearedBefore floor: Int, ids: Set<Int>) throws {
        let advanced = floor > clearedBefore
        if let selected = catalog[selectedID] { initial = selected }
        clearedBefore = max(clearedBefore, floor); excluded.formUnion(ids)
        catalog = catalog.filter { $0.key > clearedBefore && !excluded.contains($0.key) }
        guard selectedID > clearedBefore, !excluded.contains(selectedID) else {
            throw IOSPhotoGalleryFailure.unavailable
        }
        if advanced { catalog = [:]; nextPage = 1; hasMore = true }
    }
}

/// Direction locks dismiss to a single-finger downward drag at the fitted size.
enum IOSPhotoDismissGesture {
    static func canBegin(horizontal: Double, vertical: Double, zoomRatio: Double, touches: Int) -> Bool {
        touches == 1 && zoomRatio <= 1.01 && vertical > 0 && vertical > abs(horizontal) * 1.15
    }
    static func shouldFinish(distance: Double, velocity: Double, height: Double) -> Bool {
        distance > min(120, max(72, height * 0.14)) || (distance > 24 && velocity > 750)
    }
    static func progress(distance: Double, height: Double) -> Double {
        min(1, max(0, distance) / max(1, height * 0.65))
    }
}
