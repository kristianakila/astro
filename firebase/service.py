import os
import json
import firebase_admin
from firebase_admin import credentials, firestore

print("🟢 Инициализация Firebase…")

def init_firebase():
    if not firebase_admin._apps:
        # Пытаемся получить Firebase конфиг из переменных окружения
        firebase_config_json = os.getenv("FIREBASE_CONFIG_JSON")
        
        if firebase_config_json:
            # Используем конфиг из переменной окружения
            print("✅ Используем Firebase config из Environment Variables")
            try:
                firebase_config = json.loads(firebase_config_json)
                cred = credentials.Certificate(firebase_config)
                print("✅ Firebase credentials успешно созданы из Environment Variables")
            except Exception as e:
                print(f"❌ Ошибка при создании credentials из Environment Variables: {e}")
                raise
        else:
            # Пытаемся использовать файл (для локальной разработки)
            firebase_key_path = os.getenv("FIREBASE_KEY_PATH", "serviceAccountKey.json")
            print(f"DEBUG: Используем путь к ключу: {firebase_key_path}")

            if not os.path.exists(firebase_key_path):
                raise RuntimeError(f"❌ Файл ключа Firebase не найден по пути: {firebase_key_path}")

            try:
                cred = credentials.Certificate(firebase_key_path)
                print("✅ Firebase credentials успешно созданы из файла")
            except Exception as e:
                print(f"❌ Ошибка при создании credentials.Certificate: {e}")
                raise

        try:
            firebase_admin.initialize_app(cred)
            print("✅ Firebase успешно инициализирован")
        except Exception as e:
            print(f"❌ Ошибка при инициализации Firebase: {e}")
            raise
    
    return firestore.client()

# Инициализируем Firestore
db = init_firebase()
print("✅ Firestore client готов")
