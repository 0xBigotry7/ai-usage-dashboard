import XCTest
@testable import UsageMenuBar

@MainActor
final class CollectorSupervisorTests: XCTestCase {
    func testUnexpectedChildExitRestartsOnce() async {
        let harness = CollectorHarness(healthResults: [false, false])
        let supervisor = makeSupervisor(harness: harness)

        await supervisor.start()
        XCTAssertEqual(harness.launches.count, 1)

        harness.exitLaunch(at: 0, status: 9)
        await waitUntil { harness.launches.count == 2 }

        XCTAssertEqual(harness.launches.count, 2)
    }

    func testStopNeverRelaunchesCollector() async {
        let harness = CollectorHarness(healthResults: [false])
        let supervisor = makeSupervisor(harness: harness)

        await supervisor.start()
        XCTAssertEqual(harness.launches.count, 1)

        supervisor.stop()
        await drainTasks()

        XCTAssertEqual(harness.launches.count, 1)
        XCTAssertEqual(harness.launches[0].process.terminateCount, 1)
    }

    func testStopCancelsPendingRestart() async {
        let harness = CollectorHarness(healthResults: [false])
        let sleeper = CancellationAwareRestartSleep()
        let supervisor = makeSupervisor(
            harness: harness,
            restartDelays: [60],
            restartSleep: { delay in
                try await sleeper.sleep(delay)
            }
        )

        await supervisor.start()
        harness.exitLaunch(at: 0, status: 9)
        await waitUntilAsync { await sleeper.didStart }
        supervisor.stop()
        await waitUntilAsync { await sleeper.wasCancelled }

        XCTAssertEqual(harness.launches.count, 1)
    }

    func testStopBeforeQueuedStartPreventsLaunch() async {
        let harness = CollectorHarness(healthResults: [false])
        let supervisor = makeSupervisor(harness: harness)

        supervisor.stop()
        await supervisor.start()

        XCTAssertEqual(harness.launches.count, 0)
    }

    func testHealthyExistingCollectorIsNotDuplicated() async {
        let harness = CollectorHarness(healthResults: [true, true, true])
        let supervisor = makeSupervisor(harness: harness)

        await supervisor.start()
        await supervisor.checkHealth()
        await supervisor.checkHealth()

        XCTAssertEqual(harness.launches.count, 0)
        supervisor.stop()
    }

    func testExternalCollectorTakingOverDuringBackoffIsAdopted() async {
        let harness = CollectorHarness(healthResults: [false, true])
        let supervisor = makeSupervisor(harness: harness)

        await supervisor.start()
        harness.exitLaunch(at: 0, status: 9)
        await waitUntil { harness.healthCheckCount == 2 }

        XCTAssertEqual(harness.launches.count, 1)
        XCTAssertEqual(harness.healthCheckCount, 2)
    }

    func testConcurrentChecksShareOneProbe() async {
        let harness = CollectorHarness(
            healthResults: [true],
            healthDelayYields: 10
        )
        let supervisor = makeSupervisor(harness: harness)

        let start = Task { @MainActor in
            await supervisor.start()
        }
        await Task.yield()
        let periodicCheck = Task { @MainActor in
            await supervisor.checkHealth()
        }
        await start.value
        await periodicCheck.value

        XCTAssertEqual(harness.healthCheckCount, 1)
        XCTAssertEqual(harness.launches.count, 0)
    }

    func testOnlyConsecutiveHealthFailuresRestart() async {
        let harness = CollectorHarness(
            healthResults: [
                false,
                false, false, true,
                false, false, false,
                false,
            ]
        )
        let supervisor = makeSupervisor(harness: harness)

        await supervisor.start()
        let firstProcess = harness.launches[0].process

        await supervisor.checkHealth()
        await supervisor.checkHealth()
        await supervisor.checkHealth()
        await supervisor.checkHealth()
        await supervisor.checkHealth()
        XCTAssertEqual(firstProcess.terminateCount, 0)

        await supervisor.checkHealth()
        XCTAssertEqual(firstProcess.terminateCount, 1)
        await waitUntil { harness.launches.count == 2 }

        XCTAssertEqual(harness.launches.count, 2)
    }

