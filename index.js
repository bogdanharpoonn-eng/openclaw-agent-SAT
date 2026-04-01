import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("OpenClaw agent is running 🚀");
});

app.post("/generate-workflow", async (req, res) => {
  try {
    const userRequest = req.body.prompt;

    if (!userRequest) {
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

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Ти AI-агент, який допомагає створювати workflow для n8n.
Поверни тільки валідний JSON без пояснень і без markdown.

Формат відповіді:
{
  "goal": "коротка ціль workflow",
  "nodes": ["список потрібних нод n8n"],
  "logic": ["крок 1", "крок 2", "крок 3"],
  "result": "який результат отримає користувач"
}`,
        },
        {
          role: "user",
          content: `Створи workflow для задачі: ${userRequest}`,
        },
      ],
    });

    const rawText = response.choices[0].message.content;
    const parsed = JSON.parse(rawText);

    return res.json({
      status: "ok",
      data: parsed,
    });
  } catch (error) {
    console.error("OpenAI error:", error);

    return res.status(500).json({
      status: "error",
      message: "Помилка при зверненні до OpenAI або обробці JSON",
      details: error?.message || "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
