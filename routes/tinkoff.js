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
const NOTIFICATION_URL = "https://astro-1-nns5.onrender.com/api/webhook";

// === Универсальная генерация токена (по твоему Init) ===
function generateTinkoffToken(paramsObj) {
  const params = Object.entries(paramsObj)
    .filter(([k, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, value]) => ({ key, value: value.toString() }));

  params.push({ key: "Password", value: TINKOFF_PASSWORD });
  params.push({ key: "TerminalKey", value: TINKOFF_TERMINAL_KEY });

  params.sort((a, b) => a.key.localeCompare(b.key));

  const raw = params.map(p => p.value).join("");

  console.log("🔐 Token RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === POST запрос к Tinkoff ===
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

// === GetState для получения RebillId ===
async function getTinkoffState(paymentId) {
  const token = generateTinkoffToken({ PaymentId: paymentId });

  const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Token: token
    })
  });

  const data = await resp.json();
  console.log("📥 Tinkoff GetState response:", data);

  return data.PaymentData?.RebillId || null;
}

// === Поиск заказа в Firestore по OrderId ===
async function findOrderByOrderId(orderId) {
  try {
    console.log(`🔍 Поиск заказа с OrderId: ${orderId}`);

    const usersSnapshot = await db.collection("telegramUsers").get();

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const orderRef = db
        .collection("telegramUsers")
        .doc(userId)
        .collection("orders")
        .doc(orderId);

      const orderDoc = await orderRef.get();

      if (orderDoc.exists) {
        console.log(`✅ Найден заказ у пользователя ${userId}`);
        return { userId, orderData: orderDoc.data(), orderRef };
      }
    }

    console.log(`❌ Заказ не найден`);
    return null;
  } catch (error) {
    console.error("❌ Ошибка при поиске заказа:", error);
    return null;
  }
}

// === Init ===
router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;

    if (!amount || !userId || !description) {
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffToken({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: NOTIFICATION_URL
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId,
      Token: token,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: NOTIFICATION_URL,
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

    console.log("🔔 NotificationURL добавлен в запрос Init:", NOTIFICATION_URL);

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
        currency: "RUB",
        description,
        tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
        rebillId: null,
        recurrent,
        payType: "O",
        notificationUrl: NOTIFICATION_URL,
        customerKey: userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: null,
      recurrent,
      notificationUrl: NOTIFICATION_URL
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === FinishAuthorize ===
router.post("/finish-authorize", async (req, res) => {
  try {
    const { userId, orderId, paymentId, amount, description } = req.body;

    if (!userId || !orderId || !paymentId || !amount || !description) {
      return res.status(400).json({ error: "Missing params" });
    }

    const amountKop = Math.round(amount * 100);

    const token = generateTinkoffToken({
      Amount: amountKop,
      PaymentId: paymentId,
      OrderId: orderId,
      NotificationURL: NOTIFICATION_URL
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      Token: token,
      NotificationURL: NOTIFICATION_URL
    };

    console.log("🔔 NotificationURL добавлен в запрос FinishAuthorize:", NOTIFICATION_URL);

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    const rebillId = await getTinkoffState(paymentId);

    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update({
        tinkoff: { ...data },
        rebillId,
        finishedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({ ...data, rebillId, notificationUrl: NOTIFICATION_URL });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Webhook ===
router.post("/webhook", async (req, res) => {
  try {
    const notification = req.body;
    console.log("📨 Tinkoff Webhook received:", JSON.stringify(notification, null, 2));
    console.log("🌐 Webhook URL:", NOTIFICATION_URL);

    if (notification.Success && notification.Status === "CONFIRMED") {
      const { OrderId, PaymentId, RebillId } = notification;

      let userId = notification.CustomerKey || notification.customerKey;
      let orderRef = null;

      if (userId) {
        orderRef = db
          .collection("telegramUsers")
          .doc(userId)
          .collection("orders")
          .doc(OrderId);

        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) userId = null;
      }

      if (!userId) {
        const found = await findOrderByOrderId(OrderId);
        if (found) {
          userId = found.userId;
          orderRef = found.orderRef;
        }
      }

      if (userId && orderRef) {
        const updateData = {
          tinkoffNotification: notification,
          notifiedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (RebillId) updateData.rebillId = RebillId;

        await orderRef.update(updateData);
      } else {
        await db.collection("unprocessedWebhooks").add({
          orderId: OrderId,
          paymentId: PaymentId,
          rebillId: RebillId,
          customerKey: userId,
          notification,
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    res.json({ Success: true });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.json({ Success: true });
  }
});

export default router;
