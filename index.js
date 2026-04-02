import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "5mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 1. Чітке розпізнавання наміру
function detectTaskType(prompt) {
  const lowPrompt = prompt.toLowerCase();
  const casualPhrases = ["привіт", "як справи", "що робиш", "hello", "hi", "дякую", "хто ти"];
  
  if (casualPhrases.some(phrase => lowPrompt.includes(phrase)) && lowPrompt.length < 30) {
    return "casual_chat";
  }
  
  const workflowKeywords = ["флоу", "workflow", "схему", "ноди", "автоматизацію", "json", "створи", "напиши код"];
  if (workflowKeywords.some(key => lowPrompt.includes(key))) {
    return "workflow_generation";
  }

  return "general_analysis";
}

// 2. Генерація системного промпту залежно від задачі
async function buildSystemPrompt(taskType) {
  if (taskType === "casual_chat") {
    return `Ти ввічливий AI-асистент для логістів. 
    Відповідай ТІЛЬКИ у форматі JSON з одним полем "analysis". 
    ЗАБОРОНЕНО генерувати масиви "nodes" або "connections".
    Мова: українська.
    Приклад: { "analysis": "Привіт! Я готовий допомогти з логістикою або створити для вас workflow." }`;
  }

  // Схема тільки для генерації workflow
  const workflowSchema = {
    nodes: [{ parameters: {}, id: "uuid", name: "Node", type: "n8n-nodes-base.node", typeVersion: 1, position: [250, 300] }],
    connections: { "Node": { main: [[ { node: "Next", type: "main", index: 0 } ]] } }
  };

  const externalPrompt = await getPromptFile("n8n_builder.txt");

  return `Ти — Senior n8n Engineer. 
  Відповідай ТІЛЬКИ валідним JSON-кодом для імпорту в n8n. 
  Обов'язково використовуй структуру з полями "nodes" та "connections".
  ${externalPrompt}
  
  Структура відповіді:
  ${JSON.stringify(workflowSchema, null, 2)}`;
}

async function getPromptFile(fileName) {
  try {
    const filePath = path.join(process.cwd(), "prompts", fileName);
    return await fs.readFile(filePath, "utf-8");
  } catch { return ""; }
}

app.post("/agent", async (req, res) => {
  try {
    const { prompt, context } = req.body;
    if (!prompt) return res.status(400).json({ error: "No prompt" });

    const taskType = detectTaskType(prompt);
    const systemContent = await buildSystemPrompt(taskType);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0, // Повна стабільність
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: prompt }
      ],
    });

    const aiResponse = JSON.parse(response.choices[0].message.content);

    return res.json({
      status: "ok",
      task_type: taskType,
      data: aiResponse // n8n отримає цей об'єкт у $json.data
    });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
