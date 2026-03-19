"use strict";

const fs = require("node:fs");
const { readFile } = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

loadEnvFile(path.join(__dirname, ".env"));

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_SYSTEM_PROMPT =
  process.env.GEMINI_SYSTEM_PROMPT ||
  "You are Antonov AI. If the user asks who you are, answer briefly that you are Antonov AI. Do not mention ownership, creators, or configuration unless the user explicitly asks for technical implementation details. Reply in the user's language unless they ask otherwise.";
const DEFAULT_CHAT_MODELS = dedupeModels([
  GEMINI_MODEL,
  GEMINI_FALLBACK_MODEL,
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
  "gemini-pro-latest",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
]);
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_SIZE = 1024 * 1024;
const MAX_HISTORY_MESSAGES = 24;
let availableModelsCache = {
  expiresAt: 0,
  models: DEFAULT_CHAT_MODELS,
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

startServer(PORT);

function createServer(port) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || `${HOST}:${port}`}`,
      );

      if (request.method === "GET" && url.pathname === "/api/config") {
        return handleConfigRequest(response);
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        return handleChatRequest(request, response);
      }

      if (request.method === "GET") {
        return serveStaticFile(url.pathname, response);
      }

      return sendJson(response, 405, { error: "Method not allowed." });
    } catch (error) {
      console.error("Unexpected server error:", error);
      return sendJson(response, 500, { error: "Unexpected server error." });
    }
  });
}

function startServer(initialPort) {
  const maxAttempts = 20;
  listenOnAvailablePort(initialPort, maxAttempts);
}

function listenOnAvailablePort(port, attemptsRemaining) {
  const server = createServer(port);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsRemaining > 1) {
      console.warn(`Port ${port} is busy. Trying ${port + 1}...`);
      listenOnAvailablePort(port + 1, attemptsRemaining - 1);
      return;
    }

    console.error(`Could not start server on port ${port}:`, error.message);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const localhostUrl = `http://localhost:${port}`;
    const boundUrl = `http://${HOST}:${port}`;

    console.log(`Gemini chat is running on ${localhostUrl}`);
    if (HOST !== "localhost" && HOST !== "127.0.0.1") {
      console.log(`Bound address: ${boundUrl}`);
    }
  });
}

async function handleChatRequest(request, response) {
  if (!GEMINI_API_KEY) {
    return sendJson(response, 500, {
      error: "Missing GEMINI_API_KEY. Add it to .env or your environment variables.",
    });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { error: error.message });
  }

  const contents = normalizeConversation(body?.history);
  const availableModels = await getAvailableChatModels();
  const requestedModel = pickRequestedModel(body?.model, availableModels);
  if (!contents.length) {
    return sendJson(response, 400, { error: "Chat history is empty." });
  }

  const lastMessage = contents.at(-1);
  if (!lastMessage || lastMessage.role !== "user") {
    return sendJson(response, 400, {
      error: "The last message in history must be a user message.",
    });
  }

  const payload = {
    system_instruction: {
      parts: [{ text: GEMINI_SYSTEM_PROMPT }],
    },
    contents,
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.8,
      topP: 0.95,
    },
  };

  let geminiResult = await requestGemini(requestedModel, payload);
  let fallbackUsed = false;

  if (shouldRetryWithFallback(geminiResult, availableModels)) {
    const fallbackResult = await requestGemini(GEMINI_FALLBACK_MODEL, payload);
    if (fallbackResult.ok) {
      geminiResult = fallbackResult;
      fallbackUsed = true;
    }
  }

  if (!geminiResult.ok) {
    return sendJson(response, geminiResult.status, {
      error: geminiResult.errorMessage || "Gemini API request failed.",
      retryAfterSeconds: geminiResult.retryAfterSeconds,
      quotaMetric: geminiResult.quotaMetric,
      quotaLimit: geminiResult.quotaLimit,
      model: geminiResult.model,
      details: geminiResult.rawText,
    });
  }

  const reply = extractReplyText(geminiResult.result);
  if (!reply) {
    const blockReason = geminiResult.result?.promptFeedback?.blockReason;
    return sendJson(response, 502, {
      error: blockReason
        ? `Prompt blocked by Gemini: ${blockReason}.`
        : "Gemini returned an empty response.",
      model: geminiResult.model,
      details: geminiResult.result,
    });
  }

  return sendJson(response, 200, {
    reply,
    configuredModel: pickRequestedModel(GEMINI_MODEL, availableModels),
    requestedModel,
    activeModel: geminiResult.model,
    fallbackUsed,
    finishReason: geminiResult.result?.candidates?.[0]?.finishReason || null,
    modelVersion: geminiResult.result?.modelVersion || geminiResult.model,
    usageMetadata: geminiResult.result?.usageMetadata || null,
  });
}

async function handleConfigRequest(response) {
  const availableModels = await getAvailableChatModels();

  return sendJson(response, 200, {
    hasKey: Boolean(GEMINI_API_KEY),
    model: pickRequestedModel(GEMINI_MODEL, availableModels),
    models: availableModels,
  });
}

function normalizeConversation(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      role: entry.role === "assistant" ? "model" : entry.role === "user" ? "user" : null,
      text: typeof entry.content === "string" ? entry.content.trim() : "",
    }))
    .filter((entry) => entry.role && entry.text)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((entry) => ({
      role: entry.role,
      parts: [{ text: entry.text }],
    }));
}

