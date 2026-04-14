import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import iconv from "iconv-lite";

const app = express();
app.use(express.json({ limit: "5mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const WEB_FETCH_TIMEOUT_MS = Number(process.env.WEB_FETCH_TIMEOUT_MS || 8000);
const WEB_FETCH_MAX_CHARS = Number(process.env.WEB_FETCH_MAX_CHARS || 12000);
const SCRAPLING_BIN = process.env.SCRAPLING_BIN || "scrapling";
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 45000);
const SCRAPLING_NO_VERIFY = String(process.env.SCRAPLING_NO_VERIFY || "").toLowerCase() === "true";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BASE_URL = process.env.BASE_URL || "";
const PORT = process.env.PORT || 3000;
const TELEGRAM_CHAT_ALLOWLIST = (process.env.TELEGRAM_CHAT_ALLOWLIST || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const TELEGRAM_RATE_LIMIT_WINDOW_MS = Number(process.env.TELEGRAM_RATE_LIMIT_WINDOW_MS || 60000);
const TELEGRAM_RATE_LIMIT_MAX = Number(process.env.TELEGRAM_RATE_LIMIT_MAX || 20);
const ERROR_LOG_FILE = process.env.ERROR_LOG_FILE || path.join(process.cwd(), "logs", "errors.log");
const execFileAsync = promisify(execFile);
const WEB_FETCH_ALLOWLIST = (process.env.WEB_FETCH_ALLOWLIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const telegramRateBucket = new Map();

// Завантаження конфігурації агентів
async function getAgentsConfig() {
  const data = await fs.readFile(path.join(process.cwd(), "agents.json"), "utf-8");
  return JSON.parse(data);
}

function buildCapabilitiesText(config) {
  return Object.entries(config)
    .map(([agentId, settings]) => {
      const name = settings.display_name || agentId;
      const description = settings.description || "Профільний субагент.";
      return `- ${name} (${agentId}): ${description}`;
    })
    .join("\n");
}

function isAllowedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid URL format" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, reason: "Only http/https URLs are allowed" };
  }

  if (WEB_FETCH_ALLOWLIST.length === 0) {
    return { ok: true, url: parsed.toString() };
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowed = WEB_FETCH_ALLOWLIST.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  if (!allowed) {
    return { ok: false, reason: `Domain is not in allowlist: ${hostname}` };
  }

  return { ok: true, url: parsed.toString() };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractUrlsFromText(text) {
  const matches = text.match(/https?:\/\/[^\s)]+/gi) || [];
  const normalized = matches
    .map(u => u.trim().replace(/[.,!?;:]+$/, ""))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function fixMojibake(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  // Heuristic: recover UTF-8 text that was misread as Latin-1/Windows-1252.
  const recoded = Buffer.from(text, "latin1").toString("utf8");
  const hasCyrOriginal = /[А-Яа-яІіЇїЄєҐґ]/.test(text);
  const hasCyrRecoded = /[А-Яа-яІіЇїЄєҐґ]/.test(recoded);
  if (!hasCyrOriginal && hasCyrRecoded) {
    return recoded;
  }
  return text;
}

function cyrillicScore(text) {
  const m = text.match(/[А-Яа-яІіЇїЄєҐґ]/g);
  return m ? m.length : 0;
}

function decodeBestText(buffer) {
  const utf8 = buffer.toString("utf8");
  const cp1251 = iconv.decode(buffer, "win1251");
  const latin1Utf8 = Buffer.from(utf8, "latin1").toString("utf8");

  const candidates = [utf8, cp1251, latin1Utf8].map(t => fixMojibake(t));
  const best = candidates.sort((a, b) => cyrillicScore(b) - cyrillicScore(a))[0];
  return best || utf8;
}

async function runScraplingExtract({
  rawUrl,
  mode = "get",
  cssSelector,
  timeoutMs = SCRAPE_TIMEOUT_MS,
  waitSelector,
}) {
  const check = isAllowedUrl(rawUrl);
  if (!check.ok) {
    throw new Error(check.reason);
  }

  const allowedModes = new Set(["get", "fetch", "stealthy-fetch"]);
  if (!allowedModes.has(mode)) {
    throw new Error(`Unsupported scrape mode: ${mode}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scrapling-"));
  const outFile = path.join(tmpDir, "content.txt");

  const args = ["extract", mode, check.url, outFile, "--ai-targeted"];
  if (SCRAPLING_NO_VERIFY && mode === "get") {
    args.push("--no-verify");
  }
  if (cssSelector && typeof cssSelector === "string") {
    args.push("--css-selector", cssSelector.trim());
  }
  if (waitSelector && typeof waitSelector === "string" && (mode === "fetch" || mode === "stealthy-fetch")) {
    args.push("--wait-selector", waitSelector.trim());
  }

  try {
    await execFileAsync(SCRAPLING_BIN, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const contentBuffer = await fs.readFile(outFile);
    return { url: check.url, mode, content: decodeBestText(contentBuffer).trim() };
  } catch (error) {
    const stderr = error?.stderr?.toString?.() || "";
    const stdout = error?.stdout?.toString?.() || "";
    const details = [stderr, stdout].filter(Boolean).join(" ").trim();
    if (details.includes("not recognized") || details.includes("ENOENT")) {
      throw new Error("Scrapling binary is not available. Install Scrapling and set SCRAPLING_BIN if needed.");
    }
    throw new Error(details || error.message || "Scrapling execution failed");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function fetchUrlText(rawUrl) {
  const check = isAllowedUrl(rawUrl);
  if (!check.ok) {
    throw new Error(check.reason);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(check.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "OpenClaw-Agent/1.0 (+web-fetch)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text") && !contentType.includes("html") && !contentType.includes("json")) {
      throw new Error(`Unsupported content-type: ${contentType}`);
    }

    const raw = await response.text();
    const text = contentType.includes("html") ? htmlToText(raw) : raw.trim();
    return text.slice(0, WEB_FETCH_MAX_CHARS);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text || "Порожня відповідь.",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }

  return response.json();
}

function isAllowedTelegramChat(chatId) {
  if (TELEGRAM_CHAT_ALLOWLIST.length === 0) return true;
  return TELEGRAM_CHAT_ALLOWLIST.includes(String(chatId));
}

function consumeTelegramRateLimit(chatId) {
  const key = String(chatId);
  const now = Date.now();
  const row = telegramRateBucket.get(key) || { count: 0, windowStart: now };
  if (now - row.windowStart >= TELEGRAM_RATE_LIMIT_WINDOW_MS) {
    row.count = 0;
    row.windowStart = now;
  }
  row.count += 1;
  telegramRateBucket.set(key, row);
  return row.count <= TELEGRAM_RATE_LIMIT_MAX;
}

async function logError(event, details) {
  try {
    await fs.mkdir(path.dirname(ERROR_LOG_FILE), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...details,
    });
    await fs.appendFile(ERROR_LOG_FILE, `${line}\n`, "utf-8");
  } catch {
    // Do not fail request due to logging failure.
  }
}

// Пошук потрібного субагента за ключовими словами
function identifyAgentByKeywords(prompt, config) {
  const lowPrompt = prompt.toLowerCase();
  for (const [agentId, settings] of Object.entries(config)) {
    if (settings.keywords.some(key => lowPrompt.includes(key))) {
      return agentId;
    }
  }
  return null;
}

// Якщо ключові слова не спрацювали, архітектор обирає профільного субагента через LLM
async function identifyAgentByArchitect(prompt, config) {
  const availableAgents = Object.keys(config);
  const agentsHints = Object.entries(config)
    .map(([agentId, settings]) => `${agentId}: ${settings.keywords.join(", ")}`)
    .join("\n");

  const classifier = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Ти агент-архітектор. Ти не відповідаєш користувачу по суті, лише обираєш sub-agent.
Поверни ТІЛЬКИ JSON формату {"agent":"<id>"}.
Доступні sub-agent:
${agentsHints}
Якщо запит загальний або неочевидний, обирай "general_assistant".`,
      },
      { role: "user", content: prompt }
    ],
  });

  const raw = classifier.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  const candidate = parsed?.agent;
  return availableAgents.includes(candidate) ? candidate : "general_assistant";
}

app.post("/fetch", async (req, res) => {
  try {
    const url = req.body?.url;
    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ status: "error", message: "Field 'url' is required." });
    }

    const content = await fetchUrlText(url.trim());
    return res.json({ status: "ok", url: url.trim(), content });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: "error", message: error.message || "Fetch failed" });
  }
});

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url;
    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ status: "error", message: "Field 'url' is required." });
    }

    const mode = typeof req.body?.mode === "string" ? req.body.mode.trim() : "get";
    const cssSelector = typeof req.body?.css_selector === "string" ? req.body.css_selector : undefined;
    const waitSelector = typeof req.body?.wait_selector === "string" ? req.body.wait_selector : undefined;
    const timeoutMs = Number(req.body?.timeout_ms || SCRAPE_TIMEOUT_MS);

    const result = await runScraplingExtract({
      rawUrl: url.trim(),
      mode,
      cssSelector,
      waitSelector,
      timeoutMs,
    });

    return res.json({ status: "ok", ...result });
  } catch (error) {
    console.error("SCRAPE_ERROR_DETAILS:", error.message || error);
    return res.status(500).json({ status: "error", message: error.message || "Scrape failed" });
  }
});

