import {
  addCredential,
  listCredentials,
  updateCredentialByIndex,
} from '@/lib/server/credentials';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  return Response.json(listCredentials());
};

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<Record<string, unknown>>(request);

  try {
    if (typeof body.index === 'number' && Number.isInteger(body.index)) {
      return Response.json(updateCredentialByIndex(body.index, body));
    }

    return Response.json(
      addCredential(
        body,
        typeof body.filename === 'string' ? body.filename : undefined,
      ),
    );
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
