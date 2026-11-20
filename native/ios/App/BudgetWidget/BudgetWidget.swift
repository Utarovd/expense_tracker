import WidgetKit
import SwiftUI

// Данные пишет приложение (BudgetNative.setWidget) в общий App Group; виджет только показывает готовые строки.
struct WidgetData: Codable {
    var v: Int?
    var signedIn: Bool?
    var hidden: Bool?
    var balance: String?
    var today: String?
    var month: String?
    var zero: String?
    var limit: String?
    var pct: Int?
    var day: String?
    var monthKey: String?
    var updated: Double?

    static let placeholder = WidgetData(v: 1, signedIn: true, hidden: false, balance: "17 345 UZS", today: "58 000 UZS",
                                        month: "1 240 000 UZS", zero: "0 UZS", limit: "3 000 000 UZS", pct: 41,
                                        day: nil, monthKey: nil, updated: nil)

    static func load() -> WidgetData? {
        var groups = (Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String]) ?? []
        groups.append("group.uz.inmanager.budget")
        for g in groups {
            if let s = UserDefaults(suiteName: g)?.string(forKey: "widget"), let d = s.data(using: .utf8),
               let w = try? JSONDecoder().decode(WidgetData.self, from: d) { return w }
        }
        return nil
    }

    /// Новый день / месяц, а приложение ещё не открывали: траты обнуляются.
    func fixed(now: Date) -> WidgetData {
        var w = self
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Tashkent") ?? .current
        let c = cal.dateComponents([.year, .month, .day], from: now)
        let today = String(format: "%02d.%02d", c.day ?? 0, c.month ?? 0)
        let mk = String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
        if let d = w.day, d != today { w.today = w.zero }
        if let m = w.monthKey, m != mk { w.month = w.zero; w.pct = w.pct.map { _ in 0 } }
        return w
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let data: WidgetData?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), data: .placeholder) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), data: context.isPreview ? .placeholder : WidgetData.load()?.fixed(now: Date())))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let now = Date()
        let data = WidgetData.load()
        // перерисовать после полуночи (Ташкент), чтобы «Today» обнулился
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Tashkent") ?? .current
        let midnight = cal.nextDate(after: now, matching: DateComponents(hour: 0, minute: 0, second: 5), matchingPolicy: .nextTime) ?? now.addingTimeInterval(3600)
        let entries = [Entry(date: now, data: data?.fixed(now: now)), Entry(date: midnight, data: data?.fixed(now: midnight))]
        completion(Timeline(entries: entries, policy: .after(midnight)))
    }
}

enum Palette {
    static let navyTop = Color(red: 0x0A / 255, green: 0x15 / 255, blue: 0x30 / 255)
    static let navyMid = Color(red: 0x13 / 255, green: 0x26 / 255, blue: 0x52 / 255)
    static let navyBottom = Color(red: 0x1F / 255, green: 0x3B / 255, blue: 0x72 / 255)
    static let yellow = Color(red: 0xF5 / 255, green: 0xC5 / 255, blue: 0x18 / 255)
    static let red = Color(red: 0xFF / 255, green: 0x6B / 255, blue: 0x70 / 255)
    static let gradient = LinearGradient(colors: [navyTop, navyMid, navyBottom], startPoint: .topLeading, endPoint: .bottomTrailing)
}

struct Label2: View {
    let title: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.yellow).kerning(0.6)
            Text(value).font(.system(size: 15, weight: .semibold, design: .rounded)).foregroundStyle(.white)
                .minimumScaleFactor(0.6).lineLimit(1)
        }
    }
}

struct BudgetWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        Group {
            if let d = entry.data, d.signedIn != false {
                switch family {
                case .systemMedium: medium(d)
                default: small(d)
                }
            } else {
                VStack(spacing: 6) {
                    Text("Budget").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                    Text("Open the app to sign in").font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                }
            }
        }
        .widgetBackground(Palette.gradient)
    }

    func small(_ d: WidgetData) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label2(title: "Balance", value: d.balance ?? "—")
            Spacer(minLength: 0)
            Label2(title: "Today", value: d.today ?? "—")
            Label2(title: "This month", value: d.month ?? "—")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "budget://home"))
    }

    func medium(_ d: WidgetData) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("BALANCE").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.yellow).kerning(0.6)
                    Text(d.balance ?? "—").font(.system(size: 24, weight: .bold, design: .rounded)).foregroundStyle(.white)
                        .minimumScaleFactor(0.5).lineLimit(1)
                }
                Spacer(minLength: 0)
                HStack(spacing: 16) {
                    Label2(title: "Today", value: d.today ?? "—")
                    Label2(title: "Month", value: d.month ?? "—")
                }
                if let p = d.pct, p >= 0 {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(.white.opacity(0.18))
                            Capsule().fill(p > 100 ? Palette.red : Palette.yellow).frame(width: g.size.width * CGFloat(min(100, p)) / 100)
                        }
                    }
                    .frame(height: 5)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            Link(destination: URL(string: "budget://add")!) {
                ZStack {
                    Circle().fill(Palette.yellow)
                    Image(systemName: "plus").font(.system(size: 24, weight: .bold)).foregroundStyle(Palette.navyMid)
                }
                .frame(width: 52, height: 52)
            }
        }
        .widgetURL(URL(string: "budget://home"))
    }
}

extension View {
    @ViewBuilder func widgetBackground(_ bg: LinearGradient) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(for: .widget) { bg }
        } else {
            self.padding().background(bg)
        }
    }
}

@main
struct BudgetWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BudgetWidget", provider: Provider()) { entry in
            BudgetWidgetView(entry: entry)
        }
        .configurationDisplayName("Budget")
        .description("Balance and spending today and this month.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
