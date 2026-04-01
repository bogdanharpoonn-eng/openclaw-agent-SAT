import express from "express";

const app = express();

app.use(express.json());

// перевірка сервера
app.get("/", (req, res) => {
  res.send("OpenClaw agent is running 🚀");
});

// 🔥 ОСНОВНИЙ ENDPOINT
app.post("/generate-workflow", (req, res) => {
  const userRequest = req.body.prompt;

  console.log("Запит:", userRequest);

  // поки що тестова відповідь
  res.json({
    status: "ok",
    message: "Workflow generated (test)",
    input: userRequest
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
