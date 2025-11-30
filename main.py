from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
from firebase.service import db, check_firebase_connection

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
    """Проверка здоровья приложения"""
    firebase_status = check_firebase_connection()
    status = "healthy" if firebase_status else "degraded"
    
    return {
        "status": status,
        "firebase": "connected" if firebase_status else "disconnected",
        "timestamp": "2024-01-01T00:00:00Z"  # Здесь можно добавить реальное время
    }

@app.get("/debug/env")
def debug_env():
    """Эндпоинт для отладки переменных окружения (удалите после настройки)"""
    env_vars = {
        "FIREBASE_PROJECT_ID": os.getenv("FIREBASE_PROJECT_ID"),
        "FIREBASE_CLIENT_EMAIL": os.getenv("FIREBASE_CLIENT_EMAIL"),
        "FIREBASE_PRIVATE_KEY_ID": os.getenv("FIREBASE_PRIVATE_KEY_ID"),
        "HAS_FIREBASE_PRIVATE_KEY": bool(os.getenv("FIREBASE_PRIVATE_KEY")),
        "TERMINAL_KEY": bool(os.getenv("TERMINAL_KEY")),
        "TELEGRAM_BOT_TOKEN": bool(os.getenv("TELEGRAM_BOT_TOKEN")),
    }
    return env_vars
