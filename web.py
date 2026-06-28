"""
Main Web Service for CodeBuddy2API
"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import the routers
from src.codebuddy_router import router as codebuddy_router, lifecycle_manager
from src.codebuddy_auth_router import router as codebuddy_auth_router
from src.settings_router import router as settings_router
from src.frontend_router import router as frontend_router

from config import get_server_host, get_server_port, get_log_level, get_server_password

# 配置日志
logging.basicConfig(
    level=getattr(logging, get_log_level().upper()),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    logger.info("Starting CodeBuddy2API Service")
    try:
        # 启动时初始化资源
        await lifecycle_manager.startup()
        yield
    finally:
        # 关闭时清理资源
        await lifecycle_manager.shutdown()
        logger.info("CodeBuddy2API Service stopped")


# 创建FastAPI应用
app = FastAPI(
    title="CodeBuddy2API",
    description="CodeBuddy API proxy with OpenAI-compatible interface",
    version="1.0.0",
    lifespan=lifespan
)

# CORS中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 挂载前端路由
app.include_router(
    frontend_router,
    tags=["Frontend"]
)

# 挂载CodeBuddy认证路由
app.include_router(
    codebuddy_auth_router,
    prefix="/codebuddy",
    tags=["CodeBuddy OAuth2 Authentication"]
)

# 挂载CodeBuddy API路由
app.include_router(
    codebuddy_router,
    prefix="/codebuddy",
    tags=["CodeBuddy Compatible API"]
)

# 兼容标准 OpenAI 客户端：直接支持 /v1/* 路径
app.include_router(
    codebuddy_router,
    tags=["OpenAI Compatible API"]
)

# 挂载设置路由
app.include_router(
    settings_router,
    prefix="/api",
    tags=["Settings Management"]
)

# 健康检查端点
@app.get("/health")
async def health_check():
    """健康检查"""
    return {
        "status": "healthy",
        "service": "codebuddy2api",
        "auth_required": bool(get_server_password())
    }


@app.get("/")
async def root():
    """根路径信息"""
    return {
        "service": "CodeBuddy2API",
        "version": "1.0.0",
        "description": "CodeBuddy API proxy with OpenAI-compatible interface",
        "endpoints": {
            "models": "/codebuddy/v1/models",
            "chat": "/codebuddy/v1/chat/completions",
            "credentials": "/codebuddy/v1/credentials",
            "auth_start": "/codebuddy/auth/start",
            "auth_poll": "/codebuddy/auth/poll",
            "auth_callback": "/codebuddy/auth/callback",
            "get_settings": "/api/settings",
            "save_settings": "/api/settings"
        }
    }


if __name__ == "__main__":
    from hypercorn.asyncio import serve
    from hypercorn.config import Config
    
    port = get_server_port()
    host = get_server_host()
    
    logger.info("=" * 60)
    logger.info("Starting CodeBuddy2API")
    logger.info("=" * 60)
    logger.info(f"Main Service: http://{host}:{port}")
    logger.info("=" * 60)
    logger.info("Web Interface:")
    logger.info(f"   Admin Panel: http://{host}:{port}/")
    logger.info("=" * 60)
    logger.info("API Endpoints:")
    logger.info(f"   Models: GET http://{host}:{port}/codebuddy/v1/models")
    logger.info(f"   Chat: POST http://{host}:{port}/codebuddy/v1/chat/completions")
    logger.info(f"   Credentials: GET http://{host}:{port}/codebuddy/v1/credentials")
    logger.info("=" * 60)
    logger.info("Authentication:")
    if get_server_password():
        logger.info("   CODEBUDDY_PASSWORD is set")
        logger.info("   Use Bearer token in Authorization header")
    else:
        logger.info("   CODEBUDDY_PASSWORD is not set")
        logger.info("   Admin panel and API are available without a service password")
    logger.info("=" * 60)

    config = Config()
    config.bind = [f"{host}:{port}"]
    config.accesslog = None
    config.errorlog = "-"
    config.loglevel = "INFO"
    config.use_colors = True

    asyncio.run(serve(app, config))
