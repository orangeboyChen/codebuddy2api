import { startCodeBuddyAuth } from '@/lib/server/proxy/codebuddy-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  return startCodeBuddyAuth();
};
