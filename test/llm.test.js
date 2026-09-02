const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { OPTIONAL_API_KEY_PLACEHOLDER } = require('../src/openai-compatible');

let capturedClientOptions = null;
let capturedCompletionRequest = null;
// Set by a test to drive the fake stream; null means "one ordinary chunk".
let stubStreamChunks = null;
const originalModuleLoad = Module._load;

Module._load = function loadWithProviderStubs(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor(clientOptions) {
        capturedClientOptions = clientOptions;
        this.chat = {
          completions: {
            create: async (completionRequest) => {
              capturedCompletionRequest = completionRequest;
              return stubStreamChunks || [{ choices: [{ delta: { content: 'ok' } }] }];
            }
          }
        };
      }
    };
  }
  if (request === '@anthropic-ai/sdk') {
    return class FakeAnthropic {
      constructor(clientOptions) {
        capturedClientOptions = clientOptions;
        this.messages = {
          create: async (completionRequest) => {
            capturedCompletionRequest = completionRequest;
            return stubStreamChunks || [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }];
          }
        };
      }
    };
  }
  if (request === '@google/genai') {
    return {
      GoogleGenAI: class FakeGoogleGenAI {
        constructor(clientOptions) {
          capturedClientOptions = clientOptions;
          this.models = {
            generateContentStream: async (completionRequest) => {
              capturedCompletionRequest = completionRequest;
              return stubStreamChunks || [{ text: 'ok' }];
            }
          };
        }
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const {
  createLLM,
  formatProviderErrorMessage,
  isQuotaError,
  resolveMaxTokens,
  MAX_TOKENS_CEILING,
  CURRENT_GEMINI_DEFAULT
} = require('../src/llm');

test.after(() => {
  Module._load = originalModuleLoad;
});

function createCustomSettings(overrides = {}) {
  return {
    provider: 'custom',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' },
    models: { custom: { fast: 'openclaw/default', smart: 'openclaw/default' } },
    ...overrides
  };
}

test.beforeEach(() => {
  capturedClientOptions = null;
  capturedCompletionRequest = null;
  stubStreamChunks = null;
});

test('routes the Custom provider through the configured OpenAI-compatible endpoint', async () => {
  const receivedTokens = [];
  const llm = createLLM(createCustomSettings());

  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'openclaw/default');

  const response = await llm.stream({
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: (token) => receivedTokens.push(token)
  });

  assert.deepEqual(capturedClientOptions, {
    apiKey: 'gateway-token',
    baseURL: 'http://127.0.0.1:18789/v1'
  });
  assert.equal(capturedCompletionRequest.model, 'openclaw/default');
  assert.equal(response, 'ok');
  assert.deepEqual(receivedTokens, ['ok']);
});

test('allows an unauthenticated local Custom endpoint', async () => {
  const llm = createLLM(createCustomSettings({ apiKeys: { custom: '' } }));
  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, OPTIONAL_API_KEY_PLACEHOLDER);
});

test('does not apply the Custom Base URL to official OpenAI requests', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.deepEqual(capturedClientOptions, { apiKey: 'official-openai-key' });
});

test('reports incomplete Custom endpoint settings without making a request', () => {
  const llm = createLLM(createCustomSettings({ baseUrl: '' }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Base URL/);
  assert.equal(capturedClientOptions, null);
});

test('requires a model for the Custom provider', () => {
  const llm = createLLM(createCustomSettings({
    models: { custom: { fast: '', smart: '' } }
  }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Fast or Smart model/);
});

// ---- MiniMax (PR #22) -----------------------------------------------------
// MiniMax is OpenAI-compatible and region-split, so these assert the regional
// gateway selection rather than any new transport.

function minimaxSettings(overrides) {
  return Object.assign({
    provider: 'minimax',
    smart: true,
    apiKeys: { minimax: 'test-key' },
    models: { minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' } }
  }, overrides || {});
}

test('selects the MiniMax model for the active tier and reports readiness', () => {
  const smart = createLLM(minimaxSettings({ smart: true }));
  assert.equal(smart.provider, 'minimax');
  assert.equal(smart.model, 'MiniMax-M3');
  assert.equal(smart.ready, true);

  const fast = createLLM(minimaxSettings({ smart: false }));
  assert.equal(fast.model, 'MiniMax-M2.7');
});

test('routes MiniMax to the global OpenAI-compatible endpoint by default', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'global_en' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
  assert.equal(capturedClientOptions.apiKey, 'test-key');
});

test('routes MiniMax to the China endpoint when that region is selected', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'cn_zh' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimaxi.com/v1');
});

test('falls back to the global endpoint for an unknown region', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'unknown' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
});

// ---- Gemini 404/429 error mapping ------------------------------------------
// Reproduces the exact bug-report clusters: "Error: got status: 404 Not Found.
// {"error":{"message":"exception parsing response","code":404,"status":"Not
// Found"}}" (dead/misspelled model) and 429 quota exhaustion, and asserts they
// come out as actionable in-app messages instead of the raw provider JSON.

