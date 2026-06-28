"""
Configuration management for CodeBuddy2API

Implements a multi-layered configuration system with hot-reloading.
Priority order:
1. In-memory config (for hot-settings from the UI)
2. config.json file (for persisted user overrides)
3. Environment variables (for deployment, e.g., Docker)
4. Hard-coded defaults
"""
import os
import json
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# --- Private State ---
_config_cache: Dict[str, Any] = {}
_CONFIG_JSON_PATH = 'config/config.json'  # Use a path inside a directory

_DEFAULT_CONFIG = {
    "CODEBUDDY_HOST": "127.0.0.1",
    "CODEBUDDY_PORT": 8001,
    "CODEBUDDY_PASSWORD": None,
    "CODEBUDDY_API_ENDPOINT": "https://copilot.tencent.com",
    "CODEBUDDY_AUTH_MODE": "auto",
    "CODEBUDDY_API_KEY": None,
    "CODEBUDDY_INTERNET_ENVIRONMENT": "ioa",
    "CODEBUDDY_CREDS_DIR": ".codebuddy_creds",
    "CODEBUDDY_LOG_LEVEL": "INFO",
    "CODEBUDDY_MODELS": "glm-5.1,glm-5.0,glm-5.0-turbo,glm-5v-turbo,glm-4.7,minimax-m3-play,minimax-m2.7,minimax-m2.5,kimi-k2.6,kimi-k2.5,hy3-preview-agent,deepseek-v4-pro,deepseek-v4-flash,deepseek-v3-2-volc,glm-5.1-ioa,glm-5.0-ioa,glm-5.0-turbo-ioa,glm-5v-turbo-ioa,glm-4.7-ioa,minimax-m3-ioa,minimax-m2.7-ioa,minimax-m2.5-ioa,kimi-k2.6-ioa,kimi-k2.5-ioa,hy3-preview-agent-ioa,deepseek-v4-pro-ioa,deepseek-v4-flash-ioa,deepseek-v3-2-volc-ioa",
    "CODEBUDDY_ROTATION_COUNT": 1
}

# --- Core Functions ---

def load_config():
    """
    Loads configuration from all sources into the in-memory cache.
    This should be called once at application startup.
    """
    global _config_cache
    
    config = _DEFAULT_CONFIG.copy()
    
    try:
        from dotenv import load_dotenv
        load_dotenv()
        logger.info("Loaded environment variables from .env file.")
    except ImportError:
        logger.warning("python-dotenv not installed, skipping .env file loading.")

    for key in config:
        env_value = os.getenv(key)
        if env_value is not None:
            config[key] = env_value
            
    if os.path.exists(_CONFIG_JSON_PATH):
        try:
            with open(_CONFIG_JSON_PATH, 'r', encoding='utf-8') as f:
                content = f.read()
                if content:
                    persisted_config = json.loads(content)
                    config.update(persisted_config)
                    logger.info(f"Loaded and merged persisted settings from {_CONFIG_JSON_PATH}.")
        except Exception as e:
            logger.error(f"Error loading {_CONFIG_JSON_PATH}: {e}")

    _config_cache = config
    logger.info("Configuration loaded successfully.")


def _get_config_value(key: str) -> Any:
    return _config_cache.get(key, _DEFAULT_CONFIG.get(key))

def _update_config_value(key: str, value: Any):
    global _config_cache
    _config_cache[key] = value
    # Downgrade to debug to avoid verbose logging in production
    logger.debug(f"Hot-reloaded setting '{key}' to new value.")


def save_config_to_json():
    """
    Saves the entire current in-memory configuration to config.json.
    This is simpler and more robust, ensuring a complete snapshot is always saved.
    This will create the file if it doesn't exist.
    """
    try:
        # Ensure the directory exists before writing the file
        config_dir = os.path.dirname(_CONFIG_JSON_PATH)
        if not os.path.exists(config_dir):
            os.makedirs(config_dir)
            logger.info(f"Created config directory at {config_dir}")

        with open(_CONFIG_JSON_PATH, 'w', encoding='utf-8') as f:
            # Only save keys that are part of the original default config
            # to avoid saving runtime-only variables.
            config_to_save = {key: _config_cache.get(key) for key in _DEFAULT_CONFIG}
            json.dump(config_to_save, f, indent=4)
        logger.info(f"Settings successfully persisted to {_CONFIG_JSON_PATH}.")
    except Exception as e:
        logger.error(f"Failed to save config to {_CONFIG_JSON_PATH}: {e}")
        raise

# --- Public Getter Functions ---

def get_active_config() -> Dict[str, Any]:
    return {key: _config_cache.get(key) for key in _DEFAULT_CONFIG}

def get_server_host() -> str:
    return str(_get_config_value("CODEBUDDY_HOST"))

def get_server_port() -> int:
    return int(_get_config_value("CODEBUDDY_PORT"))

def get_server_password() -> Optional[str]:
    return _get_config_value("CODEBUDDY_PASSWORD")

def get_codebuddy_api_endpoint() -> str:
    endpoint = str(_get_config_value("CODEBUDDY_API_ENDPOINT") or "").strip()
    if endpoint:
        return endpoint.rstrip("/")

    # Auto-resolve official endpoint from internet environment when endpoint is not explicitly set.
    internet_env = str(_get_config_value("CODEBUDDY_INTERNET_ENVIRONMENT") or "").strip().lower()
    if internet_env in ("internal", "ioa"):
        return "https://copilot.tencent.com"
    return "https://www.codebuddy.ai"

def get_codebuddy_auth_mode() -> str:
    return str(_get_config_value("CODEBUDDY_AUTH_MODE") or "auto").strip().lower()

def get_codebuddy_api_key() -> Optional[str]:
    value = _get_config_value("CODEBUDDY_API_KEY")
    if value is None:
        return None
    value = str(value).strip()
    return value or None

def get_codebuddy_internet_environment() -> str:
    return str(_get_config_value("CODEBUDDY_INTERNET_ENVIRONMENT") or "").strip().lower()

def get_codebuddy_creds_dir() -> str:
    return str(_get_config_value("CODEBUDDY_CREDS_DIR"))

def get_log_level() -> str:
    return str(_get_config_value("CODEBUDDY_LOG_LEVEL")).upper()

def get_available_models() -> list:
    models_str = str(_get_config_value("CODEBUDDY_MODELS"))
    return [model.strip() for model in models_str.split(",")]

def get_rotation_count() -> int:
    return int(_get_config_value("CODEBUDDY_ROTATION_COUNT"))

# --- Public Setter for Hot-Reload ---

def update_settings(new_settings: Dict[str, Any]):
    """Updates the live config and persists it to config.json."""
    for key, value in new_settings.items():
        if key in _config_cache:
            original_type = type(_DEFAULT_CONFIG.get(key, value))
            try:
                if original_type is bool:
                    typed_value = str(value).lower() in ('true', '1', 't', 'y', 'yes')
                else:
                    typed_value = original_type(value)
                _update_config_value(key, typed_value)
            except (ValueError, TypeError):
                logger.warning(f"Could not cast new value for '{key}' to {original_type}. Using as string.")
                _update_config_value(key, value)
    
    save_config_to_json()

# --- Initial Load ---
load_config()