    func testReplacementDoesNotInheritOldHealthFailures() async {
        let harness = CollectorHarness(
            healthResults: [false, false, false, false, false]
        )
        let supervisor = makeSupervisor(harness: harness)

        await supervisor.start()
        await supervisor.checkHealth()
        await supervisor.checkHealth()
        harness.exitLaunch(at: 0, status: 9)
        await waitUntil { harness.launches.count == 2 }

        let replacement = harness.launches[1].process
        await supervisor.checkHealth()

        XCTAssertEqual(replacement.terminateCount, 0)
    }

    func testDelayedExitFromOldGenerationIsIgnored() async {
        let harness = CollectorHarness(healthResults: [false, false])
        let supervisor = makeSupervisor(harness: harness)

        await supervisor.start()
        harness.exitLaunch(at: 0, status: 9)
        await waitUntil { harness.launches.count == 2 }

        harness.exitLaunch(at: 0, status: 9)
        await drainTasks()

        XCTAssertEqual(harness.launches.count, 2)
    }

    private func makeSupervisor(
        harness: CollectorHarness,
        restartDelays: [TimeInterval] = [0],
        restartSleep: CollectorRestartSleep? = nil
    ) -> CollectorSupervisor {
        let healthCheck = { await harness.nextHealthResult() }
        let launch: CollectorSupervisor.Launcher = { id, onExit in
            harness.launch(id: id, onExit: onExit)
        }
        if let restartSleep {
            return CollectorSupervisor(
                healthCheck: healthCheck,
                launch: launch,
                restartDelays: restartDelays,
                restartSleep: restartSleep,
                healthFailureThreshold: 3
            )
        }
        return CollectorSupervisor(
            healthCheck: healthCheck,
            launch: launch,
            restartDelays: restartDelays,
            healthFailureThreshold: 3
        )
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<1_000 where !condition() {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func drainTasks() async {
        try? await Task.sleep(nanoseconds: 10_000_000)
    }

    private func waitUntilAsync(
        _ condition: @escaping @Sendable () async -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<1_000 {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("Condition was not met", file: file, line: line)
    }
}

private actor CancellationAwareRestartSleep {
    private(set) var didStart = false
    private(set) var wasCancelled = false

    func sleep(_ delay: TimeInterval) async throws {
        didStart = true
        do {
            try await Task.sleep(
                nanoseconds: UInt64(delay * 1_000_000_000)
            )
        } catch {
            wasCancelled = true
            throw error
        }
    }
}

@MainActor
private final class CollectorHarness {
    struct Launch {
        let id: UUID
        let process: FakeCollectorProcess
        let onExit: CollectorExitHandler
    }

    private var healthResults: [Bool]
    private let healthDelayYields: Int
    private(set) var healthCheckCount = 0
    private(set) var launches: [Launch] = []

    init(healthResults: [Bool], healthDelayYields: Int = 0) {
        self.healthResults = healthResults
        self.healthDelayYields = healthDelayYields
    }

    func nextHealthResult() async -> Bool {
        healthCheckCount += 1
        for _ in 0..<healthDelayYields {
            await Task.yield()
        }
        guard !healthResults.isEmpty else { return false }
        return healthResults.removeFirst()
    }

    func launch(
        id: UUID,
        onExit: @escaping CollectorExitHandler
    ) -> any CollectorProcessHandle {
        let process = FakeCollectorProcess()
        process.onTerminate = { onExit(id, 0) }
        launches.append(Launch(id: id, process: process, onExit: onExit))
        return process
    }

    func exitLaunch(at index: Int, status: Int32) {
        let launch = launches[index]
        launch.process.isRunning = false
        launch.onExit(launch.id, status)
    }
}

@MainActor
private final class FakeCollectorProcess: CollectorProcessHandle {
    var isRunning = true
    var terminateCount = 0
    var onTerminate: (() -> Void)?

    func terminate() {
        terminateCount += 1
        isRunning = false
        onTerminate?()
    }
}
