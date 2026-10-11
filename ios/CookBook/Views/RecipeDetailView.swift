import SwiftUI
import UIKit

struct RecipeDetailView: View {
    let recipeID: UUID

    @Environment(RecipeStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var factor = 1.0
    @State private var keepAwake = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var myNotes = ""
    @State private var notesTask: Task<Void, Never>?

    private var bridge: ParserBridge { .shared }

    var body: some View {
        if let recipe = store.recipe(id: recipeID) {
            detail(recipe)
        } else {
            ContentUnavailableView("Recipe deleted", systemImage: "trash")
        }
    }

    private func detail(_ recipe: Recipe) -> some View {
        let progress = store.cooking[recipe.id] ?? CookingProgress()
        return ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header(recipe)
                scaleBar(recipe.content)
                ingredients(recipe, progress)
                steps(recipe, progress)
                notes(recipe.content)
                myNotesSection
            }
            .padding(20)
        }
        .navigationTitle(recipe.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarItems(recipe, progress) }
        .onAppear {
            myNotes = recipe.myNotes
            if recipe.isNew { store.modify(recipe.id) { $0.isNew = false } }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            notesTask?.cancel()
            saveNotes(myNotes)
        }
        .onChange(of: keepAwake) { _, on in
            UIApplication.shared.isIdleTimerDisabled = on
        }
        .onChange(of: myNotes) { _, value in
            notesTask?.cancel()
            notesTask = Task {
                try? await Task.sleep(for: .milliseconds(700))
                guard !Task.isCancelled else { return }
                saveNotes(value)
            }
        }
        .confirmationDialog("Delete “\(recipe.title)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Recipe", role: .destructive) {
                store.delete(recipe.id)
                dismiss()
            }
        } message: {
            Text("This can’t be undone.")
        }
        .sheet(isPresented: $editing) {
            RecipeEditorView(request: .edit(recipe.id))
        }
    }

    // MARK: Sections

    private func header(_ recipe: Recipe) -> some View {
        let content = recipe.content
        var facts: [String] = []
        let servings = bridge.servingsLabel(content.servings, factor: factor)
        if !servings.isEmpty { facts.append(servings) }
        if !content.prepTime.isEmpty { facts.append("Prep " + content.prepTime) }
        if !content.cookTime.isEmpty { facts.append("Cook " + content.cookTime) }
        if !content.totalTime.isEmpty { facts.append("Total " + content.totalTime) }

        return VStack(alignment: .leading, spacing: 10) {
            Text(recipe.title)
                .font(Theme.title(.largeTitle))
                .fixedSize(horizontal: false, vertical: true)
            if !content.description.isEmpty {
                Text(bridge.styled(content.description, style: .plain))
                    .foregroundStyle(.secondary)
            }
            if !facts.isEmpty {
                Text(facts.joined(separator: "  ·  "))
                    .font(.subheadline.monospaced().weight(.semibold))
            }
            if !recipe.tags.isEmpty {
                Text(recipe.tags.map { "#" + $0 }.joined(separator: "  "))
                    .font(.subheadline)
                    .foregroundStyle(Theme.accent)
            }
            if recipe.fromClaude {
                Label("Sent by Claude", systemImage: "sparkles")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            VStack(spacing: 3) {
                Rectangle().fill(Theme.red).frame(height: 1.5)
                Rectangle().fill(Theme.red).frame(height: 1.5)
            }
            .padding(.top, 4)
        }
    }

    private func scaleBar(_ content: RecipeContent) -> some View {
        let base = bridge.servingsNumber(content.servings)
        let label = base == nil
            ? "\(bridge.formatFactor(factor))× recipe"
            : bridge.servingsLabel(content.servings, factor: factor)

        return HStack(spacing: 10) {
            Button {
                factor = Scaling.next(from: factor, base: base, direction: -1)
            } label: {
                Image(systemName: "minus").frame(width: 28, height: 28)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Make less")

            VStack(spacing: 2) {
                Text(label).font(.headline.monospaced())
                if factor != 1 {
                    Text("×" + factor.formatted(.number.precision(.fractionLength(0...2))))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minWidth: 130)

            Button {
                factor = Scaling.next(from: factor, base: base, direction: 1)
            } label: {
                Image(systemName: "plus").frame(width: 28, height: 28)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Make more")

            Spacer(minLength: 0)
            if factor != 1 {
                Button("Reset") { factor = 1 }.font(.subheadline)
            }
        }
    }

    private func ingredients(_ recipe: Recipe, _ progress: CookingProgress) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle(title: "Ingredients", detail: "\(recipe.content.ingredientCount)")
            ForEach(IndexedGroup.from(recipe.content.ingredients)) { group in
                if !group.title.isEmpty { GroupTitle(title: group.title) }
                ForEach(group.lines) { line in
                    let done = progress.ingredients.contains(line.id)
                    Button {
                        store.toggleIngredient(recipe.id, line.id)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(done ? Theme.accent : Color.secondary)
                            Text(bridge.styled(line.text, style: .ingredient, factor: factor))
                                .strikethrough(done)
                                .foregroundStyle(done ? Color.secondary : Color.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(done ? .isSelected : [])
                    Rectangle().fill(Theme.rule).frame(height: 1)
                }
            }
        }
    }

    private func steps(_ recipe: Recipe, _ progress: CookingProgress) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle(title: "Directions", detail: "Tap a step when it’s done")
            ForEach(IndexedGroup.from(recipe.content.steps)) { group in
                if !group.title.isEmpty { GroupTitle(title: group.title) }
                ForEach(group.lines) { line in
                    let done = progress.steps.contains(line.id)
                    Button {
                        store.toggleStep(recipe.id, line.id)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(done ? "✓" : "\(line.id + 1)")
                                .font(.title3.monospaced().weight(.bold))
                                .foregroundStyle(done ? Color.secondary : Theme.red)
                                .frame(width: 30, alignment: .leading)
                            Text(bridge.styled(line.text, style: .step, factor: factor, ingredients: recipe.content.ingredients))
                                .lineSpacing(4)
                                .foregroundStyle(done ? Color.secondary : Color.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(done ? .isSelected : [])
                    Rectangle().fill(Theme.rule).frame(height: 1)
                }
            }
        }
    }

    @ViewBuilder
    private func notes(_ content: RecipeContent) -> some View {
        if !content.notes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionTitle(title: "Notes")
                ForEach(IndexedGroup.from(content.notes)) { group in
                    if !group.title.isEmpty { GroupTitle(title: group.title) }
                    ForEach(group.lines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("•").foregroundStyle(Theme.red)
                            Text(bridge.styled(line.text, style: .plain))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    private var myNotesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(title: "My notes")
            TextField("What you changed, what to try next time", text: $myNotes, axis: .vertical)
                .lineLimit(3...12)
                .textFieldStyle(.roundedBorder)
        }
    }

    @ToolbarContentBuilder
    private func toolbarItems(_ recipe: Recipe, _ progress: CookingProgress) -> some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                store.modify(recipe.id) { $0.favorite.toggle() }
            } label: {
                Image(systemName: recipe.favorite ? "star.fill" : "star")
            }
            .accessibilityLabel(recipe.favorite ? "Remove from favorites" : "Add to favorites")

            Menu {
                Button { editing = true } label: { Label("Edit", systemImage: "pencil") }
                ShareLink(item: bridge.markdown(for: recipe.content)) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                Toggle(isOn: $keepAwake) { Label("Keep Screen On", systemImage: "sun.max") }
                if !progress.isEmpty {
                    Button { store.clearCooking(recipe.id) } label: {
                        Label("Clear Ticks", systemImage: "arrow.counterclockwise")
                    }
                }
                Divider()
                Button(role: .destructive) { confirmDelete = true } label: {
                    Label("Delete", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("More")
        }
    }

    private func saveNotes(_ value: String) {
        guard let recipe = store.recipe(id: recipeID), recipe.myNotes != value else { return }
        store.modify(recipeID) { $0.myNotes = value }
    }
}
