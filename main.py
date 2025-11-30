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
try:
    start_subscription_checker()
except Exception as e:
    print(f"⚠️ Не удалось запустить проверку подписок: {e}")

@app.get("/")
def root():
    return {"status": "ok", "message": "Payment API работает", "version": "v1.0.0"}

@app.get("/health")
def health_check():
    """Проверка здоровья приложения"""
    firebase_status = check_firebase_connection()
    status = "healthy" if firebase_status else "degraded"
    
    return {
        "status": status,
        "firebase": "connected" if firebase_status else "disconnected",
        "dependencies": {
            "fastapi": "0.104.1",
            "firebase_admin": "5.2.0",
            "pydantic": "1.10.12"
        }
    }

# Временный эндпоинт для отладки (удалите после настройки)
@app.get("/debug/env")
def debug_env():
    """Эндпоинт для отладки переменных окружения"""
    import pydantic
    import firebase_admin
    import fastapi
    
    env_vars = {
        "FIREBASE_PROJECT_ID": os.getenv("FIREBASE_PROJECT_ID"),
        "FIREBASE_CLIENT_EMAIL": os.getenv("FIREBASE_CLIENT_EMAIL"),
        "FIREBASE_PRIVATE_KEY_ID": os.getenv("FIREBASE_PRIVATE_KEY_ID"),
        "HAS_FIREBASE_PRIVATE_KEY": bool(os.getenv("FIREBASE_PRIVATE_KEY")),
        "TERMINAL_KEY": bool(os.getenv("TERMINAL_KEY")),
        "TELEGRAM_BOT_TOKEN": bool(os.getenv("TELEGRAM_BOT_TOKEN")),
        "versions": {
            "pydantic": pydantic.VERSION,
            "fastapi": fastapi.__version__,
            "firebase_admin": firebase_admin.__version__
        }
    }
    return env_vars
