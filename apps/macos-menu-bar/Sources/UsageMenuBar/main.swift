import AppKit
import Combine
import Foundation
import ServiceManagement
import SwiftUI
import UserNotifications

private let staleInterval: TimeInterval = 5 * 60
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
    let updatedAt: String?
    let windows: [UsageWindow]
    let balance: UsageBalance?
    let tokenUsage: TokenEstimate?
    let tokenEstimates: [TokenEstimate]?

    var primaryWindow: UsageWindow? {
        windows.first(where: { $0.id == "weekly" && $0.usedPercent != nil })
            ?? windows.first(where: { $0.id == "monthly" && $0.usedPercent != nil })
            ?? windows.first(where: { $0.usedPercent != nil })
    }

    var updatedDate: Date? {
        parseISO8601(updatedAt)
    }

    var isStale: Bool {
        guard let updatedDate else { return true }
        return Date().timeIntervalSince(updatedDate) > staleInterval
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
}

private struct UsageBalance: Decodable {
    let label: String
    let value: Double
    let unit: String
}

private struct TokenEstimate: Decodable {
    let basis: String
    let estimated: Bool?
    let totalTokens: Double?
    let periodSeconds: Double?
    let models: [ModelTokenUsage]?
}

private struct ModelTokenUsage: Decodable {
    let id: String
    let label: String
    let estimatedTokens: Double?
    let requestCount: Double?
}

private struct ModelTokenDisplay: Identifiable {
    let id: String
    let label: String
    let tokens: Double
    let basis: String
    let estimated: Bool
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
            return "按当前速度 \(futureText(exhaustionDate)) 用尽"
        }
        return "预计周期末 \(Int(projectedPercent.rounded()))%"
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

    private let endpoint = URL(string: "http://127.0.0.1:4317/api/usage")!
    private var refreshTimer: Timer?
    private let defaults = UserDefaults.standard
    private var deliveredNotificationCycles: Set<String> = []
    private var pendingNotificationKeys: Set<String> = []

    var hasDegradedData: Bool {
        errorMessage != nil || providers.contains(where: \.isDegraded)
    }

    var menuTitle: String {
        let summaries = providers
            .prefix(3)
            .map { provider in
                let value: String
                if let percent = provider.primaryWindow?.usedPercent {
                    value = "\(Int(percent.rounded()))%"
                } else {
                    value = provider.state == "ready" ? "—" : "!"
                }
                return "\(provider.shortName.uppercased()) \(value)"
            }

        let title = summaries.isEmpty ? "AI —" : summaries.joined(separator: " · ")
        return hasDegradedData ? "\(title) !" : title
    }

    var symbolName: String {
        hasDegradedData ? "exclamationmark.triangle.fill" : "chart.bar.fill"
    }

    init() {
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
            await refresh()
        }
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refresh()
            }
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            var request = URLRequest(url: endpoint)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 8
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let payload = try JSONDecoder().decode(UsagePayload.self, from: data)
            providers = payload.providers
            lastUpdated = parseISO8601(payload.generatedAt) ?? Date()
            errorMessage = payload.skippedProviderCount > 0
                ? "已忽略 \(payload.skippedProviderCount) 个格式不兼容的平台"
                : nil
            evaluateQuotaNotifications()
        } catch {
            NSLog("Usage menu refresh failed: %@", String(describing: error))
            if error is DecodingError {
                errorMessage = "采集器数据格式不兼容，正在显示上次数据"
            } else {
                errorMessage = "本机采集器已断开，正在显示上次数据"
            }
        }
    }

    func openDashboard() {
        guard let url = URL(string: "http://localhost:3000") else { return }
        NSWorkspace.shared.open(url)
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
                launchAtLoginMessage = "请在“系统设置 › 通用 › 登录项”中允许"
            } else {
                launchAtLoginMessage = nil
            }
        } catch {
            refreshLaunchAtLoginStatus()
            launchAtLoginMessage = "无法修改登录项，请从“应用程序”目录运行"
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
            notificationMessage = granted ? nil : "请在系统设置中允许通知"
            if granted {
                evaluateQuotaNotifications()
            }
        } catch {
            notificationsEnabled = false
            defaults.set(false, forKey: PreferenceKey.notificationsEnabled)
            notificationMessage = "无法启用额度提醒"
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
            notificationMessage = "系统通知权限已关闭"
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
            for window in provider.windows {
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

                let cycle = window.resetsAt ?? "until-below-threshold"
                let key = "\(prefix)\(cycle)"
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
        content.title = "\(provider.name) 已用 \(Int(percent.rounded()))%"
        var details = "\(window.label)额度达到 \(notificationThreshold)% 提醒线"
        if let pace = paceForWindow(window), pace.level > 0 {
            details += "，\(pace.summary)"
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
                self.notificationMessage = "额度提醒发送失败，将在下次刷新重试"
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

    var body: some View {
        VStack(spacing: 0) {
            header

            if store.providers.isEmpty {
                emptyState
                    .frame(height: 220)
            } else {
                ProviderSummaryStrip(providers: Array(store.providers.prefix(3)))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)

                Divider()

                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(store.providers) { provider in
                            ProviderRow(provider: provider)
                        }
                    }
                    .padding(12)
                }
                .frame(height: 430)
                .scrollIndicators(.visible)
            }

            Divider()
            footer
        }
        .frame(width: 410)
        .background(.ultraThinMaterial)
    }

    private var header: some View {
        HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.green.opacity(0.12))
                Image(systemName: store.hasDegradedData ? "exclamationmark.triangle.fill" : "chart.bar.fill")
                    .foregroundStyle(store.hasDegradedData ? .orange : .green)
            }
            .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text("AI Usage Dashboard")
                    .font(.system(size: 13, weight: .semibold))
                Text(statusText)
                    .font(.system(size: 10))
                    .foregroundStyle(
                        store.errorMessage == nil ? Color.secondary : Color.orange
                    )
            }

            Spacer()

            Button {
                Task { await store.refresh() }
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
            .help("刷新")
        }
        .padding(14)
    }

    private var statusText: String {
        if let errorMessage = store.errorMessage { return errorMessage }
        guard let lastUpdated = store.lastUpdated else { return "正在读取本机采集器…" }
        return "采集器 \(freshnessText(lastUpdated))"
    }

    private var emptyState: some View {
        VStack(spacing: 9) {
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                .font(.system(size: 24))
                .foregroundStyle(.secondary)
            Text("还没有可显示的平台")
                .font(.system(size: 12, weight: .medium))
            Text(store.errorMessage ?? "请先运行 npm run local")
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
                    "额度提醒",
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

                Picker(
                    "提醒线",
                    selection: Binding(
                        get: { store.notificationThreshold },
                        set: { store.setNotificationThreshold($0) }
                    )
                ) {
                    ForEach(notificationThresholdOptions, id: \.self) { threshold in
                        Text("\(threshold)%").tag(threshold)
                    }
                }
                .pickerStyle(.menu)
                .controlSize(.mini)
                .disabled(!store.notificationsEnabled)
                .frame(width: 112)
            }

            HStack {
                Toggle(
                    "登录时启动",
                    isOn: Binding(
                        get: { store.launchAtLoginEnabled },
                        set: { store.setLaunchAtLogin($0) }
                    )
                )
                .toggleStyle(.switch)
                .controlSize(.mini)

                Spacer()

                Button("打开 Dashboard") {
                    store.openDashboard()
                }
                .buttonStyle(.borderless)

                Button("退出") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
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

private struct ProviderSummaryStrip: View {
    let providers: [UsageProvider]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(providers) { provider in
                HStack(spacing: 7) {
                    ProviderLogo(provider: provider, size: 26)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(provider.shortName.uppercased())
                                .font(.system(size: 9, weight: .semibold))
                            Circle()
                                .fill(providerHealthColor(provider))
                                .frame(width: 5, height: 5)
                        }
                        Text(formatPercent(provider.primaryWindow?.usedPercent))
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(
                    Color.primary.opacity(0.04),
                    in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                )
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(provider.name)，\(formatPercent(provider.primaryWindow?.usedPercent))"
                )
            }
        }
    }
}

