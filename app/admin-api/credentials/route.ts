import { addCredential, listCredentials } from '@/lib/server/credentials';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  return Response.json(listCredentials());
};

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<Record<string, unknown>>(request);

  return Response.json(
    addCredential(
      body,
      typeof body.filename === 'string' ? body.filename : undefined,
    ),
  );
};
