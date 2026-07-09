import type { NextRequest } from 'next/server';

import { getServerPassword } from './config';

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

// Anthropic SDK and Claude Code send the API key via the x-api-key header.
const extractApiKeyToken = (request: NextRequest): string | null => {
  return request.headers.get('x-api-key')?.trim() || null;
};

export const getAuthErrorResponse = (request: NextRequest): Response | null => {
  const password = getServerPassword();

  if (!password) {
    return null;
  }

  const token = extractBearerToken(request);

  if (!token) {
    return Response.json(
      { error: { message: 'Authorization header is required' } },
      { status: 401 },
    );
  }

  if (token !== password) {
    return Response.json(
      { error: { message: 'Invalid password' } },
      { status: 403 },
    );
  }

  return null;
};

// Anthropic SDK and Claude Code send the API key via the x-api-key header
// instead of Authorization: Bearer. This function accepts both schemes so
// /v1/messages works when CODEBUDDY_PASSWORD is configured.
export const getAnthropicAuthErrorResponse = (
  request: NextRequest,
): Response | null => {
  const password = getServerPassword();

  if (!password) {
    return null;
  }

  const token = extractBearerToken(request) ?? extractApiKeyToken(request);

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

  if (token !== password) {
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
