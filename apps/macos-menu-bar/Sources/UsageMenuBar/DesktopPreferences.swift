import AppKit
import SwiftUI
import WidgetKit

struct SourceField: Decodable, Identifiable {
    let key: String
    let label: String
    let kind: String
    var id: String { key }
}
struct SourceSetup: Decodable, Identifiable {
    let id, name, method, help: String
    let fields: [SourceField]
}
// Both types read as leniently as collector/desktop-preferences.mjs does: a
// file the collector accepts must not lock the app out of saving settings.
struct ConnectionChoice: Codable {
    var mode = "auto"
    var values: [String: String] = [:]

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decodeIfPresent(String.self, forKey: .mode) ?? "auto"
        values = try container.decodeIfPresent([String: String].self, forKey: .values) ?? [:]
    }
}
struct DesktopChoices: Codable {
    var version = 1
    var widgetEnabled = true
    var shortcuts: [String: Bool] = [:]
    var sources: [String: ConnectionChoice] = [:]

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        widgetEnabled = try container.decodeIfPresent(Bool.self, forKey: .widgetEnabled) ?? true
        shortcuts = try container.decodeIfPresent([String: Bool].self, forKey: .shortcuts) ?? [:]
        sources = try container.decodeIfPresent([String: ConnectionChoice].self, forKey: .sources) ?? [:]
    }
}
@MainActor
final class DesktopPreferences: ObservableObject {
    static let shared = DesktopPreferences()
    @Published private(set) var choices = DesktopChoices()
    @Published var issue: String?
    let catalog: [SourceSetup]
    private let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".usage-hub/desktop-connections.json")
    private var unreadable = false

    init() {
        let paths = [Bundle.main.resourceURL?.appendingPathComponent("collector/desktop-sources.json"),
                     URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("collector/desktop-sources.json")]
        catalog = paths.compactMap { $0 }.lazy.compactMap { url in
            try? JSONDecoder().decode([SourceSetup].self, from: Data(contentsOf: url))
        }.first ?? []
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                choices = try JSONDecoder().decode(DesktopChoices.self, from: Data(contentsOf: file))
                if choices.version != 1 { throw CocoaError(.fileReadUnknown) }
            } catch {
                unreadable = true
                issue = "The existing connection settings could not be read. They have been preserved."
            }
        }
    }

    @discardableResult func save(_ change: (inout DesktopChoices) -> Void) -> Bool {
        guard !unreadable else { return false }
        var updated = choices
        change(&updated)
        let manager = FileManager.default
        let parent = file.deletingLastPathComponent()
        let temporary = parent.appendingPathComponent(".desktop-" + UUID().uuidString)
        defer { try? manager.removeItem(at: temporary) }
        do {
            try manager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            guard manager.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteUnknown)
            }
            let handle = try FileHandle(forWritingTo: temporary)
            defer { try? handle.close() }
            try handle.write(contentsOf: JSONEncoder().encode(updated))
            try handle.synchronize()
            guard rename(temporary.path, file.path) == 0 else { throw POSIXError(.EIO) }
            choices = updated
            issue = nil
            WidgetCenter.shared.reloadTimelines(ofKind: "AIUsageQuotaPools")
            return true
        } catch {
            issue = "Could not save the private connection settings."
            return false
        }
    }
}

struct ConnectionSettingsView: View {
    @ObservedObject var preferences: DesktopPreferences
    let connected: Set<String>
    let refresh: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selected: String?
    @State private var draft = ConnectionChoice()
    @State private var status: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Data connections").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            HStack(alignment: .top, spacing: 16) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(preferences.catalog) { source in
                            Button {
                                selected = source.id
                                draft = preferences.choices.sources[source.id] ?? ConnectionChoice()
                                status = nil
                            } label: {
                                HStack {
                                    Text(source.name)
                                    Spacer()
                                    if preferences.choices.sources[source.id]?.mode == "off" {
                                        Text("Off").foregroundStyle(.secondary)
                                    } else if connected.contains(source.id) { Image(systemName: "checkmark") }
                                }.padding(5).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                                .background(selected == source.id ? Color.accentColor.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 5))
                        }
                    }
                }.frame(width: 150)
                Divider()
                if let source = preferences.catalog.first(where: { $0.id == selected }) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(source.name).font(.headline)
                            Text(source.method).font(.subheadline)
                            Text(source.help).font(.caption).foregroundStyle(.secondary)
                            Picker("Collect", selection: $draft.mode) {
                                Text("Automatic").tag("auto"); Text("On").tag("on"); Text("Off").tag("off")
                            }.pickerStyle(.segmented)
                            if draft.mode == "on" {
                                ForEach(source.fields) { field in fieldView(field) }
                            } else {
                                Text(draft.mode == "auto" ? "Follow the collector’s existing configuration and detection rules." : "Skip collection for this source.").font(.caption)
                            }
                            Text("API keys are stored only in the owner-readable local settings file. Leave an override empty to use the collector’s existing configuration.").font(.caption2).foregroundStyle(.secondary)
                            Button("Apply connection") {
                                if preferences.save({ $0.sources[source.id] = draft }) {
                                    status = "Connection saved."
                                    refresh()
                                }
                            }
                            if let status { Text(status).font(.caption) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else { Text("Select a source").foregroundStyle(.secondary) }
            }
            Divider()
            Text("App shortcuts").font(.headline)
            HStack {
                shortcut("gemini", "Gemini", "com.google.GeminiMacOS")
                shortcut("muse", "Muse", "com.meta.endo")
            }
            if let issue = preferences.issue { Text(issue).foregroundStyle(.orange) }
        }.padding(18).frame(width: 580, height: 445)
        .onAppear {
            if let first = preferences.catalog.first {
                selected = first.id
                draft = preferences.choices.sources[first.id] ?? ConnectionChoice()
            }
        }
    }

    @ViewBuilder private func fieldView(_ field: SourceField) -> some View {
        let value = Binding(get: { draft.values[field.key] ?? "" }, set: { draft.values[field.key] = $0 })
        switch field.kind {
        case "secret": SecureField(field.label, text: value).textFieldStyle(.roundedBorder)
        case "toggle":
            Toggle(field.label, isOn: Binding(get: { value.wrappedValue == "1" }, set: { value.wrappedValue = $0 ? "1" : "0" }))
        default:
            Text(field.label).font(.caption)
            HStack {
                TextField(field.label, text: value).textFieldStyle(.roundedBorder)
                if field.kind != "text" {
                    Button("Choose…") {
                        if field.kind == "snapshot" {
                            let dialog = NSSavePanel()
                            dialog.nameFieldStringValue = "muse-usage.json"
                            if dialog.runModal() == .OK, let path = dialog.url?.path { value.wrappedValue = path }
                        } else {
                            let dialog = NSOpenPanel()
                            dialog.canChooseDirectories = field.kind == "directory"
                            dialog.canChooseFiles = field.kind != "directory"
                            if dialog.runModal() == .OK, let path = dialog.url?.path { value.wrappedValue = path }
                        }
                    }
                }
            }
        }
    }

    private func shortcut(_ key: String, _ title: String, _ bundle: String) -> some View {
        let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) != nil
        return Toggle(installed ? title : title + " (not installed)", isOn: Binding(
            get: { preferences.choices.shortcuts[key] == true },
            set: { enabled in if preferences.save({ $0.shortcuts[key] = enabled }) { refresh() } }
        )).disabled(!installed && preferences.choices.shortcuts[key] != true)
    }
}
