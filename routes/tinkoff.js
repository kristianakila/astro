import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import iconv from "iconv-lite";
import { parseStringPromise } from "xml2js";
import { db } from "../index.js"; // <<< Firestore теперь отсюда
import admin from "firebase-admin";

const router = express.Router();

// === Константы Tinkoff ===
const TINKOFF_TERMINAL_KEY = "1691507148627";
const TINKOFF_PASSWORD = "rlkzhollw74x8uvv";
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";

// === Генерация токена Init ===
function generateTinkoffTokenInit({ Amount, CustomerKey, Description, OrderId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Init RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена Finish ===
function generateTinkoffTokenFinish({ Amount, CustomerKey, Description, OrderId, PaymentId }) {
  const raw = `${Amount}${CustomerKey}${Description}${OrderId}${PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  console.log("🔐 Token Finish RAW:", raw);
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
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

// === Курс USD → RUB ===
async function getUsdToRubRate() {
  try {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const dateStr = `${dd}/${mm}/${yyyy}`;

    const cbUrl = `https://www.cbr.ru/scripts/XML_daily.asp?date_req=${dateStr}`;
    console.log("📡 Fetching CBR:", cbUrl);

    const resp = await fetch(cbUrl);
    if (!resp.ok) throw new Error("CBR fetch failed");

    const buffer = await resp.arrayBuffer();
    const text = iconv.decode(Buffer.from(buffer), "win1251");

    const match = text.match(
      /<Valute\s+ID="[^"]*">[\s\S]*?<CharCode>USD<\/CharCode>[\s\S]*?<Nominal>(\d+)<\/Nominal>[\s\S]*?<Value>([\d,]+)<\/Value>[\s\S]*?<\/Valute>/i
    );

    if (!match) throw new Error("USD not found in XML");

    const nominal = parseInt(match[1], 10);
    const value = parseFloat(match[2].replace(",", "."));
    const rate = value / nominal;

    console.log("💱 CBR USD/RUB:", rate);
    return rate;
  } catch (err) {
    console.warn("⚠️ CBR error, fallback:", err.message);

    const doc = await db.collection("settings").doc("exchangeRates").get();
    const val = doc.exists ? doc.data().USD_RUB : 100;

    console.log("💱 Using fallback USD/RUB:", val);
    return val;
  }
}

// === Init ===
router.post("/init", async (req, res) => {
  console.log("➡️ /api/init BODY:", req.body);

  try {
    const { amount, currency = "RUB", userId, orderId, description } = req.body;

    if (!amount || !userId || !description) {
      console.log("❌ Missing params");
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    // === Конвертация при USD ===
    let rate = 1;
    if (currency === "USD") rate = await getUsdToRubRate();

    const amountRub = currency === "USD" ? amount * rate : amount;
    const amountKop = Math.round(amountRub * 100);

    const finalOrderId =
      (orderId || `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`).slice(0, 36);

    console.log("🧾 Amount RUB:", amountRub, "Kopecks:", amountKop);
    console.log("🧾 OrderId:", finalOrderId);

    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: finalOrderId,
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: finalOrderId,
      Description: description,
      CustomerKey: userId,
      Token: token,
      Receipt: {
        Email: "test@example.com",
        Taxation: "osn",
        Items: [
          {
            Name: description,
            Price: amountKop,
            Quantity: 1,
            Amount: amountKop,
            Tax: "none",
          },
        ],
      },
    };

    const data = await postTinkoff("Init", payload);
    if (!data.Success) {
      console.log("❌ Tinkoff Init failed");
      return res.status(400).json(data);
    }

    // === Firestore запись заказа ===
    console.log("🔥 Saving new order to Firestore");
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(finalOrderId)
      .set({
        orderId: finalOrderId,
        amountKop,
        currency,
        usdRate: rate,
        description,
        tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId: finalOrderId,
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === FinishAuthorize ===
router.post("/finish-authorize", async (req, res) => {
  console.log("➡️ /api/finish-authorize BODY:", req.body);

  try {
    const { userId, orderId, paymentId, amount, description } = req.body;

    if (!userId || !orderId || !paymentId || !amount || !description) {
      console.log("❌ Missing params finish-authorize");
      return res.status(400).json({ error: "Missing params" });
    }

    const amountKop = Math.round(amount * 100);
    console.log("🧾 Finish amount:", amountKop);

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
    if (!data.Success) {
      console.log("❌ Finish authorize failed");
      return res.status(400).json(data);
    }

    console.log("🔥 Updating order in Firestore");

    await db
      .collection("telegramUsers")
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
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
