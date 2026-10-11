import Foundation
import JavaScriptCore

struct ParseResult: Decodable {
    var recipe: RecipeContent
    var problems: [String]
    var stepsWithAmounts: Int

    static let empty = ParseResult(recipe: RecipeContent(), problems: [], stepsWithAmounts: 0)
}

/// One styled run of text: bold or italic Markdown, or an amount.
struct TextPiece: Decodable, Hashable {
    struct Amount: Decodable, Hashable {
        var original: String
        var changed: Bool
    }

    var text: String
    var bold: Bool?
    var italic: Bool?
    var qty: Amount?
}

enum AmountStyle: String {
    /// Every number is an amount ("3 eggs", "juice of 1 lemon").
    case ingredient
    /// Only measured amounts and counts of ingredients; temperatures, times and pan sizes are left alone.
    case step
    /// Inline Markdown only.
    case plain
}

/// Runs the shared JavaScript recipe parser (cookbook/parser.js and
/// cookbook/bridge.js) in JavaScriptCore, so the app reads recipes exactly the
/// way the tested parser does.
@MainActor
final class ParserBridge {
    static let shared = ParserBridge()

    private let context: JSContext
    private let bridge: JSValue
    private let errors: ErrorLog
    private var pieceCache: [String: [TextPiece]] = [:]

    /// The last JavaScript error, if any. Shown by the tests when something breaks.
    var lastError: String? { errors.last }

    private final class ErrorLog {
        var last: String?
    }

    private init() {
        guard let context = JSContext() else { fatalError("JavaScriptCore is unavailable") }
        let errors = ErrorLog()
        context.exceptionHandler = { _, exception in
            let message = exception?.toString() ?? "unknown error"
            errors.last = message
            print("CookBook parser error:", message)
        }
        let bundle = Bundle(for: ParserBridge.self)
        for name in ["parser", "bridge"] {
            guard let url = bundle.url(forResource: name, withExtension: "js"),
                  let source = try? String(contentsOf: url, encoding: .utf8) else {
                fatalError("\(name).js is missing from the app bundle")
            }
            context.evaluateScript(source, withSourceURL: url)
        }
        self.context = context
        self.errors = errors
        self.bridge = context.objectForKeyedSubscript("CookBookBridge")
        if !bridge.isObject {
            errors.last = (errors.last.map { $0 + " / " } ?? "") + "CookBookBridge is not defined after loading the scripts"
        }
    }

    // MARK: Calls

    func parse(_ text: String) -> ParseResult {
        decode(ParseResult.self, call("parse", [text]))
            ?? ParseResult(recipe: RecipeContent(), problems: ["CookBook couldn't read this text."], stepsWithAmounts: 0)
    }

    func pieces(_ text: String, style: AmountStyle, factor: Double = 1, ingredients: [RecipeGroup] = []) -> [TextPiece] {
        let groups = style == .step ? Self.json(ingredients) : "[]"
        let key = "\(style.rawValue)|\(factor)|\(groups.hashValue)|\(text)"
        if let cached = pieceCache[key] { return cached }
        let result = decode([TextPiece].self, call("pieces", [text, style.rawValue, factor, groups])) ?? [TextPiece(text: text)]
        if pieceCache.count > 4000 { pieceCache.removeAll() }
        pieceCache[key] = result
        return result
    }

    func markdown(for content: RecipeContent) -> String {
        call("markdown", [Self.json(content)])
    }

    /// "Serves 6", "Makes 24 cookies"; empty when the recipe gives no yield.
    func servingsLabel(_ servings: String, factor: Double) -> String {
        call("servingsLabel", [servings, factor])
    }

    func servingsNumber(_ servings: String) -> Double? {
        let value = bridge.invokeMethod("servingsNumber", withArguments: [servings])?.toDouble() ?? -1
        return value > 0 ? value : nil
    }

    /// 0.5 -> "½", 1.5 -> "1½"
    func formatFactor(_ factor: Double) -> String {
        call("formatFactor", [factor])
    }

    // MARK: Plumbing

    private func call(_ method: String, _ arguments: [Any]) -> String {
        bridge.invokeMethod(method, withArguments: arguments)?.toString() ?? ""
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T? {
        try? JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private static func json<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}
