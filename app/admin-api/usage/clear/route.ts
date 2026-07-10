import { clearUsageHistory } from '@/lib/server/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (): Promise<Response> => {
  clearUsageHistory();

  return Response.json({
    success: true,
  });
};
