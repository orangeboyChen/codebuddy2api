import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { publishCredentialExpiryNotification } from '@/lib/server/domain/credential-expiry-notifications';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) return authError;

  const body = await getJsonBody<{ channel?: unknown }>(request);
  const channel = body.channel;
  if (channel !== 'web' && channel !== 'desktop') {
    return Response.json(
      { error: 'Notification channel is required' },
      { status: 400 },
    );
  }

  const delivered = publishCredentialExpiryNotification(channel, {
    body:
      channel === 'web'
        ? '这是一条 CodeBuddy2API Web 端测试通知。'
        : '这是一条 CodeBuddy2API 桌面端测试通知。',
    credential: 'test',
    expiresAt: Date.now() / 1000 + 3 * 24 * 60 * 60,
    key: 'three_days',
    title: 'CodeBuddy2API 凭据提醒测试',
  });

  return Response.json({ delivered, message: 'Test notification sent.' });
};
