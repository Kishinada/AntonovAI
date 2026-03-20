const elements = {
  chatForm: document.querySelector("#chatForm"),
  clearButton: document.querySelector("#clearButton"),
  helperText: document.querySelector("#helperText"),
  messages: document.querySelector("#messages"),
  modelSelect: document.querySelector("#modelSelect"),
  promptInput: document.querySelector("#promptInput"),
  sendButton: document.querySelector("#sendButton"),
  statusPill: document.querySelector("#statusPill"),
};

const storageKeys = {
  messages: "gemini-browser-chat:v1",
  model: "gemini-browser-chat:model",
};

const state = {
  activeModel: "gemini-2.5-flash-lite",
  hasKey: false,
  isSending: false,
  messages: loadMessages(),
  model: "gemini-2.5-flash-lite",
  models: [],
  rateLimits: {},
  selectedModel: loadSelectedModel(),
};
let rateLimitTimerId = null;
const quickPrompts = [
  {
    title: "Написать код",
    prompt: "Напиши аккуратный пример кода и кратко объясни, как он работает.",
  },
  {
    title: "Разобрать ошибку",
    prompt: "Разбери мою ошибку по шагам и предложи точечный фикс.",
  },
  {
    title: "Составить план",
    prompt: "Составь понятный пошаговый план решения задачи.",
  },
  {
    title: "Придумать идею",
    prompt: "Придумай сильную идею проекта и оцени риски запуска.",
  },
];

boot();

async function boot() {
  render();
  autoResizeTextarea();

  elements.chatForm.addEventListener("submit", onSubmit);
  elements.clearButton.addEventListener("click", clearConversation);
  elements.messages.addEventListener("click", onMessagesClick);
  elements.modelSelect.addEventListener("change", onModelChange);
  elements.promptInput.addEventListener("keydown", onPromptKeyDown);
  elements.promptInput.addEventListener("input", autoResizeTextarea);

  await fetchConfig();
  render();
}

async function fetchConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const data = await response.json();
    state.model = typeof data.model === "string" ? data.model : state.model;
    state.models = normalizeModels(data.models, state.model);
    state.selectedModel = state.models.includes(state.selectedModel)
      ? state.selectedModel
      : state.model;
    state.activeModel = state.selectedModel;
    state.hasKey = Boolean(data.hasKey);
    persistSelectedModel();
  } catch (error) {
    state.hasKey = false;
    setStatus("Не удалось получить конфигурацию сервера.");
    elements.helperText.textContent = error.message;
  }
}

function onModelChange(event) {
  state.selectedModel = event.target.value;
  state.activeModel = state.selectedModel;
  persistSelectedModel();
  syncComposerState();
  render();
  elements.promptInput.focus();
}

function onMessagesClick(event) {
  const trigger = event.target.closest("[data-suggestion]");
  if (!trigger) {
    return;
  }

  elements.promptInput.value = trigger.dataset.suggestion || "";
  autoResizeTextarea();
  elements.promptInput.focus();
}

async function onSubmit(event) {
  event.preventDefault();

  const content = elements.promptInput.value.trim();
  if (!content || state.isSending || !state.hasKey || isRateLimited(state.selectedModel)) {
    return;
  }

  appendMessage({ role: "user", content });
  elements.promptInput.value = "";
  autoResizeTextarea();

  const placeholderId = appendMessage({
    role: "assistant",
    content: "",
    pending: true,
  });

  state.isSending = true;
  syncComposerState();
  setStatus("Ассистент думает...");
  elements.helperText.textContent = "Запрос отправлен на локальный сервер.";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: state.selectedModel,
        history: state.messages
          .filter((message) => !message.pending && !message.error)
          .map(({ role, content: text }) => ({ role, content: text })),
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "API returned an error.");
      error.retryAfterSeconds = data.retryAfterSeconds || null;
      error.model = data.model || state.model;
      error.quotaMetric = data.quotaMetric || null;
      error.quotaLimit = data.quotaLimit || null;
      throw error;
    }

    state.activeModel = data.activeModel || state.model;
    updateMessage(placeholderId, {
      content: data.reply,
      pending: false,
      error: false,
    });

    if (data.fallbackUsed) {
      elements.helperText.textContent = `Лимит основной модели достигнут, ответ получен от ${data.activeModel}.`;
    } else {
      elements.helperText.textContent = data.usageMetadata?.totalTokenCount
        ? `Всего токенов в последнем ответе: ${data.usageMetadata.totalTokenCount}.`
        : "Ответ получен.";
    }

    setStatus(`Активна: ${data.activeModel || data.modelVersion || state.selectedModel}`);
  } catch (error) {
    if (error.retryAfterSeconds) {
      applyRateLimit(error.retryAfterSeconds, error.model);
    }

    updateMessage(placeholderId, {
      content: formatErrorMessage(error),
      pending: false,
      error: true,
    });
    if (!error.retryAfterSeconds) {
      elements.helperText.textContent =
        "Если ключ уже публиковался открыто, его могли заблокировать. В таком случае создайте новый.";
      setStatus("Ошибка запроса");
    }
  } finally {
    state.isSending = false;
    syncComposerState();
    persistMessages();
    render();
  }
}

