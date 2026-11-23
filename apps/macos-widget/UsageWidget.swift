import SwiftUI
import WidgetKit

private struct Pool: Decodable, Identifiable {
    let id: String
    let name: String
    let remaining: Int
    let reset: String?
    let dayOnly: Bool
    var stale: Bool
    // When the reading turns stale by age or its date-only quota ends.
    var staleAt: String?
    var resetDate: Date? {
        guard let reset else { return nil }
        if dayOnly {
            let parser = DateFormatter()
            parser.locale = Locale(identifier: "en_US_POSIX")
            parser.dateFormat = "yyyy-MM-dd"
            return parser.date(from: reset)
        }
        return parseTimestamp(reset)
    }
    var staleDate: Date? { staleAt.flatMap(parseTimestamp) }
    var destination: URL { URL(string: "aiusage-dashboard://pool/")!.appendingPathComponent(id) }
}
// The collector sends times with fractional seconds; accept both forms.
private func parseTimestamp(_ value: String) -> Date? {
    (try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        ?? (try? Date(value, strategy: .iso8601))
}
private struct Snapshot: Decodable {
    let enabled: Bool
    let pools: [Pool]
}
private struct Entry: TimelineEntry {
    var date = Date()
    var enabled = true
    var pools: [Pool] = []
    var offline = false
}
private struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        let start = Date()
        let examples = [("codex", "Codex", 42, 1), ("claude", "Claude weekly", 68, 2), ("grok", "Grok", 86, 4)]
        return Entry(pools: examples.map { id, name, remaining, days in
            Pool(id: id, name: name, remaining: remaining,
                 reset: start.addingTimeInterval(Double(days) * 86_400).formatted(.iso8601),
                 dayOnly: false, stale: false)
        })
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)) }
        else { fetch(completion) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        fetch { entry in
            guard entry.enabled else {
                completion(Timeline(entries: [entry], policy: .never))
                return
            }
            guard !entry.offline else {
                // One missed answer should not blank the widget for 15 minutes.
                completion(Timeline(entries: [entry], policy: .after(entry.date.addingTimeInterval(2 * 60))))
                return
            }
            var entries = [entry]
            let next = entry.date.addingTimeInterval(15 * 60)
            // WidgetKit may delay the next fetch for hours, so schedule the
            // changes already known: timed pools disappear at reset, and
            // readings become stale at their scheduled staleness time.
            let changes = Set(entry.pools.flatMap { pool in
                [pool.dayOnly ? nil : pool.resetDate, pool.stale ? nil : pool.staleDate].compactMap { $0 }
            })
            for date in changes.sorted() where date > entry.date {
                var updated = entry
                updated.date = date
                updated.pools = entry.pools.compactMap { pool in
                    if !pool.dayOnly, let reset = pool.resetDate, reset <= date { return nil }
                    var pool = pool
                    if let staleDate = pool.staleDate, staleDate <= date { pool.stale = true }
                    return pool
                }
                entries.append(updated)
            }
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    private func fetch(_ completion: @escaping (Entry) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4317/api/widget")!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 4
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else {
                completion(Entry(offline: true)); return
            }
            completion(Entry(enabled: snapshot.enabled, pools: snapshot.pools))
        }.resume()
    }
}
private struct WidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: Entry
    private let settings = URL(string: "aiusage-dashboard://settings")!
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if entry.enabled, let first = entry.pools.first {
                if family == .systemSmall {
                    Text(first.name).font(.headline).lineLimit(2)
                    Spacer(minLength: 2)
                    Text("\(first.remaining)%").font(.system(size: 34, weight: .semibold)).monospacedDigit().minimumScaleFactor(0.7)
                    Text(first.stale ? "Remaining · last reading" : "Remaining").font(.caption)
                    reset(first)
                } else {
                    Text("Quota remaining").font(.headline)
                    ForEach(entry.pools.prefix(family == .systemMedium ? 3 : 6)) { pool in
                        Link(destination: pool.destination) {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(pool.name).font(.subheadline).lineLimit(1)
                                    reset(pool)
                                }
                                Spacer()
                                if pool.stale { Image(systemName: "clock").accessibilityLabel("Last reading") }
                                Text("\(pool.remaining)%").monospacedDigit()
                            }
                        }
                    }
                }
            } else {
                Text("AI Usage").font(.headline)
                Text(!entry.enabled ? "Widget updates are off" : entry.offline ? "Open the dashboard to reconnect" : "No quota window available")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(.background, for: .widget)
        .widgetURL(entry.enabled ? (entry.pools.first?.destination ?? settings) : settings)
    }
    @ViewBuilder private func reset(_ pool: Pool) -> some View {
        if let date = pool.resetDate {
            Text("Resets \(date.formatted(date: .abbreviated, time: pool.dayOnly ? .omitted : .shortened))")
                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        } else {
            Text("Reset time unavailable").font(.caption2).foregroundStyle(.secondary)
        }
    }
}
@main
struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AIUsageQuotaPools", provider: Provider()) { WidgetView(entry: $0) }
            .configurationDisplayName("AI Usage Dashboard")
            .description("Remaining allowance and reset times for your connected quota pools.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
