import os
import json
import firebase_admin
from firebase_admin import credentials, firestore
import logging

# Настраиваем логирование
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

print("🟢 Инициализация Firebase…")

def init_firebase():
    if not firebase_admin._apps:
        try:
            # Пытаемся получить Firebase конфиг из отдельных переменных окружения
            firebase_private_key = os.getenv("FIREBASE_PRIVATE_KEY")
            
            if firebase_private_key:
                # Собираем конфиг из отдельных переменных
                logger.info("✅ Используем Firebase config из Environment Variables")
                
                # Обрабатываем private key - заменяем \n на настоящие переносы строк
                private_key_processed = firebase_private_key.replace('\\n', '\n')
                
                firebase_config = {
                    "type": "service_account",
                    "project_id": os.getenv("FIREBASE_PROJECT_ID", "astro-c18eb"),
                    "private_key_id": os.getenv("FIREBASE_PRIVATE_KEY_ID", "5b999390d1a93bf6e7749456154c61ad81ed6db6"),
                    "private_key": private_key_processed,
                    "client_email": os.getenv("FIREBASE_CLIENT_EMAIL", "firebase-adminsdk-fbsvc@astro-c18eb.iam.gserviceaccount.com"),
                    "client_id": os.getenv("FIREBASE_CLIENT_ID", "109897588354023923016"),
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                    "client_x509_cert_url": os.getenv("FIREBASE_CLIENT_X509_CERT_URL", "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40astro-c18eb.iam.gserviceaccount.com"),
                    "universe_domain": "googleapis.com"
                }
                
                logger.info(f"✅ Project ID: {firebase_config['project_id']}")
                logger.info(f"✅ Client Email: {firebase_config['client_email']}")
                
                cred = credentials.Certificate(firebase_config)
                logger.info("✅ Firebase credentials успешно созданы")

            else:
                # Fallback к файлу (для локальной разработки)
                firebase_key_path = os.getenv("FIREBASE_KEY_PATH", "serviceAccountKey.json")
                logger.info(f"DEBUG: Используем путь к ключу: {firebase_key_path}")

                if not os.path.exists(firebase_key_path):
                    raise RuntimeError(f"❌ Файл ключа Firebase не найден по пути: {firebase_key_path}")

                cred = credentials.Certificate(firebase_key_path)
                logger.info("✅ Firebase credentials успешно созданы из файла")

            # Инициализируем Firebase
            firebase_admin.initialize_app(cred)
            logger.info("✅ Firebase успешно инициализирован")
            
        except Exception as e:
            logger.error(f"❌ Критическая ошибка при инициализации Firebase: {e}")
            raise
    
    return firestore.client()

# Инициализируем Firestore с обработкой ошибок
try:
    db = init_firebase()
    logger.info("✅ Firestore client готов")
except Exception as e:
    logger.error(f"❌ Ошибка инициализации Firestore: {e}")
    db = None

# Функция для проверки подключения
def check_firebase_connection():
    if db is None:
        return False
    try:
        # Простая проверка подключения
        db.collection("telegramUsers").limit(1).get()
        return True
    except Exception as e:
        logger.error(f"❌ Ошибка подключения к Firestore: {e}")
        return False
