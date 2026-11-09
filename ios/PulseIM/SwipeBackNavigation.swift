import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

struct PulseTabBackAction {
    var enabled = false
    var perform: () -> Void = {}
}
private struct PulseTabBackKey: EnvironmentKey {
    static let defaultValue = PulseTabBackAction()
}
extension EnvironmentValues {
    var pulseTabBack: PulseTabBackAction {
        get { self[PulseTabBackKey.self] }
        set { self[PulseTabBackKey.self] = newValue }
    }
}

/// SwiftUI still owns all presentation/path bindings. UIKit only detects the drag.
struct PulseNavigationStack: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.isPresented) private var isPresented
    @Environment(\.pulseTabBack) private var tabBack
    // Keep nested chat/profile/modal view graphs behind a fixed-size boundary.
    // A chat has many state-bearing modifiers and must not be copied inline
    // through every enclosing NavigationStack's generic value type.
    private let content: AnyView

    init<Content: View>(@ViewBuilder content: () -> Content) { self.content = AnyView(content()) }

    var body: some View {
        NavigationStack {
            content.pulseSwipeBack(enabled: isPresented || tabBack.enabled) {
                if isPresented { dismiss() } else { tabBack.perform() }
            }
        }
    }
}

extension View {
    func pulseSwipeBack(enabled: Bool = true, identity: AnyHashable = "page", action: (() -> Void)? = nil) -> some View {
        modifier(PulseSwipeBackModifier(enabled: enabled, identity: identity, action: action))
    }

    @MainActor func pulseSheet<Sheet: View>(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil,
                                @ViewBuilder content: @escaping () -> Sheet) -> some View {
        modifier(PulseBoolModal(isPresented: isPresented, onDismiss: onDismiss, fullScreen: false, destination: content))
    }

    @MainActor func pulseSheet<Item: Identifiable, Sheet: View>(item: Binding<Item?>, onDismiss: (() -> Void)? = nil,
                                                   @ViewBuilder content: @escaping (Item) -> Sheet) -> some View {
        modifier(PulseItemModal(item: item, onDismiss: onDismiss, fullScreen: false, destination: content))
    }

    @MainActor func pulseFullScreenCover<Cover: View>(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil,
                                          @ViewBuilder content: @escaping () -> Cover) -> some View {
        modifier(PulseBoolModal(isPresented: isPresented, onDismiss: onDismiss, fullScreen: true, destination: content))
    }

    @MainActor func pulseFullScreenCover<Item: Identifiable, Cover: View>(item: Binding<Item?>, onDismiss: (() -> Void)? = nil,
                                                             @ViewBuilder content: @escaping (Item) -> Cover) -> some View {
        modifier(PulseItemModal(item: item, onDismiss: onDismiss, fullScreen: true, destination: content))
    }
}

/// Read the owner at the presenter, then explicitly carry both dependencies
/// across every modal boundary, including a modal opened from another modal.
@MainActor private struct PulseBoolModal<Destination: View>: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Binding var isPresented: Bool
    let onDismiss: (() -> Void)?
    let fullScreen: Bool
    let destination: () -> Destination
    func body(content: Content) -> some View {
        if fullScreen {
            content.fullScreenCover(isPresented: $isPresented, onDismiss: onDismiss) { root }
        } else {
            content.sheet(isPresented: $isPresented, onDismiss: onDismiss) { root }
        }
    }
    private var root: some View {
        PulseModalRoot(destination: destination).environmentObject(session).environmentObject(appLock)
    }
}

@MainActor private struct PulseItemModal<Item: Identifiable, Destination: View>: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @Binding var item: Item?
    let onDismiss: (() -> Void)?
    let fullScreen: Bool
    let destination: (Item) -> Destination
    func body(content: Content) -> some View {
        if fullScreen {
            content.fullScreenCover(item: $item, onDismiss: onDismiss) { value in root(value) }
        } else {
            content.sheet(item: $item, onDismiss: onDismiss) { value in root(value) }
        }
    }
    private func root(_ value: Item) -> some View {
        PulseModalRoot { destination(value) }.environmentObject(session).environmentObject(appLock)
    }
}

@MainActor private struct PulseModalRoot<Destination: View>: View {
    let destination: () -> Destination
    var body: some View { AnyView(destination().pulseSwipeBack()) }
}

private struct PulseBackScope: Hashable {
    let token: String?
    let userID: Int
    let endpoint: String
    let page: AnyHashable
}

private struct PulseSwipeBackModifier: ViewModifier {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    @State private var appeared = false
    let enabled: Bool
    let identity: AnyHashable
    let action: (() -> Void)?

