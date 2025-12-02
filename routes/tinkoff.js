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

// === Универсальная генерация токена ===
function generateTinkoffTokenInit(params) {
  // Собираем все параметры
  const paramsMap = new Map();
  
  // Обязательно добавляем все возможные параметры
  if (params.Amount !== undefined && params.Amount !== "") paramsMap.set("Amount", params.Amount.toString());
  if (params.CustomerKey) paramsMap.set("CustomerKey", params.CustomerKey);
  if (params.Description) paramsMap.set("Description", params.Description);
  if (params.OrderId) paramsMap.set("OrderId", params.OrderId);
  if (params.PaymentId) paramsMap.set("PaymentId", params.PaymentId);
  if (params.RebillId) paramsMap.set("RebillId", params.RebillId);
  if (params.Recurrent) paramsMap.set("Recurrent", params.Recurrent);
  if (params.PayType) paramsMap.set("PayType", params.PayType);
  if (params.Language) paramsMap.set("Language", params.Language);
  if (params.NotificationURL) paramsMap.set("NotificationURL", params.NotificationURL);
  if (params.Status) paramsMap.set("Status", params.Status);
  if (params.OperationInitiatorType) paramsMap.set("OperationInitiatorType", params.OperationInitiatorType);
  
  // Обязательные для всех запросов
  paramsMap.set("Password", TINKOFF_PASSWORD);
  paramsMap.set("TerminalKey", TINKOFF_TERMINAL_KEY);
  
  // Сортируем по ключу (алфавитный порядок)
  const sortedKeys = Array.from(paramsMap.keys()).sort();
  
  // Формируем строку
  const raw = sortedKeys.map(key => paramsMap.get(key)).join("");
  
  console.log("🔐 Token RAW string:", raw);
  console.log("🔐 Token params order:", sortedKeys);
  console.log("🔐 Token params values:", sortedKeys.map(key => `${key}:${paramsMap.get(key)}`));
  
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  console.log(`📤 Sending to Tinkoff ${method}:`, payload);
  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  console.log(`📥 Response from Tinkoff ${method}:`, data);
  return data;
}

// === Получение RebillId через GetState ===
async function getTinkoffState(paymentId) {
  const token = generateTinkoffTokenInit({ PaymentId: paymentId });
  const resp = await postTinkoff("GetState", { 
    TerminalKey: TINKOFF_TERMINAL_KEY, 
    PaymentId: paymentId, 
    Token: token 
  });
  return resp.RebillId || resp.PaymentData?.RebillId || null;
}

// === Поиск заказа по OrderId ===
async function findOrderByOrderId(orderId) {
  const usersSnapshot = await db.collection("telegramUsers").get();
  for (const userDoc of usersSnapshot.docs) {
    const orderRef = db.collection("telegramUsers").doc(userDoc.id).collection("orders").doc(orderId);
    const orderDoc = await orderRef.get();
    if (orderDoc.exists) return { userId: userDoc.id, orderRef, orderData: orderDoc.data() };
  }
  return null;
}

// === Init платежа ===
router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;
    if (!amount || !userId || !description) return res.status(400).json({ error: "Missing amount, userId, description" });

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffTokenInit({
      Amount: amountKop, 
      CustomerKey: userId, 
      Description: description,
      OrderId: orderId, 
      Recurrent: recurrent,
      PayType: "O", 
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
      PayType: "O",
      NotificationURL: NOTIFICATION_URL
    };

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    await db.collection("telegramUsers").doc(userId).collection("orders").doc(orderId).set({
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
    console.error("❌ Error in /init:", err);
    res.status(500).json({ error: err.message }); 
  }
});

