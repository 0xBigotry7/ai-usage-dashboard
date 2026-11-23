import Foundation

func menuPageRange(count: Int, page: Int, size: Int = 6) -> Range<Int> {
    guard count > 0, size > 0 else { return 0..<0 }
    let lastPage = (count - 1) / size
    let start = min(max(0, page), lastPage) * size
    return start..<min(count, start + size)
}

func menuTokenCaption(basis: String, period: String?) -> String {
    if basis == "quota_percentage" { return "Cycle estimate ≈" }
    return period == "today" ? "Today · " : "Cycle · "
}
