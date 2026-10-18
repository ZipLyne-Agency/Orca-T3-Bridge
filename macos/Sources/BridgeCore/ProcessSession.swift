import Foundation
import Darwin

public enum ProcessEvent: Sendable {
    case output(Data)
    case error(Data)
    case exited(Int32)
}

/// A shell-free child with bounded output queues and an exact-process shutdown deadline.
public final class ProcessSession: @unchecked Sendable {
    public let events: AsyncStream<ProcessEvent>
    private let continuation: AsyncStream<ProcessEvent>.Continuation
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let lock = NSLock()
    private var ended = false
    private var inputClosed = false
    private var deadline: DispatchWorkItem?

    public init(executable: URL, arguments: [String], environment: [String: String],
                timeout: TimeInterval? = nil) throws {
        let stream = AsyncStream<ProcessEvent>.makeStream(bufferingPolicy: .bufferingOldest(64))
        events = stream.stream; continuation = stream.continuation
        process.executableURL = executable; process.arguments = arguments
        process.environment = environment
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { self?.emit(.output(data)) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { self?.emit(.error(data)) }
        }
        process.terminationHandler = { [weak self] child in self?.finished(child.terminationStatus) }
        do { try process.run() }
        catch {
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            continuation.finish()
            throw error
        }
        if let timeout {
            let item = DispatchWorkItem { [weak self] in self?.stop() }
            deadline = item
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: item)
        }
    }

    public var pid: Int32 { process.processIdentifier }

    private func emit(_ event: ProcessEvent) {
        if case .dropped = continuation.yield(event) { stop() }
    }

    private func finished(_ status: Int32) {
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        // Read remaining bytes before delivering exit, including short-lived command output.
        let tail = output.fileHandleForReading.readDataToEndOfFile()
        let errorTail = errors.fileHandleForReading.readDataToEndOfFile()
        if !tail.isEmpty { emit(.output(tail)) }
        if !errorTail.isEmpty { emit(.error(errorTail)) }
        lock.lock(); ended = true; deadline?.cancel(); deadline = nil; lock.unlock()
        closeInput()
        continuation.yield(.exited(status)); continuation.finish()
    }

    public func wake() {
        lock.lock(); defer { lock.unlock() }
        guard !ended, !inputClosed else { return }
        try? input.fileHandleForWriting.write(contentsOf: Data("sync\n".utf8))
    }

    private func closeInput() {
        lock.lock(); defer { lock.unlock() }
        if !inputClosed { inputClosed = true; try? input.fileHandleForWriting.close() }
    }

    public func stop() {
        closeInput()
        lock.lock(); let active = !ended; lock.unlock()
        guard active else { return }
        if process.isRunning { process.terminate() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [self] in
            // Retain shutdown ownership even if a cancelled caller releases its session.
            self.lock.lock(); let active = !self.ended; self.lock.unlock()
            // isRunning belongs to this Process instance, so a reused PID is never targeted.
            if active && self.process.isRunning { kill(self.process.processIdentifier, SIGKILL) }
        }
    }
}

public struct CommandFailure: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

public func runCommand(executable: URL, arguments: [String], environment: [String: String],
                       timeout: TimeInterval = 90) async throws -> Data {
    let session = try ProcessSession(executable: executable, arguments: arguments,
                                     environment: environment, timeout: timeout)
    return try await withTaskCancellationHandler {
        var result = Data(); var errorOutput = Data()
        for await event in session.events {
            switch event {
            case .output(let data):
                result.append(data)
                if result.count > 131_072 { session.stop(); throw CommandFailure("Bridge response exceeded its limit.") }
            case .error(let data):
                errorOutput.append(data)
                if errorOutput.count > 16_384 { session.stop(); throw CommandFailure("Bridge diagnostics exceeded their limit.") }
            case .exited(let status):
                guard status == 0 else {
                    let message = String(data: errorOutput, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    throw CommandFailure(message?.isEmpty == false ? message! : "The bridge stopped before the operation completed. Try again after opening Orca and T3.")
                }
                return result
            }
        }
        throw CommandFailure("The bridge connection closed unexpectedly.")
    } onCancel: { session.stop() }
}
