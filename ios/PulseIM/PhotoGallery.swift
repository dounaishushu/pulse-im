import SwiftUI
import UIKit
import ImageIO

struct IOSPhotoGalleryPresentation: Identifiable {
    let id = UUID()
    let index: IOSPhotoGalleryIndex
    let client: APIClient
    let token: String
    init?(message: Message, client: APIClient, token: String, clearedBefore: Int = 0) {
        guard let index = IOSPhotoGalleryIndex(initial: message, clearedBefore: clearedBefore) else { return nil }
        self.index = index; self.client = client; self.token = token
    }
}

extension View {
    func iosPhotoGallery(item: Binding<IOSPhotoGalleryPresentation?>, clearedBefore: Int = 0,
                         invalidatedIDs: Set<Int> = [], onUnavailable: @escaping () -> Void = {}) -> some View {
        modifier(IOSPhotoGalleryModifier(item: item, clearedBefore: clearedBefore,
                                        invalidatedIDs: invalidatedIDs, onUnavailable: onUnavailable))
    }
}

private struct IOSPhotoGalleryModifier: ViewModifier {
    @Binding var item: IOSPhotoGalleryPresentation?
    let clearedBefore: Int
    let invalidatedIDs: Set<Int>
    let onUnavailable: () -> Void
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    func body(content: Content) -> some View {
        content.background {
            IOSPhotoGalleryHost(presentation: item, clearedBefore: clearedBefore, invalidatedIDs: invalidatedIDs,
                current: { value in
                    session.isSignedIn && session.token == value.token && !appLock.isLocked && !session.updateRequired
                        && value.client.endpointIdentity == APIClient.shared.endpointIdentity
                }, onClose: { id, unavailable in
                    guard item?.id == id else { return }
                    item = nil
                    if unavailable { onUnavailable() }
                }).frame(width: 0, height: 0)
        }
    }
}

/// overFullScreen keeps the chat mounted, its scroll position, draft and socket
/// intact, while also covering the navigation bar and the home-indicator area.
private struct IOSPhotoGalleryHost: UIViewControllerRepresentable {
    let presentation: IOSPhotoGalleryPresentation?
    let clearedBefore: Int
    let invalidatedIDs: Set<Int>
    let current: (IOSPhotoGalleryPresentation) -> Bool
    let onClose: (UUID, Bool) -> Void
    func makeUIViewController(context: Context) -> Host { Host() }
    func updateUIViewController(_ host: Host, context: Context) {
        host.request = presentation; host.current = current; host.onClose = onClose
        host.clearedBefore = clearedBefore; host.invalidatedIDs = invalidatedIDs
        DispatchQueue.main.async { [weak host] in host?.reconcile() }
    }
    static func dismantleUIViewController(_ host: Host, coordinator: ()) { host.stop() }
    final class Host: UIViewController {
        var request: IOSPhotoGalleryPresentation?
        var current: (IOSPhotoGalleryPresentation) -> Bool = { _ in false }
        var onClose: (UUID, Bool) -> Void = { _, _ in }
        var clearedBefore = 0
        var invalidatedIDs = Set<Int>()
        private var gallery: IOSPhotoGalleryController?
        override func loadView() { view = UIView(); view.backgroundColor = .clear }
        override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); reconcile() }
        func reconcile() {
            if let gallery {
                guard request?.id == gallery.presentation.id, current(gallery.presentation) else {
                    gallery.close(animated: false); return
                }
                gallery.invalidate(clearedBefore: clearedBefore, ids: invalidatedIDs)
                return
            }
            guard let request, current(request), view.window != nil, presentedViewController == nil else { return }
            let controller = IOSPhotoGalleryController(presentation: request,
                current: { [weak self] in self?.current(request) == true },
                onClose: { [weak self] unavailable in
                    guard let self else { return }
                    self.gallery = nil
                    if self.request?.id == request.id { self.request = nil }
                    self.onClose(request.id, unavailable)
                    self.reconcile()
                })
            gallery = controller
            controller.invalidate(clearedBefore: clearedBefore, ids: invalidatedIDs)
            guard !controller.closing else { return }
            present(controller, animated: false)
        }
        func stop() { request = nil; gallery?.close(animated: false) }
    }
}

