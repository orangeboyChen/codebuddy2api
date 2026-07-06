"""
Unauthenticated admin router for the built-in management panel.

These routes exist so the built-in browser UI can work without a separate
front-end password prompt. The public `/v1/*` routes keep their existing auth
checks.
"""
from typing import Optional

from fastapi import APIRouter, Header, Request

from .codebuddy_router import (
    add_credential,
    chat_completions,
    delete_credential,
    get_current_credential,
    list_credentials,
    resume_auto_rotation,
    select_credential,
    toggle_auto_rotation,
)
from .settings_router import Settings, get_settings, get_usage_stats, save_settings

router = APIRouter()


@router.get("/settings")
async def admin_get_settings():
    return await get_settings(_token="admin")


@router.post("/settings")
async def admin_save_settings(new_settings: Settings):
    return await save_settings(new_settings, _token="admin")


@router.get("/stats")
async def admin_get_stats():
    return await get_usage_stats(_token="admin")


@router.get("/credentials")
async def admin_list_credentials():
    return await list_credentials(_token="admin")


@router.post("/credentials")
async def admin_add_credential(request: Request):
    return await add_credential(request, _token="admin")


@router.get("/credentials/current")
async def admin_get_current_credential():
    return await get_current_credential(_token="admin")


@router.post("/credentials/select")
async def admin_select_credential(request: Request):
    return await select_credential(request, _token="admin")


@router.post("/credentials/auto")
async def admin_resume_auto_rotation():
    return await resume_auto_rotation(_token="admin")


@router.post("/credentials/toggle-rotation")
async def admin_toggle_auto_rotation():
    return await toggle_auto_rotation(_token="admin")


@router.post("/credentials/delete")
async def admin_delete_credential(request: Request):
    return await delete_credential(request, _token="admin")


@router.post("/chat/completions")
async def admin_chat_completions(
    request: Request,
    x_conversation_id: Optional[str] = Header(None, alias="X-Conversation-ID"),
    x_conversation_request_id: Optional[str] = Header(None, alias="X-Conversation-Request-ID"),
    x_conversation_message_id: Optional[str] = Header(None, alias="X-Conversation-Message-ID"),
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
):
    return await chat_completions(
        request=request,
        x_conversation_id=x_conversation_id,
        x_conversation_request_id=x_conversation_request_id,
        x_conversation_message_id=x_conversation_message_id,
        x_request_id=x_request_id,
        _token="admin",
    )
