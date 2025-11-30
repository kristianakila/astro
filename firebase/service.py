import os
import json
import firebase_admin
from firebase_admin import credentials, firestore

print("🟢 Инициализация Firebase…")

def init_firebase():
    if not firebase_admin._apps:
        # Пытаемся получить Firebase конфиг из отдельных переменных окружения
        firebase_private_key = os.getenv("FIREBASE_PRIVATE_KEY")
        
        if firebase_private_key:
            # Собираем конфиг из отдельных переменных
            print("✅ Используем Firebase config из Environment Variables")
            firebase_config = {
                "type": "service_account",
                "project_id": os.getenv("FIREBASE_PROJECT_ID", "astro-c18eb"),
                "private_key_id": os.getenv("FIREBASE_PRIVATE_KEY_ID", "5b999390d1a93bf6e7749456154c61ad81ed6db6"),
                "private_key": firebase_private_key.replace('\\n', '\n'),
                "client_email": os.getenv("FIREBASE_CLIENT_EMAIL", "firebase-adminsdk-fbsvc@astro-c18eb.iam.gserviceaccount.com"),
                "client_id": os.getenv("FIREBASE_CLIENT_ID", "109897588354023923016"),
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                "client_x509_cert_url": os.getenv("FIREBASE_CLIENT_X509_CERT_URL", "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40astro-c18eb.iam.gserviceaccount.com"),
                "universe_domain": "googleapis.com"
            }
            
            try:
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
