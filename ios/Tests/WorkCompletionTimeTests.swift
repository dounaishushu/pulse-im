import Foundation

@main struct WorkCompletionTimeTests {
    static func main() {
        NSTimeZone.default = TimeZone(identifier: "America/Los_Angeles")!
        let cases: [(String, String)] = [
            ("2026-11-24T01:49:25.432687Z", "2026-11-24 09:49:25"),
            ("2026-11-24T01:49:25Z", "2026-11-24 09:49:25"),
            ("2026-11-24T01:49:25.432687123+00:00", "2026-11-24 09:49:25"),
            ("2026-11-24T09:49:25.432687+08:00", "2026-11-24 09:49:25"),
            ("2026-11-24T01:49:25.4-05:00", "2026-11-24 14:49:25"),
            ("2026-11-24T23:49:25.987654321Z", "2026-11-25 07:49:25"),
            ("2028-02-29T20:00:00Z", "2028-03-01 04:00:00"),
            ("2026-11-24 09:49:25", "2026-11-24 09:49:25"),
            ("2026-11-24 09:49:25.432687", "2026-11-24 09:49:25"),
            ("2026-11-24T09:49:25.432687", "2026-11-24 09:49:25"),
            ("09:49:25", "09:49:25"), ("09:49:25.432687", "09:49:25"),
            (" 2026-11-24T01:49:25.432687Z ", "2026-11-24 09:49:25"),
            ("", "-"), ("   ", "-"), ("null", "-"), ("invalid", "-")
        ]
        for (raw, expected) in cases {
            let actual = WorkCompletionTime.text(raw)
            guard actual == expected else {
                fatalError("\(raw): expected \(expected), got \(actual)")
            }
        }
        print("PASS \(cases.count) completion-time cases")
    }
}
