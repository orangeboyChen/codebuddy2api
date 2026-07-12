import { getCodeBuddyApiEndpoint } from '../domain/config';
import { addCredential, type CredentialData } from '../domain/credentials';
import { getAdminSessionErrorResponse } from '../admin/session';

const getAuthStateEndpoint = async (): Promise<string> =>
  `${await getCodeBuddyApiEndpoint()}/v2/plugin/auth/state`;

const getAuthTokenEndpoint = async (): Promise<string> =>
  `${await getCodeBuddyApiEndpoint()}/v2/plugin/auth/token`;

const buildTraceHeaders = async (): Promise<HeadersInit> => {
  const baseUrl = new URL(await getCodeBuddyApiEndpoint());
  const requestId = crypto.randomUUID().replaceAll('-', '');
  const spanId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);

  return {
    Accept: 'application/json, text/plain, */*',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    'Content-Type': 'application/json',
    Host: baseUrl.host,
    Pragma: 'no-cache',
    'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8',
    'X-Domain': baseUrl.host,
    'X-No-Authorization': 'true',
    'X-No-Department-Info': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-User-Id': 'true',
    'X-Product': 'SaaS',
    'X-Request-ID': requestId,
    'X-Requested-With': 'XMLHttpRequest',
    'X-B3-ParentSpanId': '',
    'X-B3-Sampled': '1',
    'X-B3-SpanId': spanId,
    'X-B3-TraceId': requestId,
    b3: `${requestId}-${spanId}-1-`,
  };
};

const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1];

  if (!payload) {
    return {};
  }

  const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
};

