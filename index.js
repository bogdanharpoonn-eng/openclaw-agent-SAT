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

// Пошук потрібного субагента за ключовими словами
function identifyAgent(prompt, config) {
  const lowPrompt = prompt.toLowerCase();
  for (const [agentId, settings] of Object.entries(config)) {
    if (settings.keywords.some(key => lowPrompt.includes(key))) {
      return agentId;
    }
  }
  return "casual_chat"; // Дефолтний агент
}

app.post("/agent", async (req, res) => {
  try {
    const { prompt } = req.body;
    const config = await getAgentsConfig();
    const agentId = identifyAgent(prompt, config);
    const agentSettings = config[agentId];

    // Читаємо інструкцію субагента з .txt файлу
    const systemInstruction = await fs.readFile(
      path.join(process.cwd(), "prompts", agentSettings.prompt_file),
      "utf-8"
    );

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${systemInstruction}\nВідповідай ТІЛЬКИ JSON українською мовою.` },
        { role: "user", content: prompt }
      ],
    });

    return res.json({
      status: "ok",
      agent: agentId,
      data: JSON.parse(response.choices[0].message.content)
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine started on port ${PORT}`));
