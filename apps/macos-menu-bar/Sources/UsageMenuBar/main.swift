import AppKit
import Foundation
import SwiftUI

private struct UsagePayload: Decodable {
    let generatedAt: String
    let providers: [UsageProvider]
}

private struct UsageProvider: Decodable, Identifiable {
    let id: String
    let name: String
    let shortName: String
    let accent: String
    let state: String
    let plan: String?
    let windows: [UsageWindow]
    let balance: UsageBalance?
}

private struct UsageWindow: Decodable, Identifiable {
    let id: String
    let label: String
    let usedPercent: Double?
    let resetsAt: String?
}

private struct UsageBalance: Decodable {
    let label: String
    let value: Double
    let unit: String
}

@MainActor
private final class UsageStore: ObservableObject {
    @Published var providers: [UsageProvider] = []
    @Published var lastUpdated: Date?
    @Published var errorMessage: String?
    @Published var isRefreshing = false

    private let endpoint = URL(string: "http://127.0.0.1:4317/api/usage")!
    private var refreshTimer: Timer?

    var highestUsage: Double? {
        providers
            .flatMap(\.windows)
            .compactMap(\.usedPercent)
            .max()
    }

    var menuTitle: String {
        guard let highestUsage else { return "AI —" }
        return "AI \(Int(highestUsage.rounded()))%"
    }

    var symbolName: String {
        guard errorMessage == nil else { return "exclamationmark.triangle.fill" }
        guard let highestUsage else { return "chart.bar.fill" }
        if highestUsage >= 85 { return "exclamationmark.circle.fill" }
        return "chart.bar.fill"
    }

    init() {
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
            lastUpdated = ISO8601DateFormatter().date(from: payload.generatedAt) ?? Date()
            errorMessage = nil
        } catch {
            errorMessage = "无法连接本机采集器"
        }
    }

    func openDashboard() {
        guard let url = URL(string: "http://localhost:3000") else { return }
        NSWorkspace.shared.open(url)
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
                .frame(maxHeight: 430)
            }

            Divider()
            footer
        }
        .frame(width: 360)
        .background(.ultraThinMaterial)
    }

    private var header: some View {
        HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.green.opacity(0.12))
                Image(systemName: "chart.bar.fill")
                    .foregroundStyle(.green)
            }
            .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text("AI Usage Dashboard")
                    .font(.system(size: 13, weight: .semibold))
                Text(statusText)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
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
        return "更新于 \(lastUpdated.formatted(date: .omitted, time: .shortened))"
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
        HStack {
            Button("打开 Dashboard") {
                store.openDashboard()
            }
            .buttonStyle(.borderless)

            Spacer()

            Button("退出") {
                NSApplication.shared.terminate(nil)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
        }
        .font(.system(size: 11))
        .padding(12)
    }
}

private struct ProviderRow: View {
    let provider: UsageProvider

    private var primaryWindow: UsageWindow? {
        provider.windows.first(where: { $0.id == "weekly" })
            ?? provider.windows.first(where: { $0.usedPercent != nil })
            ?? provider.windows.first
    }

    private var accent: Color {
        Color(hex: provider.accent) ?? .green
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Text(provider.shortName)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(accent)
                    .frame(width: 30, height: 30)
                    .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text(provider.name)
                        .font(.system(size: 12, weight: .semibold))
                    Text(provider.plan ?? stateLabel)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text(primaryValue)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }

            if let window = primaryWindow, let percent = window.usedPercent {
                ProgressView(value: max(0, min(100, percent)), total: 100)
                    .tint(percent >= 85 ? .red : percent >= 70 ? .orange : accent)
                    .scaleEffect(x: 1, y: 0.7, anchor: .center)

                HStack {
                    Text(window.label)
                    Spacer()
                    Text(resetText(window.resetsAt))
                }
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            } else if let balance = provider.balance {
                HStack {
                    Text(balance.label)
                    Spacer()
                    Text(formatBalance(balance))
                }
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            }
        }
        .padding(11)
        .background(
            Color.primary.opacity(0.035),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        }
    }

    private var primaryValue: String {
        if let percent = primaryWindow?.usedPercent {
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

    private func resetText(_ value: String?) -> String {
        guard let value,
              let date = ISO8601DateFormatter().date(from: value) else {
            return "未提供重置时间"
        }
        return "重置 \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    private func formatBalance(_ balance: UsageBalance) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 2
        let value = formatter.string(from: NSNumber(value: balance.value)) ?? "\(balance.value)"
        switch balance.unit.uppercased() {
        case "USD": return "$\(value)"
        case "CNY": return "¥\(value)"
        case "CREDITS": return value
        default: return "\(value) \(balance.unit.uppercased())"
        }
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
        MenuBarExtra(store.menuTitle, systemImage: store.symbolName) {
            MenuBarPanel(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}
