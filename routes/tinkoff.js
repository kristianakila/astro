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
function generateTinkoffTokenInit({ Amount, CustomerKey, Description, OrderId, RebillId }) {
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
    const { amount, userId, description } = req.body;

    if (!amount || !userId || !description) {
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      RebillId: "", // пусто для новой рекуррентной операции
    });

const payload = {
  TerminalKey: TINKOFF_TERMINAL_KEY,
  Amount: amountKop,
  OrderId: orderId,
  Description: description,
  recurrent = "1",
  CustomerKey: userId,
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
  // Tinkoff сам создаст RebillId после первой оплаты, если пользователь сохранит карту
};



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
        currency: "RUB",
        description,
        tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
        rebillId: null, // пока нет RebillId
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: null,
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
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      Token: token,
    };

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    // ✅ Получаем RebillId после первой оплаты
    const rebillId = await getTinkoffState(paymentId);

    // Обновляем заказ в Firestore
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

// === Получение RebillId через GetState ===
// === Получение RebillId через GetState ===
router.post("/get-rebill", async (req, res) => {
  try {
    console.log("\n============================");
    console.log("🟦 /api/get-rebill START");
    console.log("============================");

    console.log("📥 Incoming body:", req.body);

    const { paymentId } = req.body;
    if (!paymentId) {
      console.log("❌ Missing paymentId");
      return res.status(400).json({ error: "Missing paymentId" });
    }

    // Логи ключей (маскируем!)
    console.log("🔐 Using TerminalKey:", String(TINKOFF_TERMINAL_KEY));
    console.log(
      "🔐 Using Password:",
      TINKOFF_PASSWORD ? TINKOFF_PASSWORD.replace(/./g, "*") : "EMPTY"
    );

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
    };

    // === Формирование токена === //
    const tokenRaw = `${payload.TerminalKey}${payload.PaymentId}${TINKOFF_PASSWORD}`;

    console.log("🧩 Token RAW string:", tokenRaw);
    console.log("🧩 RAW length:", tokenRaw.length);

    const tokenSha = crypto
      .createHash("sha256")
      .update(tokenRaw, "utf8")
      .digest("hex");

    payload.Token = tokenSha;

    console.log("🔐 Token SHA256:", tokenSha);
    console.log("🔐 Token length:", tokenSha.length);

    // === Лог URL Тинькофф === //
    const url = `${TINKOFF_API_URL}/GetState`;
    console.log("🌍 Tinkoff URL:", url);

    // === Лог тела запроса === //
    console.log("📤 Sending payload:", JSON.stringify(payload, null, 2));

    // === TRY СЕТЕВОГО ЗАПРОСА === //
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (networkErr) {
      console.error("❌ Network error while fetching Tinkoff:", networkErr);
      return res.status(500).json({
        error: "NetworkError",
        details: networkErr.message,
      });
    }

    console.log("🌐 HTTP status:", resp.status);

    let data;
    try {
      data = await resp.json();
    } catch (parseErr) {
      console.error("❌ JSON parse error:", parseErr);
      const text = await resp.text();
      console.log("🔍 Raw response text:", text);

      return res.status(500).json({
        error: "JSONParseError",
        details: parseErr.message,
        raw: text,
      });
    }

    console.log("📥 Tinkoff GetState response:", data);

    if (!data.Success) {
      console.log("❌ Tinkoff returned error:", data);
      return res.status(400).json(data);
    }

    // === УСПЕХ === //
    console.log("✅ SUCCESS RebillId:", data.RebillId);

    return res.json({
      Status: data.Status,
      RebillId: data.RebillId || null,
      PaymentId: paymentId,
    });

  } catch (err) {
    console.error("❌ GLOBAL /get-rebill error:", err);
    return res.status(500).json({ error: err.message });
  }
});



export default router;
