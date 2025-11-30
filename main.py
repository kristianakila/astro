from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import os
import requests
import hashlib

print("🚀 Starting ultra-minimal Payment API...")

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
    return {"status": "ok", "message": "Ultra-minimal Payment API"}

@app.get("/health")
def health_check():
    return {"status": "healthy", "firebase": "disabled"}

@app.post("/api/init-payment")
async def init_payment(payment_request: PaymentRequest):
    try:
        print(f"💳 Payment request received: {payment_request.dict()}")
        
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
            return {
                "PaymentURL": data["PaymentURL"], 
                "PaymentId": data["PaymentId"],
                "message": "Payment initialized successfully"
            }
        else:
            error_msg = f"Tinkoff error: {data.get('Message')}"
            print(f"❌ {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg)

    except Exception as e:
        print(f"❌ Error in init-payment: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tinkoff-callback")
async def tinkoff_callback(request: dict):
    try:
        print(f"🔥 POST Callback received: {request}")
        return {"Success": True, "message": "Callback processed"}
    except Exception as e:
        print(f"❌ Callback error: {e}")
        return {"Success": False}

@app.get("/api/tinkoff-callback")
async def tinkoff_callback_get():
    print(f"🌐 GET Callback received")
    return {"Success": True}

@app.get("/api/test")
def test_endpoint():
    return {
        "status": "working", 
        "terminal_key": bool(TERMINAL_KEY),
        "secret_key": bool(SECRET_KEY)
    }

print("✅ Ultra-minimal Payment API started successfully!")