private struct ProviderRow: View {
    let provider: UsageProvider

    private var accent: Color {
        Color(hex: provider.accent) ?? .green
    }

    private var modelTokens: [ModelTokenDisplay] {
        let entries = provider.effectiveTokenEstimates.enumerated().flatMap { usageIndex, usage in
            (usage.models ?? []).compactMap { model -> ModelTokenDisplay? in
                guard let tokens = model.estimatedTokens else { return nil }
                return ModelTokenDisplay(
                    id: "\(usageIndex)-\(usage.basis)-\(model.id)",
                    label: model.label,
                    tokens: tokens,
                    basis: usage.basis,
                    estimated: usage.estimated ?? (usage.basis != "api_usage")
                )
            }
        }
        return Array(entries.sorted { $0.tokens > $1.tokens }.prefix(3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            providerHeader

            if !provider.windows.isEmpty {
                VStack(spacing: 9) {
                    ForEach(provider.windows) { window in
                        WindowRow(window: window, accent: accent)
                    }
                }
            } else if let balance = provider.balance {
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

            if !modelTokens.isEmpty {
                Divider()
                    .opacity(0.55)
                VStack(alignment: .leading, spacing: 7) {
                    Text("模型 TOKEN")
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
                Text(provider.updatedDate.map(freshnessText) ?? "更新时间未知")
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
        if let percent = provider.primaryWindow?.usedPercent {
            return "\(Int(percent.rounded()))%"
        }
        if let balance = provider.balance {
            return formatBalance(balance)
        }
        return provider.state == "ready" ? "—" : "!"
    }

    private var stateLabel: String {
        switch provider.state {
        case "ready": return "数据正常"
        case "needs_configuration": return "等待配置"
        case "auth_error": return "需要登录"
        default: return "连接异常"
        }
    }
}

private struct WindowRow: View {
    let window: UsageWindow
    let accent: Color

    var body: some View {
        VStack(spacing: 5) {
            HStack {
                Text(window.label)
                    .font(.system(size: 10, weight: .medium))
                Spacer()
                Text(formatPercent(window.usedPercent))
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }

            if let percent = window.usedPercent {
                ProgressView(value: max(0, min(100, percent)), total: 100)
                    .tint(percent >= 85 ? .red : percent >= 70 ? .orange : accent)
                    .scaleEffect(x: 1, y: 0.68, anchor: .center)
            }

            HStack {
                Text(quotaDetail)
                Spacer()
                Text(resetText(window.resetsAt))
            }
            .font(.system(size: 8))
            .foregroundStyle(.secondary)

            if let pace = paceForWindow(window) {
                HStack(spacing: 4) {
                    Image(systemName: pace.level > 0 ? "flame.fill" : "gauge.with.dots.needle.33percent")
                    Text(pace.summary)
                }
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(paceColor(pace.level))
            }
        }
    }

    private var quotaDetail: String {
        guard let used = window.used, let limit = window.limit else {
            return "配额窗口"
        }
        return "\(formatCompactNumber(used)) / \(formatCompactNumber(limit))"
    }
}

private struct ModelTokenRow: View {
    let model: ModelTokenDisplay

    var body: some View {
        HStack(spacing: 7) {
            Text(basisLabel(model.basis))
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

            Text("\(model.estimated ? "≈" : "")\(formatTokens(model.tokens))")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .monospacedDigit()
        }
    }
}

private struct ProviderLogo: View {
    let provider: UsageProvider
    var size: CGFloat = 32

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.primary.opacity(0.055))

            if let image = BrandAssets.image(for: provider.id) {
                Image(nsImage: image)
                    .resizable()
                    .renderingMode(.original)
                    .scaledToFit()
                    .padding(6)
            } else {
                Text(provider.shortName)
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Color(hex: provider.accent) ?? .green)
            }
        }
        .frame(width: size, height: size)
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        }
        .help(provider.name)
    }
}

