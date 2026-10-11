/* CookBook bridge for the iPhone app.
 *
 * The app runs parser.js and this file in JavaScriptCore. Every function takes
 * plain strings and numbers and returns a string (usually JSON), so the Swift
 * side only needs to decode JSON.
 */
var CookBookBridge = (function () {
  'use strict';
  var P = RecipeParser;

  function parseGroups(json) {
    try { return JSON.parse(json || '[]') || []; } catch (e) { return []; }
  }

  function servingsLabel(servings, factor) {
    var s = String(servings || '').trim();
    if (!s) return '';
    var shown = factor === 1 ? s : P.scaleText(s, { mode: 'ingredient', factor: factor });
    return (/^\d+(?:\s*(?:-|–|to)\s*\d+)?$/.test(s) ? 'Serves ' : 'Makes ') + shown;
  }

  return {
    // Recipe text -> {recipe, problems, stepsWithAmounts}
    parse: function (text) {
      var recipe = P.parseRecipe(text);
      var words = P.ingredientWords(recipe.ingredients);
      var withAmounts = 0;
      recipe.steps.forEach(function (g) {
        g.items.forEach(function (step) {
          if (P.findQuantities(step, { mode: 'step', words: words }).length) withAmounts++;
        });
      });
      return JSON.stringify({ recipe: recipe, problems: P.checkRecipe(recipe), stepsWithAmounts: withAmounts });
    },

    // One line -> styled pieces. mode: "ingredient", "step" or "plain".
    pieces: function (text, mode, factor, ingredientsJSON) {
      var opts = null;
      if (mode === 'ingredient') opts = { mode: 'ingredient', factor: factor };
      else if (mode === 'step') opts = { mode: 'step', factor: factor, words: P.ingredientWords(parseGroups(ingredientsJSON)) };
      return JSON.stringify(P.inlinePieces(text, opts));
    },

    // Recipe JSON -> Markdown, for sharing and editing.
    markdown: function (recipeJSON) {
      return P.toMarkdown(JSON.parse(recipeJSON));
    },

    servingsLabel: servingsLabel,

    // "4", "4-6", "12 cookies" -> 4, 4, 12; -1 when there is no number.
    servingsNumber: function (servings) {
      var n = P.servingsNumber(servings);
      return n == null ? -1 : n;
    },

    formatFactor: function (factor) {
      return P.formatNumber(factor, 'fraction');
    },
  };
})();
