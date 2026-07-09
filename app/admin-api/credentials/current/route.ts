import { getCurrentCredentialInfo } from '@/lib/server/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  return Response.json(getCurrentCredentialInfo());
};
