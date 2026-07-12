import { getJsonBody } from '@/lib/server/shared/http';
import { beginAdminPasskeyRegistration } from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{ name?: unknown }>(request);

  return beginAdminPasskeyRegistration(
    request,
    typeof body.name === 'string' ? body.name : '',
  );
};