app.get("/health/scrapling", async (_req, res) => {
  try {
    const result = await runScraplingExtract({
      rawUrl: "https://example.com",
      mode: "get",
      timeoutMs: Math.min(SCRAPE_TIMEOUT_MS, 20000),
    });
    return res.json({
      status: "ok",
      scrapling_bin: SCRAPLING_BIN,
      preview: result.content.slice(0, 120),
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      scrapling_bin: SCRAPLING_BIN,
      message: error.message || "Scrapling health failed",
    });
  }
});

app.post("/telegram/send", async (req, res) => {
  try {
    const chatId = req.body?.chat_id;
    const text = req.body?.text;
    if (!chatId || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ status: "error", message: "Fields 'chat_id' and non-empty 'text' are required." });
    }

    const result = await sendTelegramMessage(chatId, text.trim());
    return res.json({ status: "ok", result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: "error", message: error.message || "Telegram send failed" });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  try {
    const message = req.body?.message;
    const chatId = message?.chat?.id;
    const text = message?.text;

    if (!chatId || typeof text !== "string" || !text.trim()) {
      return res.json({ status: "ignored", reason: "No text message" });
    }

    if (!isAllowedTelegramChat(chatId)) {
      await logError("telegram_blocked_chat", { chat_id: String(chatId) });
      return res.json({ status: "ignored", reason: "chat is not allowlisted" });
    }

    if (!consumeTelegramRateLimit(chatId)) {
      await sendTelegramMessage(chatId, "Забагато запитів. Спробуйте ще раз через хвилину.");
      return res.json({ status: "rate_limited" });
    }

    const urls = extractUrlsFromText(text);
    const agentPayload = {
      message: text.trim(),
      urls,
      use_scrape: true,
      scrape_mode: "get",
      use_web: false,
    };

    const agentRes = await fetch(`http://127.0.0.1:${PORT}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(agentPayload),
    });

    const replyText = await agentRes.text();
    const safeReply = (replyText || "").trim() || "Не вдалося підготувати відповідь.";
    await sendTelegramMessage(chatId, safeReply.slice(0, 3900));

    return res.json({ status: "ok" });
  } catch (error) {
    console.error(error);
    await logError("telegram_webhook_error", {
      message: error.message || "Webhook processing failed",
    });
    return res.status(500).json({ status: "error", message: error.message || "Webhook processing failed" });
  }
});

app.post("/agent", async (req, res) => {
  try {
    console.log("AGENT_BODY:", JSON.stringify(req.body));
    const prompt = req.body?.message ?? req.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).type("text/plain").send("Field 'message' or 'prompt' is required.");
    }

    const config = await getAgentsConfig();
    const configuredAgents = Object.keys(config);
    const agentId = configuredAgents.length === 1
      ? configuredAgents[0]
      : (identifyAgentByKeywords(prompt, config) ?? await identifyAgentByArchitect(prompt, config));
    const agentSettings = config[agentId];

    // Читаємо інструкцію субагента з .txt файлу
    const systemInstruction = await fs.readFile(
      path.join(process.cwd(), "prompts", agentSettings.prompt_file),
      "utf-8"
    );

    const dynamicSystemInstruction = agentId === "general_assistant"
      ? `${systemInstruction}\n\nАктуальні профільні помічники (з конфігу):\n${buildCapabilitiesText(config)}`
      : systemInstruction;

    const requestUrls = Array.isArray(req.body?.urls) ? req.body.urls.filter(u => typeof u === "string" && u.trim()) : [];
    const extractedUrls = requestUrls.length === 0 ? extractUrlsFromText(prompt) : [];
    const urls = requestUrls.length > 0 ? requestUrls : extractedUrls;
    const useWeb = Boolean(req.body?.use_web) || urls.length > 0;
    const useScrape = agentId === "web_scraping_agent" && req.body?.use_scrape !== false;

    let webContext = "";
    let webSuccessCount = 0;
    const webErrors = [];
    if (useWeb && urls.length > 0) {
      const chunks = [];
      for (const rawUrl of urls.slice(0, 3)) {
        try {
          const text = await fetchUrlText(rawUrl);
          chunks.push(`URL: ${rawUrl}\n${text}`);
          webSuccessCount += 1;
        } catch (err) {
          const msg = err?.message || "Unknown fetch error";
          chunks.push(`URL: ${rawUrl}\n[Fetch error: ${msg}]`);
          webErrors.push(`${rawUrl} -> ${msg}`);
        }
      }
      webContext = chunks.join("\n\n---\n\n");
    }

    if (useWeb && urls.length > 0 && webSuccessCount === 0) {
      const details = webErrors.length > 0 ? webErrors.join("; ") : "No content fetched";
      return res.status(502).type("text/plain").send(`Web fetch failed: ${details}`);
    }

    let scrapeContext = "";
    if (useScrape && urls.length > 0) {
      const chunks = [];
      const scrapeMode = typeof req.body?.scrape_mode === "string" ? req.body.scrape_mode.trim() : "get";
      for (const rawUrl of urls.slice(0, 2)) {
        try {
          const result = await runScraplingExtract({
            rawUrl,
            mode: scrapeMode,
            cssSelector: typeof req.body?.css_selector === "string" ? req.body.css_selector : undefined,
            waitSelector: typeof req.body?.wait_selector === "string" ? req.body.wait_selector : undefined,
            timeoutMs: Number(req.body?.scrape_timeout_ms || SCRAPE_TIMEOUT_MS),
          });
          chunks.push(`URL: ${result.url}\n${result.content.slice(0, WEB_FETCH_MAX_CHARS)}`);
        } catch (err) {
          const msg = err?.message || "Scrape failed";
          chunks.push(`URL: ${rawUrl}\n[Scrape error: ${msg}]`);
        }
      }
      scrapeContext = chunks.join("\n\n---\n\n");
    }

    const finalUserMessage = [
      prompt,
      webContext ? `Веб-контекст (використай лише якщо релевантно):\n${webContext}` : "",
      scrapeContext ? `Результат Scrapling:\n${scrapeContext}` : "",
    ].filter(Boolean).join("\n\n");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: dynamicSystemInstruction },
        { role: "user", content: finalUserMessage }
      ],
    });

    const outputText = fixMojibake(response.choices?.[0]?.message?.content?.trim() || "");
    return res.type("text/plain; charset=utf-8").send(outputText);
  } catch (error) {
    console.error(error);
    return res.status(500).type("text/plain").send(error.message || "Internal server error");
  }
});

app.get("/capabilities", async (_req, res) => {
  try {
    const config = await getAgentsConfig();
    const lines = Object.entries(config).map(([agentId, settings]) => {
      const name = settings.display_name || agentId;
      const description = settings.description || "Профільний субагент.";
      return `${name} (${agentId}): ${description}`;
    });
    return res.type("text/plain; charset=utf-8").send(lines.join("\n"));
  } catch (error) {
    console.error(error);
    return res.status(500).type("text/plain").send(error.message || "Internal server error");
  }
});

app.listen(PORT, () => console.log(`Engine started on port ${PORT}`));
