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

// === Генерация токена Init ===
function generateTinkoffTokenInit({
  Amount,
  CustomerKey,
  Description,
  OrderId,
  RebillId,
  Recurrent,
  PayType,
  Language,
  NotificationURL
}) {
  const params = [
    { key: "Amount", value: Amount.toString() },
    { key: "CustomerKey", value: CustomerKey },
    { key: "Description", value: Description },
    { key: "OrderId", value: OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "TerminalKey", value: TINKOFF_TERMINAL_KEY }
  ];

  // Добавляем опциональные параметры
  if (RebillId && RebillId.trim() !== "") {
    params.push({ key: "RebillId", value: RebillId });
  }

  if (Recurrent && Recurrent.trim() !== "") {
    params.push({ key: "Recurrent", value: Recurrent });
  }

  if (PayType && PayType.trim() !== "") {
    params.push({ key: "PayType", value: PayType });
  }

  if (Language && Language.trim() !== "") {
    params.push({ key: "Language", value: Language });
  }

  // Добавляем NotificationURL в токен, если он есть
  if (NotificationURL && NotificationURL.trim() !== "") {
    params.push({ key: "NotificationURL", value: NotificationURL });
  }

  // Сортируем по алфавиту по ключу
  params.sort((a, b) => a.key.localeCompare(b.key));

  // Конкатенируем значения
  const raw = params.map(p => p.value).join("");
  console.log("🔐 Token Init RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена FinishAuthorize ===
function generateTinkoffTokenFinish({ Amount, OrderId, PaymentId, NotificationURL }) {
  const params = [
    { key: "Amount", value: Amount.toString() },
    { key: "OrderId", value: OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "PaymentId", value: PaymentId },
    { key: "TerminalKey", value: TINKOFF_TERMINAL_KEY }
  ];

  // Добавляем NotificationURL в токен, если он есть
  if (NotificationURL && NotificationURL.trim() !== "") {
    params.push({ key: "NotificationURL", value: NotificationURL });
  }

  params.sort((a, b) => a.key.localeCompare(b.key));
  const raw = params.map(p => p.value).join("");
  console.log("🔐 Token FinishAuthorize RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Генерация токена для рекуррентного платежа ===
function generateTinkoffTokenCharge({
  Amount,
  OrderId,
  RebillId,
  Description
}) {
  const params = [
    { key: "Amount", value: Amount.toString() },
    { key: "Description", value: Description },
    { key: "OrderId", value: OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "RebillId", value: RebillId },
    { key: "TerminalKey", value: TINKOFF_TERMINAL_KEY }
  ];

  // Сортируем по алфавиту по ключу
  params.sort((a, b) => a.key.localeCompare(b.key));

  // Конкатенируем значения
  const raw = params.map(p => p.value).join("");
  console.log("🔐 Token Charge (Recurrent) RAW:", raw);

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// === Получение RebillId через GetState ===
async function getTinkoffState(paymentId) {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: paymentId
  };

  const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
  payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

  const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  console.log(`📥 Tinkoff response (${method}):`, data);

  return data;
}

// === Вспомогательная функция для поиска заказа по OrderId ===
async function findOrderByOrderId(orderId) {
  try {
    console.log(`🔍 Поиск заказа с OrderId: ${orderId}`);
    
    // Ищем во всех коллекциях заказов
    const usersSnapshot = await db.collection("telegramUsers").get();
    
    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const orderRef = db
        .collection("telegramUsers")
        .doc(userId)
        .collection("orders")
        .doc(orderId);
      
      const orderDoc = await orderRef.get();
      
      if (orderDoc.exists) {
        console.log(`✅ Найден заказ у пользователя ${userId}`);
        return {
          userId,
          orderData: orderDoc.data(),
          orderRef
        };
      }
    }
    
    console.log(`❌ Заказ с OrderId ${orderId} не найден`);
    return null;
    
  } catch (error) {
    console.error("❌ Ошибка при поиске заказа:", error);
    return null;
  }
}

// === Инициирование рекуррентного платежа (ручное списание) ===
router.post("/charge-recurrent", async (req, res) => {
  try {
    const { userId, amount, description, rebillId } = req.body;

    // Проверяем обязательные параметры
    if (!userId || !amount || !description || !rebillId) {
      return res.status(400).json({ 
        error: "Missing required parameters", 
        required: ["userId", "amount", "description", "rebillId"] 
      });
    }

    // Проверяем существование пользователя
    const userDoc = await db.collection("telegramUsers").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    // Генерируем новый OrderId для рекуррентного платежа
    const amountKop = Math.round(amount * 100);
    const orderId = `RCR-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    // Генерируем токен для рекуррентного платежа
    const token = generateTinkoffTokenCharge({
      Amount: amountKop,
      OrderId: orderId,
      RebillId: rebillId,
      Description: description
    });

    // Подготавливаем запрос для рекуррентного платежа
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Token: token,
      Description: description,
      RebillId: rebillId,
      PaymentMethod: "recurrent", // Важно: указываем метод оплаты как рекуррентный
      NotificationURL: NOTIFICATION_URL,
      Receipt: {
        Email: "test@example.com",
        Taxation: "usn_income",
        Items: [
          {
            Name: description,
            Price: amountKop,
            Quantity: 1,
            Amount: amountKop,
            Tax: "none"
          }
        ]
      }
    };

    console.log("💰 Инициируем рекуррентный платеж:", {
      userId,
      amountKop,
      orderId,
      rebillId,
      description
    });

    // Отправляем запрос на списание
    const data = await postTinkoff("Init", payload);

    // Обрабатываем ответ
    if (!data.Success) {
      console.error("❌ Ошибка рекуррентного списания:", data);
      return res.status(400).json({
        error: "Recurrent charge failed",
        tinkoffResponse: data,
        details: data.Message || "Unknown error"
      });
    }

    // Сохраняем информацию о рекуррентном платеже в Firestore
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("recurrentPayments")
      .doc(orderId)
      .set({
        orderId,
        userId,
        amountKop,
        amount,
        currency: "RUB",
        description,
        rebillId,
        tinkoff: {
          PaymentId: data.PaymentId,
          PaymentURL: data.PaymentURL,
          Status: data.Status
        },
        status: "initiated",
        chargeType: "manual_recurrent",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        notificationUrl: NOTIFICATION_URL
      });

    // Также добавляем запись в общую историю платежей пользователя
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
        rebillId,
        tinkoff: { 
          PaymentId: data.PaymentId, 
          PaymentURL: data.PaymentURL 
        },
        paymentType: "recurrent_charge",
        recurrent: "Y",
        payType: "O",
        notificationUrl: NOTIFICATION_URL,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    console.log("✅ Рекуррентный платеж инициирован:", {
      orderId,
      paymentId: data.PaymentId,
      status: data.Status
    });

    res.json({
      success: true,
      message: "Recurrent charge initiated",
      orderId,
      paymentId: data.PaymentId,
      paymentUrl: data.PaymentURL,
      status: data.Status,
      rebillId,
      amount,
      description
    });

  } catch (err) {
    console.error("❌ /charge-recurrent error:", err);
    res.status(500).json({ 
      error: err.message,
      details: "Failed to initiate recurrent charge"
    });
  }
});

// === Получение всех рекуррентных платежей пользователя ===
router.get("/user-recurrent-payments/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId parameter" });
    }

    // Проверяем существование пользователя
    const userDoc = await db.collection("telegramUsers").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    // Получаем все рекуррентные платежи пользователя
    const recurrentPaymentsSnapshot = await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("recurrentPayments")
      .orderBy("createdAt", "desc")
      .get();

    const payments = [];
    recurrentPaymentsSnapshot.forEach(doc => {
      payments.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Получаем все заказы с rebillId (история рекуррентов)
    const ordersWithRebillSnapshot = await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .where("rebillId", "!=", null)
      .orderBy("createdAt", "desc")
      .get();

    const rebillOrders = [];
    ordersWithRebillSnapshot.forEach(doc => {
      rebillOrders.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Получаем первый заказ с rebillId (для получения основного rebillId)
    const firstRebillOrderSnapshot = await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .where("rebillId", "!=", null)
      .orderBy("createdAt", "asc")
      .limit(1)
      .get();

    let primaryRebillId = null;
    if (!firstRebillOrderSnapshot.empty) {
      primaryRebillId = firstRebillOrderSnapshot.docs[0].data().rebillId;
    }

    res.json({
      success: true,
      userId,
      primaryRebillId,
      recurrentPaymentsCount: payments.length,
      recurrentPayments: payments,
      rebillOrdersCount: rebillOrders.length,
      rebillOrders: rebillOrders
    });

  } catch (err) {
    console.error("❌ /user-recurrent-payments error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Проверка статуса рекуррентного платежа ===
router.get("/check-recurrent-status/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId parameter" });
    }

    // Ищем заказ во всей базе
    const foundOrder = await findOrderByOrderId(orderId);
    
    if (!foundOrder) {
      return res.status(404).json({ 
        error: "Order not found",
        orderId 
      });
    }

    const { userId, orderData } = foundOrder;
    const paymentId = orderData.tinkoff?.PaymentId;

    if (!paymentId) {
      return res.status(400).json({ 
        error: "PaymentId not found in order data" 
      });
    }

    // Проверяем статус в Tinkoff
    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId
    };

    const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
    payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

    const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const tinkoffData = await resp.json();

    // Обновляем статус в Firestore если изменился
    if (tinkoffData.Success && tinkoffData.Status !== orderData.tinkoff?.Status) {
      await foundOrder.orderRef.update({
        "tinkoff.Status": tinkoffData.Status,
        "tinkoff.LastCheck": admin.firestore.FieldValue.serverTimestamp()
      });

      // Если это рекуррентный платеж, обновляем и в коллекции recurrentPayments
      if (orderData.chargeType === "manual_recurrent") {
        await db
          .collection("telegramUsers")
          .doc(userId)
          .collection("recurrentPayments")
          .doc(orderId)
          .update({
            status: tinkoffData.Status.toLowerCase(),
            "tinkoff.Status": tinkoffData.Status,
            lastChecked: admin.firestore.FieldValue.serverTimestamp()
          });
      }
    }

    res.json({
      success: true,
      orderId,
      userId,
      localStatus: orderData.status || orderData.tinkoff?.Status,
      tinkoffStatus: tinkoffData.Status,
      tinkoffSuccess: tinkoffData.Success,
      rebillId: orderData.rebillId,
      amount: orderData.amountKop ? orderData.amountKop / 100 : null,
      paymentId,
      tinkoffResponse: tinkoffData
    });

  } catch (err) {
    console.error("❌ /check-recurrent-status error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Init платежа ===
router.post("/init", async (req, res) => {
  try {
    const { amount, userId, description, recurrent = "Y" } = req.body;

    if (!amount || !userId || !description) {
      return res.status(400).json({ error: "Missing amount, userId, description" });
    }

    const amountKop = Math.round(amount * 100);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 36);

    const token = generateTinkoffTokenInit({
      Amount: amountKop,
      CustomerKey: userId,
      Description: description,
      OrderId: orderId,
      RebillId: "", // пусто для новой рекуррентной операции
      Recurrent: recurrent,
      PayType: "O",
      Language: "ru",
      NotificationURL: NOTIFICATION_URL
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: amountKop,
      OrderId: orderId,
      Token: token,
      Description: description,
      CustomerKey: userId,
      Recurrent: recurrent,
      PayType: "O", // One-click оплата (обязательно для рекуррента)
      Language: "ru",
      NotificationURL: NOTIFICATION_URL,
      Receipt: {
        Email: "test@example.com",
        Taxation: "usn_income",
        Items: [
          {
            Name: description,
            Price: amountKop,
            Quantity: 1,
            Amount: amountKop,
            Tax: "none"
          }
        ]
      }
    };

    console.log("🔔 NotificationURL добавлен в запрос Init:", NOTIFICATION_URL);

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
        currency: "RUB",
        description,
        tinkoff: { PaymentId: data.PaymentId, PaymentURL: data.PaymentURL },
        rebillId: null,
        recurrent: recurrent,
        payType: "O",
        notificationUrl: NOTIFICATION_URL,
        customerKey: userId, // Сохраняем явно customerKey для поиска в вебхуке
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
      orderId,
      rebillId: null,
      recurrent,
      notificationUrl: NOTIFICATION_URL
    });
  } catch (err) {
    console.error("❌ /init error:", err);
    res.status(500).json({ error: err.message });
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
      OrderId: orderId,
      PaymentId: paymentId,
      NotificationURL: NOTIFICATION_URL
    });

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId,
      Amount: amountKop,
      OrderId: orderId,
      Description: description,
      Token: token,
      NotificationURL: NOTIFICATION_URL
    };

    console.log("🔔 NotificationURL добавлен в запрос FinishAuthorize:", NOTIFICATION_URL);

    const data = await postTinkoff("FinishAuthorize", payload);
    if (!data.Success) return res.status(400).json(data);

    // Получаем RebillId после первой оплаты
    const rebillId = await getTinkoffState(paymentId);

    // Обновляем заказ в Firestore
    await db
      .collection("telegramUsers")
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .update({
        tinkoff: { ...data },
        rebillId,
        finishedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({ ...data, rebillId, notificationUrl: NOTIFICATION_URL });
  } catch (err) {
    console.error("❌ /finish-authorize error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Проверка состояния платежа и получение RebillId ===
router.post("/check-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    
    if (!paymentId) {
      return res.status(400).json({ error: "Missing paymentId" });
    }

    const rebillId = await getTinkoffState(paymentId);

    res.json({
      paymentId,
      rebillId,
      hasRebill: !!rebillId,
      notificationUrl: NOTIFICATION_URL
    });
  } catch (err) {
    console.error("❌ /check-payment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Полная проверка платежа ===
router.post("/debug-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;

    const payload = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: paymentId
    };

    const raw = `${payload.PaymentId}${TINKOFF_PASSWORD}${TINKOFF_TERMINAL_KEY}`;
    payload.Token = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

    const resp = await fetch(`${TINKOFF_API_URL}/GetState`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();

    res.json({
      paymentId,
      status: data.Status,
      success: data.Success,
      errorCode: data.ErrorCode,
      errorMessage: data.Message,
      rebillId: data.RebillId || data.PaymentData?.RebillId,
      cardId: data.CardId,
      pan: data.Pan,
      notificationUrl: NOTIFICATION_URL,
      fullResponse: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Обработчик вебхука от Tinkoff ===
router.post("/webhook", async (req, res) => {
  try {
    const notification = req.body;
    console.log("📨 Tinkoff Webhook received:", JSON.stringify(notification, null, 2));
    console.log("🌐 Webhook URL:", NOTIFICATION_URL);

    // Проверяем успешность платежа
    if (notification.Success && notification.Status === "CONFIRMED") {
      const { OrderId, PaymentId, RebillId } = notification;
      
      // Получаем CustomerKey из разных возможных полей
      const customerKey = notification.CustomerKey || notification.customerKey;
      
      console.log("✅ Payment confirmed!");
      console.log("📋 OrderId:", OrderId);
      console.log("📋 PaymentId:", PaymentId);
      console.log("📋 RebillId:", RebillId);
      console.log("👤 CustomerKey:", customerKey);

      let userId = customerKey;
      let orderRef = null;

      // Если есть CustomerKey, пытаемся найти заказ напрямую
      if (userId) {
        orderRef = db
          .collection("telegramUsers")
          .doc(userId)
          .collection("orders")
          .doc(OrderId);
        
        const orderDoc = await orderRef.get();
        
        if (!orderDoc.exists) {
          console.log(`⚠️ Заказ ${OrderId} не найден у пользователя ${userId}, ищем по всей БД`);
          userId = null;
        }
      }

      // Если userId не найден или заказ не найден, ищем по всей БД
      if (!userId) {
        const foundOrder = await findOrderByOrderId(OrderId);
        
        if (foundOrder) {
          userId = foundOrder.userId;
          orderRef = foundOrder.orderRef;
        }
      }

      // Если нашли заказ, обновляем его
      if (userId && orderRef) {
        const updateData = {
          tinkoffNotification: notification,
          notifiedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // Добавляем RebillId если он есть
        if (RebillId) {
          updateData.rebillId = RebillId;
          console.log(`💾 Сохраняем RebillId ${RebillId} для заказа ${OrderId}`);
        }

        await orderRef.update(updateData);
        console.log(`✅ Заказ ${OrderId} успешно обновлен для пользователя ${userId}`);
        
        // Если это рекуррентный платеж, обновляем и в коллекции recurrentPayments
        const orderData = await orderRef.get();
        if (orderData.data()?.chargeType === "manual_recurrent") {
          await db
            .collection("telegramUsers")
            .doc(userId)
            .collection("recurrentPayments")
            .doc(OrderId)
            .update({
              status: "confirmed",
              "tinkoff.Status": notification.Status,
              "tinkoff.Notification": notification,
              lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
          console.log(`💳 Рекуррентный платеж ${OrderId} подтвержден`);
        }
      } else {
        console.log(`❌ Не удалось найти заказ ${OrderId} для обновления`);
        
        // Создаем запись в логе необработанных вебхуков
        await db.collection("unprocessedWebhooks").add({
          orderId: OrderId,
          paymentId: PaymentId,
          rebillId: RebillId,
          customerKey: customerKey,
          notification: notification,
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Тут можно добавить логику для отправки уведомлений пользователю
      // или обновления баланса
    } else {
      console.log(`ℹ️ Вебхук получен, но статус не CONFIRMED:`, notification.Status);
    }

    // Всегда возвращаем успешный ответ Tinkoff
    res.json({ Success: true });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    // Все равно возвращаем успех, чтобы Tinkoff не отправлял повторно
    res.json({ Success: true });
  }
});

// === Генерация токена для вебхука (для проверки подписи) ===
function generateWebhookToken(notification) {
  const params = [
    { key: "Amount", value: notification.Amount.toString() },
    { key: "OrderId", value: notification.OrderId },
    { key: "Password", value: TINKOFF_PASSWORD },
    { key: "PaymentId", value: notification.PaymentId },
    { key: "Status", value: notification.Status },
    { key: "TerminalKey", value: notification.TerminalKey }
  ];

  // Если есть дополнительные поля
  if (notification.RebillId) {
    params.push({ key: "RebillId", value: notification.RebillId });
  }

  // Добавляем NotificationURL, если он есть в уведомлении
  if (notification.NotificationURL) {
    params.push({ key: "NotificationURL", value: notification.NotificationURL });
  }

  params.sort((a, b) => a.key.localeCompare(b.key));
  const raw = params.map(p => p.value).join("");

  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export default router;
