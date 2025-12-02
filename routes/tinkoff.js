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
   🔐 Универсальная генерация токена Tinkoff для Init/FinishAuthorize/GetState
   Token = SHA256(values(sortedKeys) + Password)
   (Этот используется для Init/FinishAuthorize/GetState — оставлен как есть)
   ============================================================ */
function generateTinkoffToken(params) {
  const filtered = {};

  for (const key of Object.keys(params)) {
    if (key !== "Token" && params[key] !== undefined && params[key] !== null) {
      filtered[key] = params[key];
    }
  }

  const sortedKeys = Object.keys(filtered).sort();
  const rawString = sortedKeys.map((k) => `${filtered[k]}`).join("") + TINKOFF_PASSWORD;

  console.log("🔐 Token RAW:", rawString);

  return crypto.createHash("sha256").update(rawString, "utf8").digest("hex");
}

/* ============================================================
   Генерация токена строго для Charge (MIT COF)
   Порядок (строго!): TerminalKey, PaymentId, RebillId, Amount (если есть),
   IP (если есть), SendEmail (если есть), InfoEmail (если есть), Password
   ============================================================ */
function generateChargeTokenStrict(opts) {
  const parts = [];

  parts.push(opts.TerminalKey || "");
  parts.push(opts.PaymentId || "");
  parts.push(opts.RebillId || "");

  if (typeof opts.Amount !== "undefined" && opts.Amount !== null) {
    parts.push(String(opts.Amount));
  }

  // IP участвует в подписи (если есть)
  parts.push(opts.IP || "");

  // SendEmail участвует (строка 'true'/'false' если передан)
  if (typeof opts.SendEmail !== "undefined") {
    parts.push(String(Boolean(opts.SendEmail)));
  } else {
    parts.push("");
  }

  // InfoEmail участвует если есть
  parts.push(opts.InfoEmail || "");

  // И в конце — секретный ключ
  parts.push(TINKOFF_PASSWORD);

  const raw = parts.join("");
  console.log("🔐 Charge Token RAW (strict):", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
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
   (Оставлен твой рабочий Init, используем generateTinkoffToken)
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
   🔥 Recurrent Charge (MIT) — исправленная версия
   ============================================================ */
router.post("/recurrent-charge", async (req, res) => {
  try {
    const {
      userId,
      paymentId,
      rebillId,
      amount,
      description,
      orderId: clientOrderId,
      ip,
      sendEmail = false,
      infoEmail = ""
    } = req.body;

    if (!userId || !paymentId || !rebillId)
      return res.status(400).json({ error: "Missing params: userId, paymentId, rebillId required" });

    // Сумма в копейках, если передана
    const amountKop = typeof amount === "number" ? Math.round(amount * 100) : undefined;

    // генерация orderId, если клиент не передал
    const orderId = clientOrderId || `RC-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    // --- Формируем объект, который участвует в подписи Charge (строго по Tinkoff) ---
    // ВНИМАНИЕ: CustomerKey и OrderId НЕ включаем в подпись Charge (они могут быть в payload)
    const chargeSignObj = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      RebillId: rebillId
    };

    if (typeof amountKop !== "undefined") chargeSignObj.Amount = amountKop;
    if (ip) chargeSignObj.IP = ip;
    if (typeof sendEmail !== "undefined") chargeSignObj.SendEmail = Boolean(sendEmail);
    if (infoEmail) chargeSignObj.InfoEmail = infoEmail;

    // Генерируем токен строго по порядку для Charge
    const token = generateChargeTokenStrict(chargeSignObj);

    // --- Формируем payload строго по примеру: TerminalKey, PaymentId, RebillId, Token, IP, SendEmail, InfoEmail ---
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      RebillId: rebillId,
      Token: token
    };

    if (typeof amountKop !== "undefined") payload.Amount = amountKop;
    // CustomerKey и OrderId можно передать в payload, но не включать в токен
    if (userId) payload.CustomerKey = userId;
    if (orderId) payload.OrderId = orderId;
    if (ip) payload.IP = ip;
    payload.SendEmail = Boolean(sendEmail);
    if (infoEmail) payload.InfoEmail = infoEmail;

    console.log("🔐 Charge Token RAW (sent):", /* token already logged by generator */ "");
    console.log("📦 Charge payload (sent to Tinkoff):", JSON.stringify(payload));

    // --- POST в Tinkoff Charge ---
    const resp = await fetch(`${TINKOFF_API_URL}/Charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    console.log("📤 Charge HTTP status:", resp.status);
    console.log("📤 Charge Response RAW:", text);

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      console.error("❌ Failed to parse Tinkoff response:", e.message);
      return res.status(500).json({ error: "Invalid response from Tinkoff", httpStatus: resp.status, raw: text });
    }

    if (!data || data.Success !== true) {
      console.error("❌ Charge failed:", data);
      return res.status(400).json({ error: "Charge failed", tinkoff: data, raw: text });
    }

    // --- Сохраняем заказ в Firestore при успехе ---
    await db.collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set({
        orderId,
        amountKop: typeof amountKop !== "undefined" ? amountKop : null,
        currency: "RUB",
        description: description || "recurrent charge",
        tinkoff: data,
        rebillId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    return res.json({ ...data, rebillId });
  } catch (err) {
    console.error("❌ /recurrent-charge error:", err);
    return res.status(500).json({ error: err.message });
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