@MainActor private final class IOSPhotoGalleryController: UIViewController,
    UICollectionViewDataSource, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    let presentation: IOSPhotoGalleryPresentation
    private var index: IOSPhotoGalleryIndex
    private let current: () -> Bool
    private let onClose: (Bool) -> Void
    private(set) var closing = false
    private let backdrop = UIView()
    private let layout = UICollectionViewFlowLayout()
    private lazy var pages = UICollectionView(frame: .zero, collectionViewLayout: layout)
    private let controls = IOSPhotoGalleryControls()
    private let closeButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)
    private let previousButton = UIButton(type: .system)
    private let nextButton = UIButton(type: .system)
    private let positionLabel = UILabel()
    private let detailLabel = UILabel()
    private let statusButton = UIButton(type: .system)
    private lazy var dismissPan = UIPanGestureRecognizer(target: self, action: #selector(dragToDismiss(_:)))
    private var rendered: [Message] = []
    private var renderedSize = CGSize.zero
    private var pendingRender = false
    private var loadingTask: Task<Void, Never>?
    private var lifetimeTask: Task<Void, Never>?
    private var shareTask: Task<Void, Never>?
    private var shareURL: URL?
    private var loading = false
    private var loadFailed = false
    private var sharing = false
    private var shareFailure = ""

    init(presentation: IOSPhotoGalleryPresentation, current: @escaping () -> Bool, onClose: @escaping (Bool) -> Void) {
        self.presentation = presentation; index = presentation.index; self.current = current; self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen; modalPresentationCapturesStatusBarAppearance = true
    }
    required init?(coder: NSCoder) { return nil }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .clear; view.isOpaque = false; view.accessibilityViewIsModal = true
        backdrop.backgroundColor = .black; view.addSubview(backdrop)
        layout.scrollDirection = .horizontal; layout.minimumLineSpacing = 0; layout.minimumInteritemSpacing = 0
        pages.backgroundColor = .clear; pages.isOpaque = false; pages.isPagingEnabled = true; pages.alwaysBounceVertical = false
        pages.showsHorizontalScrollIndicator = false; pages.contentInsetAdjustmentBehavior = .never
        pages.dataSource = self; pages.delegate = self
        pages.register(IOSPhotoGalleryCell.self, forCellWithReuseIdentifier: "photo")
        controls.isOpaque = false; view.addSubview(pages); view.addSubview(controls)
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.accessibilityLabel = "关闭图片"; closeButton.accessibilityIdentifier = "gallery_close"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        shareButton.setImage(UIImage(systemName: "square.and.arrow.up"), for: .normal)
        shareButton.accessibilityLabel = "分享原图"; shareButton.addTarget(self, action: #selector(shareTapped), for: .touchUpInside)
        previousButton.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        previousButton.accessibilityLabel = "上一张图片"; previousButton.addTarget(self, action: #selector(previousTapped), for: .touchUpInside)
        nextButton.setImage(UIImage(systemName: "chevron.right"), for: .normal)
        nextButton.accessibilityLabel = "下一张图片"; nextButton.addTarget(self, action: #selector(nextTapped), for: .touchUpInside)
        for button in [closeButton, shareButton, previousButton, nextButton] { button.tintColor = .white; controls.addSubview(button) }
        positionLabel.font = .monospacedDigitSystemFont(ofSize: 16, weight: .semibold)
        positionLabel.textAlignment = .center; positionLabel.textColor = .white; controls.addSubview(positionLabel)
        detailLabel.font = .systemFont(ofSize: 12); detailLabel.textColor = .lightGray
        detailLabel.textAlignment = .center; detailLabel.numberOfLines = 2; controls.addSubview(detailLabel)
        statusButton.titleLabel?.font = .systemFont(ofSize: 13); statusButton.setTitleColor(.lightGray, for: .normal)
        statusButton.addTarget(self, action: #selector(retryList), for: .touchUpInside); controls.addSubview(statusButton)
        dismissPan.maximumNumberOfTouches = 1; dismissPan.delegate = self; view.addGestureRecognizer(dismissPan)
        pages.panGestureRecognizer.require(toFail: dismissPan)
        renderIndex(); loadMoreIfNeeded()
        lifetimeTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
                guard let self, !self.closing else { return }
                if !self.current() { self.close(animated: false); return }
            }
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews(); backdrop.frame = view.bounds; controls.frame = view.bounds
        pages.bounds = CGRect(origin: .zero, size: view.bounds.size)
        pages.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        let safe = view.safeAreaInsets, width = view.bounds.width
        closeButton.frame = CGRect(x: safe.left + 8, y: safe.top + 2, width: 44, height: 44)
        shareButton.frame = CGRect(x: width - safe.right - 52, y: safe.top + 2, width: 44, height: 44)
        positionLabel.frame = CGRect(x: safe.left + 60, y: safe.top + 2, width: max(0, width - safe.left - safe.right - 120), height: 44)
        previousButton.frame = CGRect(x: safe.left + 8, y: view.bounds.height - safe.bottom - 58, width: 44, height: 44)
        nextButton.frame = CGRect(x: width - safe.right - 52, y: previousButton.frame.minY, width: 44, height: 44)
        detailLabel.frame = CGRect(x: safe.left + 60, y: previousButton.frame.minY, width: positionLabel.frame.width, height: 42)
        statusButton.frame = CGRect(x: safe.left + 54, y: safe.top + 44, width: max(0, width - safe.left - safe.right - 108), height: 34)
        if view.bounds.size != renderedSize, view.bounds.width > 0 {
            renderedSize = view.bounds.size; layout.itemSize = renderedSize; layout.invalidateLayout()
            scrollToSelected(animated: false)
        }
    }
    override func accessibilityPerformEscape() -> Bool { close(animated: true); return true }
    @objc private func closeTapped() { close(animated: true) }
    @objc private func retryList() {
        if !index.reachedSelection { index.restart() }
        loadFailed = false; loadMoreIfNeeded(force: true)
    }
    @objc private func previousTapped() { move(-1) }
    @objc private func nextTapped() { move(1) }
    private func move(_ offset: Int) {
        guard let row = rendered.firstIndex(where: { $0.id == index.selectedID }), rendered.indices.contains(row + offset), !closing else { return }
        currentCell?.resetZoom(); pages.isScrollEnabled = true; index.select(rendered[row + offset].id)
        scrollToSelected(animated: true); updateLabels(); loadMoreIfNeeded()
    }
    private var currentCell: IOSPhotoGalleryCell? {
        guard let row = rendered.firstIndex(where: { $0.id == index.selectedID }) else { return nil }
        return pages.cellForItem(at: IndexPath(item: row, section: 0)) as? IOSPhotoGalleryCell
    }
    private var interacting: Bool {
        pages.isDragging || pages.isDecelerating || dismissPan.state == .began || dismissPan.state == .changed
            || (currentCell?.zoomRatio ?? 1) > 1.01
    }
    func invalidate(clearedBefore: Int, ids: Set<Int>) {
        guard !closing else { return }
        do { try index.invalidate(clearedBefore: clearedBefore, ids: ids) }
        catch { close(animated: false, unavailable: true); return }
        if isViewLoaded { renderIndex() }
    }
    private func renderIndex() {
        guard !closing else { return }
        if interacting { pendingRender = true; return }
        pendingRender = false
        let values = index.items
        if values.map(\.id) != rendered.map(\.id) {
            for case let cell as IOSPhotoGalleryCell in pages.visibleCells { cell.stop() }
            rendered = values; pages.reloadData(); pages.layoutIfNeeded(); scrollToSelected(animated: false)
        }
        updateLabels()
    }
    private func scrollToSelected(animated: Bool) {
        guard renderedSize.width > 0, let row = rendered.firstIndex(where: { $0.id == index.selectedID }) else { return }
        pages.setContentOffset(CGPoint(x: CGFloat(row) * renderedSize.width, y: 0), animated: animated)
    }
    private func updateLabels() {
        let row = (rendered.firstIndex { $0.id == index.selectedID } ?? 0) + 1
        positionLabel.text = "\(row) / \(rendered.count)"
        positionLabel.accessibilityLabel = "第\(row)张，已加载\(rendered.count)张图片"
        let selected = rendered.first { $0.id == index.selectedID }
        detailLabel.text = selected?.senderName
        previousButton.isEnabled = row > 1 && !sharing; nextButton.isEnabled = row < rendered.count && !sharing
        pages.isUserInteractionEnabled = !sharing
        previousButton.alpha = row > 1 ? 1 : 0.3; nextButton.alpha = row < rendered.count ? 1 : 0.3
        shareButton.isEnabled = !sharing && currentCell?.hasImage == true
        if sharing { statusButton.setTitle("正在准备原图…", for: .normal) }
        else if !shareFailure.isEmpty { statusButton.setTitle(shareFailure, for: .normal) }
        else if loadFailed { statusButton.setTitle("相册加载失败，点此重试", for: .normal) }
        else if loading { statusButton.setTitle(index.reachedSelection ? "正在加载更早图片…" : "正在读取聊天相册…", for: .normal) }
        else { statusButton.setTitle(nil, for: .normal) }
        statusButton.isEnabled = loadFailed && !loading && !sharing && shareFailure.isEmpty
    }
    private func loadMoreIfNeeded(force: Bool = false) {
        guard !closing, current(), !loading, !loadFailed, force || index.needsMore else { return }
        loading = true; updateLabels()
        loadingTask = Task { [weak self] in
            guard let self else { return }
            defer { self.loading = false; self.loadingTask = nil; if !self.closing { self.renderIndex(); self.updateLabels() } }
            do {
                repeat {
                    let page = try await self.presentation.client.sharedMedia(conversationID: self.index.conversationID, page: self.index.nextPage, size: 50, type: "image")
                    try Task.checkCancellation()
                    guard self.current(), !self.closing else { return }
                    // A live clear can reset pagination while this page is in flight.
                    if page.page != self.index.nextPage { continue }
                    try self.index.apply(page); self.renderIndex()
                } while self.index.needsMore
            } catch IOSPhotoGalleryFailure.unavailable {
                // Offset pages may shift if another member deletes a photo.
                // A still-authorized selected image remains open for a list retry.
                do { _ = try await self.authorizedImage(self.index.selectedID); self.loadFailed = true }
                catch { if !Task.isCancelled, self.current() { self.close(animated: false, unavailable: true) } }
            }
            catch { if !Task.isCancelled, self.current(), !self.closing { self.loadFailed = true } }
        }
    }
    private func authorizedImage(_ id: Int) async throws -> Message {
        guard current(), !closing else { throw CancellationError() }
        let result = try await presentation.client.locateMessage(conversationID: index.conversationID, messageID: id)
        try Task.checkCancellation()
        guard current(), !closing, result.targetId == id, id > index.clearedBefore,
              let image = result.items.first(where: { $0.id == id && $0.conversationId == index.conversationID }),
              IOSPhotoGalleryIndex.isImage(image), index.items.contains(where: { $0.id == id })
        else { throw IOSPhotoGalleryFailure.unavailable }
        return image
    }
    private func image(for id: Int) async throws -> UIImage {
        let message: Message
        do { message = try await authorizedImage(id) }
        catch IOSPhotoGalleryFailure.unavailable { close(animated: false, unavailable: true); throw IOSPhotoGalleryFailure.unavailable }
        guard let raw = message.body["url"]?.stringValue, let url = presentation.client.mediaURL(raw) else { throw IOSPhotoGalleryFailure.unavailable }
        let image = try await IOSChatImageCache.shared.load(url, client: presentation.client, maximumPixel: 2560)
        try Task.checkCancellation()
        guard current(), !closing, id > index.clearedBefore, index.items.contains(where: { $0.id == id }) else {
            throw IOSPhotoGalleryFailure.unavailable
        }
        return image
    }
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { rendered.count }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "photo", for: indexPath) as! IOSPhotoGalleryCell
        let message = rendered[indexPath.item]
        // The visible chat thumbnail is immediately usable while the current
        // message is revalidated and its display-sized image is decoded.
        let preview = (message.body["url"]?.stringValue).flatMap { raw in
            presentation.client.mediaURL(raw).flatMap { IOSChatImageCache.shared.cachedPreview($0, client: presentation.client) }
        }
        cell.configure(id: message.id, preview: preview, title: "\(message.senderName ?? "") 图片",
            loader: { [weak self] in
                guard let self else { throw CancellationError() }
                return try await self.image(for: message.id)
            }, zoomChanged: { [weak self, weak cell] zoomed in
                guard let self, cell?.messageID == self.index.selectedID else { return }
                self.pages.isScrollEnabled = !zoomed
                if !zoomed, self.pendingRender { self.renderIndex() }
            }, loaded: { [weak self] in self?.updateLabels() })
        return cell
    }
    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        (cell as? IOSPhotoGalleryCell)?.start()
    }
    func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        (cell as? IOSPhotoGalleryCell)?.releaseImage()
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settled() }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { settled() } }
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { settled() }
    private func settled() {
        guard renderedSize.width > 0, !closing else { return }
        let row = Int((pages.contentOffset.x / renderedSize.width).rounded())
        if rendered.indices.contains(row) { index.select(rendered[row].id) }
        pages.isScrollEnabled = (currentCell?.zoomRatio ?? 1) <= 1.01
        if pendingRender { renderIndex() }
        updateLabels(); loadMoreIfNeeded()
    }
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === dismissPan else { return true }
        let velocity = dismissPan.velocity(in: view)
        return !closing && !sharing && !pages.isDecelerating
            && IOSPhotoDismissGesture.canBegin(horizontal: Double(velocity.x), vertical: Double(velocity.y),
                zoomRatio: Double(currentCell?.zoomRatio ?? 1), touches: dismissPan.numberOfTouches)
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Leave top/bottom controls and the retry button tappable.
        !(touch.view is UIControl) && touch.view?.isDescendant(of: controls) != true
    }
    @objc private func dragToDismiss(_ gesture: UIPanGestureRecognizer) {
        guard !closing else { return }
        let delta = gesture.translation(in: view), distance = max(0, delta.y)
        let progress = CGFloat(IOSPhotoDismissGesture.progress(distance: Double(distance), height: Double(view.bounds.height)))
        switch gesture.state {
        case .began, .changed:
            pages.transform = CGAffineTransform(translationX: delta.x * 0.25, y: distance).scaledBy(x: 1 - progress * 0.35, y: 1 - progress * 0.35)
            backdrop.alpha = 1 - progress; controls.alpha = max(0, 1 - progress * 3)
        case .ended:
            if IOSPhotoDismissGesture.shouldFinish(distance: Double(distance), velocity: Double(gesture.velocity(in: view).y), height: Double(view.bounds.height)) {
                close(animated: true)
            } else { restoreAfterDrag() }
        case .cancelled, .failed: restoreAfterDrag()
        default: break
        }
    }
    private func restoreAfterDrag() {
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
            self.pages.transform = .identity; self.backdrop.alpha = 1; self.controls.alpha = 1
        } completion: { _ in if self.pendingRender { self.renderIndex() } }
    }
    @objc private func shareTapped() {
        guard !sharing, !closing, current() else { return }
        let selected = index.selectedID; sharing = true; shareFailure = ""; updateLabels()
        shareTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.shareURL == nil { self.sharing = false; self.shareTask = nil; self.updateLabels() }
            }
            do {
                let image = try await self.authorizedImage(selected)
                guard let raw = image.body["url"]?.stringValue else { throw IOSPhotoGalleryFailure.unavailable }
                let name = image.body["name"]?.stringValue ?? image.body["file_name"]?.stringValue ?? "图片.jpg"
                guard let url = self.presentation.client.mediaURL(raw) else { throw IOSPhotoGalleryFailure.unavailable }
                let file = try await IOSChatImageCache.shared.export(url, name: name, client: self.presentation.client)
                guard !Task.isCancelled, self.current(), !self.closing, self.index.selectedID == selected,
                      selected > self.index.clearedBefore, self.index.items.contains(where: { $0.id == selected }) else {
                    APIClient.removeDownloadedMedia(at: file); return
                }
                self.shareURL = file
                let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                controller.popoverPresentationController?.sourceView = self.shareButton
                controller.popoverPresentationController?.sourceRect = self.shareButton.bounds
                controller.completionWithItemsHandler = { [weak self] _, _, _, _ in
                    Task { @MainActor in self?.finishShare() }
                }
                self.present(controller, animated: true)
            } catch {
                if !Task.isCancelled, self.current(), !self.closing { self.shareFailure = "原图加载失败，请重试分享" }
                self.sharing = false; self.shareButton.isEnabled = self.currentCell?.hasImage == true
            }
        }
    }
    private func finishShare() {
        if let shareURL { APIClient.removeDownloadedMedia(at: shareURL) }; shareURL = nil
        sharing = false; shareTask = nil; updateLabels()
    }
    func close(animated: Bool, unavailable: Bool = false) {
        guard !closing else { return }; closing = true
        loadingTask?.cancel(); lifetimeTask?.cancel(); shareTask?.cancel()
        let finish: () -> Void = { [weak self] in
            guard let self else { return }
            for case let cell as IOSPhotoGalleryCell in self.pages.visibleCells { cell.stop() }
            self.finishShare()
            if self.presentingViewController != nil {
                self.dismiss(animated: false) { self.onClose(unavailable) }
            } else { self.onClose(unavailable) }
        }
        if animated, isViewLoaded, view.window != nil {
            UIView.animate(withDuration: 0.2, animations: {
                self.pages.transform = self.pages.transform.translatedBy(x: 0, y: self.view.bounds.height * 0.12).scaledBy(x: 0.7, y: 0.7)
                self.pages.alpha = 0; self.backdrop.alpha = 0; self.controls.alpha = 0
            }, completion: { _ in finish() })
        } else { finish() }
    }
}

