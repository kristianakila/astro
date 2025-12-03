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
   🔐 Универсальная генерация токена Tinkoff (Init, Charge, др.)
   Token = SHA256( values(sortedKeys) + Password )
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
  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await resp.json();
}

/* ============================================================
   Создание чека для рекуррентного платежа
   ============================================================ */
function createReceipt(email = 'test@example.com', amountKop, description = 'Продление подписки') {
  return {
    Email: email,
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
}

/* ============================================================
   Проведение рекуррентного платежа по RebillId
   (В ТОЧНОСТИ как в рабочем примере)
   ============================================================ */
router.post("/recurrent-charge", async (req, res) => {
  try {
    const { rebillId, amount, description = 'Автоматическое списание по подписке', email = 'test@example.com' } = req.body;

    if (!rebillId || !amount) {
      return res.status(400).json({ 
        error: "Missing required parameters", 
        required: ["rebillId", "amount"] 
      });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = 'recurrent-' + Date.now();

    // 1. СОЗДАНИЕ ЧЕКА (как в примере)
    const receipt = createReceipt(email, amountKop, description);

    // 2. ИНИЦИАЛИЗАЦИЯ ПЛАТЕЖА (БЕЗ RebillId!)
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

    console.log("🔄 Init payload:", JSON.stringify(initPayload, null, 2));

    const initResponse = await postTinkoff("Init", initPayload);
    
    if (!initResponse.Success) {
      return res.status(400).json({ 
        error: "Init failed", 
        details: initResponse 
      });
    }

    const newPaymentId = initResponse.PaymentId;
    console.log("✅ New PaymentId:", newPaymentId);

    // 3. СПИСАНИЕ ПО РЕКУРРЕНТУ (Charge)
    const chargeToken = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      RebillId: rebillId
    });

    const chargePayload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      RebillId: rebillId,
      Token: chargeToken
    };

    console.log("💳 Charge payload:", JSON.stringify(chargePayload, null, 2));

    const chargeResponse = await postTinkoff("Charge", chargePayload);
    
    if (!chargeResponse.Success) {
      // Если Charge не удался, все равно проверяем статус
      console.log("⚠️ Charge failed, checking status...");
    }

    // 4. ПРОВЕРКА ФИНАЛЬНОГО СТАТУСА
    const stateToken = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId
    });

    const stateResponse = await postTinkoff("GetState", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: newPaymentId,
      Token: stateToken
    });

    // 5. ФОРМИРОВАНИЕ РЕЗУЛЬТАТА
    const result = {
      success: chargeResponse.Success || false,
      paymentId: newPaymentId,
      rebillId: rebillId,
      status: stateResponse.Status,
      amount: stateResponse.Amount ? stateResponse.Amount / 100 : amountKop / 100,
      orderId: orderId,
      initResponse: initResponse,
      chargeResponse: chargeResponse,
      stateResponse: stateResponse
    };

    // 6. СОХРАНЕНИЕ В FIRESTORE
    await db.collection("recurrentCharges").doc(newPaymentId).set({
      ...result,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: req.body.userId || null
    });

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
   Упрощенный endpoint для тестирования (точно как в примере)
   ============================================================ */
router.post("/recurrent-simple", async (req, res) => {
  try {
    const { rebillId, amount } = req.body;
    
    if (!rebillId || !amount) {
      return res.status(400).json({ error: "Missing rebillId or amount" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = 'recurrent-' + Date.now();

    // 1. Чек (обязательно!)
    const receipt = {
      Email: 'test@example.com',
      Phone: '+79001234567',
      Taxation: 'osn',
      Items: [
        {
          Name: 'Продление подписки',
          Price: amountKop,
          Quantity: 1,
          Amount: amountKop,
          Tax: 'vat20',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service'
        }
      ]
    };

    // 2. Init
    const initToken = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Автоматическое списание по подписке',
      NotificationURL: NOTIFICATION_URL,
      Receipt: receipt
    });

    const initResult = await postTinkoff("Init", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: 'Автоматическое списание по подписке',
      NotificationURL: NOTIFICATION_URL,
      Token: initToken,
      Receipt: receipt
    });

    if (!initResult.Success) {
      return res.status(400).json({ error: "Init failed", details: initResult });
    }

    // 3. Charge
    const chargeToken = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: initResult.PaymentId,
      RebillId: rebillId
    });

    const chargeResult = await postTinkoff("Charge", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: initResult.PaymentId,
      RebillId: rebillId,
      Token: chargeToken
    });

    // 4. GetState
    const stateToken = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: initResult.PaymentId
    });

    const finalStatus = await postTinkoff("GetState", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: initResult.PaymentId,
      Token: stateToken
    });

    const result = {
      success: chargeResult.Success,
      paymentId: initResult.PaymentId,
      status: finalStatus.Status,
      amount: finalStatus.Amount ? finalStatus.Amount / 100 : amountKop / 100,
      orderId: orderId,
      rebillId: rebillId
    };

    // Сохраняем
    await db.collection("recurrentCharges").doc(initResult.PaymentId).set({
      ...result,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json(result);

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   Остальной код без изменений
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

/* ============================================================
   Init платежа
   ============================================================ */
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

/* ============================================================
   FinishAuthorize
   ============================================================ */
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

/* ============================================================
   Check Payment
   ============================================================ */
router.post("/check-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    const rebillId = await getTinkoffState(paymentId);
    res.json({ paymentId, rebillId, hasRebill: !!rebillId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   Debug Payment
   ============================================================ */
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

/* ============================================================
   Webhook
   ============================================================ */
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
