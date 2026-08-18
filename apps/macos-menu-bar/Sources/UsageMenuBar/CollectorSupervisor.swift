import Foundation

@MainActor
protocol CollectorProcessHandle: AnyObject {
    var isRunning: Bool { get }
    func terminate()
}

extension Process: CollectorProcessHandle {}

typealias CollectorExitHandler = @Sendable (UUID, Int32) -> Void
typealias CollectorRestartSleep = @Sendable (TimeInterval) async throws -> Void

@MainActor
final class CollectorSupervisor {
    typealias HealthCheck = () async -> Bool
    typealias Launcher = (
        _ id: UUID,
        _ onExit: @escaping CollectorExitHandler
    ) throws -> any CollectorProcessHandle

    private struct Child {
        let id: UUID
        let process: any CollectorProcessHandle
    }

    private struct HealthProbe {
        let id: UUID
        let task: Task<Bool, Never>
    }

    private let healthCheck: HealthCheck
    private let launch: Launcher
    private let restartDelays: [TimeInterval]
    private let restartSleep: CollectorRestartSleep
    private let healthFailureThreshold: Int
    private let onFailure: (String) -> Void
    private let onRecovery: () -> Void

    private var child: Child?
    private var activeHealthProbe: HealthProbe?
    private var pendingRestartTask: Task<Void, Never>?
    private var consecutiveHealthFailures = 0
    private var restartAttempt = 0
    private var healthCheckInFlight = false
    private var hasReportedFailure = false
    private var hasStarted = false
    private var isStopping = false

    init(
        healthCheck: @escaping HealthCheck,
        launch: @escaping Launcher,
        restartDelays: [TimeInterval] = [2, 5, 15, 30, 60],
        restartSleep: @escaping CollectorRestartSleep = { delay in
            guard delay > 0 else { return }
            try await Task.sleep(
                nanoseconds: UInt64(delay * 1_000_000_000)
            )
        },
        healthFailureThreshold: Int = 3,
        onFailure: @escaping (String) -> Void = { _ in },
        onRecovery: @escaping () -> Void = {}
    ) {
        self.healthCheck = healthCheck
        self.launch = launch
        self.restartDelays = restartDelays.isEmpty ? [60] : restartDelays
        self.restartSleep = restartSleep
        self.healthFailureThreshold = max(1, healthFailureThreshold)
        self.onFailure = onFailure
        self.onRecovery = onRecovery
    }

    func start() async {
        guard !hasStarted, !isStopping else { return }
        hasStarted = true

        let healthy = await probeHealth()
        guard hasStarted, !isStopping else { return }
        if healthy {
            noteHealthy()
            return
        }
        launchNow()
    }

    func checkHealth() async {
        guard hasStarted, !isStopping, !healthCheckInFlight else { return }
        healthCheckInFlight = true
        let healthy = await probeHealth()
        healthCheckInFlight = false
        guard !isStopping else { return }

        if healthy {
            noteHealthy()
            return
        }

        consecutiveHealthFailures += 1
        guard consecutiveHealthFailures >= healthFailureThreshold else { return }
        consecutiveHealthFailures = 0
        reportFailure("Collector health check failed")

        if let ownedChild = child {
            child = nil
            if ownedChild.process.isRunning {
                ownedChild.process.terminate()
            }
        }
        scheduleRestart()
    }

    func stop() {
        isStopping = true
        hasStarted = false
        activeHealthProbe?.task.cancel()
        activeHealthProbe = nil
        pendingRestartTask?.cancel()
        pendingRestartTask = nil

        let ownedChild = child
        child = nil
        if ownedChild?.process.isRunning == true {
            ownedChild?.process.terminate()
        }
    }

    private func launchNow() {
        guard hasStarted, !isStopping, child == nil else { return }
        let id = UUID()
        let onExit: CollectorExitHandler = { [weak self] id, status in
            Task { @MainActor in
                self?.childDidExit(id: id, status: status)
            }
        }

        do {
            let process = try launch(id, onExit)
            if isStopping {
                if process.isRunning {
                    process.terminate()
                }
                return
            }
            child = Child(id: id, process: process)
            consecutiveHealthFailures = 0
        } catch {
            reportFailure(error.localizedDescription)
            scheduleRestart()
        }
    }

    private func childDidExit(id: UUID, status: Int32) {
        guard child?.id == id else { return }
        child = nil
        consecutiveHealthFailures = 0
        guard !isStopping else { return }

        reportFailure("Collector exited (status \(status))")
        scheduleRestart()
    }

    private func scheduleRestart() {
        guard
            hasStarted,
            !isStopping,
            pendingRestartTask == nil,
            child == nil
        else {
            return
        }

        let index = min(restartAttempt, restartDelays.count - 1)
        let delay = max(0, restartDelays[index])
        restartAttempt += 1
        pendingRestartTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.restartSleep(delay)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            self.pendingRestartTask = nil
            await self.restartIfNeeded()
        }
    }

    private func restartIfNeeded() async {
        guard hasStarted, !isStopping, child == nil else { return }
        let healthy = await probeHealth()
        guard hasStarted, !isStopping, child == nil else { return }
        if healthy {
            noteHealthy()
            return
        }
        launchNow()
    }

    private func probeHealth() async -> Bool {
        if let activeHealthProbe {
            return await activeHealthProbe.task.value
        }

        let id = UUID()
        let check = healthCheck
        let task = Task { @MainActor in
            await check()
        }
        activeHealthProbe = HealthProbe(id: id, task: task)
        let result = await task.value
        if activeHealthProbe?.id == id {
            activeHealthProbe = nil
        }
        return result
    }

    private func reportFailure(_ message: String) {
        hasReportedFailure = true
        onFailure(message)
    }

    private func noteHealthy() {
        consecutiveHealthFailures = 0
        restartAttempt = 0
        pendingRestartTask?.cancel()
        pendingRestartTask = nil
        guard hasReportedFailure else { return }
        hasReportedFailure = false
        onRecovery()
    }
}
