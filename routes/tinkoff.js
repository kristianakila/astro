import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import crypto from "crypto";
import iconv from 'iconv-lite'
import { parseStringPromise } from "xml2js";

// === Константы Tinkoff ===
const TINKOFF_TERMINAL_KEY = "1691507148627";
const TINKOFF_PASSWORD = "rlkzhollw74x8uvv";
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";

// === Firebase ===
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

// === Генерация токена Init ===
function generateTinkoffTokenInit({ Amount, CustomerKey, Description, OrderId }) {
  const tokenString = `${Amount}${CustomerKey}${Description}${OrderId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  return crypto.createHash("sha256").update(tokenString, "utf8").digest("hex");
}

// === Генерация токена FinishAuthorize ===
function generateTinkoffTokenFinish({ Amount, CustomerKey, Description, OrderId, PaymentId }) {
  const tokenString = `${Amount}${CustomerKey}${Description}${OrderId}${PaymentId || ""}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  return crypto.createHash("sha256").update(tokenString, "utf8").digest("hex");
}

// === POST к Tinkoff API ===
async function postTinkoff(method, payload) {
  const resp = await fetch(`${TINKOFF_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await resp.json();
}

const router = express.Router();

// === Курс USD → RUB ===
async function getUsdToRubRate() {
  try {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const dateStr = `${dd}/${mm}/${yyyy}`;

    const cbUrl = `https://www.cbr.ru/scripts/XML_daily.asp?date_req=${dateStr}`;
    const resp = await fetch(cbUrl);
    if (!resp.ok) throw new Error('CBR fetch failed');

    const buffer = await resp.arrayBuffer();
    const text = iconv.decode(Buffer.from(buffer), 'win1251');

    const regex = /<Valute\s+ID="[^"]*">[\s\S]*?<CharCode>USD<\/CharCode>[\s\S]*?<Nominal>(\d+)<\/Nominal>[\s\S]*?<Value>([\d,]+)<\/Value>[\s\S]*?<\/Valute>/i;
    const match = text.match(regex);
    if (!match) throw new Error('USD rate not found in CBR XML');

    const nominal = parseInt(match[1], 10);
    const value = parseFloat(match[2].replace(',', '.'));
    return value / nominal;

  } catch (err) {
    console.warn('Failed to fetch USD rate from CBR, fallback to Firebase:', err.message);
    const ratesDoc = await db.collection("settings").doc("exchangeRates").get();
    const ratesData = ratesDoc.exists ? ratesDoc.data() : { USD_RUB: 100 };
    return ratesData.USD_RUB;
  }
}

// === Init ===
router.post("/init", async (req, res) => {
  try {
    const { amount, currency = "RUB", userId, orderId, description } = req.body;
    if (!amount || !userId || !description)
      return res.status(400).json({ error: "Missing amount, userId or description" });

    let usdToRub = 1;
    if (currency === "USD") usdToRub = await getUsdToRubRate();

    let amountInRub = Number(amount);
    if (currency === "USD") amountInRub = amountInRub * usdToRub;

    const amountInKopecks = Math.round(amountInRub * 100);
    const finalOrderId = (orderId || `ORD${Date.now()}${Math.floor(Math.random() * 10000)}`).slice(0, 36);

    const token = generateTinkoffTokenInit({
      Amount: amountInKopecks,
      CustomerKey: userId,
      Description: description,
      OrderId: finalOrderId,
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountInKopecks,
      OrderId: finalOrderId,
      CustomerKey: userId,
      Description: description,
      Token: token,
      Receipt: {
        Email: "test@example.com",
        Taxation: "osn",
        Items: [
          {
            Name: description,
            Price: amountInKopecks,
            Quantity: 1.0,
            Amount: amountInKopecks,
            Tax: "none"
          }
        ]
      }
    };

    const data = await postTinkoff("Init", payload);
    if (!data.Success) return res.status(400).json(data);

    await db.collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(finalOrderId)
      .set({
        orderId: finalOrderId,
        amountInKopecks,
        currency,
        usdToRub,
        description,
        tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ PaymentURL: data.PaymentURL, PaymentId: data.PaymentId });
  } catch (err) {
    console.error("Init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === FinishAuthorize ===
router.post("/finish-authorize", async (req, res) => {
  try {
    const { userId, orderId, paymentId, amount, description } = req.body;
    if (!userId || !orderId || !paymentId || !amount || !description)
      return res.status(400).json({ error: "Missing parameters" });

    const amountInKopecks = Math.round(Number(amount) * 100);

    const token = generateTinkoffTokenFinish({
      Amount: amountInKopecks,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      PaymentId: paymentId,
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountInKopecks,
      OrderId: orderId,
      Description: description,
      Token: token,
    };

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    await db.collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update({
        description,
        tinkoff: { ...data },
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json(data);
  } catch (err) {
    console.error("FinishAuthorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