    func body(content: Content) -> some View {
        content.background {
            PulseSwipeBackAnchor(
                visible: appeared,
                enabled: enabled && !appLock.isLocked && !session.updateRequired && session.activeAnnouncement == nil,
                identity: PulseBackScope(token: session.token, userID: session.user?.id ?? 0,
                                         endpoint: APIClient.shared.endpointIdentity, page: identity),
                action: { if let action { action() } else { dismiss() } })
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { appeared = true }
        .onDisappear { appeared = false }
    }
}

private struct PulseSwipeBackAnchor: UIViewRepresentable {
    let visible: Bool
    let enabled: Bool
    let identity: AnyHashable
    let action: () -> Void

    func makeUIView(context: Context) -> PulseSwipeBackAnchorView { PulseSwipeBackAnchorView() }
    func updateUIView(_ view: PulseSwipeBackAnchorView, context: Context) {
        view.routeVisible = visible; view.routeEnabled = enabled; view.routeIdentity = identity; view.backAction = action
    }
    static func dismantleUIView(_ view: PulseSwipeBackAnchorView, coordinator: ()) { view.unregister() }
}

/// Also usable by the UIKit registration flow; the view never intercepts taps.
@MainActor final class PulseSwipeBackAnchorView: UIView {
    var routeVisible = false
    var routeEnabled = false
    var routeIdentity: AnyHashable = "page"
    var backAction: () -> Void = {}
    private weak var coordinator: PulseSwipeBackCoordinator?

    init() { super.init(frame: .zero); isUserInteractionEnabled = false; backgroundColor = .clear }
    required init?(coder: NSCoder) { fatalError("Use init()") }
    override func didMoveToWindow() {
        super.didMoveToWindow(); unregister()
        if let window {
            let manager = PulseSwipeBackCoordinator.forWindow(window)
            coordinator = manager; manager.register(self)
        }
    }
    func unregister() { coordinator?.unregister(self); coordinator = nil }
}

@MainActor private final class PulseSwipeBackRecognizer: UIGestureRecognizer {
    weak var coordinateView: UIView?
    var valid: () -> Bool = { false }
    var cleared: () -> Void = {}
    private weak var finger: UITouch?
    private var drag = BackSwipeState()

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard finger == nil, touches.count == 1, let touch = touches.first, let coordinateView, valid() else { cancel(); return }
        finger = touch
        drag.begin(at: touch.location(in: coordinateView), width: coordinateView.bounds.width)
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard valid(), let finger, let coordinateView else { cancel(); return }
        let active = event.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? 0
        if active != 1 { cancel(); return }
        if drag.move(to: finger.location(in: coordinateView), fingers: active) {
            state = state == .possible ? .began : .changed
        }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard valid(), let finger, touches.contains(finger), let coordinateView,
              drag.finish(at: finger.location(in: coordinateView)) else { cancel(); return }
        state = .ended
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { cancel() }
    override func reset() { super.reset(); drag.reset(); finger = nil; coordinateView = nil; cleared() }
    private func cancel() { drag.reset(); state = state == .began || state == .changed ? .cancelled : .failed }
}

/// One recognizer per window chooses the frontmost visible page once per touch.
/// It never invokes UINavigationController pop and SwiftUI dismiss in the same drag.
@MainActor private final class PulseSwipeBackCoordinator: NSObject, UIGestureRecognizerDelegate {
    private static let windows = NSMapTable<UIWindow, PulseSwipeBackCoordinator>.weakToStrongObjects()
    private final class WeakAnchor {
        weak var value: PulseSwipeBackAnchorView?
        init(_ value: PulseSwipeBackAnchorView) { self.value = value }
    }
    private weak var window: UIWindow?
    private var anchors: [WeakAnchor] = []
    private weak var selected: PulseSwipeBackAnchorView?
    private weak var presentation: UIViewController?
    private var selectedIdentity: AnyHashable?
    private var selectedFrame = CGRect.zero
    private let recognizer = PulseSwipeBackRecognizer()

    static func forWindow(_ window: UIWindow) -> PulseSwipeBackCoordinator {
        if let manager = windows.object(forKey: window) { return manager }
        let manager = PulseSwipeBackCoordinator(window: window)
        windows.setObject(manager, forKey: window)
        return manager
    }

