import AppKit
import Combine
import Foundation
import ServiceManagement
import SwiftUI
import UserNotifications
import WidgetKit

private let defaultStaleInterval: TimeInterval = 10 * 60
private let claudeStaleInterval: TimeInterval = 45 * 60
private let notificationThresholdOptions = [70, 80, 90]

private enum PreferenceKey {
    static let notificationsEnabled = "usage-menu.notifications-enabled"
    static let notificationThreshold = "usage-menu.notification-threshold"
    static let deliveredNotificationCycles = "usage-menu.delivered-notification-cycles"
}

private struct UsagePayload: Decodable {
    let generatedAt: String?
    let providers: [UsageProvider]
    let skippedProviderCount: Int

    private enum CodingKeys: String, CodingKey {
        case generatedAt
        case providers
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        let decoded = try container.decode(
            [LossyDecodable<UsageProvider>].self,
            forKey: .providers
        )
        providers = decoded.compactMap(\.value)
        skippedProviderCount = decoded.count - providers.count
    }
}

private struct LossyDecodable<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

private struct UsageProvider: Decodable, Identifiable {
    let id: String
    let name: String
    let shortName: String
    let accent: String
    let state: String
    let plan: String?
    let sourceKind: String?
    let updatedAt: String?
    let windows: [UsageWindow]
    let balance: UsageBalance?
    let usageDetails: [UsageDetail]?
    let readings: [ProviderReading]?
    let message: String?
    let tokenUsage: TokenEstimate?
    let tokenEstimates: [TokenEstimate]?

    // Mirrors the web dashboard's primary-window choice (weekly, otherwise
    // the last window) while still requiring a usable percentage for the
    // menu bar's percent display.
    var primaryWindow: UsageWindow? {
        windows.first(where: { $0.id == "weekly" && $0.usedPercent != nil })
            ?? windows.last(where: { $0.usedPercent != nil })
    }

    var updatedDate: Date? {
        parseISO8601(updatedAt)
    }

    // Same rule as lib/provider-selectors.ts and the widget feed in
    // collector/desktop-preferences.mjs; keep the three in step.
    var isStale: Bool {
        // A reading taken before its window reset describes the last cycle.
        if primaryWindow?.isExpired() == true { return true }
        // A manual snapshot stays valid until its window ends.
        if sourceKind == "manual" { return false }
        guard let updatedDate else { return true }
        let threshold = id.hasPrefix("claude") ? claudeStaleInterval : defaultStaleInterval
        return Date().timeIntervalSince(updatedDate) > threshold
    }

    var isDegraded: Bool {
        state != "ready" || isStale
    }

    var effectiveTokenEstimates: [TokenEstimate] {
        if let tokenEstimates, !tokenEstimates.isEmpty {
            return tokenEstimates
        }
        return tokenUsage.map { [$0] } ?? []
    }
}

private struct UsageWindow: Decodable, Identifiable {
    let id: String
    let label: String
    let durationSeconds: Double?
    let usedPercent: Double?
    let used: Double?
    let limit: Double?
    let remaining: Double?
    let resetsAt: String?
    let resetDate: String?

    var remainingPercent: Double? {
        usedPercent.map { max(0, min(100, 100 - $0)) }
    }

    // Past its reset time, or past the end of a day-only reset date.
    func isExpired(now: Date = Date()) -> Bool {
        if let day = parseResetDate(resetDate),
           let end = Calendar.current.date(byAdding: .day, value: 1, to: day) {
            return end <= now
        }
        return parseISO8601(resetsAt).map { $0 <= now } ?? false
    }
}

private struct UsageBalance: Decodable {
    let label: String
    let value: Double
    let unit: String
    let approximate: Bool?
}

private struct UsageDetail: Decodable {
    let label: String
    let value: String
}

private struct ProviderReading: Decodable, Identifiable {
    let id: String
    let name: String
    let scope: String
    let updatedAt: String?
    let windows: [UsageWindow]
    let details: [UsageDetail]
    let message: String?
}

private struct TokenEstimate: Decodable {
    let basis: String
    let periodId: String?
    let scope: String?
    let estimated: Bool?
    let totalTokens: Double?
    let inputTokens: Double?
    let cachedInputTokens: Double?
    let outputTokens: Double?
    let reasoningOutputTokens: Double?
    let periodSeconds: Double?
    let models: [ModelTokenUsage]?
}

private struct ModelTokenUsage: Decodable {
    let id: String
    let label: String
    let estimatedTokens: Double?
    let inputTokens: Double?
    let cachedInputTokens: Double?
    let outputTokens: Double?
    let reasoningOutputTokens: Double?
    let requestCount: Double?
}

private struct ModelTokenDisplay: Identifiable {
    let id: String
    let label: String
    let tokens: Double
    let basis: String
    let periodId: String?
    let estimated: Bool
    let cachedInputTokens: Double?
}

private struct WindowPace {
    let projectedPercent: Double
    let exhaustionDate: Date?

    var level: Int {
        if projectedPercent >= 100 { return 2 }
        if projectedPercent >= 85 { return 1 }
        return 0
    }

    var summary: String {
        if let exhaustionDate {
            return "on pace to run out \(futureText(exhaustionDate))"
        }
        return "on pace for \(Int(projectedPercent.rounded()))% at cycle end"
    }
}

