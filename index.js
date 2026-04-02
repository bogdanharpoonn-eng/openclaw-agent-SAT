import express from "express";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "5mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 1. Визначення типу задачі (Логіка фільтрації запитів)
function detectTaskType(prompt) {
  const lowPrompt = prompt.toLowerCase();
  
  // Перевірка на звичайне спілкування
  const casualPhrases = ["привіт", "як справи", "що робиш", "hello", "hi", "дякую"];
  if (casualPhrases.some(phrase => lowPrompt.includes(phrase)) && lowPrompt.length < 25) {
    return "casual_chat";
  }

  // Перевірка на запит автоматизації
  const workflowKeywords = ["флоу", "workflow", "схему", "ноди", "автоматизацію", "json", "створи"];
  if (workflowKeywords.some(key => lowPrompt.includes(key))) {
    return "workflow_generation";
  }

  return "general_analysis";
}

// 2. Схеми відповідей (Щоб нода If в n8n працювала коректно)
function getSchemaByTaskType(taskType) {
  if (taskType === "workflow_generation") {
    return {
      nodes: [
        {
          parameters: {},
          id: "uuid",
          name: "Node Name",
          type: "n8n-nodes-base.nodeType",
          typeVersion: 1,
          position: [250, 300]
        }
      ],
      connections: {
        "Node Name": { main: [[ { node: "Next Node", type: "main", index: 0 } ]] }
      }
    };
  }
  
  // Для чату поле 'nodes' відсутнє - це запустить гілку FALSE в n8n
  return {
    analysis: "Текст вашої відповіді тут",
    status: "chat_or_analysis"
  };
}

async function getPromptFile(fileName) {
  try {
    const filePath = path.join(process.cwd(), "prompts", fileName);
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    return "";
  }
}

async function buildSystemPrompt(taskType) {
  const schema = JSON.stringify(getSchemaByTaskType(taskType), null, 2);
  let instructions = "Ти — універсальний AI-помічник для логістики та автоматизації.";

  if (taskType === "workflow_generation") {
    const externalPrompt = await getPromptFile("n8n_builder.txt");
    instructions = `Ти — Senior n8n Engineer. 
    Генеруй ПОВНИЙ JSON workflow (nodes та connections). 
    Координати position — це завжди масив [x, y].
    ${externalPrompt}`;
  } else if (taskType === "casual_chat") {
    instructions = "Ти ввічливий асистент. Відповідай коротко, без генерації JSON-вузлів n8n.";
  }

  return `${instructions}
  Відповідай ТІЛЬКИ валідним JSON за цією структурою:
  ${schema}
  Мова: українська. Жодного тексту поза JSON.`;
}

app.post("/agent", async (req, res) => {
  try {
    const { prompt, context, task_type } = req.body;

    if (!prompt) return res.status(400).json({ error: "No prompt provided" });

    const finalTaskType = task_type || detectTaskType(prompt);
    const systemContent = await buildSystemPrompt(finalTaskType);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0, // Гарантує стабільність структури JSON
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: `Запит: ${prompt}. Контекст: ${JSON.stringify(context || {})}` },
      ],
    });

    return res.json({
      status: "ok",
      task_type: finalTaskType,
      data: JSON.parse(response.choices[0].message.content),
    });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
