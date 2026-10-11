# CookBook

An iPhone recipe box for the recipes you get from Claude, with the amount of every ingredient kept right in the directions.

There are two ways to get a recipe in:

- **Claude sends it.** Turn on **Let Claude send recipes** in the app's Settings and add your private link to Claude as a connector. Then, in any chat, say *"save this to my CookBook"* and it appears in the app.
- **Paste it.** Copy Claude's reply, tap **+**, then **Paste**. CookBook picks out the title, servings, ingredients, steps and notes, and shows a preview first.

Every person who installs the app gets their own link and their own recipes.

## Features

- **Amounts highlighted in the directions**, so you never scroll back up to the ingredient list.
- **Scale servings.** Amounts change in the ingredients *and* the directions. Oven temperatures, times and pan sizes stay put.
- **Cooking mode.** Tick off ingredients, tap steps when they're done, and keep the screen on.
- **Search** by title, ingredient or tag. Filter by tag or favorites. Swipe to favorite or delete.
- **My notes** on each recipe, **edit** a recipe as text, and **share** it as text.
- New recipes from Claude show up under **New from Claude** until you open them.

## How it fits together

```
Claude ──save_recipe──▶ CookBook server ◀──collects── iPhone app
        (connector)      (Cloudflare,                  (recipes saved
                          one inbox per person)         on the phone)
```

| Folder | What it is |
| --- | --- |
| `ios/` | The SwiftUI app (iOS 17+). `project.yml` is the source of truth; CI regenerates `CookBook.xcodeproj` from it. |
| `server/` | The Cloudflare Worker: per-person inboxes and the MCP connector Claude talks to. See [server/README.md](server/README.md). |
| `cookbook/parser.js` | The recipe reader and amount scaler. The app runs it in JavaScriptCore, so the app and tests use the same code. |
| `cookbook/bridge.js` | The functions the app calls in `parser.js`. |
| `cookbook/index.html` | An earlier web version, still usable as a claude.ai artifact. It keeps its own recipes. |
| `tests/`, `server/test/`, `ios/CookBookTests/` | Tests. GitHub Actions runs all of them on every push, including the iOS tests on a simulator. |

## Set it up

### 1. Deploy the server (once)

Follow [server/README.md](server/README.md). It takes about five minutes on Cloudflare's free plan and gives you an address like `https://cookbook-server.your-name.workers.dev`. Put that address in `ios/project.yml` as `COOKBOOK_SERVER_URL`.

### 2. Install the app on your iPhone

You need a Mac with [Xcode](https://apps.apple.com/app/xcode/id497799835) 16 or later.

1. Download this repository and open `ios/CookBook.xcodeproj`.
2. Click the **CookBook** project, then the **CookBook** target, then **Signing & Capabilities**. Choose your Apple ID under **Team**. If Xcode says the bundle identifier is taken, change it to something unique, such as `com.yourname.cookbook`.
3. Plug in your iPhone and pick it as the run destination. The first time, turn on Developer Mode on the phone under Settings › Privacy & Security.
4. Press **Run**.

With a free Apple ID the app stops opening after 7 days; press Run again to renew it. Your recipes stay on the phone. With a paid Apple Developer account ($99 a year) there's no expiry, and you can share the app with other people through **TestFlight** (in Xcode, Product › Archive, then Distribute App).

If you change `project.yml`, regenerate the project with [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`, then `xcodegen` in `ios/`). Or just push, and CI regenerates and commits it.

### 3. Let Claude send recipes

1. In the app, open **Settings** and turn on **Let Claude send recipes**. Tap **Copy Link**.
2. On claude.ai or in the Claude desktop app, open **Settings › Connectors** and choose **Add custom connector**. Name it **CookBook** and paste the link. Connectors you add there also work in the Claude iPhone app.
3. In any chat, ask for a recipe and say *"save it to my CookBook."*

Turning the switch off, or tapping **Make a New Link**, stops the old link working. The free Claude plan allows one custom connector, and paid plans allow more.

## Asking Claude for recipes

When Claude sends a recipe through the connector, the tool itself asks for every amount in the steps. For recipes you paste, this prompt gives replies that import cleanly. You can also put it in a Claude project's instructions:

```
Give me a recipe for [DISH]. Format it for my cookbook:
- Start with the recipe name as a # heading, then one sentence about it.
- Then a line like: Serves: 4 | Prep: 15 min | Cook: 30 min
- "## Ingredients" as a bulleted list with amounts. Label parts with bold lines like **For the sauce:**
- "## Directions" as a numbered list. Write the exact amount of every ingredient into the step where it is used, like "Add 2 tbsp olive oil".
- "## Notes" for tips, swaps and storage.
```

## Develop

```sh
npm test                   # parser and bridge tests
(cd server && npm test)    # server tests
```

The iOS tests run in CI (`.github/workflows/ios.yml`) on a macOS runner, or locally in Xcode with ⌘U.
