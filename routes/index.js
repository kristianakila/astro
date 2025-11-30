// index.js
import express from "express";
import cors from "cors";
import paymentsRouter from "./routes/payments.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health & root
app.get("/", (req, res) => res.json({ ok: true, service: "tinkoff-payments-backend" }));
app.get("/health", (req, res) => res.send("OK"));

// API
app.use("/api/payments", paymentsRouter);

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
