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
        message: "Поле prompt є обов’язковим",
      });
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: `Ти AI-агент, який допомагає створювати workflow для n8n.
Користувач написав: "${userRequest}"

Поверни коротку структуровану відповідь українською:
1. Що потрібно зробити
2. Які ноди n8n потрібні
3. Яка логіка між нодами
4. Який результат очікується`,
    });

    return res.json({
      status: "ok",
      result: response.output_text,
    });
  } catch (error) {
    console.error("OpenAI error:", error);

    return res.status(500).json({
      status: "error",
      message: "Помилка при зверненні до OpenAI",
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
