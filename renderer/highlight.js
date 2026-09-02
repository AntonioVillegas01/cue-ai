/* Minimal syntax highlighter for cue's answer pane.
 *
 * No library and no CDN: the renderer runs under a strict CSP
 * (`script-src 'self'`, no external hosts), and the project inlines what it
 * needs rather than shipping a dependency — the same call icons.js makes with
 * lucide. A few hundred lines of code in an overlay panel does not need a
 * full grammar engine; it needs comments, strings, numbers and keywords to
 * stop looking like prose.
 *
 * SAFETY — read before editing.
 * Every character of the input goes through `escapeHtml` before it reaches the
 * output, and the only markup emitted is this file's own fixed
 * `<span class="tok-…">` tags. Model output is attacker-influenceable (it is
 * written from whatever is on the user's screen and in the meeting
 * transcript), so nothing here may ever interpolate model text into an
 * attribute, a tag name, or an unescaped position.
 *
 * Exposed as `window.HIGHLIGHT` for the renderer and as a CommonJS module so
 * the escaping rules above can be unit-tested without a browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HIGHLIGHT = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[c]));
  }

  // JavaScript, TypeScript, Node and React first — that is the stack this
  // panel is used against. The rest are kept because a problem is occasionally
  // posed in another language, and merging them is safe in practice: `def`
  // does not appear in TypeScript and `function` does not appear in Python, so
  // cross-language false positives are rare and cosmetic when they happen.
  //
  // Deliberately NOT keywords: `get`, `set` and `constructor`. They are far
  // more often ordinary identifiers in this stack (`const set = new Set()`),
  // and colouring those as keywords is worse than leaving them plain.
  const JS_TS_KEYWORDS =
    'as async await break case catch class const continue debugger default delete do else enum ' +
    'export extends false finally for from function if implements import in instanceof interface ' +
    'let new null of package private protected public readonly return static super switch this ' +
    'throw true try type typeof undefined var void while with yield ' +
    // TypeScript's type-level vocabulary.
    'abstract any asserts bigint boolean declare infer is keyof namespace never number object ' +
    'out override satisfies string symbol unique unknown';

  const OTHER_KEYWORDS =
    'and assert base bool byte chan char constexpr crate decimal def defer del double elif except ' +
    'extern final float fn func global go goto impl include init int internal lambda long loop ' +
    'match mod module mut nil none nonlocal not nullptr operator pass pub raise range rec ref ' +
    'sealed self short sizeof str struct synchronized template throws trait typedef union unsafe ' +
    'unsigned use using virtual volatile where';

  const KEYWORDS = new Set((JS_TS_KEYWORDS + ' ' + OTHER_KEYWORDS).split(/\s+/).filter(Boolean));

  // Languages where `#` starts a comment anywhere on the line. Elsewhere a
  // leading `#` is still treated as a comment (a line that begins with one is
  // a comment in every language that uses them), but a mid-line `#` is left
  // alone so JavaScript private fields and C# directives are not swallowed.
  const HASH_COMMENT_LANGS = /^(py|python|rb|ruby|sh|bash|zsh|shell|yaml|yml|toml|ini|r|pl|perl|make|makefile|dockerfile|conf)$/i;

  const TOKEN_RE = new RegExp([
    '(\\/\\*[\\s\\S]*?\\*\\/)',                 // 1 block comment
    '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\')', // 2 docstring
    '(\\/\\/[^\\n]*)',                           // 3 line comment
    '(#[^\\n]*)',                                // 4 hash comment (conditional)
    '("(?:\\\\[\\s\\S]|[^"\\\\\\n])*"' +
      '|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n])*\'' +
      '|`(?:\\\\[\\s\\S]|[^`\\\\])*`)',          // 5 string
    '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)', // 6 number
    '([A-Za-z_$][A-Za-z0-9_$]*)'                 // 7 identifier
  ].join('|'), 'g');

  /** Is this `#` the first non-whitespace character on its line? */
  function startsLine(code, index) {
    for (let i = index - 1; i >= 0; i--) {
      const c = code[i];
      if (c === '\n') return true;
      if (c !== ' ' && c !== '\t') return false;
    }
    return true;
  }

  /** Does an identifier ending at `index` read as a call? */
  function isCall(code, index) {
    for (let i = index; i < code.length; i++) {
      const c = code[i];
      if (c === ' ' || c === '\t') continue;
      return c === '(';
    }
    return false;
  }

  const span = (cls, text) => '<span class="' + cls + '">' + escapeHtml(text) + '</span>';

  /**
   * Turn source text into HTML-safe, highlighted markup.
   *
   * @param {string} code Raw code, exactly as the model wrote it.
   * @param {string} [lang] Language tag from the fence, if any.
   * @returns {string} Escaped HTML with token spans.
   */
  function highlightCode(code, lang) {
    const source = typeof code === 'string' ? code : '';
    if (!source) return '';
    const hashIsComment = HASH_COMMENT_LANGS.test(String(lang || ''));

    let out = '';
    let plainFrom = 0;
    let match;
    TOKEN_RE.lastIndex = 0;

    // Everything not claimed by a token is escaped and emitted verbatim, so no
    // input character can escape the sanitizer by falling between the cracks.
    const flushPlain = (upto) => {
      if (upto > plainFrom) out += escapeHtml(source.slice(plainFrom, upto));
    };

    while ((match = TOKEN_RE.exec(source)) !== null) {
      const [text, block, doc, line, hash, str, num, ident] = match;

      if (hash !== undefined && !hashIsComment && !startsLine(source, match.index)) {
        // A `#` that is not a comment here: emit it as plain text and resume
        // scanning right after it, so the rest of the line is tokenized.
        flushPlain(match.index + 1);
        plainFrom = match.index + 1;
        TOKEN_RE.lastIndex = match.index + 1;
        continue;
      }

      flushPlain(match.index);

      if (block !== undefined || doc !== undefined || line !== undefined || hash !== undefined) {
        out += span('tok-com', text);
      } else if (str !== undefined) {
        out += span('tok-str', text);
      } else if (num !== undefined) {
        out += span('tok-num', text);
      } else if (ident !== undefined) {
        if (KEYWORDS.has(ident)) out += span('tok-kw', text);
        // Capitalised identifiers are types, classes and — the reason this
        // exists — React components, so `<Button>` and `new Map()` read as
        // what they are. Checked before the call test on purpose: `Map(` is a
        // type being constructed, not a function being called.
        else if (/^[A-Z]/.test(ident)) out += span('tok-type', text);
        else if (isCall(source, match.index + text.length)) out += span('tok-fn', text);
        else out += escapeHtml(text);
      } else {
        out += escapeHtml(text);
      }

      plainFrom = match.index + text.length;
    }

    flushPlain(source.length);
    return out;
  }

  return { highlightCode, escapeHtml };
});
