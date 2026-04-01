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
        message: "Поле prompt є обов'язковим"
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        status: "error",
        message: "OPENAI_API_KEY не знайдено в Variables"
      });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "Ти AI-агент, який допомагає створювати workflow для n8n. Відповідай українською коротко і структуровано."
        },
        {
          role: "user",
          content: `Створи логіку workflow для задачі: ${userRequest}. Поверни: 1) що зробити, 2) які ноди потрібні, 3) логіку між нодами, 4) очікуваний результат.`
        }
      ],
      temperature: 0.3
    });

    return res.json({
      status: "ok",
      result: response.choices[0].message.content
    });
  } catch (error) {
    console.error("OpenAI error:", error);

    return res.status(500).json({
      status: "error",
      message: "Помилка при зверненні до OpenAI",
      details: error?.message || "Unknown error"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
