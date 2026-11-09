import AVFoundation
import Foundation
import Combine
import UIKit

struct IOSRecordedVoice: Identifiable {
    let id = UUID()
    let data: Data
    let durationMilliseconds: Int
}

@MainActor final class VoiceRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var isRecording = false
    @Published private(set) var isStarting = false
    @Published private(set) var elapsedMilliseconds = 0
    @Published private(set) var completedRecording: IOSRecordedVoice?
    @Published var error = ""
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var permissionGeneration = 0
    private var observers: [NSObjectProtocol] = []

    override init() {
        super.init()
        for name in [AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.isRecording || self.isStarting else { return }
                    self.cancelRecording(); self.error = "录音已被中断，请重新录制"
                }
            })
        }
    }
    deinit { timer?.invalidate(); for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    @discardableResult func startRecording(whenActive: () -> Bool = { true }) async -> Bool {
        guard !isRecording, !isStarting, completedRecording == nil else { return false }
        permissionGeneration += 1
        let generation = permissionGeneration
        isStarting = true; error = ""
        defer { if generation == permissionGeneration { isStarting = false } }
        let allowed = await requestPermission()
        guard generation == permissionGeneration, !Task.isCancelled else { return false }
        guard allowed else { error = "录音需要允许\(PulseApp.name)使用麦克风"; return false }
        // The permission callback can precede the scene becoming active again.
        for _ in 0..<60 {
            guard generation == permissionGeneration, !Task.isCancelled else { return false }
            if UIApplication.shared.applicationState == .active, whenActive() { break }
            do { try await Task.sleep(nanoseconds: 50_000_000) } catch { return false }
        }
        guard UIApplication.shared.applicationState == .active, whenActive() else { error = "请回到聊天页面后重试录音"; return false }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pulse-\(UUID().uuidString).wav")
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            // PCM WAV plays on iOS, Android and browser players, and does not
            // depend on the server accepting one particular MP4 container layout.
            // Five minutes at 16 kHz/mono/16 bit stays below the 10 MiB limit.
            let settings: [String: Any] = [AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false]
            let value = try AVAudioRecorder(url: url, settings: settings)
            value.delegate = self
            guard value.prepareToRecord(), value.record(forDuration: 300), value.isRecording else {
                value.stop(); throw APIClientError.server("录音启动失败，请重试")
            }
            recorder = value; elapsedMilliseconds = 0; isRecording = true
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let value = self.recorder, self.isRecording else { return }
                    self.elapsedMilliseconds = min(300000, max(self.elapsedMilliseconds, Int(value.currentTime * 1000)))
                    if self.elapsedMilliseconds >= 300000 { _ = self.stopRecording() }
                }
            }
            return true
        } catch {
            try? FileManager.default.removeItem(at: url)
            cleanupRecorder(); self.error = error.localizedDescription
            return false
        }
    }

    func stopRecording() -> IOSRecordedVoice? {
        if let completedRecording { return completedRecording }
        guard let value = recorder else { return nil }
        finish(value, successfully: true)
        return completedRecording
    }
    func consumeCompletedRecording() { completedRecording = nil }

    private func finish(_ value: AVAudioRecorder, successfully: Bool) {
        guard recorder === value else { return }
        let recordedMilliseconds = max(elapsedMilliseconds, Int(value.currentTime * 1000))
        let url = value.url
        recorder = nil; value.delegate = nil; value.stop()
        cleanupRecorder()
        defer { try? FileManager.default.removeItem(at: url) }
        guard successfully else { error = "录音编码失败，请重新录制"; return }
        do {
            let data = try Data(contentsOf: url)
            guard !data.isEmpty, data.count <= 10 * 1024 * 1024 else { throw APIClientError.server("录音为空或超过10MB限制") }
            let audio = try AVAudioPlayer(data: data)
            guard audio.duration.isFinite, audio.duration >= 0.2, audio.duration <= 300.5, audio.numberOfChannels > 0 else {
                throw APIClientError.server("录音太短或内容无效，请重新录制")
            }
            let milliseconds = min(300000, Int(audio.duration * 1000))
            guard recordedMilliseconds > 0, milliseconds > 0 else { throw APIClientError.server("录音内容无效，请重新录制") }
            completedRecording = IOSRecordedVoice(data: data, durationMilliseconds: milliseconds)
        } catch { self.error = error.localizedDescription }
    }

    func cancelRecording() {
        let ownedAudioSession = recorder != nil || isStarting || isRecording
        permissionGeneration += 1
        if let value = recorder {
            recorder = nil; value.delegate = nil; value.stop()
            try? FileManager.default.removeItem(at: value.url)
        }
        completedRecording = nil
        if ownedAudioSession { cleanupRecorder() }
    }
    private func cleanupRecorder() {
        timer?.invalidate(); timer = nil
        recorder = nil; elapsedMilliseconds = 0; isRecording = false; isStarting = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.finish(recorder, successfully: flag) }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor [weak self] in self?.finish(recorder, successfully: false) }
    }
    private func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in continuation.resume(returning: granted) }
        }
    }
}
