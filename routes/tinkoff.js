import express from "express";
import { db } from "../firebase.js";
import fetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";

const router = express.Router();

const TINKOFF_TERMINAL_KEY = "1691507148627";
const TINKOFF_PASSWORD = "rlkzhollw74x8uvv";
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";

// === Генерация токена Init ===
function generateTokenInit({ Amount, CustomerKey, Description, OrderId, RebillId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${RebillId || ""}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await resp.json();
}

// === Init платеж ===
router.post("/init-payment", async (req, res) => {
  try {
    const { amount, customerKey, email, description, orderId, productType, rebillId } = req.body;

    if (!amount || !customerKey || !description || !orderId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const amountKop = Math.round(Number(amount) * 100);

    const token = generateTokenInit({ Amount: amountKop, CustomerKey: customerKey, Description: description, OrderId: orderId, RebillId: rebillId });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      CustomerKey: customerKey,
      Description: description,
      Token: token,
      Receipt: {
        Email: email,
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
      // Для рекуррентной подписки указываем RebillId
      RebillId: productType === "subscription" ? rebillId || undefined : undefined,
    };

    const data = await postTinkoff("Init", payload);

    if (!data.Success) return res.status(400).json(data);

    // === Сохраняем заказ и RebillId для подписки ===
    const orderData = {
      orderId,
      amountKop,
      description,
      productType,
      tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (productType === "subscription" && data.RebillId) {
      orderData.rebillId = data.RebillId;
    }

    await db.collection("telegramUsers")
      .doc(customerKey)
      .collection("orders")
      .doc(orderId)
      .set(orderData);

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      RebillId: data.RebillId || null,
    });
  } catch (err) {
    console.error("❌ /init-payment error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
