import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(ClaudeLink.self) private var link
    @Environment(RecipeStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var copied = false
    @State private var promptCopied = false
    @State private var confirmNewLink = false
    @State private var serverText = ""

    private var sendingBinding: Binding<Bool> {
        Binding(
            get: { link.isEnabled },
            set: { on in
                copied = false
                Task { if on { await link.enable() } else { await link.disable() } }
            }
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                claudeSection
                if link.isEnabled { connectSection }
                if link.hasInbox { inboxSection }
                askSection
                serverSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        link.setServerURL(serverText)
                        dismiss()
                    }
                }
            }
            .onAppear { serverText = link.serverURL }
            .confirmationDialog("Make a new link?", isPresented: $confirmNewLink, titleVisibility: .visible) {
                Button("Make New Link", role: .destructive) {
                    copied = false
                    Task { await link.makeNewLink() }
                }
            } message: {
                Text("Your current link stops working. Replace the CookBook connector in Claude with the new link.")
            }
        }
    }

    private var claudeSection: some View {
        Section {
            Toggle(isOn: sendingBinding) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Let Claude send recipes")
                    Text("Claude can add recipes to this app when you ask it to.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(link.isWorking || (!link.hasServer && !link.isEnabled))

            if link.isWorking {
                HStack(spacing: 8) { ProgressView(); Text("Talking to the CookBook server…").foregroundStyle(.secondary) }
            }

            if let url = link.connectorURL {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Your private connector link").font(.subheadline.weight(.semibold))
                    Text(url)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                }
                Button {
                    UIPasteboard.general.string = url
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy Link", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                Button("Make a New Link", role: .destructive) { confirmNewLink = true }
            }

            if let error = link.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        } header: {
            Text("Claude")
        } footer: {
            if link.isEnabled {
                Text("Anyone with this link can add recipes to your CookBook, so only paste it into your own Claude account. Turning this off or making a new link stops the old link working.")
            } else if !link.hasServer {
                Text("Add the CookBook server address under Server first.")
            } else {
                Text("You get a private link to add to Claude. Each person who uses CookBook gets their own.")
            }
        }
    }

    private var connectSection: some View {
        Section("Connect it in Claude") {
            Instruction(number: 1, text: "On claude.ai or in the Claude desktop app, open Settings and go to Connectors.")
            Instruction(number: 2, text: "Choose Add custom connector. Name it CookBook and paste your link.")
            Instruction(number: 3, text: "In any chat, say “Save this recipe to my CookBook.” Connectors you add there also work in the Claude iPhone app.")
        }
    }

    private var inboxSection: some View {
        Section {
            Button("Check for Recipes Now") {
                Task { await link.checkInbox(into: store) }
            }
            if let checked = link.lastChecked {
                LabeledContent("Last checked") {
                    Text(checked, style: .relative) + Text(" ago")
                }
            }
        } footer: {
            Text("CookBook also checks whenever it’s open. Recipes wait on the server for up to 30 days until the app collects them.")
        }
    }

    private var askSection: some View {
        Section {
            Text(AskClaude.prompt)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
            Button {
                UIPasteboard.general.string = AskClaude.prompt
                promptCopied = true
            } label: {
                Label(promptCopied ? "Copied" : "Copy Prompt", systemImage: promptCopied ? "checkmark" : "doc.on.doc")
            }
        } header: {
            Text("Asking Claude for recipes")
        } footer: {
            Text("Use this when you paste recipes yourself. Put it in a Claude project’s instructions so every recipe comes back in this shape.")
        }
    }

    private var serverSection: some View {
        Section {
            TextField("https://cookbook-server.example.workers.dev", text: $serverText)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.footnote.monospaced())
                .onSubmit { link.setServerURL(serverText) }
        } header: {
            Text("Server")
        } footer: {
            Text("The CookBook server holds recipes from Claude until this app collects them. Changing it turns off the current Claude link.")
        }
    }
}

private struct Instruction: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.headline.monospaced())
                .foregroundStyle(Theme.red)
            Text(text).font(.subheadline)
        }
    }
}
