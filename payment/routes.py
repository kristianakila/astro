from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from datetime import datetime, timedelta
import requests
import secrets

from firebase.service import db
from payment.utils import generate_token, generate_charge_token, TERMINAL_KEY
from telegram.notifications import send_telegram_message, notify_admins

payment_router = APIRouter()

# Модели данных
class PaymentRequest(BaseModel):
    orderId: str
    amount: int
    description: str
    email: str
    customerKey: str
    productType: str  # subscription | one-time

class ChargeRequest(BaseModel):
    amount: int
    rebillId: str
    customerKey: str

class RecurrentPaymentRequest(BaseModel):
    customerKey: str
    amount: int
    description: str

@payment_router.post("/init-payment")
async def init_payment(payment_request: PaymentRequest):
    try:
        description = f"{payment_request.description} | {payment_request.productType}"

        # Только основные поля для токена (как в JavaScript)
        token_data = {
            "Amount": payment_request.amount,
            "CustomerKey": payment_request.customerKey,
            "Description": description,
            "OrderId": payment_request.orderId,
        }
        
        token = generate_token(token_data)

        # Полный payload для Тинькофф
        init_payload = {
            "TerminalKey": TERMINAL_KEY,
            "Amount": payment_request.amount,
            "OrderId": payment_request.orderId,
            "CustomerKey": payment_request.customerKey,
            "Description": description,
            "Recurrent": "Y" if payment_request.productType == "subscription" else "N",
            "Token": token,
            "Receipt": {
                "Email": payment_request.email,
                "Taxation": "osn",
                "Items": [
                    {
                        "Name": description,
                        "Price": payment_request.amount,
                        "Quantity": 1.0,
                        "Amount": payment_request.amount,
                        "Tax": "none"
                    }
                ]
            }
        }

        print(f"🔧 Sending to Tinkoff: {init_payload}")

        response = requests.post("https://securepay.tinkoff.ru/v2/Init", json=init_payload)
        resp_data = response.json()

        print(f"🔧 Tinkoff response: {resp_data}")

        if resp_data.get("Success"):
            # Сохраняем данные
            db.collection("telegramUsers").document(payment_request.customerKey).set({
                "orderId": payment_request.orderId,
                "productType": payment_request.productType,
                "tinkoff": {
                    "PaymentId": resp_data["PaymentId"],
                    "PaymentURL": resp_data["PaymentURL"],
                    "Recurrent": payment_request.productType == "subscription"
                }
            }, merge=True)

            return {"PaymentURL": resp_data["PaymentURL"], "PaymentId": resp_data["PaymentId"]}
        else:
            error_msg = f"Tinkoff error: {resp_data.get('ErrorCode')} - {resp_data.get('Message')} - {resp_data.get('Details')}"
            print(f"❌ {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg)

    except Exception as e:
        print(f"❌ Error in init-payment: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@payment_router.post("/charge-recurrent")
async def charge_recurrent(charge_request: ChargeRequest):
    """
    Списание средств по рекуррентному платежу
    """
    try:
        # Генерируем уникальный OrderId для каждого списания
        order_id = f"recurrent_{charge_request.customerKey}_{int(datetime.utcnow().timestamp())}"
        
        charge_payload = {
            "TerminalKey": TERMINAL_KEY,
            "Amount": charge_request.amount,
            "OrderId": order_id,
            "RebillId": charge_request.rebillId,
            "CustomerKey": charge_request.customerKey,
        }
        charge_payload["Token"] = generate_charge_token(charge_payload)

        response = requests.post("https://securepay.tinkoff.ru/v2/Charge", json=charge_payload)
        resp_data = response.json()

        if resp_data.get("Success"):
            # Обновляем данные пользователя
            user_ref = db.collection("telegramUsers").document(charge_request.customerKey)
            user_doc = user_ref.get()
            
            if user_doc.exists:
                user_data = user_doc.to_dict()
                product_type = user_data.get("productType", "subscription")
                
                if product_type == "subscription":
                    # Продлеваем подписку на 30 дней
                    expire_at = datetime.utcnow() + timedelta(days=30)
                    user_ref.update({
                        "subscription.status": "Premium",
                        "subscription.expiresAt": expire_at,
                        "tinkoff.lastCharge": {
                            "amount": charge_request.amount,
                            "rebillId": charge_request.rebillId,
                            "orderId": order_id,
                            "chargedAt": firestore.SERVER_TIMESTAMP
                        }
                    })
                    
                    send_telegram_message(
                        chat_id=charge_request.customerKey,
                        text=f"🔄 Подписка продлена до {expire_at.strftime('%d.%m.%Y %H:%M')}."
                    )
                
                # Уведомление администраторам
                admin_message = (
                    f"🔄 Рекуррентное списание:\n"
                    f"User: {charge_request.customerKey}\n"
                    f"Amount: {charge_request.amount}\n"
                    f"RebillId: {charge_request.rebillId}\n"
                    f"Status: success"
                )
                notify_admins(admin_message)
                
                # Запись в историю платежей
                db.collection("recurrentCharges").add({
                    "customerKey": charge_request.customerKey,
                    "orderId": order_id,
                    "amount": charge_request.amount,
                    "rebillId": charge_request.rebillId,
                    "status": "success",
                    "chargedAt": firestore.SERVER_TIMESTAMP
                })
            
            return {"Success": True, "PaymentId": resp_data.get("PaymentId")}
        else:
            error_message = resp_data.get("Message", "Unknown error")
            error_details = resp_data.get("Details", "")
            
            # Логируем ошибку
            db.collection("recurrentCharges").add({
                "customerKey": charge_request.customerKey,
                "orderId": order_id,
                "amount": charge_request.amount,
                "rebillId": charge_request.rebillId,
                "status": "failed",
                "error": error_message,
                "details": error_details,
                "chargedAt": firestore.SERVER_TIMESTAMP
            })
            
            # Уведомление администраторам об ошибке
            admin_message = (
                f"❌ Ошибка рекуррентного списания:\n"
                f"User: {charge_request.customerKey}\n"
                f"Amount: {charge_request.amount}\n"
                f"RebillId: {charge_request.rebillId}\n"
                f"Error: {error_message}\n"
                f"Details: {error_details}"
            )
            notify_admins(admin_message)
            
            raise HTTPException(status_code=400, detail=resp_data)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@payment_router.post("/tinkoff-callback")
async def tinkoff_callback(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    print("🔥 Callback POST получен:", payload)

    if not payload:
        return {"Success": False, "error": "Empty payload"}

    received_token = payload.get("Token")
    customer_key = payload.get("CustomerKey")
    if not received_token or not customer_key:
        return {"Success": False, "error": "Missing Token or CustomerKey"}

    payload_copy = dict(payload)
    payload_copy.pop("Token", None)
    expected_token = generate_token(payload_copy)

    if not secrets.compare_digest(received_token, expected_token):
        return {"Success": False, "error": "Invalid token"}

    status = payload.get("Status")
    user_ref = db.collection("telegramUsers").document(customer_key)
    user_doc = user_ref.get()
    if not user_doc.exists:
        return {"Success": False, "error": "User not found"}

    user_data = user_doc.to_dict()
    product_type = user_data.get("productType", "subscription")

    update_data = {"tinkoff.lastCallbackPayload": payload, "tinkoff.updatedAt": firestore.SERVER_TIMESTAMP}

    if status and status.lower() == "confirmed":
        # Сохраняем RebillId для рекуррентных платежей
        rebill_id = payload.get("RebillId")
        if rebill_id and product_type == "subscription":
            update_data["tinkoff.rebillId"] = rebill_id
            update_data["tinkoff.hasRecurrent"] = True

        # ----------------- Пользователь -----------------
        if product_type == "subscription":
            expire_at = datetime.utcnow() + timedelta(days=30)
            update_data.update({
                "subscription.status": "Premium",
                "subscription.expiresAt": expire_at
            })
            send_telegram_message(
                chat_id=customer_key,
                text=f"🎉 Ваша подписка активирована до {expire_at.strftime('%d.%m.%Y %H:%M')}."
            )
        else:  # one-time
            update_data.update({
                "balance": user_data.get("balance", 0) + 1
            })
            send_telegram_message(
                chat_id=customer_key,
                text="✅ Оплата успешна, баланс пополнен на 1 прогноз."
            )

        # ----------------- Администраторы -----------------
        admin_message = (
            f"💰 Новый платеж:\n"
            f"User: {customer_key}\n"
            f"Product: {product_type}\n"
            f"Amount: {payload.get('Amount', 0)}\n"
            f"Status: {status}"
        )
        if rebill_id:
            admin_message += f"\nRebillId: {rebill_id}"
            
        notify_admins(admin_message)

        # ----------------- Запись в orders -----------------
        db.collection("orders").add({
            "customerKey": customer_key,
            "orderId": payload.get("OrderId", ""),
            "amount": payload.get("Amount", 0),
            "status": status,
            "productType": product_type,
            "rebillId": rebill_id,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "tinkoffPayload": payload
        })

    user_ref.update(update_data)
    return {"Success": True}

@payment_router.get("/tinkoff-callback")
async def tinkoff_callback_get(request: Request):
    params = dict(request.query_params)
    print("🌐 Callback GET получен:", params)

    order_id = params.get("OrderId")
    if not order_id:
        return {"Success": False, "error": "Missing OrderId"}

    # Ищем пользователя по orderId
    users_ref = db.collection("telegramUsers").where("orderId", "==", order_id).stream()
    updated = False
    for doc in users_ref:
        user_ref = db.collection("telegramUsers").document(doc.id)
        user_data = doc.to_dict()
        product_type = user_data.get("productType", "subscription")

        update_data = {
            "tinkoff.lastCallbackParams": params,
            "tinkoff.updatedAt": firestore.SERVER_TIMESTAMP
        }

        if params.get("Success", "").lower() == "true":
            # Сохраняем RebillId для рекуррентных платежей
            rebill_id = params.get("RebillId")
            if rebill_id and product_type == "subscription":
                update_data["tinkoff.rebillId"] = rebill_id
                update_data["tinkoff.hasRecurrent"] = True

            # ----------------- Пользователь -----------------
            if product_type == "subscription":
                expire_at = datetime.utcnow() + timedelta(days=30)
                update_data.update({
                    "subscription.status": "Premium",
                    "subscription.expiresAt": expire_at
                })
                send_telegram_message(
                    chat_id=doc.id,
                    text=f"🎉 Ваша подписка активирована до {expire_at.strftime('%d.%m.%Y %H:%M')}."
                )
            else:  # one-time
                update_data.update({
                    "balance": user_data.get("balance", 0) + 1
                })
                send_telegram_message(
                    chat_id=doc.id,
                    text="✅ Оплата успешна, баланс пополнен на 1 прогноз."
                )

            # ----------------- Администраторы -----------------
            admin_message = (
                f"💰 Новый платеж (GET callback):\n"
                f"User: {doc.id}\n"
                f"Product: {product_type}\n"
                f"Amount: {params.get('Amount', 0)}\n"
                f"Status: confirmed"
            )
            if rebill_id:
                admin_message += f"\nRebillId: {rebill_id}"
                
            notify_admins(admin_message)

            # ----------------- Запись в orders -----------------
            db.collection("orders").add({
                "customerKey": doc.id,
                "orderId": params.get("OrderId", ""),
                "amount": int(params.get("Amount", 0)),
                "status": "confirmed",
                "productType": product_type,
                "rebillId": rebill_id,
                "createdAt": firestore.SERVER_TIMESTAMP,
                "tinkoffPayload": params
            })

        user_ref.update(update_data)
        updated = True

    if not updated:
        return {"Success": False, "error": "User with this OrderId not found"}

    return {"Success": True}
