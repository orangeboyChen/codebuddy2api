import { getUsageAnalytics, type UsageRange } from '@/lib/server/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_RANGES = new Set<UsageRange>([
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
  '3d',
  '7d',
  'today',
  'yesterday',
]);

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const range = url.searchParams.get('range') ?? '24h';
  const accessKey = url.searchParams.get('accessKey') ?? 'all';
  const credential = url.searchParams.get('credential') ?? 'all';

  if (!ALLOWED_RANGES.has(range as UsageRange)) {
    return Response.json(
      {
        error: 'Invalid range',
      },
      {
        status: 400,
      },
    );
  }

  return Response.json(
    getUsageAnalytics({
      accessKey,
      credential,
      range: range as UsageRange,
    }),
  );
};
