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

// === Генерация токена Init (ИСПРАВЛЕНО) ===
function generateTinkoffTokenInit({ Amount, OrderId, Description, CustomerKey }) {
  // В документации для Init с рекуррентом:
  // TerminalKey + Amount + OrderId + Description + Recurrent + CustomerKey + Token
  // Но для генерации токена: Amount + OrderId + Description + CustomerKey + Recurrent + Password + TerminalKey
  // Однако Recurrent не включается в токен по некоторым версиям API
  
  // Лучший подход - смотреть официальную документацию:
  // https://oplata.tinkoff.ru/develop/api/request-sign/
  
  // Для Init с Recurrent="Y" и CustomerKey:
  const raw = `${Amount}${OrderId}${Description}${CustomerKey}Y${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Init RAW string:", raw);
  console.log("🔐 Components:", {
    Amount,
    OrderId,
    Description,
    CustomerKey,
    Recurrent: "Y",
    Password: TINKOFF_PASSWORD,
    TerminalKey: TINKOFF_TERMINAL_KEY
  });
  
  const token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  console.log("🔐 Generated token:", token);
  return token;
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  console.log(`📤 Tinkoff request: ${method}`, JSON.stringify(payload, null, 2));

  try {
    const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    console.log(`📥 Tinkoff response (${method}):`, data);

    return data;
  } catch (err) {
    console.error(`❌ Tinkoff request error (${method}):`, err);
    throw err;
  }
}

// === Init платежа ===
router.post("/init", async (req, res) => {
  try {
    console.log("=== НОВЫЙ ЗАПРОС /init ===");
    console.log("📥 Request body:", req.body);
    
    const { amount, userId, description, email = "test@test.com", phone = "" } = req.body;

    if (!amount || !userId || !description) {
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`;
    
    // Генерация токена
    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      OrderId: orderId,
      Description: description.substring(0, 128),
      CustomerKey: userId.toString(),
    });

    // Payload В ТОЧНОМ порядке как в документации
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Token: token,
      Description: description.substring(0, 128),
      CustomerKey: userId.toString(),
      Recurrent: "Y",
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
            Name: description.substring(0, 128),
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

    console.log("📤 Final payload to Tinkoff:", JSON.stringify(payload, null, 2));

    const data = await postTinkoff("Init", payload);
    
    if (!data.Success) {
      console.error("❌ Tinkoff API error details:", {
        ErrorCode: data.ErrorCode,
        Message: data.Message,
        Details: data.Details,
        payloadSent: payload
      });
      
      return res.status(400).json({
        error: "Tinkoff API error",
        errorCode: data.ErrorCode,
        message: data.Message,
        details: data.Details
      });
    }

    // Сохраняем заказ в Firestore
    await db
      .collection("telegramUsers")
      .doc(userId.toString())
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop,
        amount: amount,
        currency: "RUB",
        description,
        userId: userId.toString(),
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
      error: "Internal server error",
      message: err.message
    });
  }
});

// Альтернативная версия с другим порядком генерации токена
router.post("/init-test", async (req, res) => {
  try {
    console.log("=== ТЕСТОВЫЙ ЗАПРОС /init-test ===");
    
    const { amount, userId, description } = req.body;
    const amountKop = Math.round(amount * 100);
    const orderId = `TEST${Date.now()}`;
    
    // Тест 1: Попробуем без рекуррента
    console.log("\n🔧 ТЕСТ 1: Без рекуррента");
    const token1 = crypto.createHash("sha256")
      .update(`${amountKop}${orderId}${description}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`, "utf8")
      .digest("hex");
    
    const payload1 = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      Token: token1,
    };
    
    console.log("Payload 1:", JSON.stringify(payload1, null, 2));
    const result1 = await postTinkoff("Init", payload1);
    console.log("Result 1:", result1);
    
    // Тест 2: С рекуррентом но без CustomerKey
    if (!result1.Success) {
      console.log("\n🔧 ТЕСТ 2: С рекуррентом без CustomerKey");
      const token2 = crypto.createHash("sha256")
        .update(`${amountKop}${orderId}${description}Y${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`, "utf8")
        .digest("hex");
      
      const payload2 = {
        TerminalKey: TINKOFF_TERMINAL_KEY,
        Amount: amountKop,
        OrderId: orderId,
        Description: description,
        Token: token2,
        Recurrent: "Y",
      };
      
      console.log("Payload 2:", JSON.stringify(payload2, null, 2));
      const result2 = await postTinkoff("Init", payload2);
      console.log("Result 2:", result2);
    }
    
    // Тест 3: Полный вариант
    console.log("\n🔧 ТЕСТ 3: Полный вариант");
    const token3 = crypto.createHash("sha256")
      .update(`${amountKop}${orderId}${description}Y${userId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`, "utf8")
      .digest("hex");
    
    const payload3 = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      CustomerKey: userId,
      Recurrent: "Y",
      Token: token3,
      Receipt: {
        Email: "test@test.com",
        Taxation: "usn_income",
        Items: [{
          Name: description,
          Price: amountKop,
          Quantity: 1,
          Amount: amountKop,
          Tax: "none",
        }],
      },
    };
    
    console.log("Payload 3:", JSON.stringify(payload3, null, 2));
    const result3 = await postTinkoff("Init", payload3);
    console.log("Result 3:", result3);
    
    res.json({ tests: [result1, result2, result3] });
    
  } catch (err) {
    console.error("❌ /init-test error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