private func parseISO8601(_ value: String?) -> Date? {
    guard let value else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

@MainActor
private final class UsageStore: ObservableObject {
    @Published var providers: [UsageProvider] = []
    @Published var lastUpdated: Date?
    @Published var errorMessage: String?
    @Published var isRefreshing = false
    @Published var launchAtLoginEnabled = false
    @Published var launchAtLoginMessage: String?
    @Published var notificationsEnabled = false
    @Published var notificationThreshold = 80
    @Published var notificationMessage: String?
    @Published var collectorFailure: String?

    private let endpoint = URL(string: "http://127.0.0.1:4317/api/usage")!
    private let refreshEndpoint = URL(string: "http://127.0.0.1:4317/api/refresh")!
    private let museEndpoint = URL(string: "http://127.0.0.1:4317/muse")!
    private var refreshTimer: Timer?
    private let defaults = UserDefaults.standard
    private var deliveredNotificationCycles: Set<String> = []
    private var pendingNotificationKeys: Set<String> = []

    var hasDegradedData: Bool {
        activeCollectorFailure != nil
            || errorMessage != nil
            || providers.contains(where: \.isDegraded)
    }

    // An externally launched collector (`npm run local`) can still serve
    // data on the same port; only surface the bundled-runtime failure while
    // nothing is answering there.
    var activeCollectorFailure: String? {
        guard let collectorFailure else { return nil }
        return providers.isEmpty || errorMessage != nil ? collectorFailure : nil
    }

    // The collector finishes a cycle every minute; several missed cycles mean
    // it is stuck, even though it still answers with its last snapshot.
    var collectorIsStalled: Bool {
        guard let lastUpdated else { return false }
        return Date().timeIntervalSince(lastUpdated) > 5 * 60
    }

    // Ready sources first, so a failed one never pushes a working one out of
    // the menu bar's six slots.
    var menuBarProviders: [UsageProvider] {
        let ready = providers.filter { $0.state == "ready" && $0.primaryWindow != nil }
        let rest = providers.filter { !($0.state == "ready" && $0.primaryWindow != nil) }
        return Array((ready + rest).prefix(6))
    }

    init() {
        if ProcessInfo.processInfo.arguments.contains("--demo") {
            loadDemo()
            return
        }
        notificationsEnabled = defaults.bool(
            forKey: PreferenceKey.notificationsEnabled
        )
        let storedThreshold = defaults.integer(
            forKey: PreferenceKey.notificationThreshold
        )
        notificationThreshold = notificationThresholdOptions.contains(storedThreshold)
            ? storedThreshold
            : 80
        deliveredNotificationCycles = Set(
            defaults.stringArray(
                forKey: PreferenceKey.deliveredNotificationCycles
            ) ?? []
        )
        refreshLaunchAtLoginStatus()
        Task {
            await synchronizeNotificationAuthorization()
            for delaySeconds in [0, 2, 4, 8, 16] {
                if delaySeconds > 0 {
                    try? await Task.sleep(
                        nanoseconds: UInt64(delaySeconds) * 1_000_000_000
                    )
                }
                await refresh()
                if !providers.isEmpty { break }
            }
        }
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refresh()
            }
        }
    }

    private func loadDemo() {
        if let payload = try? JSONDecoder().decode(UsagePayload.self, from: menuBarDemoData()) {
            providers = payload.providers
            lastUpdated = Date()
        }
    }

    // The timer reads the collector's latest snapshot. `collect` asks the
    // collector to run a cycle first (the refresh button and connection
    // changes), which also retries sources that were waiting on a sign-in.
    func refresh(collect: Bool = false) async {
        if ProcessInfo.processInfo.arguments.contains("--demo") { loadDemo(); return }
        if isRefreshing {
            guard collect else { return }
            // A requested collection must not be dropped behind a timer read.
            while isRefreshing { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            var request = URLRequest(url: collect ? refreshEndpoint : endpoint)
            request.httpMethod = collect ? "POST" : "GET"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = collect ? 90 : 8
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let payload = try JSONDecoder().decode(UsagePayload.self, from: data)
            providers = payload.providers
            // Stays nil until the collector has finished its first cycle.
            lastUpdated = parseISO8601(payload.generatedAt)
            errorMessage = payload.skippedProviderCount > 0
                ? "Skipped \(payload.skippedProviderCount) provider(s) with incompatible data"
                : nil
            evaluateQuotaNotifications()
        } catch {
            NSLog("Usage menu refresh failed: %@", String(describing: error))
            let kept = providers.isEmpty ? "" : "; showing last data"
            errorMessage = error is DecodingError
                ? "Collector data format incompatible\(kept)"
                : "Local collector disconnected\(kept)"
        }
    }

    func applyConnections() async {
        await refresh(collect: true)
        WidgetCenter.shared.reloadTimelines(ofKind: "AIUsageQuotaPools")
    }

    func openDashboard() {
        let configuredURL = Bundle.main.object(
            forInfoDictionaryKey: "UsageHubDashboardURL"
        ) as? String
        guard let url = URL(
            string: configuredURL ?? "http://localhost:3000"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    func openMuseUsage() {
        NSWorkspace.shared.open(museEndpoint)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            refreshLaunchAtLoginStatus()
            if enabled && SMAppService.mainApp.status == .requiresApproval {
                launchAtLoginMessage = "Allow it in System Settings › General › Login Items"
            } else {
                launchAtLoginMessage = nil
            }
        } catch {
            refreshLaunchAtLoginStatus()
            launchAtLoginMessage = "Cannot change Login Items; run the app from Applications"
        }
    }

    func setNotificationsEnabled(_ enabled: Bool) async {
        if !enabled {
            notificationsEnabled = false
            notificationMessage = nil
            pendingNotificationKeys.removeAll()
            defaults.set(false, forKey: PreferenceKey.notificationsEnabled)
            return
        }

        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])
            notificationsEnabled = granted
            defaults.set(granted, forKey: PreferenceKey.notificationsEnabled)
            notificationMessage = granted ? nil : "Allow notifications in System Settings"
            if granted {
                evaluateQuotaNotifications()
            }
        } catch {
            notificationsEnabled = false
            defaults.set(false, forKey: PreferenceKey.notificationsEnabled)
            notificationMessage = "Could not enable quota alerts"
        }
    }

    func setNotificationThreshold(_ threshold: Int) {
        guard notificationThresholdOptions.contains(threshold) else { return }
        notificationThreshold = threshold
        defaults.set(threshold, forKey: PreferenceKey.notificationThreshold)
        evaluateQuotaNotifications()
    }

    private func refreshLaunchAtLoginStatus() {
        let status = SMAppService.mainApp.status
        launchAtLoginEnabled = status == .enabled || status == .requiresApproval
    }

    private func synchronizeNotificationAuthorization() async {
        guard defaults.bool(forKey: PreferenceKey.notificationsEnabled) else {
            notificationsEnabled = false
            return
        }

        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            notificationsEnabled = true
            notificationMessage = nil
        case .denied:
            notificationsEnabled = false
            notificationMessage = "Notifications are disabled in System Settings"
            defaults.set(false, forKey: PreferenceKey.notificationsEnabled)
        case .notDetermined:
            notificationsEnabled = false
            defaults.set(false, forKey: PreferenceKey.notificationsEnabled)
        @unknown default:
            notificationsEnabled = false
            defaults.set(false, forKey: PreferenceKey.notificationsEnabled)
        }
    }

    private func evaluateQuotaNotifications() {
        guard notificationsEnabled else { return }
        let threshold = Double(notificationThreshold)
        var keysChanged = false

        for provider in providers where provider.state == "ready" && !provider.isStale {
            for window in provider.windows where !window.isExpired() {
                guard let percent = window.usedPercent else { continue }
                let prefix = "\(provider.id):\(window.id):\(notificationThreshold):"

                if percent < threshold {
                    let previousCount = deliveredNotificationCycles.count
                    deliveredNotificationCycles = Set(
                        deliveredNotificationCycles.filter {
                            !$0.hasPrefix(prefix)
                        }
                    )
                    keysChanged = keysChanged ||
                        deliveredNotificationCycles.count != previousCount
                    continue
                }

                let key = "\(prefix)\(notificationCycle(window))"
                guard
                    !deliveredNotificationCycles.contains(key),
                    !pendingNotificationKeys.contains(key)
                else {
                    continue
                }
                pendingNotificationKeys.insert(key)
                deliverQuotaNotification(
                    provider: provider,
                    window: window,
                    percent: percent,
                    key: key
                )
            }
        }

        if keysChanged {
            persistDeliveredNotificationCycles()
        }
    }

    private func deliverQuotaNotification(
        provider: UsageProvider,
        window: UsageWindow,
        percent: Double,
        key: String
    ) {
        let content = UNMutableNotificationContent()
        content.title = "\(provider.name) at \(Int(percent.rounded()))% used"
        var details = "\(window.label) quota hit the \(notificationThreshold)% alert threshold"
        if let pace = paceForWindow(window), pace.level > 0 {
            details += "; \(pace.summary)"
        }
        content.body = details
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: key,
            content: content,
            trigger: nil
        )
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await UNUserNotificationCenter.current().add(request)
                self.pendingNotificationKeys.remove(key)
                self.deliveredNotificationCycles.insert(key)
                self.persistDeliveredNotificationCycles()
                self.notificationMessage = nil
            } catch {
                self.pendingNotificationKeys.remove(key)
                self.notificationMessage = "Quota alert failed to send; retrying on next refresh"
                NSLog(
                    "Usage menu notification failed: %@",
                    String(describing: error)
                )
            }
        }
    }

    private func persistDeliveredNotificationCycles() {
        if deliveredNotificationCycles.count > 200 {
            deliveredNotificationCycles = Set(
                deliveredNotificationCycles.sorted().suffix(200)
            )
        }
        defaults.set(
            Array(deliveredNotificationCycles).sorted(),
            forKey: PreferenceKey.deliveredNotificationCycles
        )
    }
}

private struct MenuBarPanel: View {
    @ObservedObject var store: UsageStore
    @ObservedObject private var preferences = DesktopPreferences.shared
    @State private var showingConnections = false
    @AppStorage("showMenuBarItem") private var showMenuBar = false
    @State private var page = 0
    private var pageCount: Int { max(1, (store.providers.count + 5) / 6) }
    private var currentPage: Int { min(page, pageCount - 1) }
    private var visibleProviders: [UsageProvider] { Array(store.providers[menuPageRange(count: store.providers.count, page: currentPage)]) }

