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
   🔐 Генерация токена ДЛЯ МЕТОДА INIT (по примеру из библиотеки)
   ============================================================ */
function generateInitToken(params) {
  // Создаем копию параметров
  const tokenParams = { ...params };
  
  // Удаляем Token если есть
  delete tokenParams.Token;
  
  // Добавляем Password
  tokenParams.Password = TINKOFF_PASSWORD;
  
  // Преобразуем ВСЕ значения к строкам
  const stringParams = {};
  Object.keys(tokenParams).forEach(key => {
    const value = tokenParams[key];
    
    if (value === undefined || value === null) {
      return;
    }
    
    // Для объектов используем JSON.stringify
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      stringParams[key] = JSON.stringify(value);
    } else {
      stringParams[key] = String(value);
    }
  });
  
  // Сортируем ключи
  const sortedKeys = Object.keys(stringParams).sort();
  
  // Конкатенация ТОЛЬКО значений
  let concatenated = '';
  sortedKeys.forEach(key => {
    concatenated += stringParams[key];
  });
  
  console.log("🔐 INIT Token calculation:");
  console.log("   Sorted keys:", sortedKeys);
  console.log("   Values:", sortedKeys.map(k => `${k}=${stringParams[k]}`));
  console.log("   Concatenated:", concatenated);
  
  // SHA-256
  return crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");
}

/* ============================================================
   🔐 Генерация токена ДЛЯ МЕТОДА CHARGE
   В Charge используются ТОЛЬКО: TerminalKey, PaymentId, RebillId + Password
   ============================================================ */
function generateChargeToken(paymentId, rebillId) {
  // Параметры для Charge (только эти три!)
  const params = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
    RebillId: rebillId,
    Password: TINKOFF_PASSWORD
  };
  
  // Сортируем ключи
  const sortedKeys = Object.keys(params).sort();
  
  // Конкатенация значений
  let concatenated = '';
  sortedKeys.forEach(key => {
    concatenated += String(params[key]);
  });
  
  console.log("🔐 CHARGE Token calculation:");
  console.log("   Params:", params);
  console.log("   Sorted keys:", sortedKeys);
  console.log("   Concatenated:", concatenated);
  
  // SHA-256
  return crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");
}

/* ============================================================
   🔐 Генерация токена ДЛЯ МЕТОДА GETSTATE
   ============================================================ */
function generateGetStateToken(paymentId) {
  const params = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
    Password: TINKOFF_PASSWORD
  };
  
  const sortedKeys = Object.keys(params).sort();
  let concatenated = '';
  sortedKeys.forEach(key => {
    concatenated += String(params[key]);
  });
  
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
   РАБОЧАЯ версия рекуррентного платежа (как в примере)
   ============================================================ */
