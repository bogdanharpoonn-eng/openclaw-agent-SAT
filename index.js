import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("OpenClaw universal agent v2 is running 🚀");
});

function getSchemaByTaskType(taskType) {
  switch (taskType) {
    case "workflow_generation":
      return {
        goal: "коротка ціль workflow",
        nodes: ["список нод n8n"],
        logic: ["крок 1", "крок 2", "крок 3"],
        result: "очікуваний результат",
      };

    case "business_analysis":
      return {
        situation: "що відбувається",
        risks: ["ризик 1", "ризик 2"],
        opportunities: ["можливість 1", "можливість 2"],
        recommendations: ["рекомендація 1", "рекомендація 2", "рекомендація 3"],
        expected_effect: "очікуваний ефект",
      };

    case "instruction_generation":
      return {
        title: "назва інструкції",
        purpose: "мета",
        steps: ["крок 1", "крок 2", "крок 3"],
        control_points: ["що перевірити 1", "що перевірити 2"],
        result: "що має бути на виході",
      };

    case "data_extraction":
      return {
        entities: {
          names: [],
          phones: [],
          emails: [],
          cities: [],
          companies: [],
          dates: [],
          other: [],
        },
        summary: "короткий зміст",
        structured_record: {
          name: "",
          phone: "",
          email: "",
          city: "",
          company: "",
          notes: "",
        },
      };

    case "email_generation":
      return {
        subject: "тема листа",
        recipient_type: "кому адресовано",
        purpose: "мета листа",
        body: "готовий текст листа",
        tone: "тон листа",
      };

    case "report_generation":
      return {
        title: "назва звіту",
        period: "період",
        key_points: ["ключовий пункт 1", "ключовий пункт 2"],
        metrics: ["показник 1", "показник 2"],
        conclusions: ["висновок 1", "висновок 2"],
        next_steps: ["крок 1", "крок 2"],
      };

    case "decision_support":
      return {
        decision_context: "контекст рішення",
        options: ["варіант 1", "варіант 2", "варіант 3"],
        pros_cons: [
          {
            option: "варіант 1",
            pros: ["плюс 1", "плюс 2"],
            cons: ["мінус 1", "мінус 2"],
          },
        ],
        recommendation: "рекомендований варіант",
        rationale: "чому саме цей варіант",
      };

    default:
      return {
        task_type: "визначений тип задачі",
        summary: "короткий зміст",
        response: "основна відповідь",
        next_steps: ["крок 1", "крок 2"],
      };
  }
}

function buildSystemPrompt(taskType) {
  const schema = JSON.stringify(getSchemaByTaskType(taskType), null, 2);

  return `Ти універсальний AI-агент для бізнесу, автоматизації, операційної роботи, аналітики та комунікацій.
Відповідай тільки валідним JSON.
Не використовуй markdown.
Не додавай пояснень поза JSON.
Не додавай вступних фраз.
Усі відповіді пиши українською мовою.
Структура JSON має точно відповідати цій схемі:

${schema}`;
}

function buildUserPrompt(taskType, prompt, context = "") {
  return `Тип задачі: ${taskType}
Задача користувача: ${prompt}
Додатковий контекст: ${context || "немає"}

Поверни відповідь строго у JSON за заданою схемою.`;
}

function detectTaskType(prompt = "") {
  const p = prompt.toLowerCase();

  if (p.includes("флоу") || p.includes("workflow") || p.includes("n8n") || p.includes("ноди")) {
    return "workflow_generation";
  }

  if (p.includes("проаналізуй") || p.includes("аналіз") || p.includes("ризик") || p.includes("можлив")) {
    return "business_analysis";
  }

  if (p.includes("інструкц") || p.includes("регламент") || p.includes("чекліст")) {
    return "instruction_generation";
  }

  if (p.includes("витягни") || p.includes("структуруй") || p.includes("дістань дані") || p.includes("розбери текст")) {
    return "data_extraction";
  }

  if (p.includes("лист") || p.includes("email") || p.includes("пошта") || p.includes("напиши відповідь")) {
    return "email_generation";
  }

  if (p.includes("звіт") || p.includes("report") || p.includes("підсумок") || p.includes("дай зведення")) {
    return "report_generation";
  }

  if (p.includes("рішення") || p.includes("що краще") || p.includes("обери") || p.includes("варіант")) {
    return "decision_support";
  }

  return "general";
}

app.post("/agent", async (req, res) => {
  try {
    const { task_type, prompt, context } = req.body;

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

    const finalTaskType = task_type || detectTaskType(prompt);

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(finalTaskType),
        },
        {
          role: "user",
          content: buildUserPrompt(finalTaskType, prompt, context),
        },
      ],
    });

    const rawText = response.choices[0].message.content;
    const parsed = JSON.parse(rawText);

    return res.json({
      status: "ok",
      task_type: finalTaskType,
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

app.post("/generate-workflow", async (req, res) => {
  try {
    const prompt = req.body.prompt;

    if (!prompt) {
      return res.status(400).json({
        status: "error",
        message: "Поле prompt є обов'язковим",
      });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt("workflow_generation"),
        },
        {
          role: "user",
          content: buildUserPrompt("workflow_generation", prompt),
        },
      ],
    });

    const rawText = response.choices[0].message.content;
    const parsed = JSON.parse(rawText);

    return res.json({
      status: "ok",
      task_type: "workflow_generation",
      data: parsed,
    });
  } catch (error) {
    console.error("Workflow error:", error);

    return res.status(500).json({
      status: "error",
      message: "Помилка при генерації workflow",
      details: error?.message || "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
