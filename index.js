import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Схеми для різних типів задач
function getSchemaByTaskType(taskType) {
  if (taskType === "workflow_generation") {
    // Структура, яку n8n розуміє при вставці (Ctrl+V)
    return {
      nodes: [
        {
          parameters: {},
          id: "UUID",
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
  
  // Стандартна схема для аналітики або ТЗ
  return {
    analysis: "Текст аналізу",
    recommendations: ["пункт 1", "пункт 2"],
    status: "success"
  };
}

// Визначення типу задачі за текстом
function detectTaskType(prompt) {
  const lowPrompt = prompt.toLowerCase();
  if (lowPrompt.includes("флоу") || lowPrompt.includes("workflow") || lowPrompt.includes("створи ноди") || lowPrompt.includes("схему")) {
    return "workflow_generation";
  }
  return "general_analysis";
}

// Формування фінального промпту користувача
function buildUserPrompt(taskType, prompt, context) {
  if (taskType === "workflow_generation") {
    return `Згенеруй технічний JSON-код для n8n за цим запитом: "${prompt}". 
    Використовуй тільки офіційні назви нод n8n. Контекст: ${JSON.stringify(context || {})}`;
  }
  return `Запит: ${prompt}. Контекст: ${JSON.stringify(context || {})}`;
}

async function getPromptFile(fileName) {
  try {
    const filePath = path.join(process.cwd(), "prompts", fileName);
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    console.error(`Помилка читання промпту ${fileName}:`, error);
    return null;
  }
}

async function buildSystemPrompt(taskType) {
  const schema = JSON.stringify(getSchemaByTaskType(taskType), null, 2);
  let specificInstructions = "";

  if (taskType === "workflow_generation") {
    const externalPrompt = await getPromptFile("n8n_builder.txt");
    if (externalPrompt) {
      specificInstructions = `\nТЕХНІЧНІ ВИМОГИ ДО N8N:\n${externalPrompt}`;
    }
  }

  return `Ти експерт з автоматизації n8n.
Відповідай ТІЛЬКИ чистим JSON без пояснень та markdown-розмітки.
Мова відповідей: українська.
Для workflow_generation генеруй ПОВНИЙ об'єкт з nodes та connections, готовий до імпорту.

Очікувана структура JSON:
${schema}`;
}

app.post("/agent", async (req, res) => {
  try {
    const { task_type, prompt, context } = req.body;

    if (!prompt) {
      return res.status(400).json({ status: "error", message: "Поле prompt є обов'язковим" });
    }

    const finalTaskType = task_type || detectTaskType(prompt);
    const systemContent = await buildSystemPrompt(finalTaskType);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: buildUserPrompt(finalTaskType, prompt, context) },
      ],
    });

    // Повертаємо безпосередньо дані, щоб n8n міг їх відразу відобразити
    return res.json({
      status: "ok",
      task_type: finalTaskType,
      data: JSON.parse(response.choices[0].message.content),
    });
  } catch (error) {
    console.error("Agent error:", error);
    return res.status(500).json({ status: "error", message: "Помилка обробки", details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