function onPromptKeyDown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
}

function clearConversation() {
  state.messages = [];
  persistMessages();
  render();
  setStatus(state.hasKey ? `Готово: ${state.selectedModel}` : "Нужен API-ключ");
  elements.helperText.textContent = "История чата очищена.";
}

function appendMessage(message) {
  const entry = {
    id: crypto.randomUUID(),
    role: message.role,
    content: message.content,
    pending: Boolean(message.pending),
    error: Boolean(message.error),
  };

  state.messages.push(entry);
  persistMessages();
  render();
  return entry.id;
}

function updateMessage(id, patch) {
  state.messages = state.messages.map((message) =>
    message.id === id ? { ...message, ...patch } : message,
  );
  persistMessages();
  render();
}

function render() {
  renderModelOptions();
  syncComposerState();

  if (!state.messages.length) {
    elements.messages.innerHTML = renderStarterBoard();
    return;
  }

  const starterBoard = state.messages.length < 4 ? renderStarterBoard("compact") : "";
  const renderedMessages = state.messages
    .map((message) => {
      const classes = [
        "message",
        `message--${message.role === "user" ? "user" : "assistant"}`,
        message.error ? "message--error" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const label = message.role === "user" ? "Вы" : "Antonov AI";
      const content = message.pending
        ? `<span class="typing"><span></span><span></span><span></span></span>`
        : renderMessageContent(message.content);

      return `
        <article class="${classes}">
          <span class="message__meta">${label}</span>
          <div class="message__bubble">${content}</div>
        </article>
      `;
    })
    .join("");

  elements.messages.innerHTML = `${starterBoard}${renderedMessages}`;

  if (state.messages.length < 4) {
    elements.messages.scrollTop = 0;
  } else {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }
}

function renderStarterBoard(mode = "full") {
  const modelLabel = escapeHtml(state.selectedModel || state.model);
  const suggestions = quickPrompts
    .map(
      (item) => `
        <button class="starter-card" type="button" data-suggestion="${escapeHtml(item.prompt)}">
          <span class="starter-card__title">${escapeHtml(item.title)}</span>
          <span class="starter-card__body">${escapeHtml(item.prompt)}</span>
        </button>
      `,
    )
    .join("");

  const compactClass = mode === "compact" ? " starter-board--compact" : "";

  return `
    <section class="starter-board${compactClass}">
      <div class="starter-board__hero">
        <p class="starter-board__eyebrow">Antonov AI</p>
        <h2>Быстрый старт</h2>
        <p class="starter-board__copy">Выберите сценарий или напишите свой запрос внизу.</p>
        <div class="starter-board__chips">
          <span>${modelLabel}</span>
          <span>Local proxy</span>
          <span>Code highlight</span>
        </div>
      </div>
      <div class="starter-board__actions">${suggestions}</div>
    </section>
  `;
}

function renderModelOptions() {
  const fragment = document.createDocumentFragment();

  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === state.selectedModel;
    fragment.append(option);
  }

  elements.modelSelect.replaceChildren(fragment);
  elements.modelSelect.disabled = state.isSending || !state.hasKey;
}

function syncComposerState() {
  const disabled = state.isSending || !state.hasKey || isRateLimited(state.selectedModel);
  elements.promptInput.disabled = disabled;
  elements.sendButton.disabled = disabled;
  elements.modelSelect.disabled = state.isSending || !state.hasKey;
  elements.sendButton.textContent = state.isSending ? "Отправка..." : "Отправить";

  if (!state.hasKey) {
    setStatus("Нужен API-ключ");
    elements.helperText.textContent =
      "Сервер не видит `GEMINI_API_KEY`. Добавьте его в `.env` или переменные окружения.";
  } else if (isRateLimited(state.selectedModel)) {
    const seconds = getRemainingRateLimitSeconds(state.selectedModel);
    setStatus(`Лимит ${state.selectedModel}: ${seconds} c`);
    elements.helperText.textContent = `Сервис просит повторить запрос через ${seconds} сек.`;
  } else if (!state.isSending) {
    setStatus(`Готово: ${state.selectedModel}`);
  }
}

