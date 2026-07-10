import { getAccessKeySecret } from '@/lib/server/access-keys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  const secret = getAccessKeySecret(id);

  if (!secret) {
    return Response.json({ error: 'Access key not found' }, { status: 404 });
  }

  return Response.json(secret);
};
