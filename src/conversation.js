// Short-term memory of the current question/answer session.
//
// Every request used to be a single standalone user turn, so a follow-up like
// "now make it O(n)" or "explain line 12" had nothing to refer to — the model
// never saw its own previous answer. This keeps the last few exchanges.
//
// Two things are deliberately bounded:
//
//   • **Size.** The user turn of a mode like `assist` embeds the whole
//     transcript; replaying that verbatim on every request would grow the
//     prompt without limit. Both sides are clipped and only the last few
//     exchanges are kept.
//   • **Scope.** `leetcode` is documented as a context-free mode: no résumé,
//     no interview style rules, because a coding answer must stay strict.
//     Carrying interview history into it would undo that, and carrying code
//     history into "What should I say?" is just as wrong. So each mode
//     declares a scope, and switching scope drops the memory rather than
//     mixing the two. `any` (used by `ask` and `continue`) adopts whichever
//     scope is already open, which is what makes "make it O(n)" work as a
//     typed follow-up to a screenshot solve.

const DEFAULT_MAX_EXCHANGES = 3;
const DEFAULT_MAX_USER_CHARS = 1200;
const DEFAULT_MAX_ASSISTANT_CHARS = 6000;
const TRUNCATION_MARKER = '\n…[truncated]';

function clip(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATION_MARKER;
}

class ConversationMemory {
  constructor({
    maxExchanges = DEFAULT_MAX_EXCHANGES,
    maxUserChars = DEFAULT_MAX_USER_CHARS,
    maxAssistantChars = DEFAULT_MAX_ASSISTANT_CHARS
  } = {}) {
    this.maxExchanges = Math.max(0, maxExchanges);
    this.maxUserChars = maxUserChars;
    this.maxAssistantChars = maxAssistantChars;
    this.entries = [];
    this.scope = null;
  }

  /**
   * Open the memory for a mode's scope and return the turns it may see.
   * A scope change clears first, so nothing crosses between coding help and
   * interview help.
   */
  enter(scope) {
    if (scope && scope !== 'any') {
      if (this.scope && this.scope !== scope) this.clear();
      this.scope = scope;
    }
    return this.turns();
  }

  /**
   * Both halves or neither: a dangling user turn with no answer would break
   * providers that require strictly alternating roles (Anthropic), and an
   * answer with no question is not worth replaying.
   */
  record(userText, assistantText) {
    const user = clip(userText, this.maxUserChars);
    const assistant = clip(assistantText, this.maxAssistantChars);
    if (!user || !assistant) return this.turns();
    this.entries.push({ role: 'user', text: user }, { role: 'assistant', text: assistant });
    const maxEntries = this.maxExchanges * 2;
    if (this.entries.length > maxEntries) this.entries.splice(0, this.entries.length - maxEntries);
    return this.turns();
  }

  turns() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear() {
    this.entries = [];
    this.scope = null;
  }

  get exchanges() {
    return this.entries.length / 2;
  }
}

module.exports = {
  ConversationMemory,
  DEFAULT_MAX_EXCHANGES,
  DEFAULT_MAX_USER_CHARS,
  DEFAULT_MAX_ASSISTANT_CHARS
};
