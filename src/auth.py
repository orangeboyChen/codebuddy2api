"""
Authentication module for CodeBuddy2API
"""
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer
from config import get_server_password

security = HTTPBearer(auto_error=False)


def authenticate(credentials = Depends(security)) -> str:
    """验证用户身份"""
    password = get_server_password()
    if not password:
        return "anonymous"

    if credentials is None:
        raise HTTPException(status_code=401, detail="Authorization header is required")
    
    token = credentials.credentials
    if token != password:
        raise HTTPException(status_code=403, detail="Invalid password")
    
    return token
