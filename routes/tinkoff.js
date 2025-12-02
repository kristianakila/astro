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

// === Генерация токена Init ===
function generateTinkoffTokenInit({
  Amount,
  CustomerKey,
  Description,
  OrderId,
  RebillId,
  Recurrent,
  PayType,
  Language,
  NotificationURL
}) {
  const params = [
    { key: "Amount", value: Amount.toString() },
    { key: "CustomerKey", value: CustomerKey },
    { key: "Description", value: Description },
    { key: "OrderId", value: OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "TerminalKey", value: TINKOFF_TERMINAL_KEY }
  ];

  // Добавляем опциональные параметры
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

  // Добавляем NotificationURL в токен, если он есть
  if (NotificationURL && NotificationURL.trim() !== "") {
    params.push({ key: "NotificationURL", value: NotificationURL });
  }

  // Сортируем по алфавиту по ключу
  params.sort((a, b) => a.key.localeCompare(b.key));

  // Конкатенируем значения
  const raw = params.map(p => p.value).join("");
  console.log("🔐 Token Init RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена FinishAuthorize ===
function generateTinkoffTokenFinish({ Amount, OrderId, PaymentId, NotificationURL }) {
  const params = [
    { key: "Amount", value: Amount.toString() },
    { key: "OrderId", value: OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "PaymentId", value: PaymentId },
    { key: "TerminalKey", value: TINKOFF_TERMINAL_KEY }
  ];

  // Добавляем NotificationURL в токен, если он есть
  if (NotificationURL && NotificationURL.trim() !== "") {
    params.push({ key: "NotificationURL", value: NotificationURL });
  }

  params.sort((a, b) => a.key.localeCompare(b.key));
  const raw = params.map(p => p.value).join("");
  console.log("🔐 Token FinishAuthorize RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Получение RebillId через GetState ===
async function getTinkoffState(paymentId) {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId
  };

  const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

  const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  console.log(`📥 Tinkoff response (${method}):`, data);

  return data;
}

// === Init платежа ===
router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;

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
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: NOTIFICATION_URL
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Token: token,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      PayType: "O", // One-click оплата (обязательно для рекуррента)
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
        rebillId: null,
        recurrent: recurrent,
        payType: "O",
        notificationUrl: NOTIFICATION_URL,
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
      OrderId: orderId,
      PaymentId: paymentId,
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

    // Получаем RebillId после первой оплаты
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
        finishedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({ ...data, rebillId, notificationUrl: NOTIFICATION_URL });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Проверка состояния платежа и получение RebillId ===
router.post("/check-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    
    if (!paymentId) {
      return res.status(400).json({ error: "Missing paymentId" });
    }

    const rebillId = await getTinkoffState(paymentId);

    res.json({
      paymentId,
      rebillId,
      hasRebill: !!rebillId,
      notificationUrl: NOTIFICATION_URL
    });
  } catch (err) {
    console.error("❌ /check-payment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Полная проверка платежа ===
router.post("/debug-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId
    };

    const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
    payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

    const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();

    res.json({
      paymentId,
      status: data.Status,
      success: data.Success,
      errorCode: data.ErrorCode,
      errorMessage: data.Message,
      rebillId: data.RebillId || data.PaymentData?.RebillId,
      cardId: data.CardId,
      pan: data.Pan,
      notificationUrl: NOTIFICATION_URL,
      fullResponse: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Обработчик вебхука от Tinkoff ===
router.post("/webhook", async (req, res) => {
  try {
    const notification = req.body;
    console.log("📨 Tinkoff Webhook received:", notification);
    console.log("🌐 Webhook URL:", NOTIFICATION_URL);

    // Проверяем подпись (опционально, но рекомендуется)
    // const token = generateWebhookToken(notification);
    // if (token !== notification.Token) {
    //   return res.status(401).json({ error: "Invalid signature" });
    // }

    // Проверяем успешность платежа
    if (notification.Success && notification.Status === "CONFIRMED") {
      const { OrderId, PaymentId, RebillId, CustomerKey } = notification;

      console.log("✅ Payment confirmed! RebillId:", RebillId);

      if (RebillId) {
        // Сохраняем RebillId в Firestore
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

      // Тут можно добавить логику для отправки уведомлений пользователю
      // или обновления баланса
    }

    // Всегда возвращаем успешный ответ Tinkoff
    res.json({ Success: true });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    // Все равно возвращаем успех, чтобы Tinkoff не отправлял повторно
    res.json({ Success: true });
  }
});

// === Генерация токена для вебхука (для проверки подписи) ===
function generateWebhookToken(notification) {
  const params = [
    { key: "Amount", value: notification.Amount.toString() },
    { key: "OrderId", value: notification.OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "PaymentId", value: notification.PaymentId },
    { key: "Status", value: notification.Status },
    { key: "TerminalKey", value: notification.TerminalKey }
  ];

  // Если есть дополнительные поля
  if (notification.RebillId) {
    params.push({ key: "RebillId", value: notification.RebillId });
  }

  // Добавляем NotificationURL, если он есть в уведомлении
  if (notification.NotificationURL) {
    params.push({ key: "NotificationURL", value: notification.NotificationURL });
  }

  params.sort((a, b) => a.key.localeCompare(b.key));
  const raw = params.map(p => p.value).join("");

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export default router;
