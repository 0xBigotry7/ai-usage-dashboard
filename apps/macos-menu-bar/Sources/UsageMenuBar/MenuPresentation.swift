import Foundation

func menuPageRange(count: Int, page: Int, size: Int = 6) -> Range<Int> {
    guard count > 0, size > 0 else { return 0..<0 }
    let lastPage = (count - 1) / size
    let start = min(max(0, page), lastPage) * size
    return start..<min(count, start + size)
}

func menuQuotaCaption(id: String, duration: Double?) -> String {
    if id.contains("weekly") || duration == 604_800 { return "used · weekly" }
    if id.contains("five_hour") || duration == 18_000 { return "used · 5 hours" }
    return "used · cycle"
}

func menuTokenCaption(basis: String, period: String?) -> String {
    if basis == "quota_percentage" { return "Cycle estimate ≈" }
    return period == "today" ? "Today · " : "Cycle · "
}
