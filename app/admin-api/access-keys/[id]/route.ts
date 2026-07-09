import {
  deleteAccessKey,
  findAccessKeyById,
  updateAccessKey,
} from '@/lib/server/access-keys';
import { listCredentialFilenames } from '@/lib/server/credentials';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const validateCredentialFilenames = (
  credentialFilenames: unknown,
): string[] => {
  if (!Array.isArray(credentialFilenames)) {
    throw new Error('credential_filenames must be an array');
  }

  const available = new Set(listCredentialFilenames());
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
  const { id } = await context.params;
  const body = await getJsonBody<{
    credential_filenames?: unknown;
    name?: unknown;
  }>(request);

  try {
    const accessKey = updateAccessKey(id, {
      credentialFilenames: validateCredentialFilenames(
        body.credential_filenames,
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
      { status: findAccessKeyById(id) ? 400 : 404 },
    );
  }
};

export const DELETE = async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;

  if (!deleteAccessKey(id)) {
    return Response.json({ error: 'Access key not found' }, { status: 404 });
  }

  return Response.json({ success: true });
};
