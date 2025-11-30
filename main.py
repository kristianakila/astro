from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
import time
from firebase.service import db, check_firebase_connection

print("✅ main.py загружен и выполняется")

app = FastAPI(title="Payment API", version="1.0.0")

# Настройка CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://womenvenera.com", "https://astro-kfg4.onrender.com"],
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
try:
    start_subscription_checker()
    print("✅ Проверка подписок запущена")
except Exception as e:
    print(f"⚠️ Не удалось запустить проверку подписок: {e}")

@app.get("/")
def root():
    return {"status": "ok", "message": "Payment API работает", "timestamp": time.time()}

@app.get("/health")
def health_check():
    """Health check для Render"""
    firebase_status = check_firebase_connection()
    return {
        "status": "healthy" if firebase_status else "degraded",
        "firebase": "connected" if firebase_status else "disconnected",
        "service": "payment-api",
        "timestamp": time.time()
    }

@app.get("/api/status")
def api_status():
    """Статус API"""
    return {
        "service": "payment-api",
        "version": "1.0.0",
        "status": "running",
        "timestamp": time.time()
    }

# Временные эндпоинты для отладки
@app.get("/debug")
def debug_info():
    """Отладочная информация"""
    return {
        "firebase_connected": check_firebase_connection(),
        "environment": "production",
        "python_version": os.environ.get('PYTHON_VERSION', 'unknown'),
        "timestamp": time.time()
    }

@app.get("/debug/env")
def debug_env():
    """Показывает установленные переменные окружения (без значений)"""
    env_vars = {
        "FIREBASE_PROJECT_ID": bool(os.getenv("FIREBASE_PROJECT_ID")),
        "FIREBASE_CLIENT_EMAIL": bool(os.getenv("FIREBASE_CLIENT_EMAIL")),
        "FIREBASE_PRIVATE_KEY_ID": bool(os.getenv("FIREBASE_PRIVATE_KEY_ID")),
        "FIREBASE_PRIVATE_KEY": bool(os.getenv("FIREBASE_PRIVATE_KEY")),
        "TERMINAL_KEY": bool(os.getenv("TERMINAL_KEY")),
        "SECRET_KEY": bool(os.getenv("SECRET_KEY")),
        "TELEGRAM_BOT_TOKEN": bool(os.getenv("TELEGRAM_BOT_TOKEN")),
        "TELEGRAM_ADMIN_IDS": bool(os.getenv("TELEGRAM_ADMIN_IDS")),
    }
    return env_vars
