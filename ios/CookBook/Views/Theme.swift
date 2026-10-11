import SwiftUI
import UIKit

/// Recipe-box look: index-card red rules, ink-blue controls, typed amounts and
/// a highlighter on the quantities in the directions.
enum Theme {
    static let accent = dynamic(light: (0.13, 0.32, 0.60), dark: (0.56, 0.70, 0.94))
    static let red = dynamic(light: (0.80, 0.23, 0.23), dark: (0.89, 0.44, 0.44))
    static let rule = dynamic(light: (0.78, 0.85, 0.92), dark: (0.17, 0.23, 0.30))
    static let highlighter = dynamic(light: (0.98, 0.90, 0.54), dark: (0.33, 0.29, 0.10))

    static func title(_ style: Font.TextStyle) -> Font {
        .system(style, design: .serif, weight: .bold)
    }

    private static func dynamic(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
}

extension ParserBridge {
    /// A line of recipe text with its Markdown and amounts styled for display.
    func styled(_ text: String, style: AmountStyle, factor: Double = 1, ingredients: [RecipeGroup] = []) -> AttributedString {
        var out = AttributedString()
        for piece in pieces(text, style: style, factor: factor, ingredients: ingredients) {
            var part = AttributedString(piece.text)
            var intent: InlinePresentationIntent = []
            if piece.bold == true { intent.insert(.stronglyEmphasized) }
            if piece.italic == true { intent.insert(.emphasized) }
            if piece.qty != nil {
                switch style {
                case .step:
                    intent.insert(.stronglyEmphasized)
                    part.backgroundColor = Theme.highlighter
                case .ingredient:
                    part.font = Font.body.monospaced().weight(.bold)
                case .plain:
                    break
                }
            }
            if !intent.isEmpty { part.inlinePresentationIntent = intent }
            out.append(part)
        }
        return out
    }
}

/// Recipe lines numbered across all of a recipe's groups.
struct IndexedLine: Identifiable {
    let id: Int
    let text: String
}

struct IndexedGroup: Identifiable {
    let id: Int
    let title: String
    let lines: [IndexedLine]

    static func from(_ groups: [RecipeGroup]) -> [IndexedGroup] {
        var result: [IndexedGroup] = []
        var n = 0
        for (gi, group) in groups.enumerated() {
            var lines: [IndexedLine] = []
            for text in group.items {
                lines.append(IndexedLine(id: n, text: text))
                n += 1
            }
            result.append(IndexedGroup(id: gi, title: group.title, lines: lines))
        }
        return result
    }
}

struct SectionTitle: View {
    let title: String
    var detail: String = ""

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(Theme.title(.title3))
                Spacer()
                if !detail.isEmpty {
                    Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            Rectangle().fill(Theme.rule).frame(height: 1)
        }
    }
}

struct GroupTitle: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.caption.weight(.bold))
            .kerning(0.8)
            .foregroundStyle(Theme.red)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The prompt that makes Claude's recipes import cleanly when pasted.
enum AskClaude {
    static let prompt = """
    Give me a recipe for [DISH]. Format it for my cookbook:
    - Start with the recipe name as a # heading, then one sentence about it.
    - Then a line like: Serves: 4 | Prep: 15 min | Cook: 30 min
    - "## Ingredients" as a bulleted list with amounts. Label parts with bold lines like **For the sauce:**
    - "## Directions" as a numbered list. Write the exact amount of every ingredient into the step where it is used, like "Add 2 tbsp olive oil".
    - "## Notes" for tips, swaps and storage.
    """
}