/// The full-screen control layer must not swallow photo, paging or pinch touches.
@MainActor private final class IOSPhotoGalleryControls: UIView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        subviews.contains { child in
            (child as? UIControl)?.isEnabled == true && !child.isHidden && child.alpha > 0.01 && child.isUserInteractionEnabled
                && child.point(inside: convert(point, to: child), with: event)
        }
    }
}

@MainActor private final class IOSPhotoGalleryCell: UICollectionViewCell, UIScrollViewDelegate {
    private let zoom = IOSGalleryZoomScrollView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let retry = UIButton(type: .system)
    private var loader: (() async throws -> UIImage)?
    private var zoomChanged: ((Bool) -> Void)?
    private var loaded: (() -> Void)?
    private var work: Task<Void, Never>?
    private var fullImageLoaded = false
    private(set) var messageID: Int?
    var zoomRatio: CGFloat { zoom.zoomScale / max(zoom.minimumZoomScale, 0.0001) }
    var hasImage: Bool { zoom.photo.image != nil }
    override init(frame: CGRect) {
        super.init(frame: frame); backgroundColor = .clear; contentView.backgroundColor = .clear
        zoom.backgroundColor = .clear; zoom.delegate = self; zoom.contentInsetAdjustmentBehavior = .never
        zoom.showsHorizontalScrollIndicator = false; zoom.showsVerticalScrollIndicator = false
        zoom.bouncesZoom = true; zoom.photo.contentMode = .scaleAspectFit; zoom.addSubview(zoom.photo)
        zoom.panGestureRecognizer.isEnabled = false; contentView.addSubview(zoom)
        spinner.color = .white; contentView.addSubview(spinner)
        retry.setTitle("图片加载失败，点此重试", for: .normal); retry.setTitleColor(.white, for: .normal)
        retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside); retry.isHidden = true; contentView.addSubview(retry)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2; zoom.addGestureRecognizer(doubleTap)
    }
    required init?(coder: NSCoder) { return nil }
    override func layoutSubviews() {
        super.layoutSubviews(); zoom.frame = contentView.bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        retry.frame = CGRect(x: 20, y: bounds.midY - 24, width: max(0, bounds.width - 40), height: 48)
    }
    func configure(id: Int, preview: UIImage?, title: String, loader: @escaping () async throws -> UIImage,
                   zoomChanged: @escaping (Bool) -> Void, loaded: @escaping () -> Void) {
        stop(); resetZoom(); messageID = id; self.loader = loader; self.zoomChanged = zoomChanged; self.loaded = loaded
        fullImageLoaded = false; zoom.setPhoto(preview); zoom.photo.accessibilityLabel = title; zoom.photo.isAccessibilityElement = true
        zoom.photo.accessibilityIdentifier = "gallery_image_\(id)"; retry.isHidden = true
    }
    func start() {
        guard work == nil, !fullImageLoaded, let loader, let id = messageID else { return }
        retry.isHidden = true; if !hasImage { spinner.startAnimating() }
        work = Task { [weak self] in
            do {
                let image = try await loader()
                guard let self, !Task.isCancelled, self.messageID == id else { return }
                self.fullImageLoaded = true; self.zoom.setPhoto(image); self.spinner.stopAnimating(); self.work = nil; self.loaded?()
            } catch {
                guard let self, !Task.isCancelled, self.messageID == id else { return }
                self.spinner.stopAnimating(); self.retry.isHidden = false; self.work = nil; self.loaded?()
            }
        }
    }
    func stop() { work?.cancel(); work = nil; spinner.stopAnimating() }
    func releaseImage() { stop(); resetZoom(); zoom.setPhoto(nil); fullImageLoaded = false }
    override func prepareForReuse() { super.prepareForReuse(); stop(); messageID = nil; zoom.setPhoto(nil); fullImageLoaded = false; loader = nil; zoomChanged = nil; loaded = nil }
    @objc private func retryTapped() { start() }
    func resetZoom() { zoom.setZoomScale(zoom.minimumZoomScale, animated: false) }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { zoom.photo }
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        zoom.centerPhoto(); let zoomed = zoomRatio > 1.01
        zoom.panGestureRecognizer.isEnabled = zoomed; zoomChanged?(zoomed)
    }
    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        guard hasImage else { return }
        if zoomRatio > 1.01 { zoom.setZoomScale(zoom.minimumZoomScale, animated: true) }
        else {
            let scale = min(zoom.maximumZoomScale, zoom.minimumZoomScale * 2.5)
            let point = gesture.location(in: zoom.photo)
            let size = CGSize(width: zoom.bounds.width / scale, height: zoom.bounds.height / scale)
            zoom.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

@MainActor private final class IOSGalleryZoomScrollView: UIScrollView {
    let photo = UIImageView()
    private var fittedSize = CGSize.zero
    func setPhoto(_ image: UIImage?) { photo.image = image; fittedSize = .zero; setNeedsLayout() }
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedSize, bounds.width > 0, bounds.height > 0, let image = photo.image {
            fittedSize = bounds.size; minimumZoomScale = 1; maximumZoomScale = 1; zoomScale = 1
            photo.frame = CGRect(origin: .zero, size: image.size); contentSize = image.size
            let fit = min(bounds.width / max(1, image.size.width), bounds.height / max(1, image.size.height))
            minimumZoomScale = fit; maximumZoomScale = max(fit * 5, fit); zoomScale = fit
        }
        centerPhoto()
    }
    func centerPhoto() {
        contentInset = UIEdgeInsets(top: max(0, (bounds.height - photo.frame.height) / 2),
                                   left: max(0, (bounds.width - photo.frame.width) / 2), bottom: 0, right: 0)
    }
}
