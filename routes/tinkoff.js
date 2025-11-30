import express from "express";
import { db } from "../firebase.js"; // Firestore
import fetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";

const router = express.Router();

// === Константы Tinkoff ===
const TINKOFF_TERMINAL_KEY = "1691507148627";
const TINKOFF_PASSWORD = "rlkzhollw74x8uvv";
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";

// === Генерация токена Init ===
function generateTinkoffTokenInit({ Amount, CustomerKey, Description, OrderId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Init RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена Finish ===
function generateTinkoffTokenFinish({ Amount, CustomerKey, Description, OrderId, PaymentId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Finish RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
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

// === Init платежа (разовый или подписка) ===
router.post("/init-payment", async (req, res) => {
  console.log("➡️ /api/init-payment BODY:", req.body);

  try {
    const { amount, customerKey, email, description, productType, rebillId } = req.body;
    if (!amount || !customerKey || !description || !productType) {
      return res.status(400).json({ error: "Missing params" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `${customerKey}-${Date.now()}`;

    // === payload для Init ===
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      CustomerKey: customerKey,
      Receipt: {
        Email: email || "test@example.com",
        Taxation: "osn",
        Items: [{ Name: description, Price: amountKop, Quantity: 1, Amount: amountKop, Tax: "none" }]
      },
    };

    // === Если это подписка и rebillId есть → InitRecurring ===
    if (productType === "subscription" && rebillId) {
      payload.RebillId = rebillId; // использовать существующий rebillId
    } else if (productType === "subscription") {
      payload.Recurrent = true; // первый рекуррентный платеж создаёт rebillId
    }

    // Генерация токена
    payload.Token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: customerKey,
      Description: description,
      OrderId: orderId,
    });

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    // === Firestore запись заказа ===
    const orderRef = db.collection("telegramUsers").doc(customerKey).collection("orders").doc(orderId);
    await orderRef.set({
      orderId,
      amountKop,
      description,
      productType,
      tinkoff: {
        PaymentId: data.PaymentId,
        PaymentURL: data.PaymentURL,
        RebillId: data.RebillId || null
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // === Если первый рекуррентный платеж, сохраняем RebillId в профиль пользователя ===
    if (productType === "subscription" && data.RebillId) {
      await db.collection("telegramUsers").doc(customerKey).set(
        { subscription: { rebillId: data.RebillId } },
        { merge: true }
      );
    }

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      RebillId: data.RebillId || null,
      orderId,
    });

  } catch (err) {
    console.error("❌ /init-payment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === FinishAuthorize ===
router.post("/finish-authorize", async (req, res) => {
  console.log("➡️ /api/finish-authorize BODY:", req.body);

  try {
    const { customerKey, orderId, paymentId, amount, description } = req.body;
    if (!customerKey || !orderId || !paymentId || !amount || !description) {
      return res.status(400).json({ error: "Missing params" });
    }

    const amountKop = Math.round(amount * 100);
    const token = generateTinkoffTokenFinish({
      Amount: amountKop,
      CustomerKey: customerKey,
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

    await db
      .collection("telegramUsers")
      .doc(customerKey)
      .collection("orders")
      .doc(orderId)
      .update({
        tinkoff: { ...data },
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json(data);

  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