private enum BrandAssets {
    private static let names = [
        "codex": "codex",
        "claude": "claude",
        "openai-api": "openai",
        "kimi": "kimi",
        "deepseek": "deepseek",
        "openrouter": "openrouter",
        "github-copilot": "githubcopilot",
    ]

    static func image(for providerID: String) -> NSImage? {
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

private func freshnessText(_ date: Date) -> String {
    let seconds = max(0, Date().timeIntervalSince(date))
    if seconds < 60 { return "刚刚更新" }
    if seconds < 3_600 { return "\(Int(seconds / 60)) 分钟前更新" }
    if seconds < 86_400 { return "\(Int(seconds / 3_600)) 小时前更新" }
    return chineseDateTime(date)
}

private func formatPercent(_ value: Double?) -> String {
    guard let value else { return "—" }
    return "\(Int(value.rounded()))%"
}

private func resetText(_ value: String?) -> String {
    guard let date = parseISO8601(value) else {
        return "未提供重置时间"
    }
    if date < Date() {
        return "等待刷新重置"
    }
    return "重置 \(chineseDateTime(date))"
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
        return "\(max(1, Int(seconds / 60))) 分钟后"
    }
    if seconds < 86_400 {
        let hours = seconds / 3_600
        return "\(formatCompactNumber(hours)) 小时后"
    }
    return chineseDateTime(date)
}

private func chineseDateTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
}

private func providerHealthColor(_ provider: UsageProvider) -> Color {
    if provider.state != "ready" { return .red }
    if provider.isStale { return .orange }
    return .green
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

private func formatCompactNumber(
    _ value: Double,
    maximumFractionDigits: Int = 1
) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.maximumFractionDigits = maximumFractionDigits
    return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
}

private func basisLabel(_ basis: String) -> String {
    switch basis {
    case "api_usage": return "API"
    case "session_logs": return "日志"
    case "quota_percentage": return "配额"
    default: return "其他"
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

@MainActor
private final class UsageMenuBarDelegate: NSObject, NSApplicationDelegate {
    private var store: UsageStore?
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var statusUpdateCancellable: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = UsageStore()
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
        popover.contentSize = NSSize(width: 410, height: 680)
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

        self.store = store
        self.statusItem = statusItem
        self.popover = popover
        updateStatusItem()
        statusUpdateCancellable = store.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async {
                self?.updateStatusItem()
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
        guard let store, let button = statusItem?.button else { return }
        button.image = nil
        button.imagePosition = .noImage
        button.title = store.menuTitle
        button.toolTip = "AI 用量：\(store.menuTitle)"
        button.setAccessibilityLabel("AI 用量：\(store.menuTitle)")
        statusItem?.length = NSStatusItem.variableLength
    }
}

@main
private struct UsageMenuBarApp: App {
    @NSApplicationDelegateAdaptor(UsageMenuBarDelegate.self)
    private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