    private init(window: UIWindow) {
        self.window = window
        super.init()
        recognizer.delegate = self
        recognizer.cancelsTouchesInView = true
        recognizer.requiresExclusiveTouchType = true
        recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        recognizer.addTarget(self, action: #selector(changed(_:)))
        recognizer.valid = { [weak self] in self?.current() == true }
        recognizer.cleared = { [weak self] in self?.selected = nil; self?.selectedIdentity = nil; self?.presentation = nil }
        window.addGestureRecognizer(recognizer)
    }

    func register(_ anchor: PulseSwipeBackAnchorView) {
        anchors.removeAll { $0.value == nil || $0.value === anchor }; anchors.append(WeakAnchor(anchor))
    }
    func unregister(_ anchor: PulseSwipeBackAnchorView) { anchors.removeAll { $0.value == nil || $0.value === anchor } }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if selected != nil { return true } // Receive a second finger so it cancels the drag.
        guard let window, let root = window.rootViewController, let touched = touch.view, !ownsHorizontalDrag(touched) else { return false }
        let front = frontPresentation(root)
        let point = touch.location(in: window)
        guard let target = frontAnchor(in: front, window: window),
              target.convert(target.bounds, to: window).contains(point) else { return false }
        // A disabled top page blocks its parent's fallback (recording, mutation, lock).
        guard target.routeEnabled else { return false }
        selected = target; selectedIdentity = target.routeIdentity
        presentation = front; selectedFrame = target.convert(target.bounds, to: window)
        recognizer.coordinateView = target
        return current()
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool { current() }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        otherGestureRecognizer is UIScreenEdgePanGestureRecognizer
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        // Vertical scrolling stays responsive while direction is being determined.
        guard let scroll = otherGestureRecognizer.view as? UIScrollView else { return false }
        return otherGestureRecognizer === scroll.panGestureRecognizer && !scroll.alwaysBounceHorizontal &&
            scroll.contentSize.width + scroll.adjustedContentInset.left + scroll.adjustedContentInset.right <= scroll.bounds.width + 1 &&
            scroll.zoomScale <= scroll.minimumZoomScale + 0.01
    }

    @objc private func changed(_ gesture: UIGestureRecognizer) {
        guard gesture.state == .ended, current(), let selected else { return }
        let action = selected.backAction
        self.selected = nil; selectedIdentity = nil; presentation = nil
        action()
    }

    private func current() -> Bool {
        guard let window, let root = window.rootViewController, let selected, let selectedIdentity, selected.routeVisible, selected.routeEnabled,
              selected.window === window, selected.routeIdentity == selectedIdentity,
              let presentation, frontPresentation(root) === presentation, !presentation.isBeingDismissed,
              frontAnchor(in: presentation, window: window) === selected,
              selected.convert(selected.bounds, to: window) == selectedFrame else { return false }
        var responder: UIResponder? = selected
        while let current = responder {
            if let controller = current as? UIViewController, controller.transitionCoordinator != nil { return false }
            responder = current.next
        }
        return true
    }

    private func frontPresentation(_ root: UIViewController) -> UIViewController {
        if let presented = root.presentedViewController { return frontPresentation(presented) }
        for child in root.children.reversed() where child.viewIfLoaded?.window != nil {
            let front = frontPresentation(child)
            if front !== child { return front }
        }
        return root
    }

    private func ownsHorizontalDrag(_ touched: UIView) -> Bool {
        var node: UIView? = touched
        while let view = node {
            if view is UITextField || view is UITextView || view is UISlider || view is UISwitch { return true }
            if let scroll = view as? UIScrollView, scroll.alwaysBounceHorizontal || scroll.zoomScale > scroll.minimumZoomScale + 0.01 ||
                scroll.contentSize.width + scroll.adjustedContentInset.left + scroll.adjustedContentInset.right > scroll.bounds.width + 1 { return true }
            node = view.superview
        }
        return false
    }

    private func frontAnchor(in front: UIViewController, window: UIWindow) -> PulseSwipeBackAnchorView? {
        anchors.compactMap(\.value).filter {
            $0.routeVisible && $0.window === window && $0.isDescendant(of: front.view) && visible($0, window: window)
        }.max(by: { isBehind($0, $1) })
    }

    private func visible(_ anchor: UIView, window: UIWindow) -> Bool {
        var area = anchor.convert(anchor.bounds, to: window).intersection(window.bounds)
        guard !area.isNull && !area.isEmpty else { return false }
        var node: UIView? = anchor
        while let view = node {
            if view.isHidden || view.alpha < 0.01 { return false }
            if view.clipsToBounds {
                area = area.intersection(view.convert(view.bounds, to: window))
                if area.isNull || area.isEmpty { return false }
            }
            node = view.superview
        }
        return true
    }

    private func isBehind(_ lhs: UIView, _ rhs: UIView) -> Bool {
        func path(_ leaf: UIView) -> [Int] {
            var result: [Int] = [], node: UIView? = leaf
            while let view = node, let parent = view.superview {
                result.append(parent.subviews.firstIndex(of: view) ?? 0); node = parent
            }
            return result.reversed()
        }
        let left = path(lhs), right = path(rhs)
        for (a, b) in zip(left, right) where a != b { return a < b }
        return left.count < right.count
    }
}
