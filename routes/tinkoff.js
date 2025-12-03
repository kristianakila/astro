// === Tinkoff Payment Router ===

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

/* ============================================================
   🔐 Универсальная генерация токена Tinkoff
   ============================================================ */
function generateTinkoffToken(params) {
  const filtered = {};
  for (const key of Object.keys(params)) {
    if (key !== "Token" && params[key] !== undefined && params[key] !== null) {
      filtered[key] = params[key];
    }
  }

  filtered["Password"] = TINKOFF_PASSWORD;
  const sortedKeys = Object.keys(filtered).sort();
  const concatenated = sortedKeys.map((key) => `${filtered[key]}`).join("");
  
  console.log("🔐 Token string:", concatenated);
  
  return crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");
}

/* ============================================================
   POST wrapper
   ============================================================ */
async function postTinkoff(method, payload) {
  console.log(`📤 Sending ${method}:`, JSON.stringify(payload, null, 2));
  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await resp.json();
  console.log(`📥 Response ${method}:`, JSON.stringify(result, null, 2));
  return result;
}

/* ============================================================
   Генерация токена для метода Charge (ОСОБЫЙ СЛУЧАЙ!)
   В Charge используются ТОЛЬКО: TerminalKey, PaymentId, RebillId
   ============================================================ */
function generateChargeToken(paymentId, rebillId) {
  const params = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
    RebillId: rebillId,
    Password: TINKOFF_PASSWORD
  };
  
  const sortedKeys = Object.keys(params).sort();
  const concatenated = sortedKeys.map((key) => `${params[key]}`).join("");
  
  console.log("🔐 Charge Token string:", concatenated);
  
  return crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");
}

/* ============================================================
   Генерация токена для метода Init
   ============================================================ */
function generateInitToken(params) {
  const paramsWithPassword = {
    ...params,
    Password: TINKOFF_PASSWORD
  };
  
  const sortedKeys = Object.keys(paramsWithPassword).sort();
  const concatenated = sortedKeys.map((key) => `${paramsWithPassword[key]}`).join("");
  
  console.log("🔐 Init Token string:", concatenated);
  
  return crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");
}

/* ============================================================
   Проведение рекуррентного платежа
   ============================================================ */
router.post("/recurrent-charge", async (req, res) => {
  try {
    const { rebillId, amount, description = 'Автоматическое списание по подписке' } = req.body;

    if (!rebillId || !amount) {
      return res.status(400).json({ 
        error: "Missing required parameters", 
        required: ["rebillId", "amount"] 
      });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = 'recurrent-' + Date.now();

    console.log("🚀 Starting recurrent charge:");
    console.log("   RebillId:", rebillId);
    console.log("   Amount:", amountKop, "kop");
    console.log("   OrderId:", orderId);

    // 1. СОЗДАЕМ ЧЕК
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: description,
          Price: amountKop,
          Quantity: 1,
          Amount: amountKop,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // 2. ИНИЦИАЛИЗИРУЕМ ПЛАТЕЖ (Init)
    const initToken = generateInitToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    });

    const initPayload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      NotificationURL: NOTIFICATION_URL,
      Token: initToken,
      Receipt: receipt
    };

    console.log("📝 Step 1: Calling Init...");
    const initResponse = await postTinkoff("Init", initPayload);
    
    if (!initResponse.Success) {
      return res.status(400).json({ 
        error: "Init failed", 
        details: initResponse 
      });
    }

    const newPaymentId = initResponse.PaymentId;
    console.log("✅ Init successful. New PaymentId:", newPaymentId);

    // 3. ВЫПОЛНЯЕМ СПИСАНИЕ (Charge) - КЛЮЧЕВОЙ МОМЕНТ!
    console.log("📝 Step 2: Calling Charge...");
    console.log("   PaymentId:", newPaymentId);
    console.log("   RebillId:", rebillId);
    
    // Для Charge используем ОСОБУЮ функцию генерации токена
    const chargeToken = generateChargeToken(newPaymentId, rebillId);
    
    const chargePayload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      RebillId: rebillId,
      Token: chargeToken
    };

    const chargeResponse = await postTinkoff("Charge", chargePayload);
    
    console.log("💳 Charge response:", chargeResponse);

    // 4. ПРОВЕРЯЕМ СТАТУС (GetState)
    console.log("📝 Step 3: Checking status...");
    const stateToken = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId
    });

    const stateResponse = await postTinkoff("GetState", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      Token: stateToken
    });

    // 5. ФОРМИРУЕМ РЕЗУЛЬТАТ
    const result = {
      success: chargeResponse.Success || false,
      paymentId: newPaymentId,
      rebillId: rebillId,
      status: stateResponse.Status || "UNKNOWN",
      amount: amountKop / 100,
      orderId: orderId,
      chargeResponse: chargeResponse,
      stateResponse: stateResponse
    };

    // 6. СОХРАНЯЕМ
    await db.collection("recurrentCharges").doc(newPaymentId).set({
      ...result,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("🎉 Recurrent charge completed:", result);
    res.json(result);

  } catch (err) {
    console.error("❌ Recurrent charge error:", err);
    res.status(500).json({ 
      error: err.message,
      code: err.code || 'INTERNAL_ERROR'
    });
  }
});

