import { deleteAdminPasskey } from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;

  return deleteAdminPasskey(request, id);
};
