// Runs parser.js and bridge.js the way the iPhone app does: as plain scripts in
// a fresh global scope (JavaScriptCore has no `module`, `require` or `self`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBridge() {
  const context = vm.createContext({});
  for (const file of ['parser.js', 'bridge.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'cookbook', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return (expr) => vm.runInContext(expr, context);
}

const run = loadBridge();
const call = (fn, ...args) => run(`CookBookBridge.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`);

const RECIPE = `# Garlic Butter Shrimp

Serves: 4 | Cook: 15 min

## Ingredients
- 1 lb shrimp
- 4 tbsp butter
- 2 eggs

## Directions
1. **Sear:** Melt 2 tbsp butter and add 1 lb shrimp.
2. Whisk 2 eggs with the remaining 2 tbsp butter. Bake at 400°F for 10 minutes.`;

test('parse returns the recipe, problems and amount count as JSON', () => {
  const out = JSON.parse(call('parse', RECIPE));
  assert.equal(out.recipe.title, 'Garlic Butter Shrimp');
  assert.equal(out.recipe.servings, '4');
  assert.deepEqual(out.problems, []);
  assert.equal(out.stepsWithAmounts, 2);
});

test('pieces splits bold text and scaled amounts', () => {
  const ingredients = JSON.stringify(JSON.parse(call('parse', RECIPE)).recipe.ingredients);
  const pieces = JSON.parse(call('pieces', '**Sear:** Melt 2 tbsp butter and add 1 lb shrimp.', 'step', 2, ingredients));
  assert.deepEqual(pieces[0], { text: 'Sear:', bold: true });
  const amounts = pieces.filter((p) => p.qty).map((p) => [p.text, p.qty.original]);
  assert.deepEqual(amounts, [['4 tbsp', '2 tbsp'], ['2 lb', '1 lb']]);

  const step2 = JSON.parse(call('pieces', 'Whisk 2 eggs. Bake at 400°F for 10 minutes.', 'step', 1, ingredients));
  assert.deepEqual(step2.filter((p) => p.qty).map((p) => p.text), ['2']);

  const plain = JSON.parse(call('pieces', 'Use *fresh* basil', 'plain', 1, '[]'));
  assert.deepEqual(plain, [{ text: 'Use ' }, { text: 'fresh', italic: true }, { text: ' basil' }]);
});

test('servings helpers and Markdown', () => {
  assert.equal(call('servingsLabel', '4', 1.5), 'Serves 6');
  assert.equal(call('servingsLabel', '12 cookies', 2), 'Makes 24 cookies');
  assert.equal(call('servingsNumber', '4-6'), 4);
  assert.equal(call('servingsNumber', 'a crowd'), -1);
  assert.equal(call('formatFactor', 0.5), '½');
  const recipe = JSON.parse(call('parse', RECIPE)).recipe;
  const md = call('markdown', JSON.stringify(recipe));
  assert.match(md, /^# Garlic Butter Shrimp\n/);
  assert.deepEqual(JSON.parse(call('parse', md)).recipe, recipe);
});
