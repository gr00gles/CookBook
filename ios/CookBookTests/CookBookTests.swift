import XCTest
@testable import CookBook

@MainActor
final class CookBookTests: XCTestCase {
    private let sample = """
    Here's a weeknight favorite:

    # Garlic Butter Shrimp

    Serves: 4 | Cook: 15 min

    ## Ingredients
    - 1 lb shrimp
    - 4 tbsp butter

    ## Directions
    1. **Sear:** Melt 2 tbsp butter and add 1 lb shrimp.
    2. Add the remaining 2 tbsp butter. Bake at 400°F for 10 minutes.
    """

    func testParserLoadsWithoutErrors() {
        _ = ParserBridge.shared.parse("# Toast")
        XCTAssertNil(ParserBridge.shared.lastError)
    }

    func testParsesARecipeInJavaScriptCore() {
        let result = ParserBridge.shared.parse(sample)
        XCTAssertNil(ParserBridge.shared.lastError)
        XCTAssertEqual(result.recipe.title, "Garlic Butter Shrimp")
        XCTAssertEqual(result.recipe.servings, "4")
        XCTAssertEqual(result.recipe.cookTime, "15 min")
        XCTAssertEqual(result.recipe.ingredientCount, 2)
        XCTAssertEqual(result.recipe.stepCount, 2)
        XCTAssertEqual(result.stepsWithAmounts, 2)
        XCTAssertEqual(result.problems, [])
    }

    func testScalesAmountsInTheDirections() throws {
        let recipe = ParserBridge.shared.parse(sample).recipe
        let steps = try XCTUnwrap(recipe.steps.first?.items, "No steps parsed. JavaScript error: \(ParserBridge.shared.lastError ?? "none")")
        XCTAssertEqual(steps.count, 2)
        guard steps.count == 2 else { return }
        let pieces = ParserBridge.shared.pieces(steps[0], style: .step, factor: 2, ingredients: recipe.ingredients)
        XCTAssertEqual(pieces.first?.text, "Sear:")
        XCTAssertEqual(pieces.first?.bold, true)
        XCTAssertEqual(pieces.filter { $0.qty != nil }.map(\.text), ["4 tbsp", "2 lb"])

        let styled = ParserBridge.shared.styled(steps[1], style: .step, factor: 2, ingredients: recipe.ingredients)
        let text = String(styled.characters)
        XCTAssertTrue(text.contains("4 tbsp butter"))
        XCTAssertTrue(text.contains("400°F for 10 minutes"))
    }

    func testServingsAndScaling() {
        let bridge = ParserBridge.shared
        XCTAssertEqual(bridge.servingsLabel("4", factor: 1.5), "Serves 6")
        XCTAssertEqual(bridge.servingsLabel("", factor: 2), "")
        XCTAssertEqual(bridge.servingsNumber("12 cookies"), 12)
        XCTAssertNil(bridge.servingsNumber("a crowd"))
        XCTAssertEqual(bridge.formatFactor(0.5), "½")
        XCTAssertEqual(Scaling.next(from: 1, base: 4, direction: 1), 1.25)
        XCTAssertEqual(Scaling.next(from: 0.25, base: 4, direction: -1), 0.25)
        XCTAssertEqual(Scaling.next(from: 1, base: nil, direction: -1), 0.75)
        XCTAssertEqual(Scaling.next(from: 1, base: 24, direction: 1), 1.5)
    }

    func testMarkdownRoundTrip() {
        let recipe = ParserBridge.shared.parse(sample).recipe
        let again = ParserBridge.shared.parse(ParserBridge.shared.markdown(for: recipe)).recipe
        XCTAssertEqual(again, recipe)
    }

    func testDecodesRecipesFromTheServer() throws {
        let json = """
        {"recipes":[{"id":"mv47pp3w-NiHGGNhX","receivedAt":1791746683484,"recipe":{"title":"Test Pancakes","description":"","servings":"4","prepTime":"","cookTime":"","totalTime":"","ingredients":[{"title":"","items":["1 cup flour","1 egg"]}],"steps":[{"title":"","items":["Whisk 1 cup flour with 1 egg."]}],"notes":[],"tags":["breakfast"]}}],"sending":true,"lastDeliveryAt":1791746683484}
        """
        let inbox = try JSONDecoder().decode(InboxResponse.self, from: Data(json.utf8))
        XCTAssertEqual(inbox.sending, true)
        XCTAssertEqual(inbox.recipes.count, 1)
        XCTAssertEqual(inbox.recipes[0].recipe.content.title, "Test Pancakes")
        XCTAssertEqual(inbox.recipes[0].recipe.content.ingredients[0].items, ["1 cup flour", "1 egg"])
        XCTAssertEqual(inbox.recipes[0].recipe.tags, ["breakfast"])
    }

    func testStoreKeepsRecipesBetweenLaunches() {
        let url = FileManager.default.temporaryDirectory.appending(path: "cookbook-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }

        let store = RecipeStore(fileURL: url)
        var content = RecipeContent()
        content.title = "Toast"
        content.steps = [RecipeGroup(items: ["Toast 2 slices bread."])]
        store.add(Recipe(content: content, tags: ["breakfast"]))
        store.modify(store.recipes[0].id) { $0.favorite = true }

        let reopened = RecipeStore(fileURL: url)
        XCTAssertNil(reopened.problem)
        XCTAssertEqual(reopened.recipes.count, 1)
        XCTAssertEqual(reopened.recipes[0].content.title, "Toast")
        XCTAssertEqual(reopened.recipes[0].tags, ["breakfast"])
        XCTAssertTrue(reopened.recipes[0].favorite)
    }

    func testTagsFromText() {
        XCTAssertEqual(RecipeEditorView.tags(from: "Dinner, #quick, dinner, , Weeknight Meals"), ["dinner", "quick", "weeknight meals"])
    }
}
