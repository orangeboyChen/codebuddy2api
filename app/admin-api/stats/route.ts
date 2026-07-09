import { getUsageStats } from '@/lib/server/stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  return Response.json(getUsageStats());
};
