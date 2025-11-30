import os
import requests

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_ADMIN_IDS = os.getenv("TELEGRAM_ADMIN_IDS", "")
ADMIN_IDS = [admin.strip() for admin in TELEGRAM_ADMIN_IDS.split(",") if admin.strip()]

def send_telegram_message(chat_id: str, text: str):
    if not TELEGRAM_BOT_TOKEN:
        print("❌ TELEGRAM_BOT_TOKEN не задан")
        return
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=10
        )
        r.raise_for_status()
        print(f"📩 Сообщение отправлено {chat_id}")
    except Exception as e:
        print("Ошибка отправки в Telegram:", e)

def notify_admins(text: str):
    """
    Отправляет сообщение всем администраторам из списка ADMIN_IDS
    """
    for admin_id in ADMIN_IDS:
        send_telegram_message(chat_id=admin_id, text=text)
