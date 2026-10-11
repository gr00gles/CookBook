import SwiftUI

@main
struct CookBookApp: App {
    @State private var store = RecipeStore()
    @State private var link = ClaudeLink()

    var body: some Scene {
        WindowGroup {
            RecipeListView()
                .environment(store)
                .environment(link)
                .tint(Theme.accent)
        }
    }
}
