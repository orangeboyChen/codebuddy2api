import {
  addCredential,
  listCredentials,
  updateCredentialByIndex,
} from '@/lib/server/domain/credentials';
import { refreshCredentialModels } from '@/lib/server/domain/credential-models';
import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json(await listCredentials());
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<Record<string, unknown>>(request);

  try {
    if (typeof body.index === 'number' && Number.isInteger(body.index)) {
      return Response.json(await updateCredentialByIndex(body.index, body));
    }

    const saved = await addCredential(
      body,
      typeof body.filename === 'string' ? body.filename : undefined,
    );
    await refreshCredentialModels(saved.filename);

    return Response.json(saved);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to save credential',
      },
      { status: 400 },
    );
  }
};
