import { getJsonBody } from '@/lib/server/shared/http';
import {
  getAdminSessionSummary,
  loginWithAdminPassword,
  logoutAdminSession,
} from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  return Response.json({
    session: await getAdminSessionSummary(request),
  });
};

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{ password?: unknown }>(request);

  return await loginWithAdminPassword(
    request,
    typeof body.password === 'string' ? body.password : '',
  );
};

export const DELETE = async (request: Request): Promise<Response> => {
  return await logoutAdminSession(request);
};
