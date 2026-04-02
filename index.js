import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
// Збільшено ліміт для передачі великих JSON-схем
app.use(express.json({ limit: "5mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * СУВОРА СХЕМА: Обов'язково показуємо ШІ правильні дужки для n8n
 */
function getSchemaByTaskType(taskType) {
  if (taskType === "workflow_generation") {
    return {
      nodes: [
        {
          parameters: {},
          id: "uuid-string",
          name: "Назва ноди",
          type: "n8n-nodes-base.назваНоди",
          typeVersion: 1,
          position: [250, 300]
        }
      ],
      connections: {
        "Назва ноди": {
          main: [
            [
              {
                node: "Наступна нода",
                type: "main",
                index: 0
              }
            ]
          ]
        }
      }
    };
  }
  return {
    status: "ok",
    analysis: "Результат аналізу текстом"
  };
}

function detectTaskType(prompt) {
  const lowPrompt = prompt.toLowerCase();
  const keywords = ["флоу", "workflow", "схему", "ноди", "автоматизацію", "json"];
  return keywords.some(key => lowPrompt.includes(key)) ? "workflow_generation" : "general_analysis";
}

async function getPromptFile(fileName) {
  try {
    const filePath = path.join(process.cwd(), "prompts", fileName);
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    console.error(`Помилка читання промпту ${fileName}:`, error);
    return "";
  }
}

async function buildSystemPrompt(taskType) {
  const schema = JSON.stringify(getSchemaByTaskType(taskType), null, 2);
  let specificInstructions = "";

  if (taskType === "workflow_generation") {
    const externalPrompt = await getPromptFile("n8n_builder.txt");
    specificInstructions = `
ТЕХНІЧНЕ ЗАВДАННЯ ДЛЯ N8N:
1. Генеруй ПОВНИЙ масив "nodes" та об'єкт "connections".
2. Кожна нода в масиві "nodes" — це окремий об'єкт {}.
3. Координати "position" — це ЗАВЖДИ масив із двох чисел у квадратних дужках, наприклад [250, 300].
4. Використовуй тільки офіційні назви (наприклад, n8n-nodes-base.telegramTrigger).
5. ${externalPrompt}`;
  }

  return `Ти — Senior Automation Engineer n8n.
Відповідай ТІЛЬКИ чистим JSON. Жодного тексту до або після JSON. Жодного markdown (\`\`\`json).
Мова значень у JSON: українська.

Обов'язкова структура відповіді:
${schema}`;
}

app.post("/agent", async (req, res) => {
  try {
    const { task_type, prompt, context } = req.body;

    if (!prompt) {
      return res.status(400).json({ status: "error", message: "Prompt is required" });
    }

    const finalTaskType = task_type || detectTaskType(prompt);
    const systemContent = await buildSystemPrompt(finalTaskType);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0, // Встановлено 0 для максимальної точності структури
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemContent },
        { 
          role: "user", 
          content: `Запит користувача: "${prompt}". 
          Контекст: ${JSON.stringify(context || {})}
          Згенеруй технічно правильний JSON за вказаною схемою.` 
        },
      ],
    });

    const resultData = JSON.parse(response.choices[0].message.content);

    return res.json({
      status: "ok",
      task_type: finalTaskType,
      data: resultData,
    });
  } catch (error) {
    console.error("Agent error:", error);
    return res.status(500).json({ 
      status: "error", 
      message: "Internal error", 
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
