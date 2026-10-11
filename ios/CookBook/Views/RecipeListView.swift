import SwiftUI

enum EditorRequest: Identifiable {
    case new
    case edit(UUID)

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let id): return id.uuidString
        }
    }
}

struct RecipeListView: View {
    @Environment(RecipeStore.self) private var store
    @Environment(ClaudeLink.self) private var link
    @Environment(\.scenePhase) private var scenePhase

    @State private var path = NavigationPath()
    @State private var search = ""
    @State private var filter = ""
    @State private var editor: EditorRequest?
    @State private var showSettings = false

    private static let favorites = "favorites"

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if store.recipes.isEmpty {
                    EmptyCookBookView(onAdd: { editor = .new }, onSettings: { showSettings = true })
                } else {
                    list
                }
            }
            .navigationTitle("CookBook")
            .navigationDestination(for: UUID.self) { id in
                RecipeDetailView(recipeID: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !store.recipes.isEmpty { filterMenu }
                    Button { editor = .new } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add recipe")
                }
            }
            .sheet(item: $editor) { request in
                RecipeEditorView(request: request) { id in path.append(id) }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
        // While the app is open, collect recipes Claude sends every 30 seconds.
        .task(id: "\(link.hasInbox)-\(scenePhase == .active)") {
            guard link.hasInbox, scenePhase == .active else { return }
            while !Task.isCancelled {
                await link.checkInbox(into: store)
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    // MARK: List

    private var visible: [Recipe] {
        let terms = search.lowercased().split(separator: " ").map(String.init)
        return store.recipes
            .filter { recipe in
                if filter == Self.favorites && !recipe.favorite { return false }
                if !filter.isEmpty && filter != Self.favorites && !recipe.tags.contains(filter) { return false }
                let text = recipe.searchText
                return terms.allSatisfy { text.contains($0) }
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private var list: some View {
        let recipes = visible
        let showArrivals = search.isEmpty && filter.isEmpty
        let arrivals = showArrivals ? recipes.filter(\.isNew) : []
        let rest = showArrivals ? recipes.filter { !$0.isNew } : recipes

        return List {
            if let problem = store.problem {
                Section { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            }
            if !arrivals.isEmpty {
                Section {
                    ForEach(arrivals) { row($0) }
                } header: {
                    Label("New from Claude", systemImage: "sparkles")
                }
            }
            if !rest.isEmpty {
                Section(arrivals.isEmpty ? "" : "All recipes") {
                    ForEach(rest) { row($0) }
                }
            }
            if recipes.isEmpty {
                ContentUnavailableView.search(text: search)
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $search, prompt: "Recipes, ingredients, tags")
        .refreshable { await link.checkInbox(into: store) }
    }

    private func row(_ recipe: Recipe) -> some View {
        NavigationLink(value: recipe.id) {
            RecipeRow(recipe: recipe)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { store.delete(recipe.id) } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading) {
            Button { store.modify(recipe.id) { $0.favorite.toggle() } } label: {
                Label(recipe.favorite ? "Unfavorite" : "Favorite", systemImage: recipe.favorite ? "star.slash" : "star")
            }
            .tint(.yellow)
        }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $filter) {
                Text("All Recipes").tag("")
                Label("Favorites", systemImage: "star").tag(Self.favorites)
                ForEach(store.tags, id: \.self) { tag in
                    Text("#" + tag).tag(tag)
                }
            }
        } label: {
            Image(systemName: filter.isEmpty ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filter recipes")
    }
}

struct RecipeRow: View {
    let recipe: Recipe

    private var meta: String {
        let bridge = ParserBridge.shared
        var parts: [String] = []
        let servings = bridge.servingsLabel(recipe.content.servings, factor: 1)
        if !servings.isEmpty { parts.append(servings) }
        let time = [recipe.content.totalTime, recipe.content.cookTime, recipe.content.prepTime].first { !$0.isEmpty }
        if let time { parts.append(time) }
        let count = recipe.content.ingredientCount
        if count > 0 { parts.append("\(count) ingredient\(count == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(recipe.title)
                    .font(Theme.title(.headline))
                    .lineLimit(2)
                Spacer(minLength: 4)
                if recipe.favorite {
                    Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow)
                        .accessibilityLabel("Favorite")
                }
                if recipe.isNew {
                    Text("NEW")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.accent, in: Capsule())
                        .foregroundStyle(.white)
                }
            }
            if !recipe.content.description.isEmpty {
                Text(ParserBridge.shared.styled(recipe.content.description, style: .plain))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if !meta.isEmpty {
                Text(meta).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            if !recipe.tags.isEmpty {
                Text(recipe.tags.map { "#" + $0 }.joined(separator: "  "))
                    .font(.caption)
                    .foregroundStyle(Theme.accent)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}

struct EmptyCookBookView: View {
    @Environment(ClaudeLink.self) private var link
    let onAdd: () -> Void
    let onSettings: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Your recipe box is empty")
                        .font(Theme.title(.title))
                    Text("Recipes you get from Claude live here, with every amount kept in the directions.")
                        .foregroundStyle(.secondary)
                    Rectangle().fill(Theme.red).frame(height: 2)
                }

                way(
                    icon: "sparkles",
                    title: link.isEnabled ? "Claude can send you recipes" : "Let Claude send recipes",
                    text: link.isEnabled
                        ? "In any chat with Claude, say “Save this to my CookBook.” It shows up here within a minute."
                        : "Turn it on in Settings, add your private link to Claude as a connector, then say “Save this to my CookBook” in any chat."
                )
                way(
                    icon: "doc.on.clipboard",
                    title: "Or paste one yourself",
                    text: "Copy Claude’s reply, tap +, and paste it. CookBook picks out the ingredients, amounts and steps."
                )

                HStack(spacing: 12) {
                    if !link.isEnabled {
                        Button("Open Settings", action: onSettings).buttonStyle(.borderedProminent)
                    }
                    Button("Add Recipe", action: onAdd).buttonStyle(.bordered)
                }
            }
            .padding(24)
        }
    }

    private func way(icon: String, title: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Theme.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}
