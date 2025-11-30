from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os

print("✅ main.py загружен и выполняется")

# Создаем основное приложение
app = FastAPI(title="Payment API", version="1.0.0")

# Настройка CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://womenvenera.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Импортируем маршруты после создания app
from payment.routes import payment_router
from subscriptions.checker import start_subscription_checker

# Подключаем маршруты
app.include_router(payment_router, prefix="/api")

# Запускаем проверку подписок
start_subscription_checker()

@app.get("/")
def root():
    return {"status": "ok", "message": "Payment API работает"}

@app.get("/health")
def health_check():
    return {"status": "healthy"}
