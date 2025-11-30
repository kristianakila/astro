import hashlib
import os

# Константы
TERMINAL_KEY = os.getenv("TERMINAL_KEY", "1691507148627")
SECRET_KEY = os.getenv("SECRET_KEY", "rlkzhollw74x8uvv")

def generate_token(data: dict) -> str:
    """
    Генерация токена для Tinkoff API
    """
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

def generate_charge_token(data: dict) -> str:
    """
    Токен для Charge метода
    """
    token_fields = [
        str(data.get("Amount", "")),
        str(data.get("CustomerKey", "")),
        str(data.get("OrderId", "")),
        str(data.get("RebillId", "")),
        SECRET_KEY,
        TERMINAL_KEY,
    ]
    
    token_string = ''.join(token_fields)
    return hashlib.sha256(token_string.encode("utf-8")).hexdigest()
