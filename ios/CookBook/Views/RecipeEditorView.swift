import SwiftUI

/// Paste a recipe (or edit one as text) with a live preview of what CookBook reads from it.
struct RecipeEditorView: View {
    let request: EditorRequest
    var onSaved: (UUID) -> Void = { _ in }

    @Environment(RecipeStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var customTitle = ""
    @State private var tags = ""
    @State private var parsed = ParseResult.empty
    @State private var loaded = false

    private var bridge: ParserBridge { .shared }

    private var existing: Recipe? {
        if case .edit(let id) = request { return store.recipe(id: id) }
        return nil
    }

    private var title: String {
        let typed = customTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return typed.isEmpty ? parsed.recipe.title : typed
    }

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var canSave: Bool {
        !title.isEmpty && (parsed.recipe.ingredientCount > 0 || parsed.recipe.stepCount > 0)
    }

    private var problems: [String] {
        var list = parsed.problems.filter { title.isEmpty || !$0.hasPrefix("No title") }
        if existing == nil, !title.isEmpty,
           store.recipes.contains(where: { $0.content.title.caseInsensitiveCompare(title) == .orderedSame }) {
            list.append("You already have a recipe called “\(title)”. Saving adds a second copy.")
        }
        return list
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    PasteButton(payloadType: String.self) { strings in
                        Task { @MainActor in text = strings.joined(separator: "\n") }
                    }
                    TextField("Paste Claude’s recipe here", text: $text, axis: .vertical)
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(8...40)
                } header: {
                    Text("Recipe text")
                } footer: {
                    Text("Copy Claude’s whole reply, then tap Paste. Tip: in Settings, turn on “Let Claude send recipes” so Claude can add them for you.")
                }

                Section("Title and tags") {
                    TextField(parsed.recipe.title.isEmpty ? "Title" : parsed.recipe.title, text: $customTitle)
                    TextField("Tags, separated by commas", text: $tags)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("Preview") { preview }
            }
            .navigationTitle(existing == nil ? "Add Recipe" : "Edit Recipe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }.disabled(!canSave)
                }
            }
            .onAppear(perform: load)
            .onChange(of: text) { _, value in parsed = bridge.parse(value) }
        }
    }

    @ViewBuilder
    private var preview: some View {
        if !hasText {
            Text("The recipe appears here as you paste it, so you can check it before saving.")
                .foregroundStyle(.secondary)
        } else {
            let content = parsed.recipe
            VStack(alignment: .leading, spacing: 6) {
                Text(title.isEmpty ? "No title yet" : title)
                    .font(Theme.title(.title3))
                    .foregroundStyle(title.isEmpty ? Color.secondary : Color.primary)
                Text(summary(content))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            ForEach(problems, id: \.self) { problem in
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
            }
            if content.ingredientCount > 0 {
                DisclosureGroup("Ingredients (\(content.ingredientCount))") {
                    ForEach(IndexedGroup.from(content.ingredients)) { group in
                        if !group.title.isEmpty { GroupTitle(title: group.title) }
                        ForEach(group.lines) { line in
                            Text(bridge.styled(line.text, style: .ingredient))
                        }
                    }
                }
            }
            if content.stepCount > 0 {
                DisclosureGroup("Directions (\(content.stepCount))") {
                    ForEach(IndexedGroup.from(content.steps)) { group in
                        if !group.title.isEmpty { GroupTitle(title: group.title) }
                        ForEach(group.lines) { line in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("\(line.id + 1).").font(.callout.monospaced().weight(.bold)).foregroundStyle(Theme.red)
                                Text(bridge.styled(line.text, style: .step, ingredients: content.ingredients))
                            }
                        }
                    }
                }
            }
        }
    }

    private func summary(_ content: RecipeContent) -> String {
        var parts: [String] = []
        let servings = bridge.servingsLabel(content.servings, factor: 1)
        if !servings.isEmpty { parts.append(servings) }
        parts.append("\(content.ingredientCount) ingredients")
        parts.append("\(content.stepCount) steps")
        if content.stepCount > 0 { parts.append("amounts in \(parsed.stepsWithAmounts) of \(content.stepCount) steps") }
        return parts.joined(separator: " · ")
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let recipe = existing else { return }
        text = recipe.source.isEmpty ? bridge.markdown(for: recipe.content) : recipe.source
        parsed = bridge.parse(text)
        customTitle = recipe.content.title == parsed.recipe.title ? "" : recipe.content.title
        tags = recipe.tags.joined(separator: ", ")
    }

    private func save() {
        var content = parsed.recipe
        content.title = title
        let tagList = Self.tags(from: tags)
        if var recipe = existing {
            recipe.content = content
            recipe.tags = tagList
            recipe.source = text
            recipe.isNew = false
            store.update(recipe)
            dismiss()
        } else {
            let recipe = Recipe(content: content, tags: tagList, source: text)
            store.add(recipe)
            dismiss()
            onSaved(recipe.id)
        }
    }

    static func tags(from text: String) -> [String] {
        var seen: [String] = []
        for raw in text.split(separator: ",") {
            var tag = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if tag.hasPrefix("#") { tag.removeFirst() }
            if !tag.isEmpty, tag.count <= 30, !seen.contains(tag) { seen.append(tag) }
        }
        return Array(seen.prefix(12))
    }
}
