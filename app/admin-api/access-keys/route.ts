import { createAccessKey, listAccessKeys } from '@/lib/server/access-keys';
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

export const GET = async (): Promise<Response> => {
  return Response.json(listAccessKeys());
};

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{
    credential_filenames?: unknown;
    name?: unknown;
  }>(request);

  try {
    const created = createAccessKey({
      credentialFilenames: validateCredentialFilenames(
        body.credential_filenames,
      ),
      name: typeof body.name === 'string' ? body.name : '',
    });

    return Response.json(created);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to create access key',
      },
      { status: 400 },
    );
  }
};
