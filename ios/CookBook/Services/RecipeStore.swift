import Foundation
import Observation

/// All recipes, saved as one JSON file in the app's Documents folder.
@MainActor
@Observable
final class RecipeStore {
    private(set) var recipes: [Recipe] = []
    private(set) var problem: String?
    private(set) var cooking: [UUID: CookingProgress] = [:]

    private let fileURL: URL

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? URL.documentsDirectory.appending(path: "recipes.json")
        load()
    }

    // MARK: Reading

    func recipe(id: UUID) -> Recipe? {
        recipes.first { $0.id == id }
    }

    /// Tags in use, most used first.
    var tags: [String] {
        var counts: [String: Int] = [:]
        for recipe in recipes { for tag in recipe.tags { counts[tag, default: 0] += 1 } }
        return counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
    }

    // MARK: Changing

    func add(_ recipe: Recipe) {
        recipes.append(recipe)
        save()
    }

    func add(contentsOf newRecipes: [Recipe]) {
        guard !newRecipes.isEmpty else { return }
        recipes.append(contentsOf: newRecipes)
        save()
    }

    func update(_ recipe: Recipe) {
        modify(recipe.id) { $0 = recipe }
    }

    func modify(_ id: UUID, _ change: (inout Recipe) -> Void) {
        guard let i = recipes.firstIndex(where: { $0.id == id }) else { return }
        change(&recipes[i])
        recipes[i].updatedAt = Date()
        save()
    }

    func delete(_ id: UUID) {
        recipes.removeAll { $0.id == id }
        cooking[id] = nil
        save()
    }

    // MARK: Cooking progress

    func toggleIngredient(_ id: UUID, _ index: Int) {
        var p = cooking[id] ?? CookingProgress()
        if p.ingredients.contains(index) { p.ingredients.remove(index) } else { p.ingredients.insert(index) }
        cooking[id] = p
    }

    func toggleStep(_ id: UUID, _ index: Int) {
        var p = cooking[id] ?? CookingProgress()
        if p.steps.contains(index) { p.steps.remove(index) } else { p.steps.insert(index) }
        cooking[id] = p
    }

    func clearCooking(_ id: UUID) {
        cooking[id] = nil
    }

    // MARK: File

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            recipes = try decoder.decode([Recipe].self, from: Data(contentsOf: fileURL))
        } catch {
            // Keep a copy rather than overwriting it on the next save.
            let stamp = Int(Date().timeIntervalSince1970)
            let backup = fileURL.deletingLastPathComponent().appending(path: "recipes-unreadable-\(stamp).json")
            try? FileManager.default.copyItem(at: fileURL, to: backup)
            problem = "Your saved recipes couldn't be read. A copy was kept as \(backup.lastPathComponent)."
        }
    }

    private func save() {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(recipes).write(to: fileURL, options: .atomic)
        } catch {
            problem = "Couldn't save your recipes: \(error.localizedDescription)"
        }
    }
}