function setStatus(text) {
  elements.statusPill.textContent = text;
}

function persistMessages() {
  const serializable = state.messages
    .filter((message) => !message.pending && !message.error)
    .map(({ id, role, content, error }) => ({ id, role, content, error }));

  localStorage.setItem(storageKeys.messages, JSON.stringify(serializable));
}

function loadMessages() {
  try {
    const raw = localStorage.getItem(storageKeys.messages);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((message) => message && typeof message === "object")
      .map((message) => ({
        id: typeof message.id === "string" ? message.id : crypto.randomUUID(),
        role: message.role === "assistant" ? "assistant" : "user",
        content: typeof message.content === "string" ? message.content : "",
        pending: false,
        error: Boolean(message.error),
      }))
      .filter((message) => message.content);
  } catch {
    return [];
  }
}

function persistSelectedModel() {
  localStorage.setItem(storageKeys.model, state.selectedModel);
}

function loadSelectedModel() {
  return localStorage.getItem(storageKeys.model) || "";
}

function normalizeModels(models, defaultModel) {
  const source = Array.isArray(models) ? models : [defaultModel];
  const uniqueModels = [];

  for (const model of source) {
    if (typeof model !== "string" || !model || uniqueModels.includes(model)) {
      continue;
    }

    uniqueModels.push(model);
  }

  if (!uniqueModels.includes(defaultModel)) {
    uniqueModels.unshift(defaultModel);
  }

  return uniqueModels;
}

function autoResizeTextarea() {
  elements.promptInput.style.height = "0px";
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 256)}px`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMessageContent(content) {
  const source = typeof content === "string" ? content : "";
  const parts = [];
  const fencePattern = /```([\w#+.-]*)[ \t]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const match of source.matchAll(fencePattern)) {
    const index = match.index ?? 0;
    const textChunk = source.slice(lastIndex, index);
    const renderedText = renderTextBlock(textChunk);
    if (renderedText) {
      parts.push(renderedText);
    }

    const language = normalizeLanguage(match[1] || "");
    const code = String(match[2] || "").replace(/\n$/, "");
    parts.push(renderCodeBlock(code, language));
    lastIndex = index + match[0].length;
  }

  const tail = renderTextBlock(source.slice(lastIndex));
  if (tail) {
    parts.push(tail);
  }

  if (!parts.length) {
    return renderTextBlock(source) || "";
  }

  return parts.join("");
}

