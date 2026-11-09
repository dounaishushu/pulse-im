import Foundation

/// Direction locks on the first meaningful motion; vertical scrolling cannot turn into back.
struct BackSwipeState {
    private var candidate = false
    private var claimed = false
    private var start = CGPoint.zero
    private var width: CGFloat = 0
    private let slop: CGFloat = 10

    mutating func begin(at point: CGPoint, width: CGFloat) {
        reset()
        candidate = width > 0 && point.x >= 0 && point.x < width
        start = point; self.width = width
    }

    mutating func move(to point: CGPoint, fingers: Int) -> Bool {
        guard fingers == 1, candidate else { reset(); return false }
        let dx = point.x - start.x, dy = abs(point.y - start.y)
        if !claimed {
            if dx < -slop || (dy > slop && dy >= dx) { reset(); return false }
            claimed = dx > slop && dx > dy * 1.5
        }
        return claimed
    }

    mutating func finish(at point: CGPoint) -> Bool {
        let dx = point.x - start.x
        let accepted = candidate && claimed && dx >= max(72, width * 0.18) && dx > abs(point.y - start.y) * 1.5
        reset()
        return accepted
    }

    mutating func reset() { candidate = false; claimed = false }
}
