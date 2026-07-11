import {
  deleteAccessKey,
  findAccessKeyById,
  updateAccessKey,
} from '@/lib/server/domain/access-keys';
import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { listCredentialFilenames } from '@/lib/server/domain/credentials';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const validateCredentialFilenames = (
  credentialFilenames: unknown,
  availableFilenames: string[],
): string[] => {
  if (!Array.isArray(credentialFilenames)) {
    throw new Error('credential_filenames must be an array');
  }

  const available = new Set(availableFilenames);
  const normalized = credentialFilenames
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!normalized.length) {
    throw new Error('At least one credential must be selected');
  }

  if (normalized.some((item) => !available.has(item))) {
    throw new Error('Selected credentials must exist');
  }

  return normalized;
};

export const PATCH = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const body = await getJsonBody<{
    credential_filenames?: unknown;
    name?: unknown;
  }>(request);
  const availableCredentialFilenames = await listCredentialFilenames();

  try {
    const accessKey = await updateAccessKey(id, {
      credentialFilenames: validateCredentialFilenames(
        body.credential_filenames,
        availableCredentialFilenames,
      ),
      name: typeof body.name === 'string' ? body.name : '',
    });

    return Response.json({ access_key: accessKey });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update access key',
      },
      { status: (await findAccessKeyById(id)) ? 400 : 404 },
    );
  }
};

export const DELETE = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const { id } = await context.params;

  if (!(await deleteAccessKey(id))) {
    return Response.json({ error: 'Access key not found' }, { status: 404 });
  }

  return Response.json({ success: true });
};
