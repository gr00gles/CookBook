# CookBook

A personal recipe box for the recipes you get from Claude. Paste Claude's reply and CookBook files it as a recipe card, with the amount of every ingredient kept right in the directions.

**Open the app:** https://claude.ai/artifact/S75x6CjTbHvYXz25scpRn5

It runs as a private claude.ai artifact. Recipes are saved to the artifact's own database, so they show up on your phone and computer while you're signed in to claude.ai.

## How to use it

1. **Ask Claude for a recipe.** Use the prompt below, or paste it into a claude.ai Project's instructions so every recipe comes back in this shape.
2. **Copy the whole reply** using the copy button under Claude's message.
3. **Open CookBook, tap "Add recipe" and paste.** The preview shows the title, servings and times, ingredients and directions it found, plus how many steps include their amounts. Add tags and save.

Tip: open the app link with `#add` on the end to jump straight to the paste screen.

### The prompt

```
Give me a recipe for [DISH]. Format it for my cookbook:
- Start with the recipe name as a # heading, then one sentence about it.
- Then a line like: Serves: 4 | Prep: 15 min | Cook: 30 min
- "## Ingredients" as a bulleted list with amounts. Label parts with bold lines like **For the sauce:**
- "## Directions" as a numbered list. Write the exact amount of every ingredient into the step where it is used, like "Add 2 tbsp olive oil".
- "## Notes" for tips, swaps and storage.
```

The parser also copes with replies that don't follow it exactly: other heading names (Instructions, Method, Steps, What you'll need), `Step 1:` style steps, grouped ingredients, emoji in headings, and plain text copied from the rendered chat.

## Features

- **Paste to import**, with a live preview before saving and a warning for duplicates.
- **Amounts highlighted in the directions**, so you never scroll back up to the ingredient list.
- **Scale servings.** Amounts change in the ingredients *and* the directions. Oven temperatures, times and pan sizes stay put.
- **Cooking mode.** Tick off ingredients, tap steps when they're done, and keep the screen awake.
- **Search** by title, ingredient or tag, plus tag and favorites filters.
- **My notes** on each recipe for what you changed and what to try next time.
- **Edit** a recipe as text, or **copy** it back out as Markdown.
- Phone-first layout with light and dark themes.

## Project layout

| Path | What it is |
| --- | --- |
| `cookbook/index.html` | The app page, published as the artifact |
| `cookbook/parser.js` | Recipe parser, Markdown writer and amount scaler (browser and Node) |
| `tests/parser.test.js` | Parser tests (`npm test`, Node 18+) |
| `scripts/recipe-to-doc.js` | Turns a Markdown recipe into the JSON document the app stores |
| `CLAUDE.md` | How Claude should format recipes and add them to the app |
