import Foundation

public struct WorkerEvent: Codable, Equatable, Sendable {
    public let phase: String
    public let message: String
    public let discovered: Int?
    public let imported: Int?
    public let lastSync: String?
    public let code: String?
    public init(phase: String, message: String, discovered: Int? = nil, imported: Int? = nil,
                lastSync: String? = nil, code: String? = nil) {
        self.phase = phase; self.message = message; self.discovered = discovered
        self.imported = imported; self.lastSync = lastSync; self.code = code
    }
}

/// Only unexpected process exits consume this budget. Availability waits happen inside one worker.
public struct RestartBudget: Sendable {
    private var failures: [Date] = []
    public init() {}
    public mutating func nextDelay(now: Date) -> TimeInterval? {
        failures.removeAll { now.timeIntervalSince($0) >= 300 }
        guard failures.count < 3 else { return nil }
        failures.append(now)
        return [2, 10, 30][failures.count - 1]
    }
    public mutating func reset() { failures.removeAll() }
}

public struct LineBuffer: Sendable {
    private var pending = Data()
    public init() {}
    public mutating func append(_ data: Data) throws -> [Data] {
        pending.append(data)
        guard pending.count <= 131_072 else { throw BufferError.exceededLimit }
        var lines: [Data] = []
        while let index = pending.firstIndex(of: 10) {
            let line = Data(pending[..<index])
            pending.removeSubrange(...index)
            if !line.isEmpty { lines.append(line) }
        }
        return lines
    }
    public enum BufferError: Error { case exceededLimit }
}
