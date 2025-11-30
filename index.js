import express from "express";
import cors from "cors";
import tinkoffRouter from "./routes/tinkoff.js";

const app = express();
app.use(cors());
app.use(express.json());

// === Health-check ===
app.get("/health", (req, res) => {
  console.log("💚 Health check ping");
  res.json({ status: "ok", timestamp: Date.now() });
});

// === Tinkoff API routes ===
app.use("/api", tinkoffRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
