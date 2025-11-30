from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import os
import requests
import hashlib
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime

print("🚀 Starting minimal Payment API...")

# Минимальная инициализация Firebase
def init_firebase():
    if not firebase_admin._apps:
        firebase_private_key = os.getenv("FIREBASE_PRIVATE_KEY")
        if firebase_private_key:
            firebase_config = {
                "type": "service_account",
                "project_id": os.getenv("FIREBASE_PROJECT_ID"),
                "private_key_id": os.getenv("FIREBASE_PRIVATE_KEY_ID"),
                "private_key": firebase_private_key.replace('\\n', '\n'),
                "client_email": os.getenv("FIREBASE_CLIENT_EMAIL"),
                "client_id": os.getenv("FIREBASE_CLIENT_ID"),
                "client_x509_cert_url": os.getenv("FIREBASE_CLIENT_X509_CERT_URL"),
            }
            cred = credentials.Certificate(firebase_config)
            firebase_admin.initialize_app(cred)
            print("✅ Firebase initialized")
        else:
            print("❌ Firebase private key not found")
            return None
    return firestore.client()

# Инициализируем Firebase
db = init_firebase()

# Создаем приложение
app = FastAPI(title="Payment API", version="1.0.0")

# Константы
TERMINAL_KEY = os.getenv("TERMINAL_KEY", "1691507148627")
SECRET_KEY = os.getenv("SECRET_KEY", "rlkzhollw74x8uvv")

# Модели
class PaymentRequest(BaseModel):
    orderId: str
    amount: int
    description: str
    email: str
    customerKey: str
    productType: str

# Утилиты
def generate_token(data: dict) -> str:
    token_fields = [
        str(data.get("Amount", "")),
        str(data.get("OrderId", "")),
        str(data.get("CustomerKey", "")),
        str(data.get("Description", "")),
        SECRET_KEY,
        TERMINAL_KEY,
    ]
    token_string = ''.join(token_fields)
    return hashlib.sha256(token_string.encode("utf-8")).hexdigest()

# Основные эндпоинты
@app.get("/")
def root():
    return {"status": "ok", "message": "Minimal Payment API"}

@app.get("/health")
def health_check():
    if db:
        return {"status": "healthy", "firebase": "connected"}
    return {"status": "degraded", "firebase": "disconnected"}

@app.post("/api/init-payment")
async def init_payment(payment_request: PaymentRequest):
    try:
        print(f"💳 Payment request: {payment_request}")
        
        # Генерируем токен
        token_data = {
            "Amount": payment_request.amount,
            "CustomerKey": payment_request.customerKey,
            "Description": payment_request.description,
            "OrderId": payment_request.orderId,
        }
        token = generate_token(token_data)

        # Payload для Тинькофф
        payload = {
            "TerminalKey": TERMINAL_KEY,
            "Amount": payment_request.amount,
            "OrderId": payment_request.orderId,
            "CustomerKey": payment_request.customerKey,
            "Description": payment_request.description,
            "Recurrent": "Y" if payment_request.productType == "subscription" else "N",
            "Token": token,
            "Receipt": {
                "Email": payment_request.email,
                "Taxation": "osn",
                "Items": [
                    {
                        "Name": payment_request.description,
                        "Price": payment_request.amount,
                        "Quantity": 1.0,
                        "Amount": payment_request.amount,
                        "Tax": "none"
                    }
                ]
            }
        }

        print(f"📤 Sending to Tinkoff: {payload}")

        # Отправляем запрос в Тинькофф
        response = requests.post("https://securepay.tinkoff.ru/v2/Init", json=payload)
        data = response.json()

        print(f"📥 Tinkoff response: {data}")

        if data.get("Success"):
            # Сохраняем в Firebase
            if db:
                db.collection("telegramUsers").document(payment_request.customerKey).set({
                    "orderId": payment_request.orderId,
                    "productType": payment_request.productType,
                    "tinkoff": {
                        "PaymentId": data["PaymentId"],
                        "PaymentURL": data["PaymentURL"],
                    },
                    "updatedAt": datetime.utcnow()
                }, merge=True)
                print("✅ Data saved to Firebase")

            return {"PaymentURL": data["PaymentURL"], "PaymentId": data["PaymentId"]}
        else:
            error_msg = f"Tinkoff error: {data.get('Message')}"
            print(f"❌ {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg)

    except Exception as e:
        print(f"❌ Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tinkoff-callback")
async def tinkoff_callback(request: dict):
    try:
        print(f"🔥 Callback received: {request}")
        
        # Простая обработка callback
        if db and request.get("CustomerKey"):
            customer_key = request.get("CustomerKey")
            status = request.get("Status")
            
            db.collection("telegramUsers").document(customer_key).set({
                "tinkoff": {
                    "lastCallback": request,
                    "updatedAt": datetime.utcnow()
                }
            }, merge=True)
            
            print(f"✅ Callback processed for user: {customer_key}, status: {status}")
        
        return {"Success": True}
    except Exception as e:
        print(f"❌ Callback error: {e}")
        return {"Success": False}

@app.get("/api/tinkoff-callback")
async def tinkoff_callback_get(request: dict):
    print(f"🌐 GET Callback received: {request}")
    return {"Success": True}

print("✅ Minimal Payment API started successfully!")