    var body: some View {
        VStack(spacing: 0) {
            header

            if store.providers.isEmpty {
                emptyState
                    .frame(height: 220)
            } else {
                VStack(spacing: 10) {
                    ForEach(0..<((visibleProviders.count + 2) / 3), id: \.self) { row in
                        HStack(spacing: 10) {
                            ForEach(Array(visibleProviders.dropFirst(row * 3).prefix(3))) { provider in
                                CompactQuotaCard(provider: provider)
                            }
                            ForEach(0..<max(0, 3 - visibleProviders.dropFirst(row * 3).prefix(3).count), id: \.self) { _ in
                                Color.clear.frame(maxWidth: .infinity).frame(height: 185)
                            }
                        }
                    }
                    if store.providers.count > 6 {
                        HStack {
                            Button("Previous") { page = max(0, page - 1) }.disabled(currentPage == 0)
                            Spacer()
                            Text("Page \(currentPage + 1) of \(pageCount)").foregroundStyle(.secondary)
                            Spacer()
                            Button("Next") { page = min(pageCount - 1, currentPage + 1) }.disabled(currentPage + 1 >= pageCount)
                        }.font(.system(size: 10))
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
            }

            Divider()
            footer
                .disabled(ProcessInfo.processInfo.arguments.contains("--demo"))
        }
        .frame(width: 640)
        .background(.ultraThinMaterial)
    }

    private var header: some View {
        HStack(spacing: 11) {
            AppMark(needsAttention: store.hasDegradedData)

            VStack(alignment: .leading, spacing: 2) {
                Text("AI Usage Dashboard")
                    .font(.system(size: 13, weight: .semibold))
                Text(statusText)
                    .font(.system(size: 10))
                    .foregroundStyle(
                        store.errorMessage == nil
                            && store.activeCollectorFailure == nil
                            && !store.collectorIsStalled
                            ? Color.secondary
                            : Color.orange
                    )
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            Button {
                Task { await store.refresh(collect: true) }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
                    .rotationEffect(.degrees(store.isRefreshing ? 360 : 0))
                    .animation(
                        store.isRefreshing
                            ? .linear(duration: 0.8).repeatForever(autoreverses: false)
                            : .default,
                        value: store.isRefreshing
                    )
            }
            .buttonStyle(.borderless)
            .disabled(store.isRefreshing)
            .help("Refresh")
        }
        .padding(14)
    }

    private var statusText: String {
        if ProcessInfo.processInfo.arguments.contains("--demo") { return "Offline demo · synthetic data" }
        if let collectorFailure = store.activeCollectorFailure {
            return collectorFailure
        }
        if let errorMessage = store.errorMessage { return errorMessage }
        // This is the time of the collector's last cycle, not of any reading;
        // each card carries its own reading time.
        guard let lastUpdated = store.lastUpdated else { return "Collector is starting…" }
        if store.collectorIsStalled {
            return "Collector stalled · last cycle \(shortDateTime(lastUpdated))"
        }
        return "Collector running"
    }

    private var emptyState: some View {
        VStack(spacing: 9) {
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                .font(.system(size: 24))
                .foregroundStyle(.secondary)
            Text("No providers to show yet")
                .font(.system(size: 12, weight: .medium))
            Text(
                store.activeCollectorFailure
                    ?? store.errorMessage
                    ?? (store.lastUpdated == nil
                        ? "Waiting for the collector’s first reading…"
                        : "Turn on a source in Connections")
            )
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
    }

    private var footer: some View {
        VStack(spacing: 8) {
            HStack {
                Toggle(
                    "Quota alerts",
                    isOn: Binding(
                        get: { store.notificationsEnabled },
                        set: { enabled in
                            Task { await store.setNotificationsEnabled(enabled) }
                        }
                    )
                )
                .toggleStyle(.switch)
                .controlSize(.mini)

                Spacer()

                Toggle("Menu bar", isOn: $showMenuBar)
                    .toggleStyle(.switch).controlSize(.mini)
                Picker(
                    "Alert at",
                    selection: Binding(
                        get: { store.notificationThreshold },
                        set: { store.setNotificationThreshold($0) }
                    )
                ) {
                    ForEach(notificationThresholdOptions, id: \.self) { threshold in
                        Text("\(threshold)% used").tag(threshold)
                    }
                }
                .pickerStyle(.menu)
                .controlSize(.mini)
                .disabled(!store.notificationsEnabled)
                .frame(width: 112)
            }

            HStack {
                Toggle(
                    "Launch at login",
                    isOn: Binding(
                        get: { store.launchAtLoginEnabled },
                        set: { store.setLaunchAtLogin($0) }
                    )
                )
                .toggleStyle(.switch)
                .controlSize(.mini)

                Spacer()

                UsageAppShortcuts()
                if store.providers.contains(where: { $0.id == "muse" && $0.sourceKind == "manual" }) {
                    Button("Update Muse") { store.openMuseUsage() }
                        .buttonStyle(.borderless)
                }

                Button("Open Dashboard") {
                    store.openDashboard()
                }
                .buttonStyle(.borderless)

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
            }

            HStack {
                Button("Connections…") { showingConnections = true }
                    .sheet(isPresented: $showingConnections) {
                        ConnectionSettingsView(preferences: preferences, connected: Set(store.providers.filter { $0.state == "ready" }.map(\.id))) {
                            Task { await store.applyConnections() }
                        }
                    }
                Spacer()
                Toggle("Widget updates", isOn: Binding(get: { preferences.choices.widgetEnabled },
                    set: { flag in preferences.save { $0.widgetEnabled = flag } }))
                    .toggleStyle(.switch).controlSize(.mini)
                    .help("Right-click the desktop and choose Edit Widgets to add, resize, or remove AI Usage Dashboard. Turning updates off hides quota readings.")
            }
            if let issue = preferences.issue {
                Text(issue)
                    .font(.system(size: 9))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let launchAtLoginMessage = store.launchAtLoginMessage {
                Text(launchAtLoginMessage)
                    .font(.system(size: 9))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let notificationMessage = store.notificationMessage {
                Text(notificationMessage)
                    .font(.system(size: 9))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .font(.system(size: 11))
        .padding(12)
    }
}

private struct CompactQuotaCard: View {
    let provider: UsageProvider
    @State private var showDetails = false
    @Environment(\.colorScheme) private var colorScheme

    private var accent: Color { providerQuotaTint(provider, dark: colorScheme == .dark) }

    private var quotaDescription: String {
        guard let window = provider.primaryWindow, let remaining = window.remainingPercent else {
            return "\(summaryValue) \(summaryLabel), \(quotaResetCaption(provider))"
        }
        return "\(window.label), \(formatPercent(remaining)) remaining, \(quotaResetCaption(provider)), \(freshness)"
    }

    var body: some View {
        Button { showDetails = true } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    ProviderLogo(provider: provider, size: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(provider.name).font(.system(size: 12, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.88)
                        Text(provider.plan ?? "Usage")
                            .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Circle().fill(providerHealthColor(provider)).frame(width: 7, height: 7)
                }

                if let window = provider.primaryWindow, let remaining = window.remainingPercent {
                    // An old reading stays visible but must not look current.
                    quotaSummary(window, remaining: remaining)
                        .opacity(provider.isStale ? 0.45 : 1)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(summaryValue).font(.system(size: 25, weight: .semibold)).monospacedDigit()
                        Text(summaryLabel).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 57, alignment: .leading)
                }

                Divider().overlay(accent.opacity(0.12))
                Label(quotaResetCaption(provider), systemImage: "clock")
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.9)
                if let secondaryQuotaText {
                    Text(secondaryQuotaText).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                HStack(spacing: 3) {
                    Text(freshness)
                        .foregroundStyle(provider.isDegraded ? Color.orange : Color.secondary)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").foregroundStyle(accent)
                }
                .font(.system(size: 9))
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 185)
            .background {
                RoundedRectangle(cornerRadius: 15).fill(Color.primary.opacity(0.045))
                RoundedRectangle(cornerRadius: 15).fill(
                    LinearGradient(colors: [accent.opacity(0.12), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)
                )
            }
            .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(accent.opacity(0.25), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 15))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(provider.name), \(quotaDescription)")
        .accessibilityHint("Open quota and token details")
        .help("View \(provider.name) quota windows, tokens, and collection details")
        .popover(isPresented: $showDetails, arrowEdge: .trailing) {
            VStack(spacing: 0) {
                HStack {
                    Text("Provider details").font(.system(size: 12, weight: .semibold))
                    Spacer()
                    Button("Done") { showDetails = false }.buttonStyle(.borderless)
                }.padding(14)
                Divider()
                ScrollView { ProviderRow(provider: provider).padding(12) }
                    .frame(maxHeight: 420)
            }
            .frame(width: 390)
        }
    }

    private func quotaSummary(_ window: UsageWindow, remaining: Double) -> some View {
        HStack(spacing: 8) {
            QuotaRing(remaining: remaining, accent: accent)
                .frame(width: 42, height: 42)

            VStack(alignment: .leading, spacing: 4) {
                Text(window.label)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)

                VStack(alignment: .leading, spacing: 2) {
                    Text(formatPercent(remaining))
                        .font(.system(size: 17, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.68)
                    Text("Remaining").font(.system(size: 9)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var freshness: String {
        if provider.state != "ready" { return provider.sourceKind == "manual" ? "Awaiting entry" : "Unavailable" }
        guard let date = provider.updatedDate else { return provider.isStale ? "Stale" : "Waiting" }
        // Say how old a stale reading is; the word alone hides a two-day gap.
        if provider.isStale { return "Stale · read \(shortDateTime(date))" }
        return provider.sourceKind == "manual" ? "Updated \(localDateTime(date))" : freshnessText(date)
    }

    private var secondaryQuotaText: String? {
        if provider.sourceKind == "manual", let balance = provider.balance {
            return "Referral bonus: \(balance.approximate == true ? "≈" : "")\(formatTokens(balance.value)) tokens"
        }
        if provider.id == "cursor", let onDemand = provider.usageDetails?.first(where: { $0.label == "On-demand usage" }) {
            return "On-demand usage: \(onDemand.value)"
        }
        if provider.id == "antigravity",
           let window = provider.windows.first(where: { $0.id != provider.primaryWindow?.id }),
           let used = window.usedPercent {
            return "\(antigravityGroup(window)) \(formatPercent(max(0, 100 - used))) left"
        }
        if provider.id == "grok-bot", let balance = provider.balance {
            return "\(balance.label) \(formatBalance(balance))"
        }
        if let window = provider.windows.first(where: {
            $0.id != provider.primaryWindow?.id && ($0.id.contains("five_hour") || $0.durationSeconds == 18_000)
                && $0.usedPercent != nil && !$0.isExpired()
        }) {
            return "5 hours \(formatPercent(window.remainingPercent)) left"
        }
        if let token = provider.tokenUsage, let total = token.totalTokens {
            return "\(menuTokenCaption(basis: token.basis, period: token.periodId))\(formatTokens(total)) tokens"
        }
        return nil
    }

    private func antigravityGroup(_ window: UsageWindow) -> String {
        let name = window.label.components(separatedBy: " · ").first ?? window.label
        if name == "Claude and GPT models" { return "Claude/GPT" }
        return name.replacingOccurrences(of: " models", with: "")
    }

    private var summaryValue: String {
        if let balance = provider.balance { return formatBalance(balance) }
        if let tokens = provider.tokenUsage?.totalTokens { return formatTokens(tokens) }
        return "—"
    }

    private var summaryLabel: String {
        if provider.balance != nil { return "balance" }
        if provider.tokenUsage != nil { return "tokens" }
        return "not provided"
    }
}

private struct QuotaRing: View {
    let remaining: Double
    let accent: Color

    var body: some View {
        ZStack {
            Circle().strokeBorder(Color.primary.opacity(0.16), lineWidth: 6)
            Circle().inset(by: 3)
                .trim(from: 0, to: max(0, min(100, remaining)) / 100)
                .stroke(accent, lineWidth: 6)
                .rotationEffect(.degrees(-90))
        }
        .accessibilityHidden(true)
    }
}

private struct AppMark: View {
    let needsAttention: Bool

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.10, green: 0.13, blue: 0.14),
                                Color(red: 0.04, green: 0.07, blue: 0.08),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                HStack(alignment: .bottom, spacing: 2.5) {
                    meterTrack(height: 13, fillHeight: 6, color: .green)
                    meterTrack(
                        height: 21,
                        fillHeight: 13,
                        color: Color(red: 0.14, green: 0.91, blue: 0.67)
                    )
                    meterTrack(
                        height: 16,
                        fillHeight: 8,
                        color: Color(red: 0.08, green: 0.74, blue: 0.82)
                    )
                }
                .padding(.bottom, 7)
            }
            .frame(width: 36, height: 36)
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.white.opacity(0.10), lineWidth: 1)
            }

            Circle()
                .fill(needsAttention ? Color.orange : Color.green)
                .frame(width: 6, height: 6)
                .overlay {
                    Circle()
                        .stroke(Color(red: 0.05, green: 0.07, blue: 0.08), lineWidth: 1.5)
                }
                .offset(x: -3, y: -3)
        }
        .frame(width: 36, height: 36)
        .shadow(color: Color.black.opacity(0.18), radius: 4, y: 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            needsAttention
                ? "AI usage; some providers need attention"
                : "AI usage; data is healthy"
        )
        .help(needsAttention ? "Some providers need attention" : "Data is healthy")
    }

    private func meterTrack(
        height: CGFloat,
        fillHeight: CGFloat,
        color: Color
    ) -> some View {
        ZStack(alignment: .bottom) {
            Capsule()
                .fill(Color.white.opacity(0.09))
            Capsule()
                .fill(color)
                .frame(height: fillHeight)
        }
        .frame(width: 5, height: height)
    }
}

private struct ProviderRow: View {
    let provider: UsageProvider
    @Environment(\.colorScheme) private var colorScheme

    private var accent: Color {
        providerQuotaTint(provider, dark: colorScheme == .dark)
    }

    // Prefer today's observed usage over a calibrated quota conversion.
    // Quota pressure remains visible in the window meters above.
    private var preferredTokenEstimate: TokenEstimate? {
        if let tokenUsage = provider.tokenUsage {
            return tokenUsage
        }
        let estimates = provider.effectiveTokenEstimates
        return estimates.first(where: {
            $0.basis == "session_logs" && $0.periodId == "today"
        })
            ?? estimates.first(where: {
                $0.basis == "api_usage" && $0.periodId == "today"
            })
            ?? estimates.first(where: { $0.basis == "api_usage" })
            ?? estimates.first(where: {
                $0.basis == "session_logs" && $0.periodId == "weekly_cycle"
            })
            ?? estimates.first(where: { $0.basis == "session_logs" })
            ?? estimates.first(where: { $0.basis == "quota_percentage" })
    }

    private var modelTokens: [ModelTokenDisplay] {
        guard let usage = preferredTokenEstimate else { return [] }
        let entries = (usage.models ?? []).compactMap { model -> ModelTokenDisplay? in
            guard let tokens = model.estimatedTokens else { return nil }
            return ModelTokenDisplay(
                id: "\(usage.basis)-\(model.id)",
                label: model.label,
                tokens: tokens,
                basis: usage.basis,
                periodId: usage.periodId,
                estimated: usage.estimated ?? (usage.basis != "api_usage"),
                cachedInputTokens: model.cachedInputTokens
            )
        }
        return Array(entries.sorted { $0.tokens > $1.tokens }.prefix(3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            providerHeader

            if !provider.windows.isEmpty {
                VStack(spacing: 9) {
                    ForEach(provider.windows) { window in
                        WindowRow(window: window, accent: accent,
                                  reportPace: provider.readings?.isEmpty != false && !["grok-bot", "antigravity"].contains(provider.id),
                                  showReset: provider.id != "cursor" && (provider.id != "antigravity" || window.resetsAt != nil))
                    }
                }
            }
            if let balance = provider.balance {
                HStack {
                    Label(balance.label, systemImage: "wallet.pass")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(formatBalance(balance))
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                }
                .font(.system(size: 10))
            }
            if let details = provider.usageDetails {
                ForEach(details, id: \.label) { detail in
                    HStack {
                        Text(detail.label).foregroundStyle(.secondary)
                        Spacer()
                        Text(detail.value).monospacedDigit()
                    }
                    .font(.system(size: 10))
                }
            }

            if let readings = provider.readings, !readings.isEmpty {
                DisclosureGroup("Source readings") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(readings) { reading in SourceReadingView(reading: reading) }
                    }.padding(.top, 8)
                }.font(.system(size: 10))
            }

            if let message = provider.message, !message.isEmpty {
                // A note on a healthy, current source is information, not a warning.
                Label(message, systemImage: provider.isDegraded ? "clock.badge.exclamationmark" : "info.circle")
                    .font(.system(size: 9))
                    .foregroundStyle(
                        provider.state != "ready" ? Color.red
                            : provider.isStale ? Color.orange : Color.secondary
                    )
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !modelTokens.isEmpty {
                Divider()
                    .opacity(0.55)
                VStack(alignment: .leading, spacing: 7) {
                    if let usage = preferredTokenEstimate,
                       usage.periodId == "today",
                       let total = usage.totalTokens {
                        HStack {
                            Text("OBSERVED TOKENS TODAY")
                            Spacer()
                            Text(formatTokens(total))
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                                .monospacedDigit()
                        }
                        .font(.system(size: 8, weight: .semibold))

                        if let input = usage.inputTokens,
                           let output = usage.outputTokens {
                            Text("Input \(formatTokens(input)) + output \(formatTokens(output))")
                                .font(.system(size: 8))
                                .foregroundStyle(.secondary)
                        }
                    }

                    Text(
                        preferredTokenEstimate?.periodId == "today"
                            ? "MODEL TOKENS TODAY"
                            : "MODEL TOKENS"
                    )
                        .font(.system(size: 8, weight: .semibold))
                        .tracking(0.7)
                        .foregroundStyle(.tertiary)

                    ForEach(modelTokens) { model in
                        ModelTokenRow(model: model)
                    }
                }
            }
        }
        .padding(12)
        .background(
            Color.primary.opacity(0.035),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        }
    }

    private var providerHeader: some View {
        HStack(spacing: 10) {
            ProviderLogo(provider: provider)

            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name)
                    .font(.system(size: 12, weight: .semibold))
                Text(
                    provider.state == "ready"
                        ? (provider.plan ?? stateLabel)
                        : stateLabel
                )
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(primaryValue)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                Text(provider.updatedDate.map { date in
                    provider.sourceKind == "manual" ? "Updated \(localDateTime(date))" : freshnessText(date)
                } ?? "update time unknown")
                    .font(.system(size: 8))
                    .foregroundStyle(
                        provider.state != "ready"
                            ? Color.red
                            : provider.isStale ? Color.orange : Color.secondary
                    )
            }
        }
    }

    private var primaryValue: String {
        if let remaining = provider.primaryWindow?.remainingPercent {
            return "\(formatPercent(remaining)) left"
        }
        if let balance = provider.balance {
            return formatBalance(balance)
        }
        return provider.state == "ready" ? "—" : "ERR"
    }

    private var stateLabel: String {
        switch provider.state {
        case "ready": return "Live"
        case "needs_configuration": return "Needs setup"
        case "auth_error": return "Sign-in required"
        default: return "Connection error"
        }
    }
}

private struct WindowRow: View {
    let window: UsageWindow
    let accent: Color
    let reportPace: Bool
    let showReset: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                if let remaining = window.remainingPercent {
                    Text("\(formatPercent(remaining)) remaining")
                        .font(.system(size: 11, weight: .semibold))
                        .monospacedDigit()
                }
            }

            if let percent = window.usedPercent, let remaining = window.remainingPercent {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.primary.opacity(0.15))
                        Capsule().fill(percent >= 85 ? .red : percent >= 70 ? .orange : accent)
                            .frame(width: geometry.size.width * remaining / 100)
                    }
                }
                .frame(height: 8)
                .accessibilityHidden(true)
            }

