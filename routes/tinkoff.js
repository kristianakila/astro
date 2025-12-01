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

// === Генерация токена Init ===
function generateTinkoffTokenInit({ Amount, CustomerKey, Description, OrderId, RebillId, Recurrent }) {
  // Важно: параметры должны быть в алфавитном порядке
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${RebillId || ""}${Recurrent || ""}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Init RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена Finish ===
function generateTinkoffTokenFinish({ Amount, CustomerKey, Description, OrderId, PaymentId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Finish RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена для Charge (повторный платеж) ===
function generateTinkoffTokenCharge({ Amount, OrderId, RebillId }) {
  const raw = `${Amount}${OrderId}${RebillId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Charge RAW:", raw);
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

  // RebillId вернётся только если карта привязана для рекуррентного платежа
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

// === Init платежа ===
router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, rebillId, isRecurrent } = req.body;

    if (!amount || !userId || !description) {
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    // Определяем, нужно ли создавать рекуррентный платеж
    const recurrentFlag = isRecurrent ? "Y" : "";

    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      RebillId: rebillId || "", // пусто для новой рекуррентной операции
      Recurrent: recurrentFlag,
    });

    // Формируем payload с параметрами в алфавитном порядке
    const payload = {
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      RebillId: rebillId || "",
      Recurrent: recurrentFlag,
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Token: token,
      Receipt: {
        Email: "test@example.com",
        Taxation: "usn_income",
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
    };

    // Дополнительные параметры для сохранения карты
    if (isRecurrent && !rebillId) {
      payload.SaveCard = true; // Сохранить карту для будущих платежей
    }

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    // Сохраняем заказ в Firestore
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop,
        amount,
        currency: "RUB",
        description,
        isRecurrent: !!isRecurrent,
        tinkoff: { 
          PaymentId: data.PaymentId, 
          PaymentURL: data.PaymentURL,
          Status: data.Status,
        },
        rebillId: rebillId || null, // сохраняем rebillId если передан
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: rebillId || null,
      isRecurrent: !!isRecurrent,
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

    const token = generateTinkoffTokenFinish({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      PaymentId: paymentId,
    });

    const payload = {
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      PaymentId: paymentId,
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Token: token,
    };

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    // ✅ Получаем RebillId после первой оплаты (если платеж был рекуррентным)
    let rebillId = null;
    if (data.Status === "AUTHORIZED" || data.Status === "CONFIRMED") {
      rebillId = await getTinkoffState(paymentId);
    }

    // Обновляем заказ в Firestore
    const updateData = {
      tinkoff: { ...data },
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (rebillId) {
      updateData.rebillId = rebillId;
    }

    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update(updateData);

    res.json({ ...data, rebillId });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Проведение платежа по сохраненным реквизитам (Charge) ===
router.post("/charge", async (req, res) => {
  try {
    const { userId, rebillId, amount, description } = req.body;
    
    if (!userId || !rebillId || !amount || !description) {
      return res.status(400).json({ error: "Missing userId, rebillId, amount, or description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `REC-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffTokenCharge({
      Amount: amountKop,
      OrderId: orderId,
      RebillId: rebillId,
    });

    // Payload в алфавитном порядке
    const payload = {
      Amount: amountKop,
      OrderId: orderId,
      RebillId: rebillId,
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Token: token,
    };

    const data = await postTinkoff("Charge", payload);
    
    // Сохраняем запись о рекуррентном платеже
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop,
        amount,
        currency: "RUB",
        description,
        isRecurrent: true,
        isCharge: true, // Флаг, что это повторный платеж
        rebillId,
        tinkoff: data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      success: data.Success,
      status: data.Status,
      paymentId: data.PaymentId,
      orderId,
      error: data.Error || null,
    });
  } catch (err) {
    console.error("❌ /charge error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
