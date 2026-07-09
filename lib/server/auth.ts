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