            if let used = window.used, let limit = window.limit {
                Text("\(formatCompactNumber(used)) / \(formatCompactNumber(limit))")
                    .font(.system(size: 11, weight: .medium))
                    .monospacedDigit()
            }

            if showReset {
                Label(resetLabel(window), systemImage: "clock")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            if reportPace, let pace = paceForWindow(window) {
                HStack(spacing: 4) {
                    Image(systemName: pace.level > 0 ? "flame.fill" : "gauge.with.dots.needle.33percent")
                    Text(pace.summary)
                }
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(paceColor(pace.level))
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
    }
}

private struct SourceReadingView: View {
    let reading: ProviderReading

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(reading.name).fontWeight(.semibold)
            Text(reading.scope).foregroundStyle(.secondary)
            if let date = parseISO8601(reading.updatedAt) {
                Text(freshnessText(date)).foregroundStyle(.secondary)
            }
            ForEach(reading.windows) { window in
                let digits = reading.id == "grok-bot" ? 4 : 0
                let percent = formatPercent(window.usedPercent, fractionDigits: digits)
                let original = window.usedPercent.map { "\($0)%" } ?? percent
                row(window.label, window.usedPercent == nil ? percent : "\(percent) used").help(original)
                if let reset = parseISO8601(window.resetsAt) {
                    row("Resets", localDateTime(reset))
                }
            }
            ForEach(reading.details, id: \.label) { detail in
                row(detail.label, detail.value)
            }
            if let message = reading.message {
                Text(message).foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit()
        }
    }
}

