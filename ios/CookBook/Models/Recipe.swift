import Foundation

/// A titled list, like "For the sauce" and its ingredients. `title` is empty
/// for a list without parts.
struct RecipeGroup: Codable, Hashable {
    var title: String = ""
    var items: [String]
}

/// The parts of a recipe that come from its text. The JavaScript parser and the
/// CookBook server both produce this shape.
struct RecipeContent: Codable, Hashable {
    var title = ""
    var description = ""
    var servings = ""
    var prepTime = ""
    var cookTime = ""
    var totalTime = ""
    var ingredients: [RecipeGroup] = []
    var steps: [RecipeGroup] = []
    var notes: [RecipeGroup] = []

    var ingredientCount: Int { ingredients.reduce(0) { $0 + $1.items.count } }
    var stepCount: Int { steps.reduce(0) { $0 + $1.items.count } }
}

struct Recipe: Codable, Identifiable, Hashable {
    var id = UUID()
    var content: RecipeContent
    var tags: [String] = []
    var favorite = false
    var myNotes = ""
    /// The text the recipe was imported from; shown when editing.
    var source = ""
    var fromClaude = false
    /// Sent by Claude and not opened yet.
    var isNew = false
    var createdAt = Date()
    var updatedAt = Date()

    var title: String { content.title.isEmpty ? "Untitled recipe" : content.title }

    var searchText: String {
        var parts = [content.title, content.description, tags.joined(separator: " ")]
        for group in content.ingredients { parts.append(group.title); parts.append(contentsOf: group.items) }
        return parts.joined(separator: " ").lowercased()
    }
}

/// Ticked ingredients and finished steps while cooking. Kept in memory only.
struct CookingProgress: Hashable {
    var ingredients: Set<Int> = []
    var steps: Set<Int> = []
    var isEmpty: Bool { ingredients.isEmpty && steps.isEmpty }
}

// Decoders that tolerate missing keys, so older saved files and server
// payloads keep loading as fields are added.

extension RecipeGroup {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        items = try c.decodeIfPresent([String].self, forKey: .items) ?? []
    }
}

extension RecipeContent {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        servings = try c.decodeIfPresent(String.self, forKey: .servings) ?? ""
        prepTime = try c.decodeIfPresent(String.self, forKey: .prepTime) ?? ""
        cookTime = try c.decodeIfPresent(String.self, forKey: .cookTime) ?? ""
        totalTime = try c.decodeIfPresent(String.self, forKey: .totalTime) ?? ""
        ingredients = try c.decodeIfPresent([RecipeGroup].self, forKey: .ingredients) ?? []
        steps = try c.decodeIfPresent([RecipeGroup].self, forKey: .steps) ?? []
        notes = try c.decodeIfPresent([RecipeGroup].self, forKey: .notes) ?? []
    }
}

extension Recipe {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        content = try c.decode(RecipeContent.self, forKey: .content)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        favorite = try c.decodeIfPresent(Bool.self, forKey: .favorite) ?? false
        myNotes = try c.decodeIfPresent(String.self, forKey: .myNotes) ?? ""
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? ""
        fromClaude = try c.decodeIfPresent(Bool.self, forKey: .fromClaude) ?? false
        isNew = try c.decodeIfPresent(Bool.self, forKey: .isNew) ?? false
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
    }
}

// MARK: - Recipes waiting on the server

struct InboxResponse: Decodable {
    var recipes: [InboxItem]
    var sending: Bool?
}

struct InboxItem: Decodable {
    var id: String
    var receivedAt: Double
    var recipe: IncomingRecipe
}

/// A recipe Claude sent: the usual content fields plus tags, side by side.
struct IncomingRecipe: Decodable {
    var content: RecipeContent
    var tags: [String]

    private enum Keys: String, CodingKey { case tags }

    init(from decoder: Decoder) throws {
        content = try RecipeContent(from: decoder)
        tags = try decoder.container(keyedBy: Keys.self).decodeIfPresent([String].self, forKey: .tags) ?? []
    }
}

// MARK: - Scaling

enum Scaling {
    static let factors: [Double] = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6]

    /// The next factor when the cook taps + or −. Small whole-number servings
    /// move one serving at a time; anything else moves through `factors`.
    static func next(from factor: Double, base: Double?, direction: Int) -> Double {
        if let base, base > 0, base <= 12, base == base.rounded() {
            let target = max(1, (base * factor).rounded() + Double(direction))
            return target / base
        }
        let i = factors.firstIndex { $0 >= factor - 1e-9 } ?? factors.count - 1
        let j = min(factors.count - 1, max(0, i + direction))
        return factors[j]
    }
}