router.post("/recurrent-charge", async (req, res) => {
  try {
    const { rebillId, amount } = req.body;

    if (!rebillId || !amount) {
      return res.status(400).json({ 
        error: "Missing required parameters", 
        required: ["rebillId", "amount"] 
      });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = 'recurrent-' + Date.now();
    const description = 'Автоматическое списание по подписке';

    console.log("🚀 Starting recurrent charge:");
    console.log("   RebillId:", rebillId);
    console.log("   Amount:", amountKop, "kop");
    console.log("   OrderId:", orderId);

    // 1. СОЗДАЕМ ЧЕК (ТОЧНО как в рабочем примере)
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Продление подписки',
          Price: amountKop,
          Quantity: 1.00,
          Amount: amountKop,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // 2. INIT (без RebillId!)
    const initParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    };

    const initToken = generateInitToken(initParams);
    
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

    // 3. CHARGE (только 3 параметра!)
    console.log("📝 Step 2: Calling Charge...");
    const chargeToken = generateChargeToken(newPaymentId, rebillId);
    
    const chargeResponse = await postTinkoff("Charge", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      RebillId: rebillId,
      Token: chargeToken
    });
    
    console.log("💳 Charge Success:", chargeResponse.Success);

    // 4. GET STATE
    console.log("📝 Step 3: Checking status...");
    const stateToken = generateGetStateToken(newPaymentId);
    
    const stateResponse = await postTinkoff("GetState", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      Token: stateToken
    });

    // 5. РЕЗУЛЬТАТ
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

    // 6. СОХРАНЕНИЕ
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
   Тест Init отдельно (упрощенный)
   ============================================================ */
router.post("/test-init", async (req, res) => {
  try {
    // Параметры как в рабочем примере
    const amountKop = 10000;
    const orderId = 'test-' + Date.now();
    
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Продление подписки',
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
      Description: 'Автоматическое списание по подписке',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    };

    console.log("🔍 Testing Init parameters:");
    console.log("Params:", JSON.stringify(initParams, null, 2));
    
    const token = generateInitToken(initParams);
    console.log("Generated token:", token);
    
    const result = await postTinkoff("Init", {
      ...initParams,
      Token: token
    });
    
    res.json({
      token: token,
      result: result
    });

  } catch (err) {
    console.error("Test init error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   Проверка текущего Init endpoint'а
   ============================================================ */
router.post("/debug-current-init", async (req, res) => {
  try {
    // Используем параметры из рабочего примера
    const amountKop = 10000;
    const orderId = 'debug-' + Date.now();
    
    // Чек из рабочего примера
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Продление подписки',
          Price: amountKop,
          Quantity: 1.00,
          Amount: amountKop,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // Параметры для токена
    const tokenParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Автоматическое списание по подписке',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt,
      Password: TINKOFF_PASSWORD
    };

    // 1. Сортируем ключи
    const sortedKeys = Object.keys(tokenParams).sort();
    
    // 2. Конкатенация значений
    let concatenated = '';
    sortedKeys.forEach(key => {
      let value = tokenParams[key];
      
      // Для Receipt преобразуем в JSON
      if (key === 'Receipt') {
        value = JSON.stringify(value);
      }
      
      concatenated += String(value);
    });
    
    console.log("🔐 DEBUG Token generation:");
    console.log("Sorted keys:", sortedKeys);
    console.log("Full concatenated string:", concatenated);
    
    // 3. SHA-256
    const token = crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");
    
    // 4. Отправляем запрос
    const initPayload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Автоматическое списание по подписке',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt,
      Token: token
    };
    
    console.log("Sending payload:", JSON.stringify(initPayload, null, 2));
    
    const result = await postTinkoff("Init", initPayload);
    
    res.json({
      concatenated: concatenated,
      token: token,
      result: result
    });

  } catch (err) {
    console.error("Debug error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   Просто скопируем рабочий пример как endpoint
   ============================================================ */
router.post("/exact-example", async (req, res) => {
  try {
    const { rebillId } = req.body;
    
    if (!rebillId) {
      return res.status(400).json({ error: "Missing rebillId" });
    }

    const REBILL_ID = rebillId;
    const amountKop = 10000; // 100 рублей
    
    // 1. Чек (точно как в примере)
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Продление подписки',
          Price: 100, // Обратите внимание: в примере Price: 100 (копейки?)
          Quantity: 1,
          Amount: 10000, // А тут Amount: 10000
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // ВНИМАНИЕ: В примере есть несоответствие!
    // Price: 100, но Amount: 10000
    // Давайте попробуем оба варианта
    
    // Вариант A: как в примере (может быть опечатка)
    const receiptA = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Продление подписки',
          Price: 100,
          Quantity: 1,
          Amount: 10000,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };
    
    // Вариант B: исправленный (Price = Amount)
    const receiptB = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Продление подписки',
          Price: 10000,
          Quantity: 1,
          Amount: 10000,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    const orderId = 'recurrent-' + Date.now();
    
    // Пробуем сначала вариант B (скорее всего правильный)
    console.log("🔄 Trying with Price=Amount=10000...");
    
    const initParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: 10000,
      OrderId: orderId,
      Description: 'Автоматическое списание по подписке',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receiptB
    };
    
    const token = generateInitToken(initParams);
    
    const initResult = await postTinkoff("Init", {
      ...initParams,
      Token: token
    });
    
    if (!initResult.Success) {
      // Пробуем вариант A (как в примере)
      console.log("🔄 Trying with Price=100, Amount=10000 (as in example)...");
      
      const initParamsA = {
        TerminalKey: TINKOFF_TERMINAL_KEY,
        Amount: 10000,
        OrderId: orderId,
        Description: 'Автоматическое списание по подписке',
        NotificationURL: NOTIFICATION_URL,
        Receipt: receiptA
      };
      
      const tokenA = generateInitToken(initParamsA);
      
      const initResultA = await postTinkoff("Init", {
        ...initParamsA,
        Token: tokenA
      });
      
      if (!initResultA.Success) {
        return res.status(400).json({ 
          error: "Both attempts failed",
          attempt1: initResult,
          attempt2: initResultA
        });
      }
      
      var finalInitResult = initResultA;
      var finalPaymentId = initResultA.PaymentId;
    } else {
      var finalInitResult = initResult;
      var finalPaymentId = initResult.PaymentId;
    }

    // Charge
    const chargeToken = generateChargeToken(finalPaymentId, REBILL_ID);
    
    const chargeResult = await postTinkoff("Charge", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: finalPaymentId,
      RebillId: REBILL_ID,
      Token: chargeToken
    });

    res.json({
      init: finalInitResult,
      charge: chargeResult,
      paymentId: finalPaymentId,
      rebillId: REBILL_ID,
      amount: 100
    });

  } catch (err) {
    console.error("Exact example error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   Остальной код (адаптированный)
   ============================================================ */

async function getTinkoffState(paymentId) {
  const token = generateGetStateToken(paymentId);
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

// Остальные endpoints оставляем без изменений...

export default router;
