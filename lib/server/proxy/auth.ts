import type { NextRequest } from 'next/server';

import {
  findAccessKeyBySecret,
  getAccessKeyStoreError,
  hasAccessKeys,
  type AccessKeyRecord,
} from '../domain/access-keys';

const extractBearerToken = (request: NextRequest): string | null => {
  const header = request.headers.get('authorization')?.trim();

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(/\s+/, 2);

  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return token;
};

const extractApiKeyToken = (request: NextRequest): string | null => {
  return request.headers.get('x-api-key')?.trim() || null;
};

const extractAccessKeyToken = (request: NextRequest): string | null => {
  return extractBearerToken(request) ?? extractApiKeyToken(request);
};

const getAccessKeyStoreErrorResponse = async (): Promise<Response | null> => {
  if (!(await getAccessKeyStoreError())) {
    return null;
  }

  return Response.json(
    {
      error: {
        message:
          'Access key storage is unreadable. Fix access-keys.json first.',
      },
    },
    { status: 503 },
  );
};

export const resolveRequestAccessKey = (
  request: NextRequest,
): Promise<AccessKeyRecord | null> => {
  return (async () => {
    if (await getAccessKeyStoreError()) {
      return null;
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return null;
    }

    return findAccessKeyBySecret(token);
  })();
};

export const getClientAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return (async () => {
    const storeError = await getAccessKeyStoreErrorResponse();

    if (storeError) {
      return storeError;
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return Response.json(
        { error: { message: 'x-api-key or Authorization header is required' } },
        { status: 401 },
      );
    }

    if (!(await findAccessKeyBySecret(token))) {
      return Response.json(
        { error: { message: 'Invalid access key' } },
        { status: 403 },
      );
    }

    return null;
  })();
};

export const getAdminAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return (async () => {
    const storeError = await getAccessKeyStoreErrorResponse();

    if (storeError) {
      return storeError;
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return Response.json(
        { error: { message: 'x-api-key or Authorization header is required' } },
        { status: 401 },
      );
    }

    if (!(await findAccessKeyBySecret(token))) {
      return Response.json(
        { error: { message: 'Invalid access key' } },
        { status: 403 },
      );
    }

    return null;
  })();
};

export const getAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return getClientAuthErrorResponse(request);
};

export const getAnthropicAuthErrorResponse = (
  request: NextRequest,
): Promise<Response | null> => {
  return (async () => {
    const storeError = await getAccessKeyStoreErrorResponse();

    if (storeError) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Access key storage is unreadable.',
          },
        },
        { status: 503 },
      );
    }

    if (!(await hasAccessKeys())) {
      return null;
    }

    const token = extractAccessKeyToken(request);

    if (!token) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'x-api-key or Authorization header is required',
          },
        },
        { status: 401 },
      );
    }

    if (!(await findAccessKeyBySecret(token))) {
      return Response.json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid API key' },
        },
        { status: 403 },
      );
    }

    return null;
  })();
};
