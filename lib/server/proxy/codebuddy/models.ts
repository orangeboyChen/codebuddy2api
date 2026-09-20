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
import { normalizeModelFields } from './model-fields';
import type { DiscoveredModel } from './types';

/**
 * A single `models[]` entry of the upstream product config. Fields beyond `id`
 * are optional because upstream only populates them where it knows a value.
 */
interface UpstreamModelEntry {
  contextWindow?: { defaultLength?: unknown; supportedLengths?: unknown };
  credits?: unknown;
  descriptionEn?: unknown;
  descriptionZh?: unknown;
  disabled?: unknown;
  id?: unknown;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  name?: unknown;
  supportsImages?: unknown;
  supportsReasoning?: unknown;
  supportsToolCall?: unknown;
  tags?: unknown;
  vendor?: unknown;
}

/**
 * Upstream renders badges as `badge:<label>:<color>` tags, e.g.
 * `badge:企业版:#3B82F6`. Labels are localized server-side, so both the Chinese
 * and English spellings are recognized.
 */
const BADGE_LABELS: Record<
  'enterprise' | 'free' | 'internal',
  readonly string[]
> = {
  enterprise: ['企业版', 'enterprise'],
  free: ['免费', 'free'],
  internal: ['内部模型', 'internal'],
};

const readBadges = (tags: unknown) => {
  const entries: unknown[] = Array.isArray(tags) ? tags : [];
  const labels = entries.flatMap((tag) => {
    if (typeof tag !== 'string') return [];
    const [prefix, ...rest] = tag.split(':');

    if (prefix.trim().toLowerCase() !== 'badge') return [];

    // The colour is the trailing segment, so a label may itself contain the
    // separator; a tag carrying no colour at all is nothing but a label.
    const label = (rest.length > 1 ? rest.slice(0, -1) : rest)
      .join(':')
      .trim()
      .toLowerCase();

    return label ? [label] : [];
  });
  const has = (candidates: readonly string[]) =>
    labels.some((label) => candidates.includes(label)) || undefined;

  return {
    isEnterprise: has(BADGE_LABELS.enterprise),
    isFree: has(BADGE_LABELS.free),
    isInternal: has(BADGE_LABELS.internal),
  };
};

const toDiscoveredModel = (
  entry: UpstreamModelEntry,
): DiscoveredModel | undefined => {
  if (entry.disabled === true) return undefined;

  return normalizeModelFields({
    ...entry,
    contextWindow: entry.contextWindow?.defaultLength,
    displayName: entry.name,
    ...readBadges(entry.tags),
  });
};

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
      models?: UpstreamModelEntry[];
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
      const discovered = toDiscoveredModel(model);

      return discovered ? ([[discovered.id, discovered]] as const) : [];
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

  // Upstream can list one id twice. The first row wins, so neither the card
  // nor the admin console's model field ever shows a repeated id.
  const seen = new Set<string>();

  return cliModels.flatMap((modelId) => {
    if (typeof modelId !== 'string' || seen.has(modelId)) return [];

    seen.add(modelId);

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