const getMetadataValue = (
  sources: Record<string, unknown>[],
  candidateKeys: string[],
): string | undefined => {
  for (const source of sources) {
    for (const key of candidateKeys) {
      const value = source[key];

      if (value === undefined || value === null) {
        continue;
      }

      const normalized = String(value).trim();

      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
};

export const startCodeBuddyAuth = async (
  request: Request = new Request('http://localhost/codebuddy/auth/start'),
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  try {
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const authStateEndpoint = await getAuthStateEndpoint();
    const authTokenEndpoint = await getAuthTokenEndpoint();
    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const response = await fetch(
      `${authStateEndpoint}?platform=CLI&nonce=${nonce}`,
      {
        method: 'POST',
        headers: await buildTraceHeaders(),
        body: JSON.stringify({ nonce }),
        cache: 'no-store',
      },
    );
    const payload = (await response.json()) as {
      code?: number;
      data?: { state?: string; authUrl?: string };
      msg?: string;
    };

    if (
      !response.ok ||
      payload.code !== 0 ||
      !payload.data?.state ||
      !payload.data.authUrl
    ) {
      return Response.json(
        {
          success: false,
          error: 'auth_start_failed',
          message: payload.msg ?? 'Failed to start CodeBuddy authentication',
        },
        { status: 400 },
      );
    }

    return Response.json({
      success: true,
      method: 'codebuddy_real_auth',
      auth_state: payload.data.state,
      verification_uri: apiEndpoint,
      verification_uri_complete: payload.data.authUrl,
      token_endpoint: `${authTokenEndpoint}?state=${payload.data.state}`,
      expires_in: 1800,
      interval: 5,
      status: 'awaiting_login',
      instructions: '请点击链接完成 CodeBuddy 登录',
      message: '请使用提供的链接登录 CodeBuddy',
      platform: 'CLI',
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: 'auth_start_failed',
        message:
          error instanceof Error ? error.message : 'Unexpected auth error',
      },
      { status: 500 },
    );
  }
};

const buildCredentialDataFromToken = (
  tokenPayload: Record<string, unknown>,
): CredentialData => {
  const bearerToken = String(
    tokenPayload.access_token ?? tokenPayload.bearer_token ?? '',
  ).trim();
  const jwtPayload = decodeJwtPayload(bearerToken);
  const enterpriseId = getMetadataValue(
    [tokenPayload, jwtPayload],
    ['enterprise_id', 'enterpriseId'],
  );
  const tenantId =
    getMetadataValue([tokenPayload, jwtPayload], ['tenant_id', 'tenantId']) ??
    enterpriseId;
  const userId =
    String(
      jwtPayload.email ??
        jwtPayload.preferred_username ??
        jwtPayload.sub ??
        tokenPayload.domain ??
        'unknown',
    ) || 'unknown';
  const userInfo = {
    email: jwtPayload.email,
    family_name: jwtPayload.family_name,
    given_name: jwtPayload.given_name,
    name: jwtPayload.name,
    preferred_username: jwtPayload.preferred_username,
    scope: jwtPayload.scope,
    session_state: jwtPayload.sid,
    sub: jwtPayload.sub,
  };

  return {
    bearer_token: bearerToken,
    created_at: Math.floor(Date.now() / 1000),
    domain: tokenPayload.domain as string | undefined,
    expires_in: Number(tokenPayload.expires_in ?? 0) || undefined,
    enterprise_id: enterpriseId,
    refresh_token: tokenPayload.refresh_token as string | undefined,
    scope: tokenPayload.scope as string | undefined,
    session_state:
      (tokenPayload.session_state as string | undefined) ??
      (jwtPayload.sid as string | undefined),
    tenant_id: tenantId,
    token_type: (tokenPayload.token_type as string | undefined) ?? 'Bearer',
    user_id: userId,
    user_info: Object.fromEntries(
      Object.entries(userInfo).filter(([, value]) => value !== undefined),
    ),
  };
};

export const pollCodeBuddyAuth = async (
  authState: string,
  request: Request = new Request('http://localhost/codebuddy/auth/poll'),
): Promise<Response> => {
  if (!authState.trim()) {
    return Response.json(
      {
        error: 'missing_parameters',
        error_description: '缺少必要的参数：auth_state',
      },
      { status: 400 },
    );
  }

  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  try {
    const authTokenEndpoint = await getAuthTokenEndpoint();
    const response = await fetch(`${authTokenEndpoint}?state=${authState}`, {
      method: 'GET',
      headers: await buildTraceHeaders(),
      cache: 'no-store',
    });
    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: {
        accessToken?: string;
        expiresIn?: number;
        refreshToken?: string;
        scope?: string;
        sessionState?: string;
        tokenType?: string;
        domain?: string;
        enterpriseId?: string;
        enterprise_id?: string;
        tenantId?: string;
        tenant_id?: string;
      };
    };

    if (payload.code === 11217) {
      return Response.json(
        {
          error: 'authorization_pending',
          error_description: payload.msg ?? '等待用户登录...',
          code: payload.code,
        },
        { status: 400 },
      );
    }

    if (!response.ok || payload.code !== 0 || !payload.data?.accessToken) {
      return Response.json(
        {
          error: 'auth_error',
          error_description: payload.msg ?? '认证过程发生错误',
          details: payload,
        },
        { status: 400 },
      );
    }

    const tokenPayload = {
      access_token: payload.data.accessToken,
      bearer_token: payload.data.accessToken,
      domain: payload.data.domain,
      enterpriseId: payload.data.enterpriseId ?? payload.data.enterprise_id,
      expires_in: payload.data.expiresIn,
      refresh_token: payload.data.refreshToken,
      scope: payload.data.scope,
      session_state: payload.data.sessionState,
      tenantId: payload.data.tenantId ?? payload.data.tenant_id,
      token_type: payload.data.tokenType ?? 'Bearer',
    };
    const credential = buildCredentialDataFromToken(tokenPayload);
    const saved = await addCredential(credential);

    return Response.json({
      access_token: tokenPayload.access_token,
      token_type: tokenPayload.token_type,
      expires_in: tokenPayload.expires_in,
      refresh_token: tokenPayload.refresh_token,
      scope: tokenPayload.scope,
      saved: saved.success,
      filename: saved.filename,
      message: '认证成功！',
      user_info: credential.user_info ?? {},
      domain: tokenPayload.domain ?? null,
    });
  } catch (error) {
    return Response.json(
      {
        error: 'auth_error',
        error_description:
          error instanceof Error ? error.message : 'Unexpected auth error',
      },
      { status: 500 },
    );
  }
};

export const getAuthCallbackResponse = (params: URLSearchParams): Response => {
  const error = params.get('error');

  if (error) {
    return Response.json(
      {
        error,
        error_description: '授权被拒绝或出现错误',
      },
      { status: 400 },
    );
  }

  return Response.json({
    message: '授权成功！请返回应用程序。',
    code: params.get('code'),
    state: params.get('state'),
  });
};
