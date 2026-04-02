import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Допоміжна функція для читання файлу промпту
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
  
  // Якщо задача — генерація workflow, пробуємо завантажити спеціальний промпт
  let specificInstructions = "";
  if (taskType === "workflow_generation") {
    const externalPrompt = await getPromptFile("n8n_builder.txt");
    if (externalPrompt) {
      specificInstructions = `\nСПЕЦІАЛЬНІ ТЕХНІЧНІ ІНСТРУКЦІЇ:\n${externalPrompt}`;
    }
  }

  return `Ти універсальний AI-агент для бізнесу, автоматизації та логістики.
Відповідай тільки валідним JSON без markdown.
Усі відповіді пиши українською мовою.${specificInstructions}

Структура JSON має точно відповідати цій схемі:
${schema}`;
}

// Решта функцій (getSchemaByTaskType, detectTaskType, buildUserPrompt) залишаються без змін

app.post("/agent", async (req, res) => {
  try {
    const { task_type, prompt, context } = req.body;

    if (!prompt) {
      return res.status(400).json({ status: "error", message: "Поле prompt є обов'язковим" });
    }

    const finalTaskType = task_type || detectTaskType(prompt);
    const systemContent = await buildSystemPrompt(finalTaskType);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", // Рекомендую використовувати актуальну назву моделі
      temperature: 0.1, // Знижено для більшої точності в JSON
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: buildUserPrompt(finalTaskType, prompt, context) },
      ],
    });

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

// Функції getSchemaByTaskType, buildUserPrompt та detectTaskType скопіюйте зі своєї попередньої версії
