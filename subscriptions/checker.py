import threading
import time
from datetime import datetime
from firebase.service import db

def check_and_update_subscription(doc_ref, user_data):
    expires_at = user_data.get("subscription", {}).get("expiresAt")
    update_data = {}
    
    if expires_at:
        # Для firebase-admin 5.2.0 проверяем тип timestamp
        if hasattr(expires_at, 'timestamp'):
            return
            
        # Если это datetime объект
        if hasattr(expires_at, 'replace'):
            if expires_at.replace(tzinfo=None) < datetime.utcnow():
                update_data["subscription.status"] = "expired"
            else:
                update_data["subscription.status"] = "Premium"
    
    if update_data:
        update_data["subscription.checkedAt"] = firestore.SERVER_TIMESTAMP
        doc_ref.update(update_data)

def periodic_subscription_check():
    while True:
        try:
            users_ref = db.collection("telegramUsers").stream()
            for doc in users_ref:
                user_data = doc.to_dict()
                check_and_update_subscription(db.collection("telegramUsers").document(doc.id), user_data)
        except Exception as e:
            print("Ошибка проверки подписок:", e)
        time.sleep(3600)  # 1 час

def start_subscription_checker():
    """Запускает проверку подписок в отдельном потоке"""
    thread = threading.Thread(target=periodic_subscription_check, daemon=True)
    thread.start()
    print("✅ Проверка подписок запущена")