// === Рекуррентное списание по RebillId (MIT COF Recurring) ===
router.post("/recurrent-charge", async (req, res) => {
  try {
    console.log("📥 Incoming /recurrent-charge request:", req.body);
    
    const { userId, rebillId, amount, description } = req.body;
    if (!userId || !rebillId || !amount || !description)
      return res.status(400).json({ error: "Missing params" });

    const amountKop = Math.round(amount * 100);
    const orderId = `RC-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    // Генерация токена с правильным порядком параметров
    const tokenParams = {
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      NotificationURL: NOTIFICATION_URL,
      OperationInitiatorType: "R", // ключевой параметр для MIT COF
      OrderId: orderId,
      PayType: "O",
      RebillId: rebillId,
      // TerminalKey и Password добавляются автоматически в функции
    };
    
    console.log("🔧 Token generation params for recurrent:", tokenParams);
    
    const token = generateTinkoffTokenInit(tokenParams);

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      RebillId: rebillId,
      CustomerKey: userId,
      Description: description,
      NotificationURL: NOTIFICATION_URL,
      OperationInitiatorType: "R", // MIT транзакция
      PayType: "O", // Одностадийная оплата
      Token: token
    };

    console.log("🚀 Sending recurrent charge to Tinkoff:", payload);
    
    // Используем метод Init с параметром RebillId для рекуррентного списания
    const data = await postTinkoff("Init", payload);
    
    if (!data.Success) {
      console.error("❌ Tinkoff rejected recurrent charge:", data);
      return res.status(400).json({
        error: "Tinkoff rejected recurrent charge",
        tinkoffError: data,
        paramsUsed: tokenParams
      });
    }

    console.log("✅ Recurrent charge successful:", data);

    // Сохраняем новый заказ в Firestore
    await db.collection("telegramUsers").doc(userId).collection("orders").doc(orderId).set({
      orderId,
      amountKop,
      currency: "RUB",
      description,
      tinkoff: { ...data },
      rebillId,
      recurrent: "Y",
      notificationUrl: NOTIFICATION_URL,
      customerKey: userId,
      operationInitiatorType: "R",
      isRecurrentCharge: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ 
      ...data, 
      rebillId, 
      orderId,
      notificationUrl: NOTIFICATION_URL,
      message: "Recurrent charge initiated successfully"
    });
  } catch (err) {
    console.error("❌ Error in /recurrent-charge:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Вебхук Tinkoff ===
router.post("/webhook", async (req, res) => {
  try {
    const n = req.body;
    console.log("📨 Webhook received:", n);

    if (n.Success && n.Status === "CONFIRMED") {
      let userId = n.CustomerKey || n.customerKey;
      let orderRef = userId ? db.collection("telegramUsers").doc(userId).collection("orders").doc(n.OrderId) : null;
      const orderDoc = orderRef ? await orderRef.get() : null;

      if (!orderDoc?.exists) {
        const found = await findOrderByOrderId(n.OrderId);
        if (found) { 
          userId = found.userId; 
          orderRef = found.orderRef; 
        }
      }

      if (userId && orderRef) {
        const updateData = { 
          tinkoffNotification: n, 
          notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: n.Status,
          lastWebhook: new Date().toISOString()
        };
        if (n.RebillId) updateData.rebillId = n.RebillId;
        if (n.PaymentId) updateData.paymentId = n.PaymentId;
        
        await orderRef.update(updateData);
        console.log(`✅ Webhook processed for order ${n.OrderId}, user ${userId}`);
      } else {
        await db.collection("unprocessedWebhooks").add({ 
          orderId: n.OrderId, 
          paymentId: n.PaymentId, 
          rebillId: n.RebillId, 
          customerKey: userId, 
          notification: n, 
          receivedAt: admin.firestore.FieldValue.serverTimestamp() 
        });
        console.log(`⚠️ Webhook saved as unprocessed for order ${n.OrderId}`);
      }
    } else {
      console.log(`ℹ️ Webhook with status ${n.Status}, success: ${n.Success}`);
    }
    
    res.json({ Success: true });
  } catch (err) { 
    console.error("❌ Webhook error:", err); 
    res.json({ Success: true });
  }
});

export default router;
