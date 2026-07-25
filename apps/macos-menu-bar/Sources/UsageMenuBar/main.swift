import AppKit
import Foundation
import ServiceManagement
import SwiftUI

private let staleInterval: TimeInterval = 5 * 60

private struct UsagePayload: Decodable {
    let generatedAt: String?
    let providers: [UsageProvider]
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

    private let endpoint = URL(string: "http://127.0.0.1:4317/api/usage")!
    private var refreshTimer: Timer?

    var hasStaleData: Bool {
        errorMessage != nil || providers.contains(where: \.isStale)
    }

    var menuTitle: String {
        let summaries = providers
            .compactMap { provider -> (UsageProvider, Double)? in
                guard let percent = provider.primaryWindow?.usedPercent else { return nil }
                return (provider, percent)
            }
            .prefix(3)
            .map { provider, percent in
                "\(provider.shortName.uppercased()) \(Int(percent.rounded()))%"
            }

        let title = summaries.isEmpty ? "AI —" : summaries.joined(separator: " · ")
        return hasStaleData ? "\(title) !" : title
    }

    var symbolName: String {
        if hasStaleData { return "exclamationmark.triangle.fill" }
        let highestUsage = providers
            .flatMap(\.windows)
            .compactMap(\.usedPercent)
            .max()
        if let highestUsage, highestUsage >= 85 {
            return "exclamationmark.circle.fill"
        }
        return "chart.bar.fill"
    }

    init() {
        refreshLaunchAtLoginStatus()
        Task { await refresh() }
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
            errorMessage = nil
        } catch {
            errorMessage = "本机采集器已断开，正在显示上次数据"
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

    private func refreshLaunchAtLoginStatus() {
        let status = SMAppService.mainApp.status
        launchAtLoginEnabled = status == .enabled || status == .requiresApproval
    }
}

private struct MenuBarPanel: View {
    @ObservedObject var store: UsageStore

    var body: some View {
        VStack(spacing: 0) {
            header

            if store.providers.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(store.providers) { provider in
                            ProviderRow(provider: provider)
                        }
                    }
                    .padding(12)
                }
                .frame(maxHeight: 560)
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
                Image(systemName: store.hasStaleData ? "exclamationmark.triangle.fill" : "chart.bar.fill")
                    .foregroundStyle(store.hasStaleData ? .orange : .green)
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
            Text("请先运行 npm run local")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
    }

    private var footer: some View {
        VStack(spacing: 8) {
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
        }
        .font(.system(size: 11))
        .padding(12)
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
                Text(provider.plan ?? stateLabel)
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
                    .foregroundStyle(provider.isStale ? .orange : .secondary)
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
        .frame(width: 32, height: 32)
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
    return date.formatted(date: .abbreviated, time: .shortened)
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
    return "重置 \(date.formatted(date: .abbreviated, time: .shortened))"
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

@main
private struct UsageMenuBarApp: App {
    @StateObject private var store = UsageStore()

    var body: some Scene {
        MenuBarExtra {
            MenuBarPanel(store: store)
        } label: {
            Label(store.menuTitle, systemImage: store.symbolName)
        }
        .menuBarExtraStyle(.window)
    }
}