private struct ModelTokenRow: View {
    let model: ModelTokenDisplay

    private var tokenText: String {
        var text = "\(model.estimated ? "≈" : "")\(formatTokens(model.tokens))"
        if model.basis == "session_logs",
           let cached = model.cachedInputTokens,
           model.tokens > 0,
           cached > 0 {
            let share = Int((cached / model.tokens * 100).rounded())
            text += " · \(share)% cached"
        }
        return text
    }

    var body: some View {
        HStack(spacing: 7) {
            Text(
                model.periodId == "today"
                    ? "Today · local"
                    : basisLabel(model.basis)
            )
                .font(.system(size: 7, weight: .semibold))
                .foregroundStyle(basisColor(model.basis))
                .padding(.horizontal, 5)
                .frame(height: 16)
                .background(
                    basisColor(model.basis).opacity(0.11),
                    in: Capsule()
                )

            Text(model.label)
                .font(.system(size: 9, weight: .medium))
                .lineLimit(1)

            Spacer(minLength: 8)

            Text(tokenText)
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .monospacedDigit()
        }
    }
}

private struct ProviderLogo: View {
    let id: String
    let name: String
    let shortName: String
    let accent: String
    let size: CGFloat

    init(provider: UsageProvider, size: CGFloat = 32) {
        self.init(id: provider.id, name: provider.name, shortName: provider.shortName, accent: provider.accent, size: size)
    }

    init(id: String, name: String, shortName: String, accent: String, size: CGFloat) {
        self.id = id
        self.name = name
        self.shortName = shortName
        self.accent = accent
        self.size = size
    }

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let color = BrandAssets.tint(id: id, fallback: accent, dark: colorScheme == .dark)
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.27).fill(color.opacity(0.12))
            if let image = BrandAssets.image(for: id) {
                Image(nsImage: image)
                    .resizable().renderingMode(.template).scaledToFit()
                    .frame(width: size * 0.64, height: size * 0.64)
                    .foregroundStyle(color)
            } else {
                Text(shortName).font(.system(size: size * 0.34, weight: .bold)).foregroundStyle(color)
            }
        }
        .frame(width: size, height: size)
        .help(name)
    }
}

private enum BrandAssets {
    private static let names = [
        "codex": "codex",
        "claude": "claude",
        "claude-fable": "claude",
        "openai-api": "openai",
        "kimi": "kimi",
        "deepseek": "deepseek",
        "openrouter": "openrouter",
        "github-copilot": "githubcopilot",
        "grok": "grok",
        "grok-bot": "grok",
        "cursor": "cursor",
        "antigravity": "antigravity-mark",
    ]
    private static let palette: [String: [String]] = {
        for base in [Bundle.main.resourceURL?.appendingPathComponent("brands"), URL(fileURLWithPath: "public/brands", isDirectory: true)].compactMap({ $0 }) {
            if let data = try? Data(contentsOf: base.appendingPathComponent("palette.json")),
               let colors = try? JSONDecoder().decode([String: [String]].self, from: data) { return colors }
        }
        return [:]
    }()

    static func tint(id: String, fallback: String, dark: Bool) -> Color {
        let colors = palette[id] ?? []
        let hex = colors.count == 2 ? colors[dark ? 0 : 1] : fallback
        return Color(hex: hex) ?? .primary
    }

    // Parsed once per mark; the cards and the menu bar ask on every redraw.
    @MainActor private static var images: [String: NSImage?] = [:]

    @MainActor static func image(for providerID: String) -> NSImage? {
        if let cached = images[providerID] { return cached }
        let image = loadImage(for: providerID)
        images[providerID] = image
        return image
    }

    private static func loadImage(for providerID: String) -> NSImage? {
        guard let name = names[providerID] else { return nil }
        let fileName = "\(name).svg"
        let candidates = [
            Bundle.main.resourceURL?
                .appendingPathComponent("brands", isDirectory: true)
                .appendingPathComponent(fileName),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent("public/brands", isDirectory: true)
                .appendingPathComponent(fileName),
        ].compactMap { $0 }

        guard let url = candidates.first(where: {
            FileManager.default.fileExists(atPath: $0.path)
        }) else {
            return nil
        }
        return NSImage(contentsOf: url)
    }
}

// Identifies a quota cycle for alert de-duplication. Providers report the same
// reset a few milliseconds apart from poll to poll, so the reset is rounded to
// the hour instead of being compared as text.
private func notificationCycle(_ window: UsageWindow) -> String {
    guard let reset = parseISO8601(window.resetsAt) else {
        return window.resetsAt ?? "until-below-threshold"
    }
    let hour = (reset.timeIntervalSince1970 / 3_600).rounded() * 3_600
    return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: hour))
}

private func shortDateTime(_ date: Date) -> String {
    date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
}

private func freshnessText(_ date: Date) -> String {
    let seconds = max(0, Date().timeIntervalSince(date))
    if seconds < 60 { return "updated just now" }
    if seconds < 3_600 { return "updated \(Int(seconds / 60))m ago" }
    if seconds < 86_400 { return "updated \(Int(seconds / 3_600))h ago" }
    return localDateTime(date)
}

private func formatPercent(_ value: Double?, fractionDigits: Int = 0) -> String {
    guard let value else { return "—" }
    if fractionDigits > 0 { return "\(formatCompactNumber(value, maximumFractionDigits: fractionDigits))%" }
    return "\(Int(value.rounded()))%"
}

private func resetText(_ value: String?) -> String {
    guard let date = parseISO8601(value) else {
        return "no reset time provided"
    }
    if date < Date() {
        return "awaiting refresh"
    }
    return "resets \(localDateTime(date))"
}

