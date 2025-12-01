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

// === Генерация токена Init (СТРОГО В ТАКОМ ПОРЯДКЕ) ===
function generateTinkoffTokenInit({ Amount, OrderId, Description, Recurrent, CustomerKey }) {
  // Важно: порядок параметров для токена должен совпадать с документацией
  // В документации: TerminalKey + Amount + OrderId + Description + Recurrent + CustomerKey + Token
  // Но для генерации токена: Amount + OrderId + Description + Recurrent + CustomerKey + Password + TerminalKey
  const raw = `${Amount}${OrderId}${Description}${Recurrent}${CustomerKey}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Init RAW:", raw);
  console.log("🔐 Token Init params:", { Amount, OrderId, Description, Recurrent, CustomerKey });
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена Finish ===
function generateTinkoffTokenFinish({ Amount, OrderId, Description, PaymentId }) {
  const raw = `${Amount}${OrderId}${Description}${PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
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

  return data.RebillId || data.PaymentData?.RebillId || null;
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  console.log(`📤 Tinkoff request: ${method}`, JSON.stringify(payload, null, 2));

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
    const { amount, userId, description, email = "test@example.com", phone = "" } = req.body;

    if (!amount || !userId || !description) {
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);
    
    // Для рекуррентного платежа
    const recurrent = "Y";
    const customerKey = userId.toString();

    // Генерация токена в правильном порядке
    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      Recurrent: recurrent,
      CustomerKey: customerKey,
    });

    // Payload СТРОГО в порядке из документации
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Token: token,
      Description: description,
      CustomerKey: customerKey,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: "https://astro-1-nns5.onrender.com/api/notification",
      SuccessURL: "https://astro-1-nns5.onrender.com/success",
      FailURL: "https://astro-1-nns5.onrender.com/fail",
      Receipt: {
        Email: email,
        Phone: phone,
        Taxation: "usn_income",
        Items: [
          {
            Name: description.substring(0, 128), // Максимум 128 символов
            Price: amountKop,
            Quantity: 1.00,
            Amount: amountKop,
            PaymentMethod: "full_payment",
            PaymentObject: "service",
            Tax: "none",
          },
        ],
      },
    };

    console.log("📤 Sending payload to Tinkoff:", JSON.stringify(payload, null, 2));

    const data = await postTinkoff("Init", payload);
    
    if (!data.Success) {
      console.error("❌ Tinkoff error:", data);
      return res.status(400).json({
        error: "Tinkoff API error",
        details: data,
      });
    }

    // Сохраняем заказ в Firestore
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop,
        amount: amount,
        currency: "RUB",
        description,
        userId,
        email,
        phone,
        tinkoff: { 
          PaymentId: data.PaymentId, 
          PaymentURL: data.PaymentURL,
          Status: data.Status 
        },
        rebillId: null,
        isRecurrent: true,
        status: "created",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      success: true,
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: null,
      isRecurrent: true,
      status: data.Status,
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ 
      error: err.message,
      stack: err.stack 
    });
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
      Description: description,
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
        "tinkoff.Status": data.Status,
        "tinkoff.Response": data,
        rebillId,
        isRecurrent: !!rebillId,
        status: data.Status === "CONFIRMED" ? "success" : "pending",
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ 
      success: data.Success,
      status: data.Status,
      rebillId,
      isRecurrent: !!rebillId,
      message: data.Message 
    });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Уведомления от Tinkoff ===
router.post("/notification", async (req, res) => {
  try {
    const notification = req.body;
    console.log("📨 Tinkoff notification received:", notification);

    // Проверяем токен уведомления
    const tokenData = `${notification.TerminalKey}${notification.OrderId}${notification.Success}${notification.Status}${notification.PaymentId}${notification.Amount}${TINKOFF_PASSWORD}`;
    const expectedToken = crypto.createHash("sha256").update(tokenData, "utf8").digest("hex");

    if (notification.Token !== expectedToken) {
      console.error("❌ Invalid notification token");
      return res.status(400).json({ error: "Invalid token" });
    }

    // Ищем заказ по OrderId
    const ordersSnapshot = await db
      .collectionGroup("orders")
      .where("orderId", "==", notification.OrderId)
      .get();

    if (!ordersSnapshot.empty) {
      const orderDoc = ordersSnapshot.docs[0];
      const orderData = orderDoc.data();
      
      await orderDoc.ref.update({
        "tinkoff.notification": notification,
        status: notification.Success ? "success" : "failed",
        rebillId: notification.RebillId || notification.PaymentData?.RebillId || orderData.rebillId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`✅ Order ${notification.OrderId} updated with notification`);
    }

    // Всегда возвращаем OK Tinkoff
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /notification error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Проверка статуса платежа ===
router.post("/check-status", async (req, res) => {
  try {
    const { orderId, userId } = req.body;
    
    if (!orderId || !userId) {
      return res.status(400).json({ error: "Missing orderId or userId" });
    }

    const orderDoc = await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const orderData = orderDoc.data();
    
    // Если есть PaymentId, можно запросить статус у Tinkoff
    if (orderData.tinkoff?.PaymentId) {
      const payload = {
        TerminalKey: TINKOFF_TERMINAL_KEY,
        PaymentId: orderData.tinkoff.PaymentId,
      };

      const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
      payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

      const tinkoffResp = await postTinkoff("GetState", payload);
      
      // Обновляем статус в БД
      if (tinkoffResp.Success) {
        await orderDoc.ref.update({
          "tinkoff.Status": tinkoffResp.Status,
          status: tinkoffResp.Status === "CONFIRMED" ? "success" : "pending",
          rebillId: tinkoffResp.RebillId || orderData.rebillId,
        });
        
        orderData.tinkoff.Status = tinkoffResp.Status;
        orderData.status = tinkoffResp.Status === "CONFIRMED" ? "success" : "pending";
        orderData.rebillId = tinkoffResp.RebillId || orderData.rebillId;
      }
    }

    res.json({
      success: true,
      order: orderData,
    });
  } catch (err) {
    console.error("❌ /check-status error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