function geminiApiError({ status, body }) {
  const err = new Error(`got status: ${status}. ${JSON.stringify(body)}`);
  err.name = 'ApiError';
  err.status = status; // matches @google/genai's ApiError shape
  return err;
}

test('formatProviderErrorMessage: maps a Gemini 404 to an actionable "model unavailable" message', () => {
  const error = geminiApiError({
    status: 404,
    body: { error: { message: 'exception parsing response', code: 404, status: 'Not Found' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.0-flash');
  assert.match(message, /Gemini/);
  assert.match(message, /model "gemini-2\.0-flash"/);
  assert.match(message, /unavailable \(404\)/);
  assert.match(message, /Settings/);
  assert.doesNotMatch(message, /exception parsing response/);
});

test('formatProviderErrorMessage: 404 message still works without a model id', () => {
  const error = geminiApiError({ status: 404, body: { error: { message: 'not found', code: 404 } } });
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI model is unavailable \(404\)/);
});

test('formatProviderErrorMessage: maps a Gemini 429 to a free-tier quota message', () => {
  const error = geminiApiError({
    status: 429,
    body: { error: { message: 'You exceeded your current quota', code: 429, status: 'RESOURCE_EXHAUSTED' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.5-flash');
  assert.match(message, /Gemini free-tier quota exhausted \(429/);
  assert.match(message, /billing/);
  assert.doesNotMatch(message, /RESOURCE_EXHAUSTED/);
});

test('formatProviderErrorMessage: surfaces retry-after when the 429 body carries a RetryInfo delay', () => {
  const error = geminiApiError({
    status: 429,
    body: {
      error: {
        message: 'Resource exhausted',
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' }]
      }
    }
  });
  const message = formatProviderErrorMessage(error, 'gemini');
  assert.match(message, /Wait about 38s/);
});

test('formatProviderErrorMessage: 429 without a retry delay falls back to a generic wait hint', () => {
  const error = new Error('429 Too Many Requests');
  error.status = 429;
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /Wait a moment/);
});

test('formatProviderErrorMessage: an OpenAI-style quota 429 (no numeric status) is still recognized', () => {
  // Matches the literal text one of the bug reports pasted in.
  const error = new Error('429 You exceeded your current quota, please check your plan and billing details.');
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI free-tier quota exhausted/);
});

test('formatProviderErrorMessage: an unrecognized error passes its raw message through unchanged', () => {
  const error = new Error('socket hang up');
  assert.equal(formatProviderErrorMessage(error, 'anthropic'), 'socket hang up');
});

test('isQuotaError: agrees with formatProviderErrorMessage on what counts as quota', () => {
  assert.equal(isQuotaError(geminiApiError({ status: 429, body: {} })), true);
  assert.equal(isQuotaError(geminiApiError({ status: 404, body: {} })), false);
  assert.equal(isQuotaError(new Error('insufficient_quota')), true);
});

// ---- Gemini model selection / self-healing migration -----------------------

function geminiSettings(overrides) {
  return Object.assign({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: 'test-key' }
  }, overrides || {});
}

test('createLLM: falls back to CURRENT_GEMINI_DEFAULT when no model is configured', () => {
  const llm = createLLM(geminiSettings({ models: {} }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
  assert.equal(llm.ready, true);
});

test('createLLM: a fresh install (store.js DEFAULTS shape) resolves to the current default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a settings file saved with the retired gemini-2.0-flash default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a legacy gemini-1.5-* model saved before the 2.0-flash migration existed', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-1.5-flash', smart: 'gemini-1.5-pro' } },
    smart: true
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: leaves a user-chosen current Gemini model alone', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' } }
  }));
  assert.equal(llm.model, 'gemini-3.5-flash');
});

// ── Token budgets ───────────────────────────────────────────────────────────
// A LeetCode answer needs room for a whole program; the 700-token
// conversational default was cutting solutions off mid-code-block.

test('resolveMaxTokens: a usable mode budget wins over the tier default', () => {
  assert.equal(resolveMaxTokens(2500, 700), 2500);
});

test('resolveMaxTokens: anything unusable falls back to the tier default', () => {
  for (const bad of [undefined, null, '', 0, -1, NaN, 'lots', {}]) {
    assert.equal(resolveMaxTokens(bad, 700), 700, `expected fallback for ${JSON.stringify(bad)}`);
  }
});

test('resolveMaxTokens: clamps to the ceiling so one request cannot run away', () => {
  assert.equal(resolveMaxTokens(999999, 700), MAX_TOKENS_CEILING);
});

test('a per-mode token budget reaches the provider request', async () => {
  const llm = createLLM(createCustomSettings());
  await llm.stream({
    system: 'Solve it.',
    turns: [{ role: 'user', text: 'Solve the coding problem shown in the screenshot.' }],
    maxTokens: 2500,
    onToken: () => {}
  });
  assert.equal(capturedCompletionRequest.max_tokens, 2500);
});

test('a request without a mode budget keeps the tier default', async () => {
  const llm = createLLM(createCustomSettings());
  await llm.stream({ system: 'Hi.', turns: [{ role: 'user', text: 'Hi' }], onToken: () => {} });
  assert.equal(capturedCompletionRequest.max_tokens, 700);
});

// ── Truncation reporting ────────────────────────────────────────────────────
// Each provider spells "I stopped because I ran out of room" differently, and
// a cut-off answer is indistinguishable from a finished one without this.

test('OpenAI-compatible: reports a stream that stopped on length', async () => {
  stubStreamChunks = [
    { choices: [{ delta: { content: 'def solve(' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'nums):' }, finish_reason: 'length' }] }
  ];
  let truncated = false;
  const llm = createLLM(createCustomSettings());
  const text = await llm.stream({
    system: 'Solve it.',
    turns: [{ role: 'user', text: 'Solve' }],
    onToken: () => {},
    onTruncated: () => { truncated = true; }
  });
  assert.equal(text, 'def solve(nums):');
  assert.equal(truncated, true);
});

test('OpenAI-compatible: a normal stop is not reported as truncated', async () => {
  stubStreamChunks = [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }];
  let truncated = false;
  const llm = createLLM(createCustomSettings());
  await llm.stream({
    system: 'x', turns: [{ role: 'user', text: 'x' }],
    onToken: () => {}, onTruncated: () => { truncated = true; }
  });
  assert.equal(truncated, false);
});