private func parseResetDate(_ value: String?) -> Date? {
    guard let components = value?.split(separator: "-").compactMap({ Int($0) }),
          components.count == 3 else { return nil }
    return Calendar.current.date(from: DateComponents(
        year: components[0], month: components[1], day: components[2]
    ))
}

private func resetLabel(_ window: UsageWindow) -> String {
    if let date = parseResetDate(window.resetDate) {
        return "resets \(date.formatted(.dateTime.month(.abbreviated).day()))"
    }
    return resetText(window.resetsAt)
}

private func paceForWindow(
    _ window: UsageWindow,
    now: Date = Date()
) -> WindowPace? {
    guard
        let percent = window.usedPercent,
        percent >= 0,
        let duration = window.durationSeconds,
        duration > 0,
        let resetDate = parseISO8601(window.resetsAt)
    else {
        return nil
    }

    let startDate = resetDate.addingTimeInterval(-duration)
    let elapsed = now.timeIntervalSince(startDate)
    guard elapsed > max(60, duration * 0.005), elapsed < duration else {
        return nil
    }

    let elapsedFraction = elapsed / duration
    let projectedPercent = min(999, percent / elapsedFraction)
    let exhaustionDate: Date?
    if percent > 0 {
        let secondsToFull = elapsed / (percent / 100)
        let projectedDate = startDate.addingTimeInterval(secondsToFull)
        exhaustionDate = projectedDate < resetDate && projectedDate > now
            ? projectedDate
            : nil
    } else {
        exhaustionDate = nil
    }

    return WindowPace(
        projectedPercent: projectedPercent,
        exhaustionDate: exhaustionDate
    )
}

private func futureText(_ date: Date) -> String {
    let seconds = date.timeIntervalSinceNow
    if seconds < 3_600 {
        return "in \(max(1, Int(seconds / 60)))m"
    }
    if seconds < 86_400 {
        let hours = seconds / 3_600
        return "in \(formatCompactNumber(hours))h"
    }
    return localDateTime(date)
}

private func localDateTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
}

private func providerHealthColor(_ provider: UsageProvider) -> Color {
    if provider.state != "ready" { return .red }
    if provider.isStale { return .orange }
    return .green
}

private func providerQuotaTint(_ provider: UsageProvider, dark: Bool) -> Color {
    BrandAssets.tint(id: provider.id, fallback: provider.accent, dark: dark)
}

private func paceColor(_ level: Int) -> Color {
    switch level {
    case 2: return .red
    case 1: return .orange
    default: return .secondary
    }
}

private func formatBalance(_ balance: UsageBalance) -> String {
    let value = formatCompactNumber(balance.value, maximumFractionDigits: 2)
    switch balance.unit.uppercased() {
    case "USD": return "$\(value)"
    case "CNY": return "¥\(value)"
    case "CREDITS": return value
    case "TOKENS": return "\(balance.approximate == true ? "≈" : "")\(value) tokens"
    default: return "\(value) \(balance.unit.uppercased())"
    }
}

private func formatTokens(_ value: Double) -> String {
    if value >= 1_000_000_000 {
        return "\(formatCompactNumber(value / 1_000_000_000))B"
    }
    if value >= 1_000_000 {
        return "\(formatCompactNumber(value / 1_000_000))M"
    }
    if value >= 1_000 {
        return "\(formatCompactNumber(value / 1_000))K"
    }
    return formatCompactNumber(value, maximumFractionDigits: 0)
}

// NumberFormatter is expensive to create; all call sites are on the main
// thread, so a single shared instance with a per-call fraction setting is
// safe here.
private let compactNumberFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    return formatter
}()

private func formatCompactNumber(
    _ value: Double,
    maximumFractionDigits: Int = 1
) -> String {
    compactNumberFormatter.maximumFractionDigits = maximumFractionDigits
    return compactNumberFormatter.string(from: NSNumber(value: value)) ?? "\(value)"
}

private func basisLabel(_ basis: String) -> String {
    switch basis {
    case "api_usage": return "API · account"
    case "session_logs": return "Logs · local"
    case "quota_percentage": return "Quota · calibrated"
    default: return "Other"
    }
}

private func basisColor(_ basis: String) -> Color {
    switch basis {
    case "api_usage": return .green
    case "session_logs": return .blue
    case "quota_percentage": return .orange
    default: return .secondary
    }
}

private extension Color {
    init?(hex: String) {
        let value = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard value.count == 6, let integer = UInt64(value, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((integer >> 16) & 0xff) / 255,
            green: Double((integer >> 8) & 0xff) / 255,
            blue: Double(integer & 0xff) / 255,
            opacity: 1
        )
    }
}

// MARK: - Collector Node.js runtime discovery

// The bundled collector uses `node:sqlite`, so runtimes older than this
// floor crash immediately on startup.
private let minimumNodeVersion = NodeVersion(major: 22, minor: 13, patch: 0)
private let collectorLogDisplayPath =
    "~/Library/Logs/AIUsageDashboard/collector.log"
private let collectorLogMaxBytes = 5 * 1024 * 1024
private let collectorHealthCheckInterval: TimeInterval = 15

private struct NodeVersion: Comparable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int

    var description: String { "v\(major).\(minor).\(patch)" }

    static func < (lhs: NodeVersion, rhs: NodeVersion) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }

    /// Parses `node --version` output ("v22.13.0") or a version-manager
    /// directory name ("22.13.0"); nil without a leading major.minor pair.
    /// Trailing pre-release or build suffixes after the patch are ignored.
    static func parse(_ text: String) -> NodeVersion? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("v") { value.removeFirst() }
        let parts = value.split(
            separator: ".",
            maxSplits: 2,
            omittingEmptySubsequences: false
        )
        guard
            parts.count >= 2,
            let major = Int(parts[0]),
            let minor = Int(parts[1])
        else {
            return nil
        }
        let patch = parts.count == 3
            ? Int(parts[2].prefix(while: \.isNumber)) ?? 0
            : 0
        return NodeVersion(major: major, minor: minor, patch: patch)
    }
}

private struct NodeDiscovery {
    let nodeURL: URL?
    let nodeVersion: NodeVersion?
    let bestRejectedVersion: NodeVersion?
}

/// Locates a Node.js runtime able to run the bundled collector. Probes, in
/// order: the USAGE_HUB_NODE override, Homebrew and system paths, nvm,
/// mise, asdf, and fnm installs (newest first), then the login shell's PATH.
/// The first candidate whose `--version` meets the floor wins; the best
/// rejected version is kept for the failure message.
private func discoverNodeRuntime(
    environment: [String: String] = ProcessInfo.processInfo.environment
) -> NodeDiscovery {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidateGroups: [() -> [String]] = [
        {
            let override = environment["USAGE_HUB_NODE"]?
                .trimmingCharacters(in: .whitespaces) ?? ""
            return override.isEmpty ? [] : [override]
        },
        { ["/opt/homebrew/bin/node", "/usr/local/bin/node"] },
        { versionManagerNodeCandidates(installRoot: "\(home)/.nvm/versions/node") },
        { versionManagerNodeCandidates(installRoot: "\(home)/.local/share/mise/installs/node") },
        { versionManagerNodeCandidates(installRoot: "\(home)/.asdf/installs/nodejs") },
        // fnm keeps each install under <version>/installation and hands
        // shells a per-session symlink directory that is deleted later, so
        // its installs are probed directly rather than through the shell.
        {
            [
                "\(home)/.local/share/fnm/node-versions",
                "\(home)/Library/Application Support/fnm/node-versions",
            ].flatMap {
                versionManagerNodeCandidates(
                    installRoot: $0,
                    binaryPath: "installation/bin/node"
                )
            }
        },
        { loginShellNodePath().map { [$0] } ?? [] },
    ]

    var bestRejected: NodeVersion?
    var probed = Set<String>()
    for group in candidateGroups {
        for candidate in group() {
            guard probed.insert(candidate).inserted else { continue }
            guard let version = probeNodeVersion(at: candidate) else { continue }
            if version >= minimumNodeVersion {
                return NodeDiscovery(
                    nodeURL: URL(fileURLWithPath: candidate),
                    nodeVersion: version,
                    bestRejectedVersion: bestRejected
                )
            }
            NSLog(
                "Rejected Node.js %@ at %@: the collector needs %@ or newer",
                version.description,
                candidate,
                minimumNodeVersion.description
            )
            if bestRejected.map({ version > $0 }) ?? true {
                bestRejected = version
            }
        }
    }
    return NodeDiscovery(
        nodeURL: nil,
        nodeVersion: nil,
        bestRejectedVersion: bestRejected
    )
}

