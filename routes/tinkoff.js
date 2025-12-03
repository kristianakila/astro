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
   ВАЖНО: для Receipt нужно использовать JSON.stringify!
   ============================================================ */
function generateTinkoffToken(params) {
  const filtered = {};
  
  for (const key of Object.keys(params)) {
    if (key !== "Token" && params[key] !== undefined && params[key] !== null) {
      // Обрабатываем Receipt отдельно - преобразуем в JSON строку
      if (key === "Receipt" && typeof params[key] === "object") {
        filtered[key] = JSON.stringify(params[key]);
      } else {
        filtered[key] = params[key];
      }
    }
  }

  filtered["Password"] = TINKOFF_PASSWORD;
  const sortedKeys = Object.keys(filtered).sort();
  
  // Собираем строку для хеширования
  const concatenated = sortedKeys.map((key) => {
    return String(filtered[key]);
  }).join("");
  
  console.log("🔐 Token string (raw):", concatenated);
  console.log("🔐 Token params:", sortedKeys.map(k => `${k}=${filtered[k]}`).join(", "));
  
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
   Генерация токена для метода Charge
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
   Проведение рекуррентного платежа (ИСПРАВЛЕННАЯ ВЕРСИЯ)
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
          Quantity: 1.00,
          Amount: amountKop,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // 2. ИНИЦИАЛИЗИРУЕМ ПЛАТЕЖ (Init)
    // ВАЖНО: все параметры должны быть в правильном порядке для токена
    const initToken = generateTinkoffToken({
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

    // 3. ВЫПОЛНЯЕМ СПИСАНИЕ (Charge)
    console.log("📝 Step 2: Calling Charge...");
    console.log("   PaymentId:", newPaymentId);
    console.log("   RebillId:", rebillId);
    
    const chargeToken = generateChargeToken(newPaymentId, rebillId);
    
    const chargePayload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      RebillId: rebillId,
      Token: chargeToken
    };

    const chargeResponse = await postTinkoff("Charge", chargePayload);
    
    console.log("💳 Charge response:", chargeResponse);

    // 4. ПРОВЕРЯЕМ СТАТУС
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
   ПРОСТОЙ ТЕСТ: Проверка генерации токена
   ============================================================ */
router.post("/test-token", async (req, res) => {
  try {
    const amountKop = 10000; // 100 рублей
    const orderId = 'test-' + Date.now();
    
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Тестовая услуга',
          Price: amountKop,
          Quantity: 1.00,
          Amount: amountKop,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // Тестируем генерацию токена
    const token = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Тестовый платеж',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    });

    // Проверяем Init с этим токеном
    const initPayload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Тестовый платеж',
      NotificationURL: NOTIFICATION_URL,
      Token: token,
      Receipt: receipt
    };

    console.log("🔍 Testing token generation...");
    console.log("Generated token:", token);
    console.log("Payload:", JSON.stringify(initPayload, null, 2));

    const result = await postTinkoff("Init", initPayload);
    
    res.json({
      token,
      receipt: JSON.stringify(receipt),
      result
    });

  } catch (err) {
    console.error("Test token error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   АЛЬТЕРНАТИВНЫЙ ВАРИАНТ: без чека для тестирования
   ============================================================ */
router.post("/recurrent-simple", async (req, res) => {
  try {
    const { rebillId, amount } = req.body;
    
    if (!rebillId || !amount) {
      return res.status(400).json({ error: "Missing rebillId or amount" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = 'simple-recurrent-' + Date.now();

    // Вариант 1: Без чека (для тестирования)
    const initToken = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Рекуррентное списание',
      NotificationURL: NOTIFICATION_URL
    });

    const initResult = await postTinkoff("Init", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Рекуррентное списание',
      NotificationURL: NOTIFICATION_URL,
      Token: initToken
    });

    if (!initResult.Success) {
      // Вариант 2: Попробуем с простым чеком
      console.log("Trying with simple receipt...");
      
      const simpleReceipt = {
        Email: 'test@example.com',
        Taxation: 'osn',
        Items: [
          {
            Name: 'Услуга',
            Price: amountKop,
            Quantity: 1.00,
            Amount: amountKop,
            Tax: 'vat20'
          }
        ]
      };

      const initToken2 = generateTinkoffToken({
        TerminalKey: TINKOFF_TERMINAL_KEY,
        Amount: amountKop,
        OrderId: orderId,
        Description: 'Рекуррентное списание',
        NotificationURL: NOTIFICATION_URL,
        Receipt: simpleReceipt
      });

      const initResult2 = await postTinkoff("Init", {
        TerminalKey: TINKOFF_TERMINAL_KEY,
        Amount: amountKop,
        OrderId: orderId,
        Description: 'Рекуррентное списание',
        NotificationURL: NOTIFICATION_URL,
        Token: initToken2,
        Receipt: simpleReceipt
      });

      if (!initResult2.Success) {
        return res.status(400).json({ 
          error: "Init failed twice", 
          firstAttempt: initResult,
          secondAttempt: initResult2 
        });
      }
      
      var finalInitResult = initResult2;
      var finalPaymentId = initResult2.PaymentId;
    } else {
      var finalInitResult = initResult;
      var finalPaymentId = initResult.PaymentId;
    }

    // Charge
    const chargeToken = generateChargeToken(finalPaymentId, rebillId);
    
    const chargeResult = await postTinkoff("Charge", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: finalPaymentId,
      RebillId: rebillId,
      Token: chargeToken
    });

    res.json({
      init: finalInitResult,
      charge: chargeResult,
      paymentId: finalPaymentId,
      rebillId: rebillId,
      amount: amount
    });

  } catch (err) {
    console.error("Simple recurrent error:", err);
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

    // Используем исправленную функцию генерации токена
    const receipt = {
      Email: "test@example.com",
      Taxation: "usn_income",
      Items: [
        { Name: description, Price: amountKop, Quantity: 1.00, Amount: amountKop, Tax: "none" }
      ]
    };

    const token = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      NotificationURL: NOTIFICATION_URL,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      Receipt: receipt
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
      Receipt: receipt
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

// Остальные endpoints оставляем без изменений...

export default router;
