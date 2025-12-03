// === Tinkoff Payment Router ===

import express from "express";
import { db } from "../firebase.js";
import fetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";
import axios from "axios";

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
  // 1. Берём только root поля и исключаем Token
  const filtered = {};
  for (const key of Object.keys(params)) {
    if (key !== "Token" && params[key] !== undefined && params[key] !== null) {
      filtered[key] = params[key];
    }
  }

  // 2. Добавляем Password в корень, как требует документация
  filtered["Password"] = TINKOFF_PASSWORD;

  // 3. Сортировка ключей (строго по алфавиту)
  const sortedKeys = Object.keys(filtered).sort();

  // 4. Конкатенация только значений
  const concatenated = sortedKeys.map((key) => `${filtered[key]}`).join("");

  console.log("🔐 Token string:", concatenated);

  // 5. SHA-256
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
   GetState → достаём RebillId
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

/* ============================================================
   Поиск заказа по OrderId
   ============================================================ */
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
   Получение последнего RebillId пользователя
   ============================================================ */
async function getLastRebillId(userId) {
  try {
    const ordersSnapshot = await db.collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .where("rebillId", "!=", null)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (ordersSnapshot.empty) {
      return null;
    }

    const lastOrder = ordersSnapshot.docs[0].data();
    return lastOrder.rebillId;
  } catch (err) {
    console.error("❌ Error getting last RebillId:", err);
    return null;
  }
}

/* ============================================================
   Создание чека для рекуррентного платежа
   ============================================================ */
function createReceipt(email = "client@example.com", description = "Продление подписки", amountKop = 10000) {
  return {
    Email: email,
    Phone: "+79001234567",
    Taxation: "usn_income",
    Items: [
      {
        Name: description,
        Price: amountKop,
        Quantity: 1,
        Amount: amountKop,
        Tax: "none",
        PaymentMethod: "full_payment",
        PaymentObject: "service"
      }
    ]
  };
}

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ ПЛАТЕЖА ДЛЯ РЕКУРРЕНТНОГО СПИСАНИЯ
   ============================================================ */
async function initRecurrentPayment(userId, amountKop, description, email = "test@example.com") {
  const orderId = `recurrent-${Date.now()}`;
  
  const receipt = createReceipt(email, description, amountKop);
  
  const token = generateTinkoffToken({
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: amountKop,
    CustomerKey: userId,
    Description: description,
    OrderId: orderId,
    NotificationURL: NOTIFICATION_URL,
    Recurrent: "Y",
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
    Recurrent: "Y",
    PayType: "O",
    Language: "ru",
    NotificationURL: NOTIFICATION_URL,
    Token: token,
    Receipt: receipt
  };

  const data = await postTinkoff("Init", payload);
  return { ...data, orderId };
}

/* ============================================================
   ВЫПОЛНЕНИЕ РЕКУРРЕНТНОГО СПИСАНИЯ
   ============================================================ */
async function chargeRecurrentPayment(paymentId, rebillId) {
  const token = generateTinkoffToken({
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
    RebillId: rebillId
  });

  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
    RebillId: rebillId,
    Token: token
  };

  const data = await postTinkoff("Charge", payload);
  return data;
}

/* ============================================================
   ОСНОВНАЯ ФУНКЦИЯ РЕКУРРЕНТНОГО ПЛАТЕЖА
   ============================================================ */
async function makeRecurrentPayment(userId, amount, description, email = "test@example.com") {
  try {
    const amountKop = Math.round(amount * 100);
    
    // 1. Получаем последний RebillId пользователя
    const rebillId = await getLastRebillId(userId);
    if (!rebillId) {
      throw new Error("У пользователя нет сохраненных реквизитов для рекуррентного платежа");
    }

    // 2. Инициализируем новый платеж
    const initResult = await initRecurrentPayment(userId, amountKop, description, email);
    if (!initResult.Success) {
      throw new Error(`Ошибка инициализации платежа: ${initResult.Message || "Неизвестная ошибка"}`);
    }

    // 3. Выполняем списание по сохраненным реквизитам
    const chargeResult = await chargeRecurrentPayment(initResult.PaymentId, rebillId);
    if (!chargeResult.Success) {
      throw new Error(`Ошибка списания: ${chargeResult.Message || "Неизвестная ошибка"}`);
    }

    // 4. Получаем финальный статус платежа
    const token = generateTinkoffToken({
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: initResult.PaymentId
    });

    const stateResult = await postTinkoff("GetState", {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: initResult.PaymentId,
      Token: token
    });

    // 5. Сохраняем информацию о платеже в БД
    const orderData = {
      orderId: initResult.OrderId,
      amountKop,
      description,
      tinkoff: {
        PaymentId: initResult.PaymentId,
        ChargeResult: chargeResult
      },
      rebillId,
      recurrent: "Y",
      notificationUrl: NOTIFICATION_URL,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isRecurrentCharge: true
    };

    await db.collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(initResult.OrderId)
      .set(orderData);

    return {
      success: chargeResult.Success,
      paymentId: initResult.PaymentId,
      orderId: initResult.OrderId,
      rebillId,
      status: stateResult.Status,
      amount: amountKop / 100,
      message: chargeResult.Message
    };

  } catch (error) {
    console.error("❌ Recurrent payment error:", error);
    throw error;
  }
}

/* ============================================================
   API ЭНДПОИНТ ДЛЯ РЕКУРРЕНТНОГО ПЛАТЕЖА
   ============================================================ */
router.post("/recurrent-charge", async (req, res) => {
  try {
    const { userId, amount, description, email } = req.body;

    if (!userId || !amount || !description) {
      return res.status(400).json({ 
        error: "Отсутствуют обязательные параметры: userId, amount, description" 
      });
    }

    const result = await makeRecurrentPayment(
      userId, 
      amount, 
      description, 
      email || "test@example.com"
    );

    res.json(result);

  } catch (error) {
    console.error("❌ Recurrent charge error:", error);
    res.status(500).json({ 
      error: error.message,
      code: error.code || "INTERNAL_ERROR",
      details: error.details || null
    });
  }
});

/* ============================================================
   API ЭНДПОИНТ ДЛЯ ПРОВЕРКИ ДОСТУПНОСТИ РЕКУРРЕНТНОГО ПЛАТЕЖА
   ============================================================ */
router.post("/check-recurrent-availability", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Отсутствует userId" });
    }

    const rebillId = await getLastRebillId(userId);
    const hasSavedCard = !!rebillId;

    res.json({
      userId,
      hasSavedCard,
      rebillId,
      canMakeRecurrent: hasSavedCard
    });

  } catch (error) {
    console.error("❌ Check recurrent availability error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ОСТАВШИЕСЯ МЕТОДЫ (без изменений)
// ============================================

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
