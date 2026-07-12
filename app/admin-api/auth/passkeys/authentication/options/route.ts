import { beginAdminPasskeyAuthentication } from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  return beginAdminPasskeyAuthentication(request);
};
