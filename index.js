import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("OpenClaw universal agent is running 🚀");
});

function buildSystemPrompt(taskType) {
  switch (taskType) {
    case "workflow_generation":
      return `Ти AI-агент, який проєктує workflow для n8n.
Поверни тільки валідний JSON без markdown і без пояснень.

Формат:
{
  "goal": "коротка ціль workflow",
  "nodes": ["список нод n8n"],
  "logic": ["крок 1", "крок 2", "крок 3"],
  "result": "очікуваний результат"
}`;

    case "business_analysis":
      return `Ти AI-агент для бізнес-аналізу.
Поверни тільки валідний JSON без markdown і без пояснень.

Формат:
{
  "situation": "що відбувається",
  "risks": ["ризик 1", "ризик 2"],
  "opportunities": ["можливість 1", "можливість 2"],
  "recommendations": ["рекомендація 1", "рекомендація 2", "рекомендація 3"],
  "expected_effect": "очікуваний ефект"
}`;

    case "instruction_generation":
      return `Ти AI-агент, який створює практичні інструкції для співробітників.
Поверни тільки валідний JSON без markdown і без пояснень.

Формат:
{
  "title": "назва інструкції",
  "purpose": "мета",
  "steps": ["крок 1", "крок 2", "крок 3"],
  "control_points": ["що перевірити 1", "що перевірити 2"],
  "result": "що має бути на виході"
}`;

    case "data_extraction":
      return `Ти AI-агент для структуризації даних з тексту.
Поверни тільки валідний JSON без markdown і без пояснень.

Формат:
{
  "entities": {
    "names": [],
    "phones": [],
    "emails": [],
    "cities": [],
    "companies": [],
    "dates": [],
    "other": []
  },
  "summary": "короткий зміст",
  "structured_record": {
    "name": "",
    "phone": "",
    "email": "",
    "city": "",
    "company": "",
    "notes": ""
  }
}`;

    default:
      return `Ти універсальний AI-агент.
Поверни тільки валідний JSON без markdown і без пояснень.

Формат:
{
  "task_type": "визначений тип задачі",
  "summary": "короткий зміст",
  "response": "основна відповідь",
  "next_steps": ["крок 1", "крок 2"]
}`;
  }
}

function buildUserPrompt(taskType, prompt) {
  switch (taskType) {
    case "workflow_generation":
      return `Створи workflow для задачі: ${prompt}`;

    case "business_analysis":
      return `Проаналізуй бізнес-ситуацію: ${prompt}`;

    case "instruction_generation":
      return `Створи практичну інструкцію для задачі: ${prompt}`;

    case "data_extraction":
      return `Витягни та структуризуй дані з цього тексту: ${prompt}`;

    default:
      return `Оброби задачу: ${prompt}`;
  }
}

app.post("/agent", async (req, res) => {
  try {
    const { task_type, prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        status: "error",
        message: "Поле prompt є обов'язковим",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        status: "error",
        message: "OPENAI_API_KEY не знайдено в Variables",
      });
    }

    const taskType = task_type || "general";

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(taskType),
        },
        {
          role: "user",
          content: buildUserPrompt(taskType, prompt),
        },
      ],
    });

    const rawText = response.choices[0].message.content;
    const parsed = JSON.parse(rawText);

    return res.json({
      status: "ok",
      task_type: taskType,
      data: parsed,
    });
  } catch (error) {
    console.error("Agent error:", error);

    return res.status(500).json({
      status: "error",
      message: "Помилка при обробці запиту",
      details: error?.message || "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
