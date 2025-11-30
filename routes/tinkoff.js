import express from "express";
import { db } from "../firebase.js";  // 🔹 импорт Firestore
import fetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";

const router = express.Router();

// === Константы Tinkoff ===
const TINKOFF_TERMINAL_KEY = "1691507148627";
const TINKOFF_PASSWORD = "rlkzhollw74x8uvv";
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";

// === Генерация токена Init ===
function generateTinkoffTokenInit({ Amount, CustomerKey, Description, OrderId, RebillId }) {
  // для рекуррентных платежей RebillId учитывается в токене
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${RebillId || ""}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Init RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена Finish ===
function generateTinkoffTokenFinish({ Amount, CustomerKey, Description, OrderId, PaymentId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Finish RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}


// === Получение RebillId через GetState ===
async function getTinkoffState(paymentId) {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
  };

  // Токен для GetState
  const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

  const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  console.log("📥 Tinkoff GetState response:", data);

  return data.RebillId || null;
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

// === Init платежа ===
router.post("/init", async (req, res) => {
  console.log("➡️ /api/init BODY:", req.body);

  try {
    const { amount, userId, orderId, description, rebillId } = req.body;

    if (!amount || !userId || !description) {
      console.log("❌ Missing params");
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);

    const finalOrderId =
      (orderId || `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`).slice(0, 36);

    console.log("🧾 Amount RUB:", amount, "Kopecks:", amountKop);
    console.log("🧾 OrderId:", finalOrderId);

    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: finalOrderId,
      RebillId: rebillId || ""
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: finalOrderId,
      Description: description,
      CustomerKey: userId,
      Token: token,
      Receipt: {
        Email: "test@example.com",
        Taxation: "osn",
        Items: [
          {
            Name: description,
            Price: amountKop,
            Quantity: 1,
            Amount: amountKop,
            Tax: "none",
          },
        ],
      },
      RebillId: rebillId || "", // пустой для разового, ID для рекуррентного
    };

    const data = await postTinkoff("Init", payload);
    if (!data.Success) {
      console.log("❌ Tinkoff Init failed");
      return res.status(400).json(data);
    }

    console.log("🔥 Saving new order to Firestore");
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(finalOrderId)
      .set({
        orderId: finalOrderId,
        amountKop,
        currency: "RUB",
        description,
        tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
        rebillId: data.RebillId || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId: finalOrderId,
      rebillId: data.RebillId || null
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === FinishAuthorize платежа ===
router.post("/finish-authorize", async (req, res) => {
  try {
    const { userId, orderId, paymentId, amount, description } = req.body;
    if (!userId || !orderId || !paymentId || !amount || !description) {
      return res.status(400).json({ error: "Missing params" });
    }

    const amountKop = Math.round(amount * 100);

    // Генерируем токен и вызываем FinishAuthorize
    const token = generateTinkoffTokenFinish({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      PaymentId: paymentId,
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      Token: token,
    };

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    // ✅ Получаем RebillId после FinishAuthorize
    const rebillId = await getTinkoffState(paymentId);

    // Обновляем заказ в Firestore с RebillId
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update({
        tinkoff: { ...data },
        rebillId,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ ...data, rebillId });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});


export default router;
