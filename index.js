import express from "express";
import cors from "cors";
import tinkoffRouter from "./routes/tinkoff.js";

const app = express();
app.use(cors());
app.use(express.json());

// Логируем все запросы
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`, req.body || "");
  next();
});

// Маршруты Tinkoff
app.use("/api", tinkoffRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