/* ============================================================
   Упрощенный тестовый endpoint
   ============================================================ */
router.post("/test-recurrent", async (req, res) => {
  try {
    const { rebillId, amount } = req.body;
    
    if (!rebillId || !amount) {
      return res.status(400).json({ error: "Missing rebillId or amount" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = 'test-recurrent-' + Date.now();

    // 1. Init
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Тестовое списание',
          Price: amountKop,
          Quantity: 1,
          Amount: amountKop,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // Токен для Init
    const initParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Тестовое рекуррентное списание',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    };
    
    const initToken = generateInitToken(initParams);

    const initResult = await postTinkoff("Init", {
      ...initParams,
      Token: initToken
    });

    if (!initResult.Success) {
      return res.status(400).json({ 
        error: "Init failed", 
        details: initResult 
      });
    }

    // 2. Charge - ВАЖНО: только 3 параметра!
    const chargeParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: initResult.PaymentId,
      RebillId: rebillId
    };
    
    const chargeToken = generateChargeToken(initResult.PaymentId, rebillId);
    
    const chargeResult = await postTinkoff("Charge", {
      ...chargeParams,
      Token: chargeToken
    });

    res.json({
      init: initResult,
      charge: chargeResult,
      paymentId: initResult.PaymentId,
      rebillId: rebillId,
      amount: amount,
      orderId: orderId
    });

  } catch (err) {
    console.error("Test error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   Остальной код (без изменений)
   ============================================================ */

async function getTinkoffState(paymentId) {
  const token = generateTinkoffToken({ TerminalKey: TINKOFF_TERMINAL_KEY, PaymentId: paymentId });
  const resp = await postTinkoff("GetState", {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
    Token: token
  });

  return resp.PaymentData?.RebillId || null;
}

async function findOrderByOrderId(orderId) {
  const usersSnapshot = await db.collection("telegramUsers").get();
  for (const userDoc of usersSnapshot.docs) {
    const orderRef = db.collection("telegramUsers")
      .doc(userDoc.id)
      .collection("orders")
      .doc(orderId);

    const orderDoc = await orderRef.get();
    if (orderDoc.exists) return { userId: userDoc.id, orderRef, orderData: orderDoc.data() };
  }
  return null;
}

router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;
    if (!amount || !userId || !description)
      return res.status(400).json({ error: "Missing amount, userId, description" });

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      NotificationURL: NOTIFICATION_URL,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru"
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: NOTIFICATION_URL,
      Token: token,
      Receipt: {
        Email: "test@example.com",
        Taxation: "usn_income",
        Items: [
          { Name: description, Price: amountKop, Quantity: 1, Amount: amountKop, Tax: "none" }
        ]
      }
    };

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    await db.collection("telegramUsers").doc(userId).collection("orders").doc(orderId).set({
      orderId,
      amountKop,
      description,
      tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
      rebillId: null,
      recurrent,
      notificationUrl: NOTIFICATION_URL,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/finish-authorize", async (req, res) => {
  try {
    const { userId, orderId, paymentId, amount, description } = req.body;

    if (!userId || !orderId || !paymentId || !amount || !description)
      return res.status(400).json({ error: "Missing params" });

    const amountKop = Math.round(amount * 100);

    const token = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      NotificationURL: NOTIFICATION_URL
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      NotificationURL: NOTIFICATION_URL,
      Token: token
    };

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    const rebillId = await getTinkoffState(paymentId);

    await db.collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update({
        tinkoff: { ...data },
        rebillId,
        finishedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({ ...data, rebillId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/check-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    const rebillId = await getTinkoffState(paymentId);
    res.json({ paymentId, rebillId, hasRebill: !!rebillId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/debug-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;

    const token = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId
    });

    const resp = await postTinkoff("GetState", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Token: token
    });

    res.json({ paymentId, ...resp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/webhook", async (req, res) => {
  try {
    const n = req.body;
    console.log("📨 Webhook:", n);

    if (n.Success && n.Status === "CONFIRMED") {
      let userId = n.CustomerKey || n.customerKey;
      let orderRef = userId
        ? db.collection("telegramUsers").doc(userId).collection("orders").doc(n.OrderId)
        : null;

      let orderDoc = orderRef ? await orderRef.get() : null;

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
          notifiedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (n.RebillId) updateData.rebillId = n.RebillId;

        await orderRef.update(updateData);
      } else {
        await db.collection("unprocessedWebhooks").add({
          orderId: n.OrderId,
          paymentId: n.PaymentId,
          rebillId: n.RebillId,
          customerKey: userId,
          notification: n,
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    res.json({ Success: true });
  } catch (err) {
    console.log("❌ Webhook Error:", err);
    res.json({ Success: true });
  }
});

export default router;