/// Lists a version manager's Node installs (for example
/// ~/.nvm/versions/node/v22.13.0/bin/node) newest first, so the
/// accept-first probe prefers the latest install.
private func versionManagerNodeCandidates(
    installRoot: String,
    binaryPath: String = "bin/node"
) -> [String] {
    guard
        let entries = try? FileManager.default
            .contentsOfDirectory(atPath: installRoot)
    else {
        return []
    }
    return entries
        .compactMap { entry -> (version: NodeVersion, path: String)? in
            guard let version = NodeVersion.parse(entry) else { return nil }
            return (version, "\(installRoot)/\(entry)/\(binaryPath)")
        }
        .sorted { $0.version > $1.version }
        .map(\.path)
}

/// Runs `<candidate> --version` and parses the result; nil when the file
/// is missing, not executable, or does not behave like Node.
private func probeNodeVersion(at path: String) -> NodeVersion? {
    guard FileManager.default.isExecutableFile(atPath: path) else { return nil }
    guard let output = capturedOutput(of: path, arguments: ["--version"]) else {
        return nil
    }
    return NodeVersion.parse(output)
}

/// Resolves `node` through the user's login shell, which loads the PATH
/// set up by tools this discovery does not know about.
private func loginShellNodePath() -> String? {
    guard
        let output = capturedOutput(
            of: "/bin/zsh",
            arguments: ["-lc", "command -v node"]
        )
    else {
        return nil
    }
    let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
    guard path.hasPrefix("/") else { return nil }
    // Version managers may answer with a per-session symlink (fnm's
    // fnm_multishells directory) that disappears while the collector is
    // still running; keep the real binary it points at instead.
    return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
}

private func capturedOutput(
    of executablePath: String,
    arguments: [String]
) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executablePath)
    process.arguments = arguments
    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        return nil
    }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)
}

/// Opens ~/Library/Logs/AIUsageDashboard/collector.log for appending,
/// truncating first when it exceeds 5 MB.
private func openCollectorLog() -> FileHandle? {
    let fileManager = FileManager.default
    let directory = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/AIUsageDashboard", isDirectory: true)
    let logURL = directory.appendingPathComponent("collector.log")
    do {
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let attributes = try? fileManager.attributesOfItem(atPath: logURL.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        if attributes == nil || size > collectorLogMaxBytes {
            try Data().write(to: logURL)
        }
        let handle = try FileHandle(forWritingTo: logURL)
        try handle.seekToEnd()
        return handle
    } catch {
        NSLog(
            "Collector log unavailable at %@: %@",
            logURL.path,
            String(describing: error)
        )
        return nil
    }
}

private struct CollectorHealthResponse: Decodable {
    let ok: Bool
}

private struct CollectorLaunchFailure: LocalizedError {
    let message: String

    var errorDescription: String? { message }
}

private func bundledCollectorIsHealthy() async -> Bool {
    guard let url = URL(string: "http://127.0.0.1:4317/healthz") else {
        return false
    }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 2
    do {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard
            let httpResponse = response as? HTTPURLResponse,
            (200..<300).contains(httpResponse.statusCode)
        else {
            return false
        }
        return (try? JSONDecoder().decode(
            CollectorHealthResponse.self,
            from: data
        ).ok) == true
    } catch {
        return false
    }
}

private func launchBundledCollector(
    resourceURL: URL,
    id: UUID,
    onExit: @escaping CollectorExitHandler
) throws -> Process {
    let collectorURL = resourceURL
        .appendingPathComponent("collector", isDirectory: true)
        .appendingPathComponent("server.mjs")
    let discovery = discoverNodeRuntime()
    guard
        let nodeURL = discovery.nodeURL,
        let nodeVersion = discovery.nodeVersion
    else {
        let bestFound = discovery.bestRejectedVersion
            .map { " (best found: \($0))" } ?? ""
        let failure = "Node.js \(minimumNodeVersion.major)."
            + "\(minimumNodeVersion.minor)+ not found\(bestFound). "
            + "Install via Homebrew or set USAGE_HUB_NODE."
        NSLog("Bundled collector not started: %@", failure)
        throw CollectorLaunchFailure(message: failure)
    }

    let logHandle = openCollectorLog()
    if let logHandle,
       let banner = "[UsageMenuBar] \(Date()) starting collector with "
           .appending("Node.js \(nodeVersion) at \(nodeURL.path)\n")
           .data(using: .utf8) {
        try? logHandle.write(contentsOf: banner)
    }

    let process = Process()
    process.executableURL = nodeURL
    process.arguments = [
        "--enable-source-maps",
        collectorURL.path,
    ]
    process.currentDirectoryURL = resourceURL
    process.environment = ProcessInfo.processInfo.environment.merging([
        "USAGE_HUB_HOST": "127.0.0.1",
        "USAGE_HUB_PORT": "4317",
        // Lets the collector stop itself if this app is killed without the
        // chance to stop it, so a later launch never adopts stale code.
        "USAGE_HUB_OWNER_PID": String(ProcessInfo.processInfo.processIdentifier),
    ]) { _, bundledValue in bundledValue }
    process.standardOutput = logHandle ?? FileHandle.nullDevice
    process.standardError = logHandle ?? FileHandle.nullDevice
    process.terminationHandler = { child in
        onExit(id, child.terminationStatus)
    }
    do {
        try process.run()
        return process
    } catch {
        NSLog(
            "Bundled collector failed to start: %@",
            String(describing: error)
        )
        throw CollectorLaunchFailure(
            message: "Collector failed to start; see \(collectorLogDisplayPath)"
        )
    }
}

private func quotaResetCaption(_ provider: UsageProvider) -> String {
    if provider.id == "cursor", let billingEnd = provider.usageDetails?.first(where: { $0.label == "Billing period ends" }) {
        return "Billing ends \(billingEnd.value)"
    }
    guard let window = provider.primaryWindow else { return "No quota window" }
    if let reset = parseISO8601(window.resetsAt), reset >= Date() {
        return "Resets \(reset.formatted(.dateTime.month(.abbreviated).day().hour().minute()))"
    }
    if provider.id == "antigravity", window.resetsAt == nil { return "No active reset" }
    return resetLabel(window)
}

private struct UsageAppShortcuts: View {
    @ObservedObject private var preferences = DesktopPreferences.shared
    var body: some View {
        HStack(spacing: 9) {
            shortcut("gemini", "Gemini", "com.google.GeminiMacOS")
            shortcut("muse", "Muse", "com.meta.endo")
        }
    }

    @ViewBuilder private func shortcut(_ key: String, _ title: String, _ bundle: String) -> some View {
        if preferences.choices.shortcuts[key] == true,
           let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) {
            Button { NSWorkspace.shared.openApplication(at: app, configuration: .init()) } label: {
                HStack(spacing: 4) {
                    Image(nsImage: NSWorkspace.shared.icon(forFile: app.path))
                        .resizable().scaledToFit().frame(width: 22, height: 22)
                    Text(title)
                }
            }.buttonStyle(.borderless).help("Open " + title + " to check usage")
        }
    }
}

private struct WidgetPoolDetail: View {
    @ObservedObject var store: UsageStore
    let poolID: String
    var body: some View {
        ScrollView {
            if let provider = store.providers.first(where: { $0.id == poolID }) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(provider.id == "claude-fable" ? "Claude · Fable weekly allowance" : provider.name).font(.title3.bold())
                    if provider.id == "claude" { Text("Subscription allowance · Claude Code").font(.caption) }
                    ProviderRow(provider: provider)
                }.padding(16)
            } else {
                Text(store.isRefreshing || store.lastUpdated == nil
                    ? "Loading quota pool…" : "This quota pool is no longer available.")
                    .padding()
            }
        }.frame(minWidth: 380, minHeight: 320)
    }
}

