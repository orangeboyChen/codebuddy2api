import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  findEligibleCredentialRecordByFilename,
  getCredentialSupportedModels,
  listEligibleCredentialRecords,
  updateCredentialSupportedModels,
} from '@/lib/server/domain/credentials';
import { getModelsByCredential } from '@/lib/server/proxy/codebuddy';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const toResponse = async (filenames?: string[]): Promise<Response> => {
  const credentials = await listEligibleCredentialRecords(filenames);
  const models = Object.fromEntries(
    credentials.map((credential) => [
      credential.filename,
      {
        error: null,
        models: getCredentialSupportedModels(credential.data).map((id) => ({
          id,
        })),
      },
    ]),
  );

  return Response.json({ models });
};

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) return authError;

  return toResponse();
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) return authError;

  const body = await getJsonBody<{ filename?: unknown }>(request);
  const filename =
    typeof body.filename === 'string' ? body.filename.trim() : '';

  if (!filename || !(await findEligibleCredentialRecordByFilename(filename))) {
    return Response.json(
      { error: { message: 'Credential is unavailable' } },
      { status: 404 },
    );
  }

  const models = await getModelsByCredential(
    await listEligibleCredentialRecords([filename]),
  );
  const value = models[filename];

  if (value && !value.error) {
    await updateCredentialSupportedModels(
      filename,
      value.models.map((model) => model.id),
    );
  }

  return Response.json({ models });
};

export const PUT = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) return authError;

  const body = await getJsonBody<{ filename?: unknown; models?: unknown }>(
    request,
  );
  const filename =
    typeof body.filename === 'string' ? body.filename.trim() : '';

  if (!filename || !(await findEligibleCredentialRecordByFilename(filename))) {
    return Response.json(
      { error: { message: 'Credential is unavailable' } },
      { status: 404 },
    );
  }

  const models =
    typeof body.models === 'string'
      ? body.models
          .split(/[\n,]/)
          .map((model) => model.trim())
          .filter(Boolean)
      : [];
  await updateCredentialSupportedModels(filename, models);

  return toResponse([filename]);
};
