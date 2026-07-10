import type { NextRequest } from 'next/server';

import {
  findAccessKeyBySecret,
  getAccessKeyStoreError,
  hasAccessKeys,
  type AccessKeyRecord,
} from './access-keys';
import { getLegacyServerPassword } from './config';

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

const getAccessKeyStoreErrorResponse = (): Response | null => {
  if (!getAccessKeyStoreError()) {
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

const getLegacyPasswordToken = (request: NextRequest): string | null => {
  return extractBearerToken(request);
};

const matchesLegacyPassword = (request: NextRequest): boolean => {
  const password = getLegacyServerPassword();
  const token = getLegacyPasswordToken(request);

  return Boolean(password && token && token === password);
};

export const resolveRequestAccessKey = (
  request: NextRequest,
): AccessKeyRecord | null => {
  if (getAccessKeyStoreError()) {
    return null;
  }

  if (!hasAccessKeys()) {
    return null;
  }

  const token = extractAccessKeyToken(request);

  if (!token) {
    return null;
  }

  return findAccessKeyBySecret(token);
};

export const getClientAuthErrorResponse = (
  request: NextRequest,
): Response | null => {
  const storeError = getAccessKeyStoreErrorResponse();

  if (storeError) {
    return storeError;
  }

  const legacyPassword = getLegacyServerPassword();

  if (!hasAccessKeys()) {
    if (!legacyPassword) {
      return null;
    }

    const token = getLegacyPasswordToken(request);

    if (!token) {
      return Response.json(
        { error: { message: 'Authorization header is required' } },
        { status: 401 },
      );
    }

    if (token !== legacyPassword) {
      return Response.json(
        { error: { message: 'Invalid password' } },
        { status: 403 },
      );
    }

    return null;
  }

  const token = extractAccessKeyToken(request);

  if (!token) {
    return Response.json(
      { error: { message: 'x-api-key or Authorization header is required' } },
      { status: 401 },
    );
  }

  if (matchesLegacyPassword(request)) {
    return null;
  }

  if (!findAccessKeyBySecret(token)) {
    return Response.json(
      { error: { message: 'Invalid access key' } },
      { status: 403 },
    );
  }

  return null;
};

export const getAdminAuthErrorResponse = (
  request: NextRequest,
): Response | null => {
  const storeError = getAccessKeyStoreErrorResponse();

  if (storeError) {
    return storeError;
  }

  const token = getLegacyPasswordToken(request);

  if (!token) {
    return Response.json(
      { error: { message: 'x-api-key or Authorization header is required' } },
      { status: 401 },
    );
  }

  const password = getLegacyServerPassword();

  if (!password) {
    return Response.json(
      { error: { message: 'Server password is not configured' } },
      { status: 503 },
    );
  }

  if (token !== password) {
    return Response.json(
      { error: { message: 'Invalid access key' } },
      { status: 403 },
    );
  }

  return null;
};

export const getAuthErrorResponse = (request: NextRequest): Response | null => {
  return getClientAuthErrorResponse(request);
};

export const getAnthropicAuthErrorResponse = (
  request: NextRequest,
): Response | null => {
  const storeError = getAccessKeyStoreErrorResponse();

  if (storeError) {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'authentication_error',
          message:
            'Access key storage is unreadable. Fix access-keys.json first.',
        },
      },
      { status: 503 },
    );
  }

  const legacyPassword = getLegacyServerPassword();

  if (!hasAccessKeys()) {
    if (!legacyPassword) {
      return null;
    }

    const token = getLegacyPasswordToken(request);

    if (!token) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Authorization header is required',
          },
        },
        { status: 401 },
      );
    }

    if (token !== legacyPassword) {
      return Response.json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid API key' },
        },
        { status: 403 },
      );
    }

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

  if (matchesLegacyPassword(request)) {
    return null;
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
