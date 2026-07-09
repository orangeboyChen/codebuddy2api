import type { NextRequest } from 'next/server';

import {
  findAccessKeyBySecret,
  hasAccessKeys,
  type AccessKeyRecord,
} from './access-keys';

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

export const resolveRequestAccessKey = (
  request: NextRequest,
): AccessKeyRecord | null => {
  if (!hasAccessKeys()) {
    return null;
  }

  const token = extractAccessKeyToken(request);

  if (!token) {
    return null;
  }

  return findAccessKeyBySecret(token);
};

export const getAuthErrorResponse = (request: NextRequest): Response | null => {
  if (!hasAccessKeys()) {
    return null;
  }

  const token = extractAccessKeyToken(request);

  if (!token) {
    return Response.json(
      { error: { message: 'x-api-key or Authorization header is required' } },
      { status: 401 },
    );
  }

  if (!findAccessKeyBySecret(token)) {
    return Response.json(
      { error: { message: 'Invalid access key' } },
      { status: 403 },
    );
  }

  return null;
};

export const getAnthropicAuthErrorResponse = (
  request: NextRequest,
): Response | null => {
  if (!hasAccessKeys()) {
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

  if (!findAccessKeyBySecret(token)) {
    return Response.json(
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid API key' },
      },
      { status: 403 },
    );
  }

  return null;
};
