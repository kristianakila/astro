import express from "express";
import { db } from "../firebase.js";
import fetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";

const router = express.Router();

// === Константы Tinkoff ===
const TINKOFF_TERMINAL_KEY = "1691507148627";
const TINKOFF_PASSWORD = "rlkzhollw74x8uvv";
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";

// ============================================================
// === Генератор токена Init (алфавитный порядок, Receipt = JSON string) ===
function generateTinkoffInitToken(payload) {
  // Копия payload, Receipt в виде строки
  const prepared = { ...payload, Receipt: JSON.stringify(payload.Receipt) };

  // Удаляем undefined/null
  for (const key in prepared) {
    if (prepared[key] === undefined || prepared[key] === null) delete prepared[key];
  }

  // Ключи по алфавиту
  const sortedKeys = Object.keys(prepared).sort();

  // Формируем строку key=valuekey=value... + пароль
  const raw = sortedKeys.map(k => `${k}=${prepared[k]}`).join("") + TINKOFF_PASSWORD;

  console.log("🔐 Signature Init RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// ============================================================
// === Генератор токена FinishAuthorize ===
function generateTinkoffTokenFinish({ Amount, CustomerKey, Description, OrderId, PaymentId }) {
  const raw =
    `Amount=${Amount}` +
    `CustomerKey=${CustomerKey}` +
    `Description=${Description}` +
    `OrderId=${OrderId}` +
    `PaymentId=${PaymentId}` +
    TINKOFF_PASSWORD;

  console.log("🔐 Signature Finish RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Получение RebillId через GetState ===
async function getTinkoffState(paymentId) {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
  };

  const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

  const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  console.log("📥 Tinkoff GetState response:", data);

  return data.PaymentData?.RebillId || null;
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

// ============================================================
// === Init рекуррентного платежа ===
router.post("/init", async (req, res) => {
  try {
    const { priceNextMonth, discount, userId, phone, email } = req.body;

    if (!priceNextMonth || discount === undefined || !userId) {
      return res.status(400).json({
        error: "Missing priceNextMonth, discount, userId",
      });
    }

    const finalAmount = parseInt(priceNextMonth * (1 - discount / 100));
    const amountKop = finalAmount * 100;

    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const description = `Доступ к астро-асистенту [${priceNextMonth}р./мес.]`;

    // === Receipt ===
    const receiptObject = {
      Email: email || "",
      Phone: phone || "",
      Taxation: "usn_income",
      Items: [
        {
          Name: description,
          Price: amountKop,
          Quantity: 1,
          Amount: amountKop,
          Tax: "none",
          PaymentObject: "service",
        },
      ],
    };

    // Payload для токена
    const tokenPayload = {
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      Recurrent: "1",
      Language: "ru",
      Receipt: receiptObject,
    };

    // Генерируем токен
    const token = generateTinkoffInitToken(tokenPayload);

    // Payload для POST
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      CustomerKey: userId,
      Recurrent: "1",
      Language: "ru",
      Receipt: receiptObject,
      Token: token,
    };

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    // Сохраняем заказ
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop,
        amount: finalAmount,
        description,
        tinkoff: {
          PaymentId: data.PaymentId,
          PaymentURL: data.PaymentURL,
        },
        rebillId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// === FinishAuthorize (получение RebillId после первой оплаты) ===
router.post("/finish-authorize", async (req, res) => {
  try {
    const { userId, orderId, paymentId, amount, description } = req.body;

    if (!userId || !orderId || !paymentId || !amount || !description) {
      return res.status(400).json({ error: "Missing params" });
    }

    const amountKop = Math.round(amount * 100);

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

    const rebillId = await getTinkoffState(paymentId);

    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update({
        tinkoff: data,
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
