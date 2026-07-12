import { getJsonBody } from '@/lib/server/shared/http';
import { finishAdminPasskeyAuthentication } from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{
    response?: unknown;
  }>(request);

  return finishAdminPasskeyAuthentication(
    request,
    typeof body.response === 'object' && body.response
      ? (body.response as Record<string, unknown>)
      : {},
  );
};
