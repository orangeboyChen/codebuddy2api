import {
  changeAdminPassword,
  disableAdminAuthentication,
} from '@/lib/server/admin/session';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{
    currentPassword?: unknown;
    nextPassword?: unknown;
    username?: unknown;
  }>(request);

  return changeAdminPassword(
    request,
    typeof body.currentPassword === 'string' ? body.currentPassword : '',
    typeof body.nextPassword === 'string' ? body.nextPassword : '',
    typeof body.username === 'string' ? body.username : undefined,
  );
};

export const DELETE = async (request: Request): Promise<Response> => {
  return disableAdminAuthentication(request);
};
