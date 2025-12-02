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

// === Универсальная генерация токена для Init/FinishAuthorize/GetState ===
function generateTinkoffTokenInit(params) {
  const base = [
    { key: "Amount", value: params.Amount?.toString() || "" },
    { key: "CustomerKey", value: params.CustomerKey || "" },
    { key: "Description", value: params.Description || "" },
    { key: "OrderId", value: params.OrderId || "" },
    { key: "PaymentId", value: params.PaymentId || "" },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "TerminalKey", value: TINKOFF_TERMINAL_KEY },
    { key: "RebillId", value: params.RebillId || "" },
    { key: "Recurrent", value: params.Recurrent || "" },
    { key: "PayType", value: params.PayType || "" },
    { key: "Language", value: params.Language || "" },
    { key: "NotificationURL", value: params.NotificationURL || "" },
    { key: "Status", value: params.Status || "" }
  ];
  const sorted = base.filter(p => p.value !== "").sort((a, b) => a.key.localeCompare(b.key));
  const raw = sorted.map(p => p.value).join("");
  console.log("🔐 Token RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена для Rebill (MIT COF Recurring) ===
function generateTinkoffTokenRebill(params) {
  // порядок строго по документации Tinkoff
  const fields = [
    params.Amount?.toString() || "",
    params.CustomerKey || "",
    params.Description || "",
    params.OrderId || "",
    params.RebillId || "",
    params.PayType || "",
    params.NotificationURL || "",
    params.OperationInitiatorType || "",
    TINKOFF_PASSWORD
  ];
  const raw = fields.join("");
  console.log("🔐 Rebill Token RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await resp.json();
}

// === Получение RebillId через GetState ===
async function getTinkoffState(paymentId) {
  const token = generateTinkoffTokenInit({ PaymentId: paymentId });
  const resp = await postTinkoff("GetState", { TerminalKey: TINKOFF_TERMINAL_KEY, PaymentId: paymentId, Token: token });
  return resp.PaymentData?.RebillId || null;
}

// === Поиск заказа по OrderId ===
async function findOrderByOrderId(orderId) {
  const usersSnapshot = await db.collection("telegramUsers").get();
  for (const userDoc of usersSnapshot.docs) {
    const orderRef = db.collection("telegramUsers").doc(userDoc.id).collection("orders").doc(orderId);
    const orderDoc = await orderRef.get();
    if (orderDoc.exists) return { userId: userDoc.id, orderRef, orderData: orderDoc.data() };
  }
  return null;
}

// === Init платежа ===
router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;
    if (!amount || !userId || !description) return res.status(400).json({ error: "Missing amount, userId, description" });

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffTokenInit({
      Amount: amountKop, CustomerKey: userId, Description: description,
      OrderId: orderId, RebillId: "", Recurrent: recurrent,
      PayType: "O", Language: "ru", NotificationURL: NOTIFICATION_URL
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Token: token,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: NOTIFICATION_URL,
      Receipt: { Email: "test@example.com", Taxation: "usn_income", Items: [{ Name: description, Price: amountKop, Quantity: 1, Amount: amountKop, Tax: "none" }] }
    };

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    await db.collection("telegramUsers").doc(userId).collection("orders").doc(orderId).set({
      orderId, amountKop, currency: "RUB", description,
      tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
      rebillId: null, recurrent, payType: "O",
      notificationUrl: NOTIFICATION_URL, customerKey: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ PaymentURL: data.PaymentURL, PaymentId: data.PaymentId, orderId, rebillId: null, recurrent, notificationUrl: NOTIFICATION_URL });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// === FinishAuthorize платежа ===
router.post("/finish-authorize", async (req, res) => {
  try {
    const { userId, orderId, paymentId, amount, description } = req.body;
    if (!userId || !orderId || !paymentId || !amount || !description) return res.status(400).json({ error: "Missing params" });

    const amountKop = Math.round(amount * 100);
    const token = generateTinkoffTokenInit({ Amount: amountKop, OrderId: orderId, PaymentId: paymentId, NotificationURL: NOTIFICATION_URL });

    const payload = { TerminalKey: TINKOFF_TERMINAL_KEY, PaymentId: paymentId, Amount: amountKop, OrderId: orderId, Description: description, Token: token, NotificationURL: NOTIFICATION_URL };
    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    const rebillId = await getTinkoffState(paymentId);
    await db.collection("telegramUsers").doc(userId).collection("orders").doc(orderId).update({
      tinkoff: { ...data }, rebillId, finishedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ...data, rebillId, notificationUrl: NOTIFICATION_URL });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// === Проверка состояния платежа ===
router.post("/check-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: "Missing paymentId" });
    const rebillId = await getTinkoffState(paymentId);
    res.json({ paymentId, rebillId, hasRebill: !!rebillId, notificationUrl: NOTIFICATION_URL });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// === Debug платежа ===
router.post("/debug-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    const token = generateTinkoffTokenInit({ PaymentId: paymentId });
    const resp = await postTinkoff("GetState", { TerminalKey: TINKOFF_TERMINAL_KEY, PaymentId: paymentId, Token: token });
    res.json({ paymentId, notificationUrl: NOTIFICATION_URL, ...resp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// === Рекуррентное списание по RebillId (MIT COF Recurring) ===
router.post("/recurrent-charge", async (req, res) => {
  try {
    const {
      userId,
      paymentId,
      rebillId,
      amount,         // рубли, опционально
      description,    // опционально
      orderId: clientOrderId, // опционально
      ip,             // опционально, example: "2011:0db8:85a3:0101:0101:8a2e:0370:7334"
      sendEmail = false,   // опционально
      infoEmail = ""       // опционально
    } = req.body;

    if (!userId || !paymentId || !rebillId) {
      return res.status(400).json({ error: "Missing params: userId, paymentId and rebillId are required" });
    }

    // amount в копейках (если передан)
    const amountKop = typeof amount === "number" ? Math.round(amount * 100) : undefined;

    // orderId — генерируем, если клиент не передал
    const orderId = clientOrderId || `RC-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    // === Функция генерации токена в строгом порядке параметров ===
    function generateChargeTokenStrict(opts) {
      // Порядок — строго такой: TerminalKey, PaymentId, RebillId, Amount (если есть),
      // CustomerKey (userId, если есть), OrderId, IP, SendEmail, InfoEmail, Password
      const parts = [];

      parts.push(opts.TerminalKey ?? "");
      parts.push(opts.PaymentId ?? "");
      parts.push(opts.RebillId ?? "");

      if (opts.Amount !== undefined && opts.Amount !== null) parts.push(String(opts.Amount));
      if (opts.CustomerKey) parts.push(String(opts.CustomerKey));
      if (opts.OrderId) parts.push(String(opts.OrderId));
      if (opts.IP) parts.push(String(opts.IP));
      // SendEmail — приводим к 'true'/'false' строке если был явно передан
      if (typeof opts.SendEmail !== "undefined") parts.push(String(Boolean(opts.SendEmail)));
      if (opts.InfoEmail) parts.push(String(opts.InfoEmail));

      // в конце добавляем пароль (секрет терминала) — обязательно
      parts.push(TINKOFF_PASSWORD);

      const raw = parts.join("");
      console.log("🔐 Charge Token RAW (strict order):", raw);
      return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
    }

    // === Собираем параметры для подписи ===
    const tokenParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      RebillId: rebillId,
      // если amountKop присутствует, включаем
      ...(typeof amountKop !== "undefined" ? { Amount: amountKop } : {}),
      CustomerKey: userId,
      OrderId: orderId,
      IP: ip,
      SendEmail: sendEmail,
      InfoEmail: infoEmail
    };

    // Генерация токена строго в порядке, который прописан в generateChargeTokenStrict
    const token = generateChargeTokenStrict(tokenParams);

    // === Формируем payload строго по примеру: TerminalKey, PaymentId, RebillId, Token, IP, SendEmail, InfoEmail
    // Добавляем Amount/CustomerKey/OrderId только если есть — но Token уже сформирован с учётом этих полей (если они были)
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      RebillId: rebillId,
      Token: token
    };

    if (typeof amountKop !== "undefined") payload.Amount = amountKop;
    if (userId) payload.CustomerKey = userId;
    if (orderId) payload.OrderId = orderId;
    if (ip) payload.IP = ip;
    // в теле запроса в примере IP, SendEmail, InfoEmail идут после Token — соблюдаем это
    if (typeof sendEmail !== "undefined") payload.SendEmail = Boolean(sendEmail);
    if (infoEmail) payload.InfoEmail = infoEmail;

    // логируем payload для отладки (убрать/редуцировать в prod)
    console.log("📦 Charge payload (sent to Tinkoff):", JSON.stringify(payload));

    // === Отправка запроса в Tinkoff Charge ===
    const resp = await fetch(`${TINKOFF_API_URL}/Charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      // добавим таймаут если нужно через AbortController в будущем
    });

    const text = await resp.text();
    console.log("📤 Tinkoff Charge HTTP status:", resp.status);
    console.log("📤 Tinkoff Charge raw response:", text);

    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      console.error("❌ JSON parse error:", e.message);
      return res.status(500).json({
        error: "Invalid response from Tinkoff (not JSON)",
        httpStatus: resp.status,
        raw: text,
        tokenRawExample: "see server logs"
      });
    }

    if (!data || data.Success !== true) {
      console.error("❌ Charge failed:", data);
      // возвращаем тело от tinkoff прямо клиенту для отладки
      return res.status(400).json({ error: "Charge failed", httpStatus: resp.status, tinkoff: data, raw: text });
    }

    // === При успехе сохраняем заказ в Firestore ===
    await db.collection("telegramUsers").doc(userId).collection("orders").doc(orderId).set({
      orderId,
      amountKop: typeof amountKop !== "undefined" ? amountKop : null,
      currency: "RUB",
      description: description || "recurrent charge",
      tinkoff: { ...data },
      rebillId,
      recurrent: "Y",
      notificationUrl: NOTIFICATION_URL,
      customerKey: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ...data, rebillId, notificationUrl: NOTIFICATION_URL });
  } catch (err) {
    console.error("❌ /recurrent-charge error:", err);
    return res.status(500).json({ error: err.message });
  }
});




// === Вебхук Tinkoff ===
router.post("/webhook", async (req, res) => {
  try {
    const n = req.body;
    console.log("📨 Webhook:", n);

    if (n.Success && n.Status === "CONFIRMED") {
      let userId = n.CustomerKey || n.customerKey;
      let orderRef = userId ? db.collection("telegramUsers").doc(userId).collection("orders").doc(n.OrderId) : null;
      const orderDoc = orderRef ? await orderRef.get() : null;

      if (!orderDoc?.exists) {
        const found = await findOrderByOrderId(n.OrderId);
        if (found) { userId = found.userId; orderRef = found.orderRef; }
      }

      if (userId && orderRef) {
        const updateData = { tinkoffNotification: n, notifiedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (n.RebillId) updateData.rebillId = n.RebillId;
        await orderRef.update(updateData);
      } else {
        await db.collection("unprocessedWebhooks").add({ orderId: n.OrderId, paymentId: n.PaymentId, rebillId: n.RebillId, customerKey: userId, notification: n, receivedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    res.json({ Success: true });
  } catch (err) { console.error("❌ Webhook error:", err); res.json({ Success: true }); }
});

export default router;
