import type { NextRequest } from 'next/server';

import { resolveRequestAccessKey } from '../auth';
import { getCodeBuddyApiEndpoint } from '../../domain/config';
import {
  type CredentialData,
  type CredentialRecord,
  getCredentialSupportedModels,
  listEligibleCredentialRecords,
} from '../../domain/credentials';
import { getCredentialValue } from './context';
import type { DiscoveredModel } from './types';

export const getModelsForCredential = async ({
  bearerToken,
  credentialData,
}: {
  bearerToken: string;
  credentialData: CredentialData;
}): Promise<DiscoveredModel[]> => {
  const configuredEndpoint = await getCodeBuddyApiEndpoint();
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${bearerToken}`,
    'X-Product': 'SaaS',
  });
  const domain = getCredentialValue(credentialData, ['domain']);
  const apiEndpoint = String(domain ?? '')
    .toLowerCase()
    .endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : configuredEndpoint;
  const enterpriseId = getCredentialValue(credentialData, [
    'enterprise_id',
    'enterpriseId',
  ]);
  const tenantId =
    getCredentialValue(credentialData, ['tenant_id', 'tenantId']) ??
    enterpriseId;
  const userId = getCredentialValue(credentialData, ['user_id', 'userId']);

  if (domain) {
    headers.set('X-Domain', String(domain));
  }

  if (enterpriseId) {
    headers.set('X-Enterprise-Id', String(enterpriseId));
  }

  if (tenantId) {
    headers.set('X-Tenant-Id', String(tenantId));
  }
  if (userId) {
    headers.set('X-User-Id', String(userId));
  }

  const fetchModels = async (path: string): Promise<Response> =>
    fetch(new URL(path, apiEndpoint), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  let response = await fetchModels('/v3/config');

  if ([400, 404, 405].includes(response.status)) {
    // Upstream splits this route by account scope: enterprise accounts must hit
    // their own segment, otherwise they are served the personal model catalog.
    const enterpriseScope = String(enterpriseId ?? '').trim() || 'personal';
    response = await fetchModels(
      `/console/enterprises/${encodeURIComponent(enterpriseScope)}/models`,
    );
  }

  if (!response.ok) {
    throw new Error(`Model discovery failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    code?: unknown;
    data?: {
      agents?: Array<{ models?: unknown; name?: unknown }>;
      models?: Array<{ disabled?: unknown; id?: unknown; name?: unknown }>;
    };
  };

  if (payload.code !== 0) {
    throw new Error('Model discovery returned an unsuccessful response');
  }

  const cliModels = payload.data?.agents?.find(
    (agent) => agent.name === 'cli',
  )?.models;
  const modelsById = new Map(
    (payload.data?.models ?? []).flatMap((model) => {
      const id = typeof model.id === 'string' ? model.id.trim() : '';

      if (!id || model.disabled === true) {
        return [];
      }

      return [
        [
          id,
          {
            displayName:
              typeof model.name === 'string' && model.name.trim()
                ? model.name
                : id,
            id,
          },
        ] as const,
      ];
    }),
  );
  const declaredModelIds = new Set(
    (payload.data?.models ?? [])
      .map((model) => (typeof model.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean),
  );

  if (!Array.isArray(cliModels)) {
    return [];
  }

  return cliModels.flatMap((modelId) => {
    if (typeof modelId !== 'string') {
      return [];
    }

    const model = modelsById.get(modelId);
    if (!model && declaredModelIds.has(modelId)) {
      return [];
    }
    return [
      model ?? {
        displayName: modelId,
        id: modelId,
      },
    ];
  });
};

export const getModelsForCredentials = async (
  credentials: CredentialRecord[],
): Promise<DiscoveredModel[]> => {
  const settled = await Promise.allSettled(
    credentials.map((credential) => {
      const supportedModels = getCredentialSupportedModels(credential.data);

      if (supportedModels.length) {
        return Promise.resolve(
          supportedModels.map((id) => ({ displayName: id, id })),
        );
      }

      const bearerToken = String(
        credential.data.bearer_token ?? credential.data.access_token ?? '',
      ).trim();

      return bearerToken
        ? getModelsForCredential({
            bearerToken,
            credentialData: credential.data,
          })
        : Promise.resolve([]);
    }),
  );
  const models = new Map<string, DiscoveredModel>();

  settled.forEach((result) => {
    if (result.status !== 'fulfilled') {
      return;
    }

    result.value.forEach((model) => {
      models.set(model.id, model);
    });
  });

  return [...models.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
};

export const getModelsByCredential = async (
  credentials: CredentialRecord[],
): Promise<
  Record<string, { error: string | null; models: DiscoveredModel[] }>
> => {
  const results = await Promise.all(
    credentials.map(async (credential) => {
      const bearerToken = String(
        credential.data.bearer_token ?? credential.data.access_token ?? '',
      ).trim();

      try {
        const models = bearerToken
          ? await getModelsForCredential({
              bearerToken,
              credentialData: credential.data,
            })
          : [];

        return [credential.filename, { error: null, models }] as const;
      } catch (error) {
        return [
          credential.filename,
          {
            error:
              error instanceof Error ? error.message : 'Model discovery failed',
            models: [],
          },
        ] as const;
      }
    }),
  );

  return Object.fromEntries(results);
};

export const getModelsResponse = async (
  request?: NextRequest,
): Promise<Response> => {
  const accessKey = request ? await resolveRequestAccessKey(request) : null;
  const models = (
    await getModelsForCredentials(
      await listEligibleCredentialRecords(accessKey?.credentialFilenames),
    )
  ).map((model) => ({
    id: model.id,
    slug: model.id,
    display_name: model.displayName,
    object: 'model',
    created: 0,
    owned_by: 'codebuddy',
  }));

  return Response.json({
    object: 'list',
    data: models,
    models,
  });
};
