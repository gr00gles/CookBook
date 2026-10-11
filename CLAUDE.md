# CookBook

A recipe box for recipes the user gets from Claude. The app is one HTML page (`cookbook/index.html`) plus a parser (`cookbook/parser.js`), published as a claude.ai artifact:

- Artifact: https://claude.ai/artifact/S75x6CjTbHvYXz25scpRn5
- Capabilities: `db` with rule `{path: "", read: "view", write: "admin"}`, and `user`. Only the owner and editors change recipes; people the cookbook is shared with can read them.

## Writing recipes for this user

The user always wants **every ingredient amount written into the directions**, not only in the ingredient list ("Add 2 tbsp olive oil", never "add the olive oil"). Use this shape so the app imports it cleanly:

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

## Adding a recipe to the app directly

When the user asks to add a recipe to their cookbook, write it to the artifact's database with the `ArtifactData` tool:

1. Save the recipe as Markdown in the scratchpad, then build the document:
   `node scripts/recipe-to-doc.js recipe.md --tags dinner,chicken > recipe.json`. It prints the doc id to use.
2. `ArtifactData` `set` with `url` = the artifact above, `collection: "recipes"`, that `doc_id` and `file_path: recipe.json`.

Document shape (collection `recipes`, one document per recipe):

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | |
| `description` | string | lines joined with `\n` |
| `servings`, `prepTime`, `cookTime`, `totalTime` | string | raw text, e.g. `"4"`, `"12 cookies"`, `"15 min"`; servings' first number drives scaling |
| `ingredients`, `steps`, `notes` | `[{title, items: string[]}]` | `title` is `""` for an ungrouped list; items keep inline `**bold**`/`*italic*`; a step's continuation lines are joined with `\n` |
| `tags` | string[] | lowercase |
| `favorite` | boolean | |
| `myNotes` | string | the user's own notes; never overwrite |
| `source` | string | the text the recipe was imported from; shown when editing |
| `createdAt`, `updatedAt` | number | ms since epoch |

Changing an existing recipe: read it first and pin the write with `if_version`. Don't touch `myNotes` or `favorite` unless asked.

## Development

- `npm test` runs the parser tests (Node 18+, no dependencies).
- `cookbook/index.html` is an artifact page fragment: no `<!doctype>`, `<html>`, `<head>` or `<body>`. The platform adds them when publishing.
- Republish: `Artifact` publish with `file_path: cookbook/index.html`, `url` = the artifact above, `files: {"parser.js": "cookbook/parser.js"}`. Leave `capabilities` out so the stored ones carry over.
- The parser avoids regex lookbehind so it runs on older iOS Safari. Keep `\u` escapes as escapes; raw U+2028/U+2029 inside a regex literal breaks the script.
