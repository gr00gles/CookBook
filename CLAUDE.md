# CookBook

An iPhone recipe box for recipes the user gets from Claude. Three parts:

- `ios/`: SwiftUI app, iOS 17+, Swift 5 language mode. `ios/project.yml` (XcodeGen) is the source of truth. The iOS CI workflow regenerates `ios/CookBook.xcodeproj` and `ios/CookBook/Info.plist` and commits them back on push, so pull before pushing again.
- `server/`: Cloudflare Worker with one Durable Object per inbox. It serves the app's HTTP API and the MCP connector (`/mcp/<inboxId>.<secret>`, tool `save_recipe`). Logic lives in `server/src/core.js` (no Cloudflare imports, so it's testable under Node); `server/src/index.js` is the thin Worker and Durable Object wrapper.
- `cookbook/parser.js` + `cookbook/bridge.js`: the recipe parser and amount scaler. The iOS app runs both in JavaScriptCore (`ParserBridge.swift`), so parser changes reach the app with no Swift changes. `cookbook/index.html` is an older web version (claude.ai artifact https://claude.ai/artifact/S75x6CjTbHvYXz25scpRn5) with its own storage.

## The user's recipe format

The user always wants **every ingredient amount written into the directions**, not only in the ingredient list ("Add 2 tbsp olive oil", never "add the olive oil"). When writing recipes, use:

```
# Recipe Name

One sentence about the dish.

Serves: 4 | Prep: 15 min | Cook: 30 min

## Ingredients

**For the sauce:**
- 2 tbsp olive oil

## Directions

1. **Short label:** Heat 2 tbsp olive oil in a 12-inch skillet...

## Notes

- Tips, swaps, storage.
```

If the CookBook connector is available in a conversation, its `save_recipe` tool takes the same content as fields (`title`, `description`, `servings`, `prep_time`, `cook_time`, `total_time`, `ingredients` and `steps` as `[{group?, items}]`, `notes`, `tags`).

## Checks

- `npm test` at the root runs the parser tests and the bridge tests. The bridge tests run the scripts in a bare `vm` context, the way JavaScriptCore does.
- `cd server && npm test` runs the server tests with an in-memory Durable Object stand-in. `npx wrangler@4 dev` runs the real Workers runtime locally.
- iOS can't be built on Linux. Push and read the **iOS app** workflow (macos-15: XcodeGen, `xcodebuild test` on a simulator, unsigned device build).

## Gotchas

- Keep `parser.js` free of regex lookbehind and ES modules. It must run as a plain script in JavaScriptCore and older Safari.
- Keep `\u` escapes as escapes in JS source; a raw U+2028/U+2029 inside a regex literal breaks the script.
- `parser.js` output shape (`title, description, servings, prepTime, cookTime, totalTime, ingredients, steps, notes`, with groups as `{title, items}`) is shared by the web app, the server's stored recipes and the Swift `RecipeContent` model. Change all of them together.
- `cookbook/index.html` is an artifact page fragment (no `<html>`/`<head>`/`<body>`). Republish with the Artifact tool: `file_path: cookbook/index.html`, `url` = the artifact above, `files: {"parser.js": "cookbook/parser.js"}`.