function renderTextBlock(text) {
  const normalized = String(text || "").replace(/^\n+|\n+$/g, "");
  if (!normalized.trim()) {
    return "";
  }

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${renderInlineCode(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderInlineCode(text) {
  let html = "";
  let lastIndex = 0;
  const inlineCodePattern = /`([^`\n]+)`/g;

  for (const match of text.matchAll(inlineCodePattern)) {
    const index = match.index ?? 0;
    html += escapeHtml(text.slice(lastIndex, index));
    html += `<code class="inline-code">${escapeHtml(match[1])}</code>`;
    lastIndex = index + match[0].length;
  }

  html += escapeHtml(text.slice(lastIndex));
  return html;
}

function renderCodeBlock(code, language) {
  const safeLanguage = normalizeLanguage(language);
  const label = formatLanguageLabel(safeLanguage);
  const highlightedCode = highlightCode(code, safeLanguage);

  return `
    <div class="code-block">
      <div class="code-block__header">${escapeHtml(label)}</div>
      <pre><code class="code-block__content language-${escapeHtml(safeLanguage || "plain")}">${highlightedCode}</code></pre>
    </div>
  `;
}

function normalizeLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  if (!value) {
    return "";
  }

  const aliases = {
    cjs: "javascript",
    htm: "html",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
    zsh: "bash",
  };

  return aliases[value] || value;
}

function formatLanguageLabel(language) {
  if (!language) {
    return "CODE";
  }

  const labels = {
    bash: "BASH",
    css: "CSS",
    html: "HTML",
    javascript: "JAVASCRIPT",
    json: "JSON",
    markdown: "MARKDOWN",
    python: "PYTHON",
    sql: "SQL",
    typescript: "TYPESCRIPT",
    xml: "XML",
    yaml: "YAML",
  };

  return labels[language] || language.toUpperCase();
}

function highlightCode(code, language) {
  switch (language) {
    case "html":
    case "xml":
    case "svg":
      return highlightMarkup(code);
    case "css":
      return highlightCss(code);
    case "bash":
      return highlightShell(code);
    case "json":
      return highlightJson(code);
    default:
      return highlightGenericCode(code, language);
  }
}

function highlightMarkup(code) {
  return tokenizeCode(code, [
    {
      pattern: /<!--[\s\S]*?-->/g,
      render: (match) => wrapToken("comment", match),
    },
    {
      pattern: /<!DOCTYPE[^>]*>/gi,
      render: (match) => wrapToken("keyword", match),
    },
    {
      pattern: /<\/?[\w:-]+(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g,
      render: highlightMarkupTag,
    },
  ]);
}

function highlightMarkupTag(tag) {
  let html = escapeHtml(tag);
  html = html.replace(/^(&lt;\/?)/, '<span class="token operator">$1</span>');
  html = html.replace(
    /^<span class="token operator">&lt;\/?<\/span>([\w:-]+)/,
    '<span class="token operator">&lt;</span><span class="token keyword">$1</span>',
  );
  html = html.replace(
    /^<span class="token operator">&lt;<\/span>\/([\w:-]+)/,
    '<span class="token operator">&lt;/</span><span class="token keyword">$1</span>',
  );
  html = html.replace(
    /([\w:-]+)(=)(&quot;.*?&quot;|&#39;.*?&#39;|[^\s>]+)/g,
    '<span class="token property">$1</span><span class="token operator">$2</span><span class="token string">$3</span>',
  );
  html = html.replace(/(\/?&gt;)$/, '<span class="token operator">$1</span>');
  return html;
}

function highlightCss(code) {
  return tokenizeCode(code, [
    {
      pattern: /\/\*[\s\S]*?\*\//g,
      render: (match) => wrapToken("comment", match),
    },
    {
      pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
      render: (match) => wrapToken("string", match),
    },
    {
      pattern: /@[a-z-]+/gi,
      render: (match) => wrapToken("keyword", match),
    },
    {
      pattern: /#[0-9a-f]{3,8}\b/gi,
      render: (match) => wrapToken("number", match),
    },
    {
      pattern: /\b[\w-]+(?=\s*:)/g,
      render: (match) => wrapToken("property", match),
    },
    {
      pattern: /\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg)?\b/gi,
      render: (match) => wrapToken("number", match),
    },
  ]);
}

function highlightShell(code) {
  return tokenizeCode(code, [
    {
      pattern: /(^|\s)(#[^\n]*)/gm,
      render: (match, space = "", comment = "") =>
        `${escapeHtml(space)}${wrapToken("comment", comment)}`,
    },
    {
      pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
      render: (match) => wrapToken("string", match),
    },
    {
      pattern: /\$\{[^}]+\}|\$[A-Za-z_][\w]*/g,
      render: (match) => wrapToken("property", match),
    },
    {
      pattern: /\b(?:if|then|else|fi|for|in|do|done|case|esac|while|until|function|select|export|local|readonly)\b/g,
      render: (match) => wrapToken("keyword", match),
    },
    {
      pattern: /\b\d+(?:\.\d+)?\b/g,
      render: (match) => wrapToken("number", match),
    },
  ]);
}

function highlightJson(code) {
  return tokenizeCode(code, [
    {
      pattern: /"(?:\\.|[^"\\])*"(?=\s*:)/g,
      render: (match) => wrapToken("property", match),
    },
    {
      pattern: /"(?:\\.|[^"\\])*"/g,
      render: (match) => wrapToken("string", match),
    },
    {
      pattern: /\b(?:true|false|null)\b/g,
      render: (match) => wrapToken("keyword", match),
    },
    {
      pattern: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi,
      render: (match) => wrapToken("number", match),
    },
  ]);
}

function highlightGenericCode(code, language) {
  const keywordPattern = getKeywordPattern(language);
  const commentPattern = getCommentPattern(language);
  const stringPattern = getStringPattern(language);
  const rules = [];

  if (commentPattern) {
    rules.push({
      pattern: commentPattern,
      render: (...args) => renderCommentToken(language, ...args),
    });
  }

  rules.push({
    pattern: stringPattern,
    render: (match) => wrapToken("string", match),
  });

  if (keywordPattern) {
    rules.push({
      pattern: keywordPattern,
      render: (match) => wrapToken("keyword", match),
    });
  }

  rules.push(
    {
      pattern: /@[A-Za-z_][\w-]*/g,
      render: (match) => wrapToken("keyword", match),
    },
    {
      pattern: /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi,
      render: (match) => wrapToken("number", match),
    },
    {
      pattern: /\b[A-Za-z_$][\w$]*(?=\s*\()/g,
      render: (match) => wrapToken("function", match),
    },
  );

  return tokenizeCode(code, rules);
}

function getCommentPattern(language) {
  if (["python", "yaml", "ruby"].includes(language)) {
    return /(^|\s)(#[^\n]*)/gm;
  }

  if (language === "sql") {
    return /--[^\n]*|\/\*[\s\S]*?\*\//g;
  }

  return /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
}

function renderCommentToken(language, match, leadingSpace = "", comment = "") {
  if (["python", "yaml", "ruby"].includes(language)) {
    return `${escapeHtml(leadingSpace)}${wrapToken("comment", comment)}`;
  }

  return wrapToken("comment", match);
}

function getStringPattern(language) {
  if (language === "python") {
    return /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
  }

  return /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
}

function getKeywordPattern(language) {
  const keywordGroups = {
    javascript:
      "\\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|null|true|false)\\b",
    typescript:
      "\\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|implements|interface|type|enum|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|null|true|false|public|private|protected|readonly)\\b",
    python:
      "\\b(?:def|return|if|elif|else|for|while|in|not|and|or|class|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|True|False|None)\\b",
    ruby:
      "\\b(?:def|end|class|module|if|elsif|else|unless|do|while|until|begin|rescue|ensure|return|yield|super|self|true|false|nil)\\b",
    sql:
      "\\b(?:SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|LIMIT|AS|AND|OR|NOT|NULL|VALUES|CREATE|TABLE|ALTER|DROP|HAVING)\\b",
    yaml: "\\b(?:true|false|null|yes|no|on|off)\\b",
  };

  const pattern =
    keywordGroups[language] ||
    keywordGroups.javascript;

  return new RegExp(pattern, language === "sql" ? "g" : "g");
}

function tokenizeCode(code, rules) {
  let text = String(code || "");
  const tokens = [];

  for (const rule of rules) {
    text = text.replace(rule.pattern, (...args) => {
      const rendered = rule.render(...args);
      const marker = buildTokenMarker(tokens.length);
      tokens.push(rendered);
      return marker;
    });
  }

  let html = escapeHtml(text);
  for (let index = 0; index < tokens.length; index += 1) {
    html = html.replaceAll(buildTokenMarker(index), tokens[index]);
  }

  return html;
}

function buildTokenMarker(index) {
  return `\uE000${index}\uE000`;
}

function wrapToken(type, text) {
  return `<span class="token ${type}">${escapeHtml(String(text || ""))}</span>`;
}

function isRateLimited(model) {
  const targetModel = model || state.selectedModel;
  return Number(state.rateLimits[targetModel] || 0) > Date.now();
}

function getRemainingRateLimitSeconds(model) {
  const targetModel = model || state.selectedModel;
  const limitUntil = Number(state.rateLimits[targetModel] || 0);
  return Math.max(1, Math.ceil((limitUntil - Date.now()) / 1000));
}

function applyRateLimit(seconds, model) {
  const targetModel = model || state.selectedModel || state.model;
  state.rateLimits[targetModel] = Date.now() + Math.max(1, Math.ceil(seconds)) * 1000;
  syncComposerState();
  render();
  ensureRateLimitTicker();
}

function ensureRateLimitTicker() {
  if (rateLimitTimerId) {
    return;
  }

  rateLimitTimerId = window.setInterval(() => {
    const now = Date.now();
    let hasActiveLimits = false;
    let selectedModelExpired = false;

    for (const [model, expiresAt] of Object.entries(state.rateLimits)) {
      if (expiresAt > now) {
        hasActiveLimits = true;
        continue;
      }

      if (model === state.selectedModel) {
        selectedModelExpired = true;
      }

      delete state.rateLimits[model];
    }

    if (!hasActiveLimits) {
      clearInterval(rateLimitTimerId);
      rateLimitTimerId = null;
    }

    if (selectedModelExpired) {
      elements.helperText.textContent = "Лимит сброшен, можно отправлять новый запрос.";
    }

    syncComposerState();
  }, 1000);
}

function formatErrorMessage(error) {
  if (error.retryAfterSeconds) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterSeconds));
    const model = error.model || state.activeModel || state.model;
    let message = `Лимит для ${model} временно исчерпан. Повторите через ${seconds} сек.`;

    if (error.quotaLimit) {
      message += ` Текущий лимит: ${error.quotaLimit}.`;
    }

    return message;
  }

  return `Ошибка: ${error.message}`;
}
