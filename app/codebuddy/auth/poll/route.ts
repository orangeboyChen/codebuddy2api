import { getJsonBody } from '@/lib/server/http';
import { pollCodeBuddyAuth } from '@/lib/server/codebuddy-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{ auth_state?: string }>(request);
  return pollCodeBuddyAuth(body.auth_state ?? '');
};
