import Foundation
import Darwin
import Testing
@testable import BridgeCore

@Test func restartBudgetStopsRepeatedCrashesAndRecoversAfterWindow() {
    var budget = RestartBudget()
    let start = Date(timeIntervalSince1970: 1_000)
    #expect(budget.nextDelay(now: start) == 2)
    #expect(budget.nextDelay(now: start.addingTimeInterval(1)) == 10)
    #expect(budget.nextDelay(now: start.addingTimeInterval(2)) == 30)
    #expect(budget.nextDelay(now: start.addingTimeInterval(3)) == nil)
    #expect(budget.nextDelay(now: start.addingTimeInterval(303)) == 2)
}

@Test func lineBufferPreservesSplitJSONAndRejectsUnboundedOutput() throws {
    var lines = LineBuffer()
    #expect(try lines.append(Data("{\"phase\":\"con".utf8)).isEmpty)
    let completed = try lines.append(Data("nected\",\"message\":\"Ready\"}\n".utf8))
    #expect(try JSONDecoder().decode(WorkerEvent.self, from: completed[0]).phase == "connected")
    #expect(throws: LineBuffer.BufferError.self) { try lines.append(Data(repeating: 65, count: 131_073)) }
}

@Test func commandsPreserveLiteralArgumentsAndDrainOutput() async throws {
    let data = try await runCommand(executable: URL(fileURLWithPath: "/usr/bin/printf"),
        arguments: ["%s", "a path with spaces; $(never executed)"], environment: [:])
    #expect(String(data: data, encoding: .utf8) == "a path with spaces; $(never executed)")
}

@Test func commandsHaveADeadline() async throws {
    let start = Date()
    await #expect(throws: CommandFailure.self) {
        try await runCommand(executable: URL(fileURLWithPath: "/bin/sleep"),
            arguments: ["20"], environment: [:], timeout: 0.1)
    }
    #expect(Date().timeIntervalSince(start) < 5)
}

@Test func cancellationStopsAChildThatIgnoresTerminate() async throws {
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: marker) }
    let task = Task {
        try await runCommand(executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "trap '' TERM; echo $$ > \"$1\"; while :; do :; done", "child", marker.path], environment: [:])
    }
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: marker.path) { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    let pid = try #require(Int32(String(contentsOf: marker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
    task.cancel()
    _ = try? await task.value
    for _ in 0..<400 {
        if kill(pid, 0) != 0 { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(kill(pid, 0) != 0, "Cancellation must retain ownership until even a TERM-ignoring child exits")
}
