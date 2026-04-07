import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "5mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

app.post("/agent", async (req, res) => {
  try {
    const prompt = req.body?.message ?? req.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).type("text/plain").send("Field 'message' or 'prompt' is required.");
    }

    const config = await getAgentsConfig();
    const agentId = identifyAgentByKeywords(prompt, config) ?? await identifyAgentByArchitect(prompt, config);
    const agentSettings = config[agentId];

    // Читаємо інструкцію субагента з .txt файлу
    const systemInstruction = await fs.readFile(
      path.join(process.cwd(), "prompts", agentSettings.prompt_file),
      "utf-8"
    );

    const dynamicSystemInstruction = agentId === "general_assistant"
      ? `${systemInstruction}\n\nАктуальні профільні помічники (з конфігу):\n${buildCapabilitiesText(config)}`
      : systemInstruction;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: dynamicSystemInstruction },
        { role: "user", content: prompt }
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
