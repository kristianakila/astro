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
   🔐 Генерация токена по правилам Tinkoff
   По документации: Token = SHA256(конкатенация значений + Password)
   Значения берутся из ВСЕХ полей запроса, кроме Token
   ============================================================ */
function generateTinkoffToken(params) {
  // 1. Удаляем Token из параметров если есть
  const paramsForToken = { ...params };
  delete paramsForToken.Token;
  
  // 2. Добавляем Password
  paramsForToken.Password = TINKOFF_PASSWORD;
  
  // 3. Преобразуем ВСЕ значения к строкам
  const stringParams = {};
  Object.keys(paramsForToken).forEach(key => {
    const value = paramsForToken[key];
    
    if (value === undefined || value === null) {
      return;
    }
    
    // Для объектов (Receipt) используем JSON.stringify
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      stringParams[key] = JSON.stringify(value);
    } else {
      stringParams[key] = String(value);
    }
  });
  
  // 4. Сортируем ключи в алфавитном порядке
  const sortedKeys = Object.keys(stringParams).sort();
  
  // 5. Конкатенация значений
  let concatenated = '';
  sortedKeys.forEach(key => {
    concatenated += stringParams[key];
  });
  
  console.log("🔐 Token calculation:");
  console.log("   Sorted keys:", sortedKeys);
  console.log("   Concatenated string length:", concatenated.length);
  console.log("   First 100 chars:", concatenated.substring(0, 100));
  
  // 6. SHA-256
  const hash = crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");
  console.log("   Generated hash:", hash.substring(0, 16) + "...");
  
  return hash;
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
   Проведение рекуррентного платежа (РАБОЧАЯ ВЕРСИЯ)
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

    // 1. СОЗДАЕМ ЧЕК (ОБЯЗАТЕЛЬНО!)
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

    // 2. ПОДГОТОВЛИВАЕМ ПАРАМЕТРЫ ДЛЯ Init
    const initParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    };

    // 3. ГЕНЕРИРУЕМ ТОКЕН ДЛЯ Init
    const initToken = generateTinkoffToken(initParams);

    // 4. ВЫЗЫВАЕМ Init
    console.log("📝 Step 1: Calling Init...");
    const initResponse = await postTinkoff("Init", {
      ...initParams,
      Token: initToken
    });
    
    if (!initResponse.Success) {
      return res.status(400).json({ 
        error: "Init failed", 
        details: initResponse 
      });
    }

    const newPaymentId = initResponse.PaymentId;
    console.log("✅ Init successful. New PaymentId:", newPaymentId);

    // 5. ПОДГОТОВЛИВАЕМ ПАРАМЕТРЫ ДЛЯ Charge
    const chargeParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      RebillId: rebillId
    };
    
    // 6. ГЕНЕРИРУЕМ ТОКЕН ДЛЯ Charge
    const chargeToken = generateTinkoffToken(chargeParams);
    
    // 7. ВЫЗЫВАЕМ Charge
    console.log("📝 Step 2: Calling Charge...");
    console.log("   PaymentId:", newPaymentId);
    console.log("   RebillId:", rebillId);
    
    const chargeResponse = await postTinkoff("Charge", {
      ...chargeParams,
      Token: chargeToken
    });
    
    console.log("💳 Charge response:", chargeResponse.Success);

    // 8. ПРОВЕРЯЕМ СТАТУС
    console.log("📝 Step 3: Checking status...");
    const stateParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId
    };
    
    const stateToken = generateTinkoffToken(stateParams);
    
    const stateResponse = await postTinkoff("GetState", {
      ...stateParams,
      Token: stateToken
    });

    // 9. ФОРМИРУЕМ РЕЗУЛЬТАТ
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

    // 10. СОХРАНЯЕМ
    await db.collection("recurrentCharges").doc(newPaymentId).set({
      ...result,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("🎉 Recurrent charge completed!");
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
   ТЕСТ: Проверка Init отдельно
   ============================================================ */
router.post("/test-init-only", async (req, res) => {
  try {
    const amountKop = 10000;
    const orderId = 'test-init-' + Date.now();
    
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

    const initParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Тестовый платеж для рекуррента',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    };

    const token = generateTinkoffToken(initParams);
    
    const result = await postTinkoff("Init", {
      ...initParams,
      Token: token
    });
    
    res.json({
      token: token,
      params: initParams,
      result: result
    });

  } catch (err) {
    console.error("Test init error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   ТЕСТ: Проверка Charge отдельно (если уже есть PaymentId)
   ============================================================ */
router.post("/test-charge-only", async (req, res) => {
  try {
    const { paymentId, rebillId } = req.body;
    
    if (!paymentId || !rebillId) {
      return res.status(400).json({ error: "Missing paymentId or rebillId" });
    }

    const chargeParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      RebillId: rebillId
    };
    
    const token = generateTinkoffToken(chargeParams);
    
    const result = await postTinkoff("Charge", {
      ...chargeParams,
      Token: token
    });
    
    res.json({
      token: token,
      params: chargeParams,
      result: result
    });

  } catch (err) {
    console.error("Test charge error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   ВАЖНО: Используем ту же функцию для всех методов API
   ============================================================ */

async function getTinkoffState(paymentId) {
  const params = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId
  };
  
  const token = generateTinkoffToken(params);
  const resp = await postTinkoff("GetState", {
    ...params,
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

/* ============================================================
   Оригинальный Init (обновленный для использования новой функции)
   ============================================================ */
router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;
    if (!amount || !userId || !description)
      return res.status(400).json({ error: "Missing amount, userId, description" });

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const receipt = {
      Email: "test@example.com",
      Taxation: "usn_income",
      Items: [
        { Name: description, Price: amountKop, Quantity: 1.00, Amount: amountKop, Tax: "none" }
      ]
    };

    const initParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    };

    const token = generateTinkoffToken(initParams);

    const payload = {
      ...initParams,
      Token: token
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

/* ============================================================
   Остальные endpoints (адаптированные)
   ============================================================ */

router.post("/finish-authorize", async (req, res) => {
  try {
    const { userId, orderId, paymentId, amount, description } = req.body;

    if (!userId || !orderId || !paymentId || !amount || !description)
      return res.status(400).json({ error: "Missing params" });

    const amountKop = Math.round(amount * 100);

    const params = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      NotificationURL: NOTIFICATION_URL
    };

    const token = generateTinkoffToken(params);

    const payload = {
      ...params,
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

    const params = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId
    };

    const token = generateTinkoffToken(params);

    const resp = await postTinkoff("GetState", {
      ...params,
      Token: token
    });

    res.json({ paymentId, ...resp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook остается без изменений
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
