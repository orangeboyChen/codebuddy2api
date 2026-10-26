import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { sendBarkNotification } from '@/lib/server/domain/credential-expiry-notifications';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) return authError;

  const body = await getJsonBody<{ token?: unknown }>(request);
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (!token) {
    return Response.json({ error: 'Bark token is required' }, { status: 400 });
  }

  try {
    await sendBarkNotification({
      body: '这是一条 CodeBuddy2API Bark 测试通知。',
      title: 'CodeBuddy2API Bark 测试',
      token,
    });
    return Response.json({ message: 'Test notification sent.' });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Bark notification failed',
      },
      { status: 502 },
    );
  }
};
