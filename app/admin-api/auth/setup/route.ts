import { getJsonBody } from '@/lib/server/shared/http';
import { setupAdminPassword } from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{ password?: unknown; username?: unknown }>(
    request,
  );

  return await setupAdminPassword(
    request,
    typeof body.username === 'string' ? body.username : '',
    typeof body.password === 'string' ? body.password : '',
  );
};
