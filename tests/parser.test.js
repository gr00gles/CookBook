const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../cookbook/parser.js');

const CLAUDE_MARKDOWN = `Here's a classic chicken parmesan with every amount written into the steps:

# Classic Chicken Parmesan

Crispy cutlets under bright marinara and bubbling mozzarella.

**Serves:** 4 | **Prep:** 20 min | **Cook:** 25 min

## Ingredients

**For the chicken:**
- 2 large boneless chicken breasts (about 1½ lbs)
- ½ cup all-purpose flour
- 2 large eggs
- 1 cup panko breadcrumbs

**For the topping:**
- 1 can (15 oz) crushed tomatoes
- 1½ cups shredded mozzarella

## Directions

1. **Prep the chicken:** Slice the 2 chicken breasts in half horizontally to make 4 cutlets.
2. Set out three shallow dishes: ½ cup flour in the first, 2 eggs beaten in the second, and 1 cup panko in the third.
3. Heat 3 tbsp olive oil in a 12-inch skillet over medium-high heat.
4. Bake at 425°F for 15–20 minutes, then top with 1½ cups mozzarella.

## Tips
- Pound the cutlets to an even ½-inch thickness so they cook evenly.

Enjoy! Let me know if you want a baked version.`;

test('parses a typical Claude Markdown recipe', () => {
  const r = P.parseRecipe(CLAUDE_MARKDOWN);
  assert.equal(r.title, 'Classic Chicken Parmesan');
  assert.equal(r.description, 'Crispy cutlets under bright marinara and bubbling mozzarella.');
  assert.equal(r.servings, '4');
  assert.equal(r.prepTime, '20 min');
  assert.equal(r.cookTime, '25 min');
  assert.deepEqual(r.ingredients.map((g) => g.title), ['For the chicken', 'For the topping']);
  assert.equal(r.ingredients[0].items.length, 4);
  assert.equal(r.ingredients[1].items[0], '1 can (15 oz) crushed tomatoes');
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].items.length, 4);
  assert.match(r.steps[0].items[0], /^\*\*Prep the chicken:\*\* Slice/);
  assert.deepEqual(r.notes, [{ title: 'Tips', items: ['Pound the cutlets to an even ½-inch thickness so they cook evenly.'] }]);
  assert.deepEqual(P.checkRecipe(r), []);
});

test('parses plain text copied from the rendered chat', () => {
  const text = `Sure! Here's a quick one.

Garlic Butter Pasta
Serves 2 · Total: 20 minutes

Ingredients
8 oz spaghetti
3 tbsp butter
4 cloves garlic, minced

Directions
Boil 8 oz spaghetti in salted water until al dente.
Melt 3 tbsp butter and cook 4 cloves garlic for 1 minute.
Toss together and serve.`;
  const r = P.parseRecipe(text);
  assert.equal(r.title, 'Garlic Butter Pasta');
  assert.equal(r.servings, '2');
  assert.equal(r.totalTime, '20 minutes');
  assert.deepEqual(r.ingredients[0].items, ['8 oz spaghetti', '3 tbsp butter', '4 cloves garlic, minced']);
  assert.equal(r.steps[0].items.length, 3);
});

test('handles "Step 1:" headings, grouped directions and indented sub-points', () => {
  const text = `## Overnight Oats
### Ingredients
- 1/2 cup rolled oats
- 1/2 cup milk
### Instructions
#### Make the base
1. Stir 1/2 cup oats into 1/2 cup milk.
   - Use a pint jar.
**Step 2: Finish**
Chill overnight.`;
  const r = P.parseRecipe(text);
  assert.equal(r.title, 'Overnight Oats');
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].title, 'Make the base');
  assert.equal(r.steps[0].items[0], 'Stir 1/2 cup oats into 1/2 cup milk.\n• Use a pint jar.');
  assert.equal(r.steps[1].title, 'Finish');
  assert.deepEqual(r.steps[1].items, ['Chill overnight.']);
});

test('Markdown round trip keeps the recipe intact', () => {
  const r = P.parseRecipe(CLAUDE_MARKDOWN);
  const again = P.parseRecipe(P.toMarkdown(r));
  assert.deepEqual(again, r);
});

test('finds amounts in directions but leaves temperatures, times and sizes alone', () => {
  const r = P.parseRecipe(CLAUDE_MARKDOWN);
  const words = P.ingredientWords(r.ingredients);
  const amounts = (s) => P.findQuantities(s, { mode: 'step', words }).map((q) => s.slice(q.start, q.end));
  assert.deepEqual(amounts('Heat 3 tbsp olive oil in a 12-inch skillet over medium-high heat.'), ['3 tbsp']);
  assert.deepEqual(amounts('Bake at 425°F for 15–20 minutes, then top with 1½ cups mozzarella.'), ['1½ cups']);
  assert.deepEqual(amounts('Crack 2 large eggs into a bowl.'), ['2']);
  assert.deepEqual(amounts('Cut into 4 pieces and use a 9x13 pan.'), []);
  assert.deepEqual(amounts('Preheat the oven to 220C (425 F).'), []);
});

test('scales ingredient lines and directions', () => {
  const ing = (s, f) => P.scaleText(s, { mode: 'ingredient', factor: f });
  assert.equal(ing('½ cup all-purpose flour', 2), '1 cup all-purpose flour');
  assert.equal(ing('1 cup panko', 1.5), '1½ cups panko');
  assert.equal(ing('2 large eggs', 0.5), '1 large eggs');
  assert.equal(ing('1 can (15 oz) crushed tomatoes', 2), '2 cans (15 oz) crushed tomatoes');
  assert.equal(ing('2 (6-ounce) salmon fillets', 2), '4 (6-ounce) salmon fillets');
  assert.equal(ing('1 cup (240 ml) milk', 2), '2 cups (480 ml) milk');
  assert.equal(ing('1.5 lbs chicken thighs', 2), '3 lbs chicken thighs');
  assert.equal(ing('2-3 cloves garlic', 2), '4-6 cloves garlic');
  assert.equal(ing('Salt and pepper, to taste', 2), 'Salt and pepper, to taste');

  const words = P.ingredientWords([{ items: ['2 large eggs', '3 tbsp olive oil'] }]);
  const step = (s, f) => P.scaleText(s, { mode: 'step', factor: f, words });
  assert.equal(step('Whisk 2 eggs with 3 tbsp olive oil, then bake at 350°F for 10 minutes.', 2),
    'Whisk 4 eggs with 6 tbsp olive oil, then bake at 350°F for 10 minutes.');
});

test('formats scaled numbers the way a cook would write them', () => {
  assert.equal(P.formatNumber(0.75, 'fraction'), '¾');
  assert.equal(P.formatNumber(2.333, 'fraction'), '2⅓');
  assert.equal(P.formatNumber(12.4, 'fraction'), '12½');
  assert.equal(P.formatNumber(680 * 1.5, 'metric'), '1020');
  assert.equal(P.formatNumber(1.25, 'decimal'), '1.25');
});

test('parses bullets and numbers with no headings at all', () => {
  const r = P.parseRecipe(`Lemonade
- 1 cup lemon juice
- 3/4 cup sugar
1. Stir 3/4 cup sugar into 1 cup lemon juice.
2. Add 4 cups cold water.`);
  assert.equal(r.title, 'Lemonade');
  assert.equal(r.ingredients[0].items.length, 2);
  assert.equal(r.steps[0].items.length, 2);
});
