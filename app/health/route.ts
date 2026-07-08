import { getCurrentCredentialInfo } from '@/lib/server/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  return Response.json({
    status: 'healthy',
    service: 'codebuddy2api',
    timestamp: new Date().toISOString(),
    active_credential: getCurrentCredentialInfo(),
  });
};
