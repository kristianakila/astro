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


// === Генерация токена: сортировка параметров по алфавиту по именам ключей ===
function generateTokenAlphabetical(params = {}, { appendTerminalKey = false } = {}) {
  // Преобразуем значения в строки и удалим undefined/null
  const kv = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)]);

  // Сортируем по имени ключа в лексикографическом (алфавитном) порядке
  kv.sort((a, b) => a[0].localeCompare(b[0], "en"));

  // Конкатенируем только значения (в порядке отсортированных ключей)
  const concatenated = kv.map(([, v]) => v).join("");

  // В конце — пароль, и при необходимости TerminalKey
  const raw = concatenated + TINKOFF_PASSWORD + (appendTerminalKey ? TINKOFF_TERMINAL_KEY : "");

  console.log("🔐 Token Alphabetical RAW:", { order: kv.map(([k]) => k), rawPreview: raw.slice(0, 200) });

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Обёртка для рекуррентного токена ===
function generateRecurrentToken(params) {
  // В params передаём: amount, description, recurrent, receipt, phone, email, expired, taxation, language, extra_params
  // Функция сама отсортирует поля по алфавиту и создаст SHA256(raw + password)
  return generateTokenAlphabetical(params, { appendTerminalKey: false });
}


// === Генерация токена FinishAuthorize ===
// === Генерация токена FinishAuthorize (с алфавитной сортировкой) ===
function generateTinkoffTokenFinish(params) {
  // Тinkoff требует в некоторых методах TerminalKey в raw — поэтому appendTerminalKey = true
  // params ожидает поля: Amount, CustomerKey, Description, OrderId, PaymentId
  // Мы сортируем имена полей по алфавиту и конкатенируем значения в этом порядке, затем добавляем пароль + TerminalKey
  return generateTokenAlphabetical(params, { appendTerminalKey: true });
}


// === Получение RebillId через GetState ===
async function getTinkoffState(paymentId) {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId,
  };

  const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

  const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  console.log("📥 Tinkoff GetState response:", data);

  return data.PaymentData?.RebillId || null;
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  console.log(`📤 Tinkoff request: ${method}`, payload);

  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  console.log(`📥 Tinkoff response (${method}):`, data);

  return data;
}

// ============================================================
// === Init рекуррентного платежа ===
// ============================================================

router.post("/init", async (req, res) => {
  try {
    const { priceNextMonth, discount, userId, phone, email } = req.body;

    if (!priceNextMonth || discount === undefined || !userId) {
      return res.status(400).json({
        error: "Missing priceNextMonth, discount, userId",
      });
    }

    // Цена со скидкой (целое число!)
    const finalAmount = parseInt(priceNextMonth * (1 - discount / 100));
    const amountKop = finalAmount * 100;

    const orderId = `ORD-${Date.now()}-${Math.floor(
      Math.random() * 9000 + 1000
    )}`.slice(0, 36);

    // Описание рекуррентного списания
    const description = `Доступ к астро-асистенту [${priceNextMonth}р./мес.]`;

    // === Формируем Receipt ===
    const receiptObject = {
      Email: email || "",
      Phone: phone || "",
      Taxation: "usn_income",
      Items: [
        {
          Name: description,
          Price: amountKop,
          Quantity: 1,
          Amount: amountKop,
          Tax: "none",
          PaymentObject: "service",
        },
      ],
    };

    const receiptString = JSON.stringify(receiptObject);

    const recurrent = "1";
    const expired = "";
    const taxation = "usn_income";
    const language = "ru";
    const extra_params = "";

    // === Генерируем токен строго в указанном порядке ===
    const token = generateRecurrentToken({
      amount: finalAmount,
      description,
      recurrent,
      receipt: receiptString,
      phone: phone || "",
      email: email || "",
      expired,
      taxation,
      language,
      extra_params,
    });

    // === Payload Init ===
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      Language: language,
      Receipt: receiptObject,
      Token: token,
    };

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
        amount: finalAmount,
        description,
        tinkoff: {
          PaymentId: data.PaymentId,
          PaymentURL: data.PaymentURL,
        },
        rebillId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// === FinishAuthorize (первая успешная оплата, получение RebillId)
// ============================================================

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

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      Token: token,
    };

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    const rebillId = await getTinkoffState(paymentId);

    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update({
        tinkoff: data,
        rebillId,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ ...data, rebillId });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