async function serveStaticFile(pathname, response) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolutePath = path.normalize(path.join(PUBLIC_DIR, relativePath));

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    return sendJson(response, 403, { error: "Forbidden." });
  }

  try {
    const file = await readFile(absolutePath);
    const contentType = MIME_TYPES[path.extname(absolutePath)] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return sendJson(response, 404, { error: "Not found." });
    }

    console.error("Static file error:", error);
    return sendJson(response, 500, { error: "Could not read static file." });
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    const error = new Error("Request body is empty.");
    error.statusCode = 400;
    throw error;
  }

  const parsed = parseJsonSafely(rawBody);
  if (!parsed) {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

function extractReplyText(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function extractGeminiError(result) {
  return result?.error?.message || result?.error?.status || null;
}

function shouldRetryWithFallback(result, availableModels) {
  if (
    !GEMINI_FALLBACK_MODEL ||
    GEMINI_FALLBACK_MODEL === result.model ||
    !availableModels.includes(GEMINI_FALLBACK_MODEL)
  ) {
    return false;
  }

  if (result.ok) {
    return false;
  }

  const status = result.status;
  const errorMessage = (result.errorMessage || "").toLowerCase();
  const errorStatus = (result.result?.error?.status || "").toLowerCase();

  return (
    status === 429 ||
    errorStatus === "resource_exhausted" ||
    errorMessage.includes("quota exceeded") ||
    errorMessage.includes("rate limit")
  );
}

function pickRequestedModel(model, availableModels) {
  if (typeof model === "string" && availableModels.includes(model)) {
    return model;
  }

  if (availableModels.includes(GEMINI_MODEL)) {
    return GEMINI_MODEL;
  }

  return availableModels[0] || GEMINI_MODEL;
}

async function requestGemini(model, payload) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`Gemini request failed for ${model}:`, error);
    return {
      ok: false,
      status: 502,
      model,
      rawText: "",
      result: null,
      errorMessage: "Could not reach Gemini API from the local server.",
      retryAfterSeconds: null,
      quotaMetric: null,
      quotaLimit: null,
    };
  }

  const rawText = await upstreamResponse.text();
  const result = parseJsonSafely(rawText);
  const errorMessage = extractGeminiError(result) || "Gemini API request failed.";

  return {
    ok: upstreamResponse.ok,
    status: upstreamResponse.status,
    model,
    rawText,
    result,
    errorMessage,
    retryAfterSeconds: extractRetryAfterSeconds(errorMessage),
    quotaMetric: extractQuotaInfo(errorMessage)?.metric || null,
    quotaLimit: extractQuotaInfo(errorMessage)?.limit || null,
  };
}

function extractRetryAfterSeconds(errorMessage) {
  const match = /Please retry in\s+([\d.]+)s/i.exec(errorMessage || "");
  if (!match) {
    return null;
  }

  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

function extractQuotaInfo(errorMessage) {
  const match =
    /Quota exceeded for metric:\s*([^,]+),\s*limit:\s*([^,]+)(?:,\s*model:\s*([^\s,]+))?/i.exec(
      errorMessage || "",
    );

  if (!match) {
    return null;
  }

  return {
    metric: match[1]?.trim() || null,
    limit: match[2]?.trim() || null,
    model: match[3]?.trim() || null,
  };
}

async function getAvailableChatModels() {
  if (availableModelsCache.expiresAt > Date.now() && availableModelsCache.models.length) {
    return availableModelsCache.models;
  }

  const discoveredModels = await fetchAvailableChatModels();
  if (discoveredModels.length) {
    availableModelsCache = {
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
      models: discoveredModels,
    };
    return availableModelsCache.models;
  }

  return availableModelsCache.models;
}

async function fetchAvailableChatModels() {
  const result = await requestGeminiModelList();
  if (!result.ok || !Array.isArray(result.models)) {
    return [];
  }

  const filteredModels = result.models
    .map((model) => normalizeListedModel(model))
    .filter(Boolean);

  return sortModels(dedupeModels(filteredModels));
}

async function requestGeminiModelList() {
  const apiUrl = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

  try {
    const response = await fetch(apiUrl, {
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
      },
      signal: AbortSignal.timeout(30_000),
    });

    const rawText = await response.text();
    const result = parseJsonSafely(rawText);

    return {
      ok: response.ok,
      models: result?.models || [],
    };
  } catch (error) {
    console.error("Could not fetch Gemini model list:", error);
    return {
      ok: false,
      models: [],
    };
  }
}

function normalizeListedModel(model) {
  if (!model || typeof model !== "object") {
    return null;
  }

  const name = String(model.name || "").replace(/^models\//, "");
  const methods = Array.isArray(model.supportedGenerationMethods)
    ? model.supportedGenerationMethods
    : [];

  if (!name.startsWith("gemini-")) {
    return null;
  }

  if (!methods.includes("generateContent")) {
    return null;
  }

  if (!isAllowedChatModel(name)) {
    return null;
  }

  return name;
}

function isAllowedChatModel(name) {
  if (
    name.includes("2.0") ||
    name.includes("image") ||
    name.includes("tts") ||
    name.includes("audio") ||
    name.includes("robotics") ||
    name.includes("computer-use") ||
    name.includes("deep-research") ||
    name.includes("customtools")
  ) {
    return false;
  }

  return (
    name.startsWith("gemini-2.5-") ||
    name.startsWith("gemini-3-") ||
    name.startsWith("gemini-3.1-") ||
    name === "gemini-flash-latest" ||
    name === "gemini-flash-lite-latest" ||
    name === "gemini-pro-latest"
  );
}

function sortModels(models) {
  const preferredOrder = [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
  ];

  return [...models].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    }

    return left.localeCompare(right);
  });
}

function dedupeModels(models) {
  const seen = new Set();
  const uniqueModels = [];

  for (const value of models) {
    const model = String(value || "").trim();
    if (!model || seen.has(model)) {
      continue;
    }

    seen.add(model);
    uniqueModels.push(model);
  }

  return uniqueModels;
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
