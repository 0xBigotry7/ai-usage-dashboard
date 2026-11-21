import Foundation

// Entirely synthetic. Demo mode must never open the collector or local sessions.
func menuBarDemoData() -> Data {
    let now = Date()
    let iso = ISO8601DateFormatter()
    let examples: [(String, String, String, String, Double)] = [
        ("codex", "OpenAI Codex", "CX", "#7864ff", 34),
        ("claude", "Claude Code", "CL", "#d97757", 57),
        ("kimi", "Kimi Code", "KM", "#1796ff", 18),
        ("openai-api", "OpenAI API", "OA", "#10a37f", 26),
        ("github-copilot", "GitHub Copilot", "GH", "#a78bfa", 42),
        ("deepseek", "DeepSeek", "DS", "#4d6bfe", 9),
    ]
    let providers: [[String: Any]] = examples.map { id, name, shortName, accent, percent in
        var provider: [String: Any] = [
            "id": id, "name": name, "shortName": shortName, "accent": accent,
            "state": "ready", "plan": "Demo data", "updatedAt": iso.string(from: now),
            "windows": [[
                "id": "weekly", "label": "Weekly demo allowance",
                "durationSeconds": 604800, "usedPercent": percent,
                "resetsAt": iso.string(from: now.addingTimeInterval(3 * 86400)),
            ]],
            "message": "Synthetic example, not an account or an advertised provider limit.",
        ]
        if id == "claude" || id == "openai-api" {
            provider["windows"] = []
            provider["tokenUsage"] = [
                "basis": id == "claude" ? "session_logs" : "api_usage",
                "periodId": "today", "estimated": false,
                "totalTokens": id == "claude" ? 8_200_000 : 12_600_000,
                "inputTokens": id == "claude" ? 8_000_000 : 12_000_000,
                "outputTokens": id == "claude" ? 200_000 : 600_000,
                "models": [[
                    "id": "demo-model", "label": "Demo coding model",
                    "estimatedTokens": id == "claude" ? 8_200_000 : 12_600_000,
                ]],
            ]
        }
        if id == "deepseek" {
            provider["windows"] = []
            provider["balance"] = ["label": "Available balance", "value": 8.4, "unit": "USD"]
        }
        if id == "github-copilot" {
            provider["windows"] = [[
                "id": "monthly", "label": "Monthly AI Credits (demo)",
                "usedPercent": percent,
                "resetsAt": iso.string(from: now.addingTimeInterval(9 * 86400)),
            ]]
        }
        return provider
    }
    return (try? JSONSerialization.data(withJSONObject: [
        "generatedAt": iso.string(from: now), "providers": providers,
    ])) ?? Data()
}
