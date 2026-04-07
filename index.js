import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "5mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const WEB_FETCH_TIMEOUT_MS = Number(process.env.WEB_FETCH_TIMEOUT_MS || 8000);
const WEB_FETCH_MAX_CHARS = Number(process.env.WEB_FETCH_MAX_CHARS || 12000);
const WEB_FETCH_ALLOWLIST = (process.env.WEB_FETCH_ALLOWLIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

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

app.post("/agent", async (req, res) => {
  try {
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

    let webContext = "";
    if (useWeb && urls.length > 0) {
      const chunks = [];
      for (const rawUrl of urls.slice(0, 3)) {
        try {
          const text = await fetchUrlText(rawUrl);
          chunks.push(`URL: ${rawUrl}\n${text}`);
        } catch (err) {
          chunks.push(`URL: ${rawUrl}\n[Fetch error: ${err.message}]`);
        }
      }
      webContext = chunks.join("\n\n---\n\n");
    }

    const finalUserMessage = webContext
      ? `${prompt}\n\nВеб-контекст (використай лише якщо релевантно):\n${webContext}`
      : prompt;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: dynamicSystemInstruction },
        { role: "user", content: finalUserMessage }
      ],
    });

    const outputText = response.choices?.[0]?.message?.content?.trim() || "";
    return res.type("text/plain").send(outputText);
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
    return res.type("text/plain").send(lines.join("\n"));
  } catch (error) {
    console.error(error);
    return res.status(500).type("text/plain").send(error.message || "Internal server error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine started on port ${PORT}`));
