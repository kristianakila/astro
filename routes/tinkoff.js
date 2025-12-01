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

// === Генерация токена Init ===
function generateTinkoffTokenInit({ Amount, CustomerKey, Description, OrderId, RebillId, Recurrent }) {
  // Параметры для токена должны быть в алфавитном порядке
  // Согласно документации: Amount, CustomerKey, Description, OrderId, RebillId, Recurrent, Password, TerminalKey
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${RebillId || ""}${Recurrent || ""}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Init RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена Finish ===
function generateTinkoffTokenFinish({ Amount, CustomerKey, Description, OrderId, PaymentId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Finish RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена для Charge (повторный платеж) ===
function generateTinkoffTokenCharge({ Amount, OrderId, RebillId }) {
  const raw = `${Amount}${OrderId}${RebillId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Charge RAW:", raw);
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

  // RebillId вернётся только если карта привязана для рекуррентного платежа
  return data.PaymentData?.RebillId || null;
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
    const { amount, userId, description, rebillId, isRecurrent, email = "test@example.com", phone } = req.body;

    if (!amount || !userId || !description) {
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    // Определяем, нужно ли создавать рекуррентный платеж
    const recurrentFlag = isRecurrent ? "Y" : "";

    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      RebillId: rebillId || "", // пусто для новой рекуррентной операции
      Recurrent: recurrentFlag,
    });

    // Формируем payload строго в алфавитном порядке (как в документации)
    const payload = {
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      RebillId: rebillId || "",
      Recurrent: recurrentFlag,
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Token: token,
      Receipt: {
        Email: email,
        Phone: phone || "+79000000000",
        Taxation: "usn_income",
        Items: [
          {
            Name: description,
            Price: amountKop,
            Quantity: 1,
            Amount: amountKop,
            PaymentMethod: "full_payment",
            PaymentObject: "service",
            Tax: "none",
          },
        ],
        Payments: {
          Electronic: amountKop,
          Cash: 0,
          AdvancePayment: 0,
          Credit: 0,
          Provision: 0,
        },
      },
    };

    // Добавляем дополнительные опциональные параметры
    if (isRecurrent && !rebillId) {
      // Для сохранения карты для будущих рекуррентов
      console.log("🔐 Инициализация рекуррентного платежа");
    }

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
        amount,
        currency: "RUB",
        description,
        isRecurrent: !!isRecurrent,
        tinkoff: { 
          PaymentId: data.PaymentId, 
          PaymentURL: data.PaymentURL,
          Status: data.Status,
        },
        rebillId: rebillId || null, // сохраняем rebillId если передан
        email: email,
        phone: phone || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      success: true,
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: rebillId || null,
      isRecurrent: !!isRecurrent,
      Status: data.Status,
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ 
      success: false,
      error: err.message,
      details: err.toString() 
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
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      PaymentId: paymentId,
    });

    // Параметры в алфавитном порядке
    const payload = {
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      PaymentId: paymentId,
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Token: token,
    };

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    // ✅ Получаем RebillId после успешной оплаты (если платеж был рекуррентным)
    let rebillId = null;
    if (data.Status === "AUTHORIZED" || data.Status === "CONFIRMED") {
      rebillId = await getTinkoffState(paymentId);
    }

    // Обновляем заказ в Firestore
    const updateData = {
      tinkoff: { 
        ...data,
        finished: true,
      },
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (rebillId) {
      updateData.rebillId = rebillId;
      updateData.recurrentActive = true;
    }

    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update(updateData);

    // Если есть rebillId, обновляем профиль пользователя
    if (rebillId) {
      await db
        .collection("telegramUsers")
        .doc(userId)
        .update({
          hasRecurrent: true,
          rebillId: rebillId,
          lastRecurrentOrder: orderId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }

    res.json({ 
      success: true,
      ...data, 
      rebillId 
    });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// === Проведение платежа по сохраненным реквизитам (Charge) ===
router.post("/charge", async (req, res) => {
  try {
    const { userId, rebillId, amount, description, email = "test@example.com" } = req.body;
    
    if (!userId || !rebillId || !amount || !description) {
      return res.status(400).json({ 
        success: false,
        error: "Missing userId, rebillId, amount, or description" 
      });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `REC-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffTokenCharge({
      Amount: amountKop,
      OrderId: orderId,
      RebillId: rebillId,
    });

    // Payload в алфавитном порядке
    const payload = {
      Amount: amountKop,
      OrderId: orderId,
      RebillId: rebillId,
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Token: token,
      Receipt: {
        Email: email,
        Taxation: "usn_income",
        Items: [
          {
            Name: description,
            Price: amountKop,
            Quantity: 1,
            Amount: amountKop,
            PaymentMethod: "full_payment",
            PaymentObject: "service",
            Tax: "none",
          },
        ],
        Payments: {
          Electronic: amountKop,
          Cash: 0,
          AdvancePayment: 0,
          Credit: 0,
          Provision: 0,
        },
      },
    };

    const data = await postTinkoff("Charge", payload);
    
    // Сохраняем запись о рекуррентном платеже
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop,
        amount,
        currency: "RUB",
        description,
        isRecurrent: true,
        isCharge: true, // Флаг, что это повторный платеж
        rebillId,
        email,
        tinkoff: data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      success: data.Success,
      status: data.Status,
      paymentId: data.PaymentId,
      orderId,
      rebillId,
      error: data.Error || null,
      message: data.Message || null,
    });
  } catch (err) {
    console.error("❌ /charge error:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// === Получение статуса платежа ===
router.post("/get-state", async (req, res) => {
  try {
    const { paymentId } = req.body;
    
    if (!paymentId) {
      return res.status(400).json({ 
        success: false,
        error: "Missing paymentId" 
      });
    }

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
    };

    // Токен для GetState
    const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
    payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

    const data = await postTinkoff("GetState", payload);

    res.json({
      success: data.Success,
      status: data.Status,
      paymentId: data.PaymentId,
      orderId: data.OrderId,
      rebillId: data.PaymentData?.RebillId || null,
      error: data.Error || null,
      message: data.Message || null,
    });
  } catch (err) {
    console.error("❌ /get-state error:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// === Отмена рекуррента (RemoveCard) ===
router.post("/remove-card", async (req, res) => {
  try {
    const { userId, cardId, rebillId } = req.body;
    
    if (!userId || !cardId) {
      return res.status(400).json({ 
        success: false,
        error: "Missing userId or cardId" 
      });
    }

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      CardId: cardId,
      CustomerKey: userId,
    };

    // Токен для RemoveCard
    const raw = `${payload.CardId}${payload.CustomerKey}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
    payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

    const data = await postTinkoff("RemoveCard", payload);

    // Обновляем статус в Firestore
    if (data.Success) {
      await db
        .collection("telegramUsers")
        .doc(userId)
        .update({
          hasRecurrent: false,
          rebillId: admin.firestore.FieldValue.delete(),
          lastRecurrentOrder: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      // Также обновляем все активные заказы
      const ordersRef = db.collection("telegramUsers").doc(userId).collection("orders");
      const snapshot = await ordersRef.where("recurrentActive", "==", true).get();
      
      const batch = db.batch();
      snapshot.forEach(doc => {
        batch.update(doc.ref, {
          recurrentActive: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      
      await batch.commit();
    }

    res.json({
      success: data.Success,
      status: data.Status,
      error: data.Error || null,
      message: data.Message || null,
    });
  } catch (err) {
    console.error("❌ /remove-card error:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

export default router;
