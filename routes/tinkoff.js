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
function generateTinkoffTokenInit({
  Amount,
  CustomerKey,
  Description,
  OrderId,
  RebillId,
  Recurrent,
  PayType,
  Language
}) {
  const params = [
    { key: "Amount", value: Amount.toString() },
    { key: "CustomerKey", value: CustomerKey },
    { key: "Description", value: Description },
    { key: "OrderId", value: OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "TerminalKey", value: TINKOFF_TERMINAL_KEY }
  ];

  if (RebillId && RebillId.trim() !== "") {
    params.push({ key: "RebillId", value: RebillId });
  }

  if (Recurrent && Recurrent.trim() !== "") {
    params.push({ key: "Recurrent", value: Recurrent });
  }

  if (PayType && PayType.trim() !== "") {
    params.push({ key: "PayType", value: PayType });
  }

  if (Language && Language.trim() !== "") {
    params.push({ key: "Language", value: Language });
  }

  params.sort((a, b) => a.key.localeCompare(b.key));

  const raw = params.map(p => p.value).join("");
  console.log("🔐 Token Init RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  console.log(`📤 Tinkoff request: ${method}`, payload);

  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  console.log(`📥 Tinkoff response (${method}):`, data);

  return data;
}

// ==========================================================================================
// === INIT ПЛАТЕЖА ==========================================================================
// ==========================================================================================

router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;

    if (!amount || !userId || !description) {
      return res
        .status(400)
        .json({ error: "Missing amount, userId or description" });
    }

    const amountKop = Math.round(amount * 100);

    const orderId = `ORD-${Date.now()}-${Math.floor(
      1000 + Math.random() * 9000
    )}`.slice(0, 36);

    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      RebillId: "",
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru"
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Token: token,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL:
        "https://astro-1-nns5.onrender.com/api/tinkoff/webhook",
      Receipt: {
        Email: "test@example.com",
        Taxation: "usn_income",
        Items: [
          {
            Name: description,
            Price: amountKop,
            Quantity: 1,
            Amount: amountKop,
            Tax: "none"
          }
        ]
      }
    };

    const data = await postTinkoff("Init", payload);

    if (!data.Success) {
      console.log("❌ Tinkoff Init error:", data);
      return res.status(400).json(data);
    }

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
        tinkoff: {
          PaymentId: data.PaymentId,
          PaymentURL: data.PaymentURL
        },
        rebillId: null,
        recurrent,
        payType: "O",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    return res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: null,
      recurrent
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================================================
// === ВЕБХУК ТИНЬКОФФ ======================================================================
// ==========================================================================================

router.post("/webhook", async (req, res) => {
  try {
    const notification = req.body;
    console.log("📨 Tinkoff Webhook received:", notification);

    if (notification.Success && notification.Status === "CONFIRMED") {
      const { OrderId, RebillId, CustomerKey } = notification;

      console.log("✅ Payment confirmed! RebillId:", RebillId);

      if (RebillId) {
        await db
          .collection("telegramUsers")
          .doc(CustomerKey)
          .collection("orders")
          .doc(OrderId)
          .update({
            rebillId: RebillId,
            tinkoffNotification: notification,
            notifiedAt: admin.firestore.FieldValue.serverTimestamp()
          });

        console.log(`💾 RebillId ${RebillId} saved for order ${OrderId}`);
      }
    }

    res.json({ Success: true });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.json({ Success: true });
  }
});

export default router;
