import SwiftUI
import AVFoundation
import UIKit

/// The preview layer sizes with its UIView instead of capturing zero bounds
/// during makeUIView. Camera configuration, start, stop and torch share one queue.
struct QRScannerPreview: UIViewRepresentable {
    var torchOn: Bool
    var onFailure: (String) -> Void = { _ in }
    let onCode: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode, onFailure: onFailure) }
    func makeUIView(context: Context) -> QRScannerCameraView {
        let view = QRScannerCameraView()
        context.coordinator.start(in: view)
        return view
    }
    func updateUIView(_ view: QRScannerCameraView, context: Context) { context.coordinator.torch(on: torchOn) }
    static func dismantleUIView(_ view: QRScannerCameraView, coordinator: Coordinator) { coordinator.stop() }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
        private let onCode: (String) -> Void
        private let onFailure: (String) -> Void
        private let capture = AVCaptureSession()
        private let cameraQueue = DispatchQueue(label: "com.pulseim.qr-camera", qos: .userInitiated)
        private let closedLock = NSLock()
        private var closed = false
        private var device: AVCaptureDevice?
        private var output: AVCaptureMetadataOutput?
        private var lastScan = Date.distantPast
        private var runtimeObserver: NSObjectProtocol?
        init(onCode: @escaping (String) -> Void, onFailure: @escaping (String) -> Void) {
            self.onCode = onCode; self.onFailure = onFailure
            super.init()
            runtimeObserver = NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: capture, queue: nil) { [weak self] _ in
                self?.fail("相机暂时无法使用，请关闭扫一扫后重试，或从相册识别二维码。")
            }
        }
        deinit { if let runtimeObserver { NotificationCenter.default.removeObserver(runtimeObserver) } }
        private var isClosed: Bool { closedLock.lock(); defer { closedLock.unlock() }; return closed }
        @MainActor func start(in view: QRScannerCameraView) {
            view.preview.videoGravity = .resizeAspectFill
            view.preview.session = capture
            cameraQueue.async { [self] in
                guard !isClosed else { return }
                guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
                    fail("请在系统设置中允许相机权限，也可从相册识别二维码。"); return
                }
                guard configure(), !isClosed else { return }
                capture.startRunning()
            }
        }
        private func configure() -> Bool {
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: camera), capture.canAddInput(input) else {
                fail("当前设备没有可用的后置相机，可从相册识别二维码。"); return false
            }
            capture.beginConfiguration()
            defer { capture.commitConfiguration() }
            if capture.canSetSessionPreset(.high) { capture.sessionPreset = .high }
            capture.addInput(input); device = camera
            let metadata = AVCaptureMetadataOutput()
            guard capture.canAddOutput(metadata) else { fail("相机无法识别二维码，请改用相册。"); return false }
            capture.addOutput(metadata)
            guard metadata.availableMetadataObjectTypes.contains(.qr) else { fail("当前相机不支持二维码识别，请改用相册。"); return false }
            metadata.setMetadataObjectsDelegate(self, queue: cameraQueue)
            metadata.metadataObjectTypes = [.qr]
            output = metadata
            return true
        }
        func stop() {
            closedLock.lock(); closed = true; closedLock.unlock()
            cameraQueue.async { [self] in
                output?.setMetadataObjectsDelegate(nil, queue: nil)
                setTorch(false)
                if capture.isRunning { capture.stopRunning() }
            }
        }
        func torch(on: Bool) {
            cameraQueue.async { [self] in if !isClosed { setTorch(on) } }
        }
        private func setTorch(_ on: Bool) {
            guard let device, device.hasTorch, device.isTorchModeSupported(on ? .on : .off) else { return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                device.torchMode = on ? .on : .off
            } catch { if on { fail("闪光灯暂时无法开启。") } }
        }
        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !isClosed, Date().timeIntervalSince(lastScan) >= 1,
                  let value = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
            lastScan = Date()
            DispatchQueue.main.async { [weak self] in guard let self, !self.isClosed else { return }; self.onCode(value) }
        }
        private func fail(_ message: String) {
            DispatchQueue.main.async { [weak self] in guard let self, !self.isClosed else { return }; self.onFailure(message) }
        }
    }
}

final class QRScannerCameraView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}
