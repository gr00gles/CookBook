#!/usr/bin/env node
// Turns a recipe written in Markdown (or plain text) into the JSON document
// CookBook stores, so it can be written straight into the app's database.
//
//   node scripts/recipe-to-doc.js recipe.md --tags dinner,chicken > recipe.json
//
// Prints the suggested document id on stderr.
const fs = require('fs');
const P = require('../cookbook/parser.js');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const tagsAt = args.indexOf('--tags');
const tags = tagsAt >= 0 && args[tagsAt + 1]
  ? args[tagsAt + 1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  : [];

const source = fs.readFileSync(file ? file : 0, 'utf8');
const recipe = P.parseRecipe(source);
const problems = P.checkRecipe(recipe);
if (problems.length) {
  console.error('Check this recipe:\n- ' + problems.join('\n- '));
  if (!recipe.title || (!P.countItems(recipe.ingredients) && !P.countItems(recipe.steps))) process.exit(1);
}

const now = Date.now();
const doc = Object.assign(recipe, {
  tags,
  favorite: false,
  myNotes: '',
  source,
  createdAt: now,
  updatedAt: now,
});
const id = P.slugify(recipe.title).slice(0, 48) + '-' + now.toString(36).slice(-5);
console.error('doc id: ' + id);
process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