test('Anthropic: reports max_tokens as truncation', async () => {
  stubStreamChunks = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
  ];
  let truncated = false;
  const llm = createLLM({
    provider: 'anthropic',
    smart: false,
    apiKeys: { anthropic: 'sk-ant-test' },
    models: { anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' } }
  });
  const text = await llm.stream({
    system: 'x', turns: [{ role: 'user', text: 'x' }],
    onToken: () => {}, onTruncated: () => { truncated = true; }
  });
  assert.equal(text, 'partial');
  assert.equal(truncated, true);
});

test('Anthropic: end_turn is not truncation', async () => {
  stubStreamChunks = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'complete' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
  ];
  let truncated = false;
  const llm = createLLM({
    provider: 'anthropic',
    smart: false,
    apiKeys: { anthropic: 'sk-ant-test' },
    models: { anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' } }
  });
  await llm.stream({
    system: 'x', turns: [{ role: 'user', text: 'x' }],
    onToken: () => {}, onTruncated: () => { truncated = true; }
  });
  assert.equal(truncated, false);
});

test('Gemini: reports MAX_TOKENS as truncation', async () => {
  stubStreamChunks = [
    { text: 'partial', candidates: [{ finishReason: null }] },
    { text: '', candidates: [{ finishReason: 'MAX_TOKENS' }] }
  ];
  let truncated = false;
  const llm = createLLM({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: 'AIza-test' },
    models: { gemini: { fast: CURRENT_GEMINI_DEFAULT, smart: CURRENT_GEMINI_DEFAULT } }
  });
  await llm.stream({
    system: 'x', turns: [{ role: 'user', text: 'x' }],
    onToken: () => {}, onTruncated: () => { truncated = true; }
  });
  assert.equal(truncated, true);
});

test('a stream without an onTruncated callback still completes', async () => {
  stubStreamChunks = [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'length' }] }];
  const llm = createLLM(createCustomSettings());
  const text = await llm.stream({ system: 'x', turns: [{ role: 'user', text: 'x' }], onToken: () => {} });
  assert.equal(text, 'ok');
});

// ── Missing-credential guidance ─────────────────────────────────────────────
// A user who puts GEMINI_API_KEY in a .env file gets no error from the file
// system and no key in the app — the message has to close that gap itself.

test('a missing key names the provider properly and says where the key goes', () => {
  const llm = createLLM({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: '' },
    models: { gemini: { fast: CURRENT_GEMINI_DEFAULT, smart: CURRENT_GEMINI_DEFAULT } }
  });

  assert.equal(llm.ready, false);
  // "Gemini", not the raw provider id "gemini".
  assert.match(llm.configurationError, /Gemini API key/);
  assert.match(llm.configurationError, /Settings → Keys/);
  assert.match(llm.configurationError, /environment variables or a \.env file/);
});

test('the missing-key message is provider-specific', () => {
  const azure = createLLM({
    provider: 'azure', smart: false, apiKeys: { azure: '' },
    models: { azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });
  assert.match(azure.configurationError, /Azure AI Foundry API key/);
});

test('Ollama is never asked for a key — its field holds a URL', () => {
  const llm = createLLM({
    provider: 'ollama', smart: false, apiKeys: { ollama: '' },
    models: { ollama: { fast: 'llama3.2', smart: 'llama3.3' } }
  });
  assert.equal(llm.ready, true);
  assert.equal(llm.configurationError, '');
});

test('DEFAULT_MODELS is exported and covers every provider the settings UI offers', () => {
  // The renderer shows these as the model placeholder, so a provider missing
  // here shows an empty box and the user cannot tell what to type.
  const { DEFAULT_MODELS } = require('../src/llm');
  for (const provider of ['openai', 'anthropic', 'gemini', 'ollama', 'groq', 'minimax', 'azure']) {
    assert.ok(DEFAULT_MODELS[provider], `DEFAULT_MODELS is missing ${provider}`);
  }
});
