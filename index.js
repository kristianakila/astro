import express from "express";
import cors from "cors";
import tinkoffRouter from "./routes/tinkoff.js";

const app = express();

// === CORS ===
app.use(cors());

// === JSON парсер с логированием ===
app.use(express.json({
  strict: true, // строгое парсирование JSON
}));

// Middleware логирования входящих запросов
app.use((req, res, next) => {
  console.log(`📥 Incoming ${req.method} ${req.url}`);
  console.log("📦 Body:", req.body);
  next();
});

// Middleware обработки ошибок JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    console.error("❌ JSON parse error:", err.message);
    return res.status(400).json({ error: "Invalid JSON" });
  }
  next();
});

// === Health-check ===
app.get("/health", (req, res) => {
  console.log("💚 Health check ping");
  res.json({ status: "ok", timestamp: Date.now() });
});

// === Tinkoff API routes ===
app.use("/api", tinkoffRouter);

// === Catch-all обработка 404 ===
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// === Ошибки сервера ===
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
