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
   🔥 Recurrent Charge (MIT) — версия через axios как в примере
   ============================================================ */

router.post("/recurrent-charge", async (req, res) => {
  try {
    const {
      userId,
      paymentId,
      rebillId,
      amount = 100, // рубли
      description = "Продление подписки",
      orderId: clientOrderId,
      ip,
      sendEmail = false,
      infoEmail = "",
      email = "client@example.com",
      phone = "+79001234567",
      taxation = "osn"
    } = req.body;

    if (!userId || !paymentId || !rebillId) {
      return res.status(400).json({ error: "Missing required params" });
    }

    const amountKop = Math.round(amount * 100);

    const orderId =
      clientOrderId ||
      `RC-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    // === Создаём чек (Receipt) ===
    const receipt = {
      Email: email,
      Phone: phone,
      Taxation: taxation,
      Items: [
        {
          Name: description,
          Price: amountKop,
          Quantity: 1,
          Amount: amountKop,
          Tax: "vat20",
          PaymentMethod: "full_payment",
          PaymentObject: "service"
        }
      ]
    };

    // === Подготовка параметров для токена (только корневые поля, без объектов/массивов) ===
    const tokenParams = {
      Amount: amountKop,
      CustomerKey: userId,
      IP: ip,
      InfoEmail: infoEmail || undefined,
      OrderId: orderId,
      PaymentId: paymentId,
      RebillId: rebillId,
      SendEmail: Boolean(sendEmail),
      TerminalKey: TINKOFF_TERMINAL_KEY
    };

    // === Генерация токена через T-Bank алгоритм ===
    const token = generateToken(tokenParams, TINKOFF_PASSWORD);

    // === Payload для запроса Charge ===
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      RebillId: rebillId,
      Amount: amountKop,
      CustomerKey: userId,
      OrderId: orderId,
      Receipt: receipt, // объект можно передавать, но не в токен
      SendEmail: Boolean(sendEmail),
      ...(ip ? { IP: ip } : {}),
      ...(infoEmail ? { InfoEmail: infoEmail } : {}),
      Token: token
    };

    console.log("📦 Charge payload:", payload);

    const response = await axios.post(`${TINKOFF_API_URL}/Charge`, payload, {
      headers: { "Content-Type": "application/json", Accept: "application/json" }
    });

    console.log("📤 Charge response:", response.data);

    if (!response.data.Success) {
      return res.status(400).json({ error: "Charge failed", tinkoff: response.data });
    }

    // === Сохраняем заказ в Firebase ===
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop,
        currency: "RUB",
        description,
        tinkoff: response.data,
        rebillId,
        receipt,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({ ...response.data, rebillId, receipt });
  } catch (err) {
    console.error("❌ Recurrent Charge error:", err);
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
