import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { db } from "../firebase.js";

const router = express.Router();

// === Tinkoff ===
const TINKOFF_TERMINAL_KEY = process.env.TINKOFF_TERMINAL_KEY;
const TINKOFF_PASSWORD = process.env.TINKOFF_PASSWORD;
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";

// === Генерация токена Init / Recurrent ===
function generateTinkoffToken(payload) {
  // сортировка ключей по алфавиту
  const keys = Object.keys(payload).sort();
  const str = keys.map(k => payload[k] || "").join("") + TINKOFF_PASSWORD + TINKOFF_TERMINAL_KEY;
  console.log("🔐 Token RAW:", str);
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  console.log(`📤 Tinkoff request: ${method}`, payload);
  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  console.log(`📥 Tinkoff response (${method}):`, data);
  return data;
}

// === Init / Recurrent ===
router.post("/init-payment", async (req, res) => {
  try {
    const { amount, customerKey, email, description, productType, rebillId } = req.body;

    if (!amount || !customerKey || !description) 
      return res.status(400).json({ error: "Missing params" });

    const orderId = `${customerKey}-${Date.now()}`;
    const payload = {
      Amount: amount,
      CustomerKey: customerKey,
      Description: description,
      Email: email || "test@example.com",
      OrderId: orderId,
      RebillId: rebillId || "",
    };

    payload.Token = generateTinkoffToken(payload);
    payload.TerminalKey = TINKOFF_TERMINAL_KEY;

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    // сохраняем в Firebase
    await db.collection("telegramUsers")
      .doc(customerKey)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amount,
        description,
        productType,
        tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
        rebillId: data.RebillId || null,
        createdAt: new Date(),
      });

    res.json({ PaymentURL: data.PaymentURL, PaymentId: data.PaymentId, orderId, rebillId: data.RebillId || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// === FinishAuthorize ===
router.post("/finish-authorize", async (req, res) => {
  try {
    const { customerKey, orderId, paymentId, amount, description } = req.body;
    if (!customerKey || !orderId || !paymentId) return res.status(400).json({ error: "Missing params" });

    const payload = { Amount: amount, CustomerKey: customerKey, Description: description, OrderId: orderId, PaymentId: paymentId };
    payload.Token = generateTinkoffToken(payload);
    payload.TerminalKey = TINKOFF_TERMINAL_KEY;

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    await db.collection("telegramUsers")
      .doc(customerKey)
      .collection("orders")
      .doc(orderId)
      .update({ tinkoff: { ...data }, finishedAt: new Date() });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
