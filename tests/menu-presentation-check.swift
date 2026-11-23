import Foundation

@main
struct MenuPresentationCheck {
    static func main() {
        assert(menuPageRange(count: 0, page: 0) == 0..<0)
        assert(menuPageRange(count: 1, page: 0) == 0..<1)
        assert(menuPageRange(count: 6, page: 0) == 0..<6)
        assert(menuPageRange(count: 7, page: 1) == 6..<7)
        assert(menuPageRange(count: 7, page: 99) == 6..<7)
        assert(menuPageRange(count: 13, page: -1) == 0..<6)
        assert(menuPageRange(count: 13, page: 2) == 12..<13)
        assert(menuPageRange(count: 6, page: 0, size: 0) == 0..<0)
        let pages = (0..<3).flatMap { Array(menuPageRange(count: 13, page: $0)) }
        assert(pages == Array(0..<13), "No configured provider may disappear or repeat")
        assert(menuTokenCaption(basis: "quota_percentage", period: "today") == "Cycle estimate ≈")
        assert(menuTokenCaption(basis: "session_logs", period: "today") == "Today · ")
        assert(menuTokenCaption(basis: "api_usage", period: "weekly_cycle") == "Cycle · ")
        let json = try! JSONSerialization.jsonObject(with: menuBarDemoData()) as! [String: Any]
        let providers = json["providers"] as! [[String: Any]]
        assert(providers.count == 6)
        assert(Set(providers.compactMap { $0["id"] as? String }).count == 6)
        assert(providers.allSatisfy { $0["plan"] as? String == "Demo data" })
        print("Menu presentation checks passed (pagination, token basis, synthetic fixture).")
    }
}