@MainActor
private final class UsageMenuBarDelegate: NSObject, NSApplicationDelegate {
    private(set) lazy var store = UsageStore()
    private var dashboardWindow: NSWindow?
    private var poolWindow: NSWindow?
    private var defaultsObserver: NSObjectProtocol?
    private var previewWindow: NSWindow?
    private var collectorSupervisor: CollectorSupervisor?
    private var collectorHealthTimer: Timer?
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var statusUpdateCancellable: AnyCancellable?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // The dashboard window is opened on every launch; do not also bring
        // back whatever windows were open at the last quit.
        UserDefaults.standard.register(defaults: ["NSQuitAlwaysKeepsWindows": false])
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !ProcessInfo.processInfo.arguments.contains("--demo") {
            configureBundledCollector(reportingTo: store)
        }
        if !ProcessInfo.processInfo.arguments.contains("--demo") {
            showDashboard()
            updateMenuVisibility()
            defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.updateMenuVisibility() }
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--demo") {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 560), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "AI Usage Dashboard — Demo"
            window.contentViewController = NSHostingController(rootView: MenuBarPanel(store: store))
            window.center()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            previewWindow = window
            if let flag = ProcessInfo.processInfo.arguments.firstIndex(of: "--demo-export"),
               ProcessInfo.processInfo.arguments.indices.contains(flag + 1) {
                let path = ProcessInfo.processInfo.arguments[flag + 1]
                DispatchQueue.main.async {
                    window.contentView?.layoutSubtreeIfNeeded()
                    guard let view = window.contentView,
                          let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
                        NSLog("Could not render demo preview")
                        exit(1)
                    }
                    view.cacheDisplay(in: view.bounds, to: bitmap)
                    do {
                        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
                        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
                    } catch {
                        NSLog("Demo export failed: %@", String(describing: error))
                        exit(1)
                    }
                    NSApp.terminate(nil)
                }
            }
        }
        statusUpdateCancellable = store.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async {
                self?.updateStatusItem()
            }
        }
    }

    private func updateMenuVisibility() {
        if !UserDefaults.standard.bool(forKey: "showMenuBarItem") {
            if let item = statusItem {
                popover?.performClose(nil)
                NSStatusBar.system.removeStatusItem(item)
                statusItem = nil
                popover = nil
            }
            return
        }
        guard statusItem == nil else { return }
        let statusItemPositionKey =
            "NSStatusItem Preferred Position AIUsageDashboardUsage"
        if UserDefaults.standard.object(forKey: statusItemPositionKey) == nil {
            // Tahoe may otherwise place a new variable-width item underneath
            // the camera housing on a crowded MacBook menu bar. This is only
            // a first-launch position; Command-dragging the item is preserved.
            UserDefaults.standard.set(540, forKey: statusItemPositionKey)
        }
        let statusItem = NSStatusBar.system.statusItem(
            withLength: NSStatusItem.variableLength
        )
        statusItem.autosaveName = "AIUsageDashboardUsage"
        statusItem.isVisible = true
        let popover = NSPopover()
        popover.behavior = .transient
        popover.animates = false
        popover.contentSize = NSSize(width: 640, height: 560)
        popover.contentViewController = NSHostingController(
            rootView: MenuBarPanel(store: store)
        )

        if let button = statusItem.button {
            button.target = self
            button.action = #selector(togglePopover(_:))
            button.sendAction(on: [.leftMouseUp])
            button.font = .monospacedDigitSystemFont(
                ofSize: 11,
                weight: .medium
            )
        }

        self.statusItem = statusItem
        self.popover = popover
        updateStatusItem()
    }

    // The panel has exactly one window. SwiftUI still requires a scene, and
    // macOS can open that scene's Settings window on its own (Command-comma,
    // or restoring it at launch), which used to put a second copy of the
    // panel on screen. Any such window is closed and the dashboard shown.
    fileprivate func replaceSettingsWindowWithDashboard() {
        for window in NSApp.windows where window.identifier?.rawValue == "com_apple_SwiftUI_Settings_window" {
            window.close()
        }
        if !ProcessInfo.processInfo.arguments.contains("--demo") { showDashboard() }
    }

    private func showDashboard() {
        if dashboardWindow == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: MenuBarPanel(store: store)))
            window.title = "AI Usage Dashboard"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.isReleasedWhenClosed = false
            window.center()
            dashboardWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        dashboardWindow?.makeKeyAndOrderFront(nil)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.last, url.scheme == "aiusage-dashboard" else { return }
        if url.host == "settings" { showDashboard(); return }
        let id = url.lastPathComponent
        guard url.host == "pool", id.range(of: #"^[a-z0-9-]{1,64}$"#, options: .regularExpression) != nil else { return }
        let pane = NSHostingController(rootView: WidgetPoolDetail(store: store, poolID: id))
        let window = poolWindow ?? NSWindow(contentRect: NSRect(x: 0, y: 0, width: 430, height: 465),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.contentViewController = pane
        window.title = "Quota pool details"
        window.isReleasedWhenClosed = false
        if poolWindow == nil { window.center() }
        poolWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showDashboard()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let defaultsObserver { NotificationCenter.default.removeObserver(defaultsObserver) }
        collectorHealthTimer?.invalidate()
        collectorHealthTimer = nil
        collectorSupervisor?.stop()
    }

    private func configureBundledCollector(reportingTo store: UsageStore) {
        guard let resourceURL = Bundle.main.resourceURL else { return }
        let collectorURL = resourceURL
            .appendingPathComponent("collector", isDirectory: true)
            .appendingPathComponent("server.mjs")
        guard FileManager.default.fileExists(atPath: collectorURL.path) else {
            // `swift run` intentionally keeps the collector external.
            return
        }

        let supervisor = CollectorSupervisor(
            healthCheck: bundledCollectorIsHealthy,
            launch: { id, onExit in
                try launchBundledCollector(
                    resourceURL: resourceURL,
                    id: id,
                    onExit: onExit
                )
            },
            onFailure: { message in
                let displayMessage = message.contains(collectorLogDisplayPath)
                    ? message
                    : "\(message); see \(collectorLogDisplayPath)"
                store.collectorFailure = displayMessage
                NSLog("Bundled collector unavailable: %@", message)
            },
            onRecovery: {
                store.collectorFailure = nil
                Task { @MainActor in
                    await store.refresh()
                }
            }
        )
        collectorSupervisor = supervisor
        Task { @MainActor in
            await supervisor.start()
        }
        // This is a loopback-only liveness probe. Provider polling remains
        // governed by the collector's independent refresh/backoff policy.
        collectorHealthTimer = Timer.scheduledTimer(
            withTimeInterval: collectorHealthCheckInterval,
            repeats: true
        ) { [weak supervisor] _ in
            Task { @MainActor in
                await supervisor?.checkHealth()
            }
        }
    }

    @objc
    private func togglePopover(_ sender: Any?) {
        guard
            let button = statusItem?.button,
            let popover
        else {
            return
        }

        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(
                relativeTo: button.bounds,
                of: button,
                preferredEdge: .minY
            )
        }
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .semibold)
        let values = store.menuBarProviders.map { provider -> (UsageProvider, String) in
            let value = provider.state == "ready"
                ? provider.primaryWindow?.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—"
                : "—"
            return (provider, value + (provider.state == "ready" && provider.isStale ? "*" : ""))
        }
        let width = values.reduce(CGFloat(8)) { total, item in
            total + 18 + 4 + (item.1 as NSString).size(withAttributes: [.font: font]).width + 10
        }
        let image = NSImage(size: NSSize(width: max(width, 36), height: 24))
        button.effectiveAppearance.performAsCurrentDrawingAppearance {
            image.lockFocus()
            var x: CGFloat = 4
            if values.isEmpty {
                ("AI" as NSString).draw(at: NSPoint(x: x, y: 4), withAttributes: [.font: font, .foregroundColor: NSColor.labelColor])
            }
            for (provider, value) in values {
                let mark = NSRect(x: x, y: 3, width: 18, height: 18)
                (BrandAssets.image(for: provider.id) ?? NSImage(systemSymbolName: "chart.bar.fill", accessibilityDescription: provider.name))?.draw(in: mark)
                // The marks are single-colour; tint them like the text so they
                // stay visible on a dark menu bar.
                NSColor.labelColor.set()
                mark.fill(using: .sourceAtop)
                x += 22
                let color: NSColor = provider.state != "ready" ? .systemRed : provider.isStale ? .systemOrange : .labelColor
                (value as NSString).draw(at: NSPoint(x: x, y: 4), withAttributes: [.font: font, .foregroundColor: color])
                x += (value as NSString).size(withAttributes: [.font: font]).width + 10
            }
            image.unlockFocus()
        }
        image.isTemplate = false
        button.attributedTitle = NSAttributedString(string: "")
        button.image = image
        button.imagePosition = .imageOnly
        button.toolTip = store.providers.map { "\($0.name): \(formatPercent($0.primaryWindow?.remainingPercent)) left\($0.isStale ? " (stale)" : "")" }.joined(separator: "\n")
        button.setAccessibilityLabel(store.providers.isEmpty ? "AI Usage Dashboard" : button.toolTip)
        statusItem?.length = NSStatusItem.variableLength
    }
}

@main
private struct UsageMenuBarApp: App {
    @NSApplicationDelegateAdaptor(UsageMenuBarDelegate.self)
    private var appDelegate

    var body: some Scene {
        Settings {
            // Never shown: see replaceSettingsWindowWithDashboard().
            Color.clear
                .frame(width: 1, height: 1)
                .onAppear {
                    DispatchQueue.main.async { appDelegate.replaceSettingsWindowWithDashboard() }
                }
        }
    }
}
