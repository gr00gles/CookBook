/* CookBook recipe parser.
 *
 * Turns a recipe reply from Claude (Markdown, or plain text copied from the
 * rendered chat) into a structured recipe, writes a recipe back out as
 * Markdown, and finds/scales the amounts inside ingredient lines and
 * directions.
 *
 * Works in the browser (window.RecipeParser) and in Node (require).
 * No regex lookbehind, so it also runs on older iOS Safari.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecipeParser = factory();
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Section headings and chat filler

  const SECTION_PATTERNS = [
    ['ingredients', /^(?:ingredients?|(?:here(?:'|’)?s )?(?:what )?you(?:'|’)?ll need|you will need|shopping list|grocery list)\b/i],
    ['steps', /^(?:directions?|instructions?|method|steps|preparation|procedure|how to (?:make|prepare|cook)(?: it)?|cooking (?:instructions|directions|steps|method))\b/i],
    ['notes', /^(?:notes?|tips?(?: (?:and|&) tricks)?|chef(?:'|’)?s? (?:notes?|tips?)|cook(?:'|’)?s? notes?|pro tips?|variations?|substitutions?|swaps|storage|storing|to store|make[- ]ahead|leftovers|serving suggestions?|to serve|serve with|equipment|tools|nutrition)\b/i],
  ];

  const CHATTER = /^(?:here(?:'|’)?s|here is|here are|sure\b|absolutely|of course|great (?:choice|question|idea)|okay\b|ok\b|certainly|happy to|i(?:'|’)?ve|i have|below is|this (?:recipe|version) (?:has|includes|puts|lists))/i;
  const SIGNOFF = /^(?:enjoy\b|let me know|happy (?:cooking|baking)|bon app[eé]tit|would you like|i hope|hope you|feel free|want me to|if you(?:'|’)?d like|should i\b|just let me)/i;

  const LEADING_EMOJI = /^(?:[\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])+\s*/;

  function stripInline(s) {
    return String(s || '')
      .replace(LEADING_EMOJI, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
  }

  function cleanHeading(s) {
    return stripInline(s).replace(/\s*:\s*$/, '').trim();
  }

  function sectionOf(text) {
    const t = cleanHeading(text);
    for (const [kind, re] of SECTION_PATTERNS) if (re.test(t)) return kind;
    return null;
  }

  function stripStepPrefix(text) {
    return text
      .replace(/^(?:step\s*)?\d{1,3}\s*[:.)\-–—]?\s*/i, '')
      .replace(/^[:.\-–—]\s*/, '')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Line classification

  const BULLET = /^(?:[-*+•·▪◦‣–]|\[[ xX]?\]|☐|▢|□)\s+(.*)$/;
  const CHECKBOX = /^(?:\[[ xX]?\]|☐|▢|□)\s+/;

  function classifyLine(raw) {
    const indent = (raw.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;
    const s = raw.trim();
    if (!s) return { type: 'blank' };
    if (/^(?:[-*_]\s*){3,}$/.test(s)) return { type: 'rule' };

    let m = s.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) return { type: 'heading', level: m[1].length, text: cleanHeading(m[2]), indent };

    // A line that is entirely bold reads as a sub-heading ("**For the sauce:**").
    m = s.match(/^(\*\*|__)(.+?)\1\s*:?\s*$/);
    if (m) return { type: 'heading', level: 7, text: cleanHeading(m[2]), indent };

    // "**1.** Text", "**1. Make the sauce:** Text"
    m = s.match(/^(\*\*|__)(\d{1,3})[.)]\s*(.*)$/);
    if (m) {
      let rest = m[3];
      if (rest.startsWith(m[1])) rest = rest.slice(2).trim();
      else if (rest.includes(m[1])) rest = m[1] + rest;
      return { type: 'numbered', num: +m[2], text: rest.trim(), indent };
    }
    // "1. Text", "1) Text"
    m = s.match(/^(\d{1,3})[.)]\s+(.+)$/);
    if (m) return { type: 'numbered', num: +m[1], text: m[2].trim(), indent };
    // "Step 1: Text", "**Step 1:** Text"
    m = s.match(/^(?:\*\*|__)?step\s*(\d{1,3})\s*[:.)\-–—]?\s*(?:\*\*|__)?\s*[:.\-–—]?\s*(.+)$/i);
    if (m) return { type: 'numbered', num: +m[1], text: m[2].trim(), indent };

    m = s.match(BULLET);
    if (m) return { type: 'bullet', text: m[1].replace(CHECKBOX, '').trim(), indent };

    // A short plain line ending in a colon reads as a sub-heading ("For the sauce:"),
    // unless it starts with an amount.
    if (/:\s*$/.test(s) && s.length <= 60 && !/^[\d½⅓⅔¼¾⅛⅜⅝⅞]/.test(s)) {
      return { type: 'heading', level: 7, text: cleanHeading(s), indent, weak: true };
    }
    // A bare section word on its own line ("Ingredients", "Directions") from a
    // plain-text copy of the chat.
    if (s.length <= 40 && !/[.!?]$/.test(s) && sectionOf(s)) {
      return { type: 'heading', level: 7, text: cleanHeading(s), indent };
    }
    return { type: 'text', text: s, indent };
  }

  // ---------------------------------------------------------------------------
  // Servings and times ("Serves: 4 | Prep: 15 min | Cook: 30 min")

  const META_PATTERNS = [
    ['servings', /^(?:serves|servings|serving size|yield|yields|makes|portions)\b\s*:?\s*(.+)$/i],
    ['servings', /^(\d+(?:\s*(?:-|–|to)\s*\d+)?\s+(?:servings?|portions?|people))$/i],
    ['prepTime', /^(?:prep(?:aration)?|active)(?:\s+time)?\b\s*:?\s*(.+)$/i],
    ['cookTime', /^(?:cook(?:ing)?|bake|baking|roast(?:ing)?)(?:\s+time)?\b\s*:?\s*(.+)$/i],
    ['totalTime', /^total(?:\s+time)?\b\s*:?\s*(.+)$/i],
  ];
  const META_SPLIT = /\s*(?:\||•|·|;|\s[—–]\s)\s*|,\s*(?=(?:prep|cook|total|serves|servings|yield|makes|bake|active)\b)/i;

  function cleanMetaValue(v) {
    return stripInline(v).replace(/^[:\s]+/, '').replace(/[.\s*_]+$/, '').trim();
  }

  // Reads a line that is only servings/time facts. Returns the facts found, or
  // null when the line is anything else (a sentence, an ingredient).
  function readMeta(text) {
    const plain = stripInline(text);
    if (!plain || plain.length > 160) return null;
    const segments = plain.split(META_SPLIT).map((x) => x.replace(LEADING_EMOJI, '').trim()).filter(Boolean);
    const found = {};
    let matched = 0;
    for (const seg of segments) {
      let hit = false;
      for (const [key, re] of META_PATTERNS) {
        const m = seg.match(re);
        if (!m) continue;
        const value = cleanMetaValue(m[1]);
        if (!/\d/.test(value) || value.length > 40) continue;
        if (!found[key]) found[key] = value;
        hit = true;
        break;
      }
      if (hit) { matched++; continue; }
      // Tolerate other short "Label: value" facts on the same line (Difficulty: Easy).
      if (!/^[A-Za-z][A-Za-z ]{1,20}:\s*\S.{0,30}$/.test(seg)) return null;
    }
    return matched ? found : null;
  }

  function applyMeta(r, found) {
    for (const k of Object.keys(found)) if (!r[k]) r[k] = found[k];
  }

  // ---------------------------------------------------------------------------
  // Parsing

  function normalize(input) {
    return String(input || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\u2044/g, '/')
      .replace(/[\u2028\u2029]/g, '\n');
  }

  function parseRecipe(input) {
    const lines = normalize(input).split('\n').map(classifyLine);
    const r = {
      title: '', description: '', servings: '', prepTime: '', cookTime: '', totalTime: '',
      ingredients: [], steps: [], notes: [],
    };
    const intro = [];
    let section = 'intro';
    let sectionLevel = 99;
    let group = null;

    const startGroup = (list, title) => {
      group = { title: title || '', items: [] };
      list.push(group);
      return group;
    };
    const currentGroup = (list) => (group && list.includes(group) ? group : startGroup(list, ''));

    for (const L of lines) {
      if (L.type === 'blank' || L.type === 'rule') continue;

      if (L.type === 'heading') {
        const kind = sectionOf(L.text);
        if (kind) {
          section = kind;
          sectionLevel = L.level;
          group = null;
          if (kind === 'notes') {
            // Keep the heading's own name ("Storage", "Tips").
            startGroup(r.notes, /^notes?$/i.test(L.text) ? '' : L.text);
          }
          const paren = L.text.match(/\(([^)]*\d[^)]*)\)/);
          if (paren && kind === 'ingredients' && !r.servings) {
            const v = paren[1].replace(/^(?:serves|for|makes)\s*/i, '').trim();
            if (v) r.servings = v;
          }
          continue;
        }
        if (section === 'intro') {
          if (!r.title && !CHATTER.test(L.text) && !readMeta(L.text)) r.title = L.text;
          else if (readMeta(L.text)) applyMeta(r, readMeta(L.text));
          continue;
        }
        if (section === 'ingredients' || section === 'steps') {
          if (L.level <= 6 && L.level <= sectionLevel) {
            // A heading as big as "Ingredients" itself starts a new extra section.
            section = 'notes';
            sectionLevel = L.level;
            startGroup(r.notes, L.text);
            continue;
          }
          const title = section === 'steps' ? stripStepPrefix(L.text) : L.text;
          if (title) startGroup(r[section], title);
          continue;
        }
        // notes
        if (L.level <= 6 && L.level < sectionLevel) sectionLevel = L.level;
        startGroup(r.notes, L.text);
        continue;
      }

      const text = L.text;

      if (section === 'intro') {
        const meta = readMeta(text);
        if (meta) { applyMeta(r, meta); continue; }
        if (CHATTER.test(text) || SIGNOFF.test(text)) continue;
        if (!r.title && L.type === 'text' && text.length <= 80 && !/[.!?:]$/.test(text)) {
          r.title = stripInline(text);
          continue;
        }
        intro.push({ type: L.type, text });
        continue;
      }

      if (L.type === 'text' && SIGNOFF.test(text)) continue;
      const meta = readMeta(text);
      if (meta) { applyMeta(r, meta); continue; }

      if (section === 'ingredients') {
        currentGroup(r.ingredients).items.push(text);
      } else if (section === 'steps') {
        const g = currentGroup(r.steps);
        const isContinuation = L.indent >= 2 && L.type !== 'numbered' && g.items.length > 0;
        if (isContinuation) {
          const piece = L.type === 'bullet' ? '• ' + text : text;
          g.items[g.items.length - 1] += '\n' + piece;
        } else {
          g.items.push(text);
        }
      } else {
        currentGroup(r.notes).items.push(text);
      }
    }

    // No section headings at all: bullets are probably ingredients and the
    // numbered list is probably the directions.
    if (!r.ingredients.length && !r.steps.length) {
      const bullets = intro.filter((x) => x.type === 'bullet').map((x) => x.text);
      const numbered = intro.filter((x) => x.type === 'numbered').map((x) => x.text);
      if (bullets.length || numbered.length) {
        if (bullets.length) r.ingredients.push({ title: '', items: bullets });
        if (numbered.length) r.steps.push({ title: '', items: numbered });
        for (let i = intro.length - 1; i >= 0; i--) if (intro[i].type !== 'text') intro.splice(i, 1);
      }
    }

    r.description = intro.map((x) => x.text).join('\n').trim();
    r.title = stripInline(r.title);
    for (const key of ['ingredients', 'steps', 'notes']) {
      r[key] = r[key]
        .map((g) => ({ title: g.title.trim(), items: g.items.map((x) => x.trim()).filter(Boolean) }))
        .filter((g) => g.items.length);
    }
    return r;
  }

  function checkRecipe(r) {
    const problems = [];
    if (!r.title) problems.push('No title found. Put the recipe name on the first line.');
    if (!countItems(r.ingredients)) problems.push('No ingredients found. List them under an "Ingredients" heading.');
    if (!countItems(r.steps)) problems.push('No directions found. Number them under a "Directions" heading.');
    return problems;
  }

  function countItems(groups) {
    return (groups || []).reduce((n, g) => n + (g.items ? g.items.length : 0), 0);
  }

  // ---------------------------------------------------------------------------
  // Writing a recipe back out as Markdown

  function toMarkdown(r) {
    const out = ['# ' + (r.title || 'Untitled recipe')];
    if (r.description) out.push('', r.description);
    const meta = [];
    if (r.servings) meta.push((/^\d+(?:\s*(?:-|–|to)\s*\d+)?$/.test(r.servings) ? 'Serves: ' : 'Makes: ') + r.servings);
    if (r.prepTime) meta.push('Prep: ' + r.prepTime);
    if (r.cookTime) meta.push('Cook: ' + r.cookTime);
    if (r.totalTime) meta.push('Total: ' + r.totalTime);
    if (meta.length) out.push('', meta.join(' | '));

    if (countItems(r.ingredients)) {
      out.push('', '## Ingredients');
      for (const g of r.ingredients) {
        if (g.title) out.push('', '### ' + g.title);
        out.push('');
        for (const item of g.items) out.push('- ' + item);
      }
    }
    if (countItems(r.steps)) {
      out.push('', '## Directions');
      let n = 1;
      for (const g of r.steps) {
        if (g.title) out.push('', '### ' + g.title);
        out.push('');
        for (const item of g.items) {
          const [first, ...rest] = String(item).split('\n');
          out.push(n++ + '. ' + first);
          for (const line of rest) out.push('   ' + line.replace(/^•\s*/, '- '));
        }
      }
    }
    for (const g of r.notes || []) {
      if (!g.items.length) continue;
      out.push('', '## ' + (g.title || 'Notes'), '');
      for (const item of g.items) out.push('- ' + item);
    }
    return out.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // Amounts: finding and scaling

  const FRACTIONS = {
    '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5,
    '⅘': 4 / 5, '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
  };
  const UF = Object.keys(FRACTIONS).join('');
  const NUM_SRC = '\\d+\\s*[' + UF + ']|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|[' + UF + ']|\\d*\\.\\d+|\\d+';
  const QTY_RE = new RegExp('(' + NUM_SRC + ')(?:\\s*(?:-|–|—|to)\\s*(' + NUM_SRC + '))?', 'g');

  const UNIT_WORDS = [
    'fluid ounces?', 'fl\\.? ?oz',
    'cups?', 'tablespoons?', 'tbsps?', 'tbs', 'tbl', 'teaspoons?', 'tsps?',
    'ounces?', 'oz', 'pounds?', 'lbs?', 'kilograms?', 'kgs?', 'kilos?', 'milligrams?', 'mg', 'grams?', 'g',
    'milliliters?', 'millilitres?', 'ml', 'centiliters?', 'centilitres?', 'cl', 'liters?', 'litres?', 'l',
    'quarts?', 'qts?', 'pints?', 'pts?', 'gallons?', 'gal',
    'sticks?', 'cloves?', 'cans?', 'tins?', 'jars?', 'packages?', 'pkgs?', 'packets?', 'cartons?', 'blocks?',
    'bunch(?:es)?', 'heads?', 'sprigs?', 'pinch(?:es)?', 'dash(?:es)?', 'handfuls?', 'stalks?', 'ribs?',
    'fillets?', 'bottles?', 'bags?', 'box(?:es)?', 'envelopes?', 'scoops?', 'drops?', 'splash(?:es)?',
    'knobs?', 'dozen', 'bulbs?',
    // count nouns: highlighted with the number, but in directions they only scale
    // when an ingredient name follows ("4 slices bacon", not "cut into 4 slices")
    'slices?', 'pieces?', 'sheets?', 'strips?', 'leaves', 'leaf', 'links?', 'ears?',
  ];
  const UNIT_RE = new RegExp('^\\s*(' + UNIT_WORDS.join('|') + ')(?![A-Za-z])', 'i');
  const COUNT_NOUN_RE = /^(?:slices?|pieces?|sheets?|strips?|leaves|leaf|links?|ears?)$/i;
  const CONTAINER_RE = /^(?:cans?|tins?|jars?|packages?|pkgs?|packets?|cartons?|blocks?|bottles?|bags?|box(?:es)?|envelopes?)$/i;
  const METRIC_RE = /^(?:kilograms?|kgs?|kilos?|milligrams?|mg|grams?|g|milliliters?|millilitres?|ml|centiliters?|centilitres?|cl|liters?|litres?|l)$/i;
  const NOT_AN_AMOUNT = /^\s*(?:minutes?|mins?\b|hours?|hrs?\b|seconds?|secs?\b|days?\b|weeks?\b|months?\b|inch(?:es)?\b|in\.|"|”|cm\b|mm\b|centimet|millimet|feet\b|foot\b|ft\b|times\b|batch|layers?\b|rounds?\b|sides?\b|stages?\b|steps?\b)/i;

  const PLURALS = {
    cup: 'cups', tablespoon: 'tablespoons', teaspoon: 'teaspoons', ounce: 'ounces', pound: 'pounds',
    gram: 'grams', kilogram: 'kilograms', milligram: 'milligrams', liter: 'liters', litre: 'litres',
    milliliter: 'milliliters', millilitre: 'millilitres', quart: 'quarts', pint: 'pints', gallon: 'gallons',
    stick: 'sticks', clove: 'cloves', can: 'cans', tin: 'tins', jar: 'jars', package: 'packages',
    packet: 'packets', carton: 'cartons', block: 'blocks', bunch: 'bunches', head: 'heads', sprig: 'sprigs',
    pinch: 'pinches', dash: 'dashes', handful: 'handfuls', stalk: 'stalks', rib: 'ribs', fillet: 'fillets',
    bottle: 'bottles', bag: 'bags', box: 'boxes', envelope: 'envelopes', scoop: 'scoops', drop: 'drops',
    splash: 'splashes', knob: 'knobs', bulb: 'bulbs', slice: 'slices', piece: 'pieces', sheet: 'sheets',
    strip: 'strips', leaf: 'leaves', link: 'links', ear: 'ears',
  };
  const SINGULARS = {};
  for (const k of Object.keys(PLURALS)) SINGULARS[PLURALS[k]] = k;

  const STOP_WORDS = new Set((
    'and or the for with of to taste plus more about into cut divided optional room temperature fresh freshly ' +
    'chopped diced minced sliced large small medium whole finely roughly thinly packed softened melted cold warm ' +
    'hot ground peeled grated shredded cubed halved quartered drained rinsed trimmed pitted seeded crushed beaten ' +
    'lightly firmly loosely extra virgin good quality plain unsalted salted boneless skinless garnish needed such ' +
    'like from your any other each per serving servings can cans jar jars cup cups tablespoon tablespoons tbsp ' +
    'teaspoon teaspoons tsp ounce ounces pound pounds gram grams inch inches piece pieces slice slices sheet ' +
    'sheets strip strips leaf leaves stick sticks clove cloves bunch head heads sprig sprigs pinch dash handful ' +
    'package packages bottle bag box well very also use used using reserved additional serve'
  ).split(' '));

  function singular(w) {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
    if (w.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }

  // Words that name ingredients, so a bare count in the directions
  // ("crack 2 eggs") can be recognised as an amount.
  function ingredientWords(groups) {
    const words = new Set();
    for (const g of groups || []) {
      for (const item of g.items || []) {
        const tokens = stripInline(item).toLowerCase().match(/[a-z]+/g) || [];
        for (const t of tokens) {
          if (t.length < 3 || STOP_WORDS.has(t)) continue;
          words.add(t);
          words.add(singular(t));
        }
      }
    }
    return words;
  }

  function parseNum(raw) {
    const s = String(raw).trim();
    let m = s.match(new RegExp('^(\\d+)\\s*([' + UF + '])$'));
    if (m) return +m[1] + FRACTIONS[m[2]];
    m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (m) return +m[1] + +m[2] / +m[3];
    m = s.match(/^(\d+)\/(\d+)$/);
    if (m) return +m[1] / +m[2];
    if (FRACTIONS[s] != null) return FRACTIONS[s];
    return parseFloat(s);
  }

  const NICE_FRACTIONS = [
    [0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'],
    [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, ''],
  ];

  function formatNumber(n, style) {
    if (!isFinite(n)) return '';
    if (style === 'decimal') {
      if (n >= 10) return String(Math.round(n));
      return String(Math.round(n * 100) / 100);
    }
    if (style === 'metric') {
      if (n >= 100) return String(Math.round(n / 5) * 5);
      if (n >= 10) return String(Math.round(n));
      return String(Math.round(n * 10) / 10);
    }
    if (n > 0 && n < 1 / 16) return String(Math.round(n * 100) / 100);
    let whole = Math.floor(n + 1e-9);
    const frac = n - whole;
    const choices = whole >= 10 ? NICE_FRACTIONS.filter((x) => [0, 0.5, 1].includes(x[0])) : NICE_FRACTIONS;
    let best = choices[0];
    for (const c of choices) if (Math.abs(c[0] - frac) < Math.abs(best[0] - frac)) best = c;
    if (best[0] === 1) { whole += 1; best = choices[0]; }
    if (!whole && !best[1]) return '0';
    return (whole ? String(whole) : '') + best[1];
  }

  function adjustUnit(unit, value) {
    const lower = unit.toLowerCase();
    let next = null;
    if (value > 1 && PLURALS[lower]) next = PLURALS[lower];
    else if (value <= 1 && SINGULARS[lower]) next = SINGULARS[lower];
    if (!next) return unit;
    return unit[0] === unit[0].toUpperCase() ? next[0].toUpperCase() + next.slice(1) : next;
  }

  function nextWordsNameIngredient(after, words) {
    if (!words || !words.size) return false;
    const clause = after.split(/[.;:,()!?]/)[0].toLowerCase();
    const tokens = (clause.match(/[a-z]+/g) || []).slice(0, 4);
    return tokens.some((w) => words.has(w) || words.has(singular(w)));
  }

  /* Finds the amounts in one line of text.
   *   mode 'ingredient': every amount counts ("3 eggs", "juice of 1 lemon").
   *   mode 'step': an amount counts when it has a measuring unit ("2 tbsp") or
   *   names an ingredient ("2 eggs"), so oven temperatures, times, pan sizes
   *   and "cut into 4 pieces" are left alone.
   * Returns [{start, end, numEnd, lo, hi, rawNum, sep, unitText, unit, style}]. */
  function findQuantities(text, opts) {
    const mode = (opts && opts.mode) || 'ingredient';
    const words = opts && opts.words;
    const found = [];
    let skipUntil = -1;
    QTY_RE.lastIndex = 0;
    let m;
    while ((m = QTY_RE.exec(text))) {
      const start = m.index;
      const numEnd = start + m[0].length;
      if (start < skipUntil) continue;
      const prev = start > 0 ? text[start - 1] : '';
      if (/[A-Za-z0-9./#×]/.test(prev)) continue;
      const after = text.slice(numEnd);
      if (/^-[A-Za-z]/.test(after)) continue; // 14-ounce, 1-inch: a size, not an amount
      if (/^\s*(?:x|×)\s*\d/i.test(after)) continue; // 9x13 pan
      if (/^\s*(?:°|º|˚|degrees?\b|deg\b)/i.test(after)) continue;
      if (/^\s*[CF]\b/.test(after)) continue;
      if (/^\s*%/.test(after)) continue;
      if (NOT_AN_AMOUNT.test(after)) continue;

      const lo = parseNum(m[1]);
      const hi = m[2] ? parseNum(m[2]) : null;
      if (!isFinite(lo) || (hi != null && !isFinite(hi))) continue;

      const um = after.match(UNIT_RE);
      const unit = um ? um[1] : '';
      const unitText = um ? um[0] : '';
      const end = numEnd + unitText.length;

      // "1 (14-ounce) can", "1 can (15 oz)": the size in brackets is per package.
      const rest = text.slice(end);
      if ((!unit || CONTAINER_RE.test(unit)) && /^\s*\(/.test(rest)) {
        const close = text.indexOf(')', end);
        if (close > 0) skipUntil = close;
      }

      let counts;
      if (mode === 'ingredient') counts = true;
      else if (unit && !COUNT_NOUN_RE.test(unit)) counts = true;
      else counts = nextWordsNameIngredient(rest, words);
      if (!counts) continue;

      const sep = m[2] ? m[0].slice(m[1].length, m[0].length - m[2].length) : '';
      let style = 'fraction';
      if (METRIC_RE.test(unit)) style = 'metric';
      else if (/\./.test(m[0])) style = 'decimal';
      found.push({ start, end, numEnd, lo, hi, rawNum: m[0], sep, unitText, unit, style });
    }
    return found;
  }

  // The text for one amount after multiplying by `factor`.
  function scaleQuantity(q, factor) {
    if (factor === 1) return q.rawNum + q.unitText;
    const lo = q.lo * factor;
    const hi = q.hi != null ? q.hi * factor : null;
    let num = formatNumber(lo, q.style);
    if (hi != null) num += q.sep + formatNumber(hi, q.style);
    let unitText = q.unitText;
    if (q.unit) {
      const lead = unitText.slice(0, unitText.length - q.unit.length);
      unitText = lead + adjustUnit(q.unit, hi != null ? hi : lo);
    }
    return num + unitText;
  }

  // Splits text into plain and amount pieces: [{text, qty?: {original, scaled}}].
  function splitAmounts(text, opts) {
    const factor = (opts && opts.factor) || 1;
    const pieces = [];
    let at = 0;
    for (const q of findQuantities(text, opts)) {
      if (q.start > at) pieces.push({ text: text.slice(at, q.start) });
      const original = text.slice(q.start, q.end);
      const scaled = scaleQuantity(q, factor);
      pieces.push({ text: scaled, qty: { original, scaled, changed: scaled !== original } });
      at = q.end;
    }
    if (at < text.length) pieces.push({ text: text.slice(at) });
    return pieces;
  }

  function scaleText(text, opts) {
    return splitAmounts(text, opts).map((p) => p.text).join('');
  }

  /* Splits one line into styled pieces for native rendering: inline **bold** and
   * *italic* Markdown, plus amounts when `opts` is given.
   * Returns [{text, bold?, italic?, qty?: {original, scaled, changed}}]. */
  function inlinePieces(text, opts) {
    const src = String(text || '')
      .replace(/\[([^\]]+)\]\((?:https?:)[^)\s]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    const runs = [];
    const re = /\*\*(.+?)\*\*|__(.+?)__|(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g;
    let at = 0;
    let m;
    while ((m = re.exec(src))) {
      let start = m.index;
      let inner;
      let style;
      if (m[1] != null) { inner = m[1]; style = 'bold'; }
      else if (m[2] != null) { inner = m[2]; style = 'bold'; }
      else { start += m[3].length; inner = m[4]; style = 'italic'; }
      if (start > at) runs.push({ text: src.slice(at, start) });
      runs.push({ text: inner, [style]: true });
      at = re.lastIndex;
    }
    if (at < src.length) runs.push({ text: src.slice(at) });

    const pieces = [];
    for (const run of runs) {
      const parts = opts ? splitAmounts(run.text, opts) : [{ text: run.text }];
      for (const p of parts) {
        const piece = { text: p.text };
        if (run.bold) piece.bold = true;
        if (run.italic) piece.italic = true;
        if (p.qty) piece.qty = p.qty;
        pieces.push(piece);
      }
    }
    return pieces;
  }

  function servingsNumber(servings) {
    const m = String(servings || '').match(/\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function slugify(title) {
    return String(title || 'recipe')
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'recipe';
  }

  return {
    parseRecipe, checkRecipe, toMarkdown, countItems,
    findQuantities, splitAmounts, scaleText, scaleQuantity, formatNumber, parseNum, inlinePieces,
    ingredientWords, servingsNumber, slugify, stripInline,
  };
});
