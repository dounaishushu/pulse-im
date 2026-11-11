import Foundation
import Security
import CryptoKit
import Dispatch

/// Supply a missing intermediate, never a new trust anchor. Evaluation still uses
/// the system roots, original policies, hostname, current date and revocation rules.
enum IOSExploreCertificateTrust {
    static let intermediateSHA256 = "ec9d6bcab9818b7dd59ed61da23a658a96a9c4e950edee0d2da93e7cf2174780"
    private static let queue = DispatchQueue(label: "pulse.explore.certificate-trust", qos: .userInitiated)

    static func intermediate(data: Data) -> SecCertificate? {
        let fingerprint = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard fingerprint == intermediateSHA256 else { return nil }
        return SecCertificateCreateWithData(nil, data as CFData)
    }
    static func bundledIntermediate() -> SecCertificate? {
        guard let url = Bundle.main.url(forResource: "ExploreZeroSSLIntermediate", withExtension: "cer"),
              let data = try? Data(contentsOf: url) else { return nil }
        return intermediate(data: data)
    }
    static func supplement(_ original: SecTrust, host: String, intermediate: SecCertificate) -> SecTrust? {
        guard !host.isEmpty, let chain = SecTrustCopyCertificateChain(original) as? [SecCertificate],
              let leaf = chain.first,
              let issuer = SecCertificateCopyNormalizedIssuerSequence(leaf),
              let subject = SecCertificateCopyNormalizedSubjectSequence(intermediate),
              (issuer as Data) == (subject as Data) else { return nil }
        let extra = SecCertificateCopyData(intermediate) as Data
        var copied: CFArray?
        guard SecTrustCopyPolicies(original, &copied) == errSecSuccess,
              let originalPolicies = copied as? [SecPolicy], !originalPolicies.isEmpty else { return nil }
        let certificates = [leaf, intermediate] + chain.dropFirst().filter { (SecCertificateCopyData($0) as Data) != extra }
        let policies = originalPolicies + [SecPolicyCreateSSL(true, host as CFString)]
        var result: SecTrust?
        guard SecTrustCreateWithCertificates(certificates as CFArray, policies as CFArray, &result) == errSecSuccess,
              let trust = result else { return nil }
        // Preserve the challenge's verification time. Production challenges use
        // the current system date; portable fixtures may explicitly set a date.
        let date = Date(timeIntervalSinceReferenceDate: SecTrustGetVerifyTime(original)) as CFDate
        guard SecTrustSetVerifyDate(trust, date) == errSecSuccess else { return nil }
        return trust
    }
    static func evaluate(_ trust: SecTrust, completion: @escaping (Bool) -> Void) {
        queue.async {
            let status = SecTrustEvaluateAsyncWithError(trust, queue) { _, valid, _ in completion(valid) }
            if status != errSecSuccess { completion(false) }
        }
    }
    static func evaluateSupplemented(_ original: SecTrust, host: String, completion: @escaping (SecTrust?) -> Void) {
        // Copying an unevaluated chain may itself ask Security to build the chain.
        // Keep resource loading, chain preparation and evaluation off the UI thread.
        queue.async {
            guard let intermediate = bundledIntermediate(),
                  let trust = supplement(original, host: host, intermediate: intermediate) else { completion(nil); return }
            evaluate(trust) { valid in completion(valid ? trust : nil) }
        }
    }
}
