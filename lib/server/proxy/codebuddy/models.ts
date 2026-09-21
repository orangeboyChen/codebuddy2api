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
  isDefault?: unknown;
  maxAllowedSize?: unknown;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  name?: unknown;
  onlyReasoning?: unknown;
  reasoning?: {
    effort?: unknown;
    supportedEfforts?: unknown;
  };
  relatedModels?: unknown;
  supportsImages?: unknown;
  supportsReasoning?: unknown;
  supportsToolCall?: unknown;
  tags?: unknown;
  vendor?: unknown;
}

/**
 * Promotions and tiers upstream ships beside the catalog.
 *
 * They arrive as catalog-wide lists naming the models they apply to, not as
 * fields on the models themselves, so a model only gets one when a list entry
 * names it.
 */
interface UpstreamCampaignEntry {
  badge?: { label?: unknown };
  discount?: { discountedCredits?: unknown };
  enabled?: unknown;
  hover?: { textEn?: unknown; textZh?: unknown };
  modelIds?: unknown;
  priority?: unknown;
  schedule?: { validFrom?: unknown; validUntil?: unknown };
  tier?: unknown;
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
  const labels: string[] = [];
  // Everything a tag says that is not a badge is a capability: `craft`,
  // `text-to-image`, `lite`. They are printed as they arrive, so the card can
  // show what upstream claims without the console inventing a vocabulary.
  const capabilityTags: string[] = [];
  entries.forEach((tag) => {
    if (typeof tag !== 'string') return;
    const [prefix, ...rest] = tag.split(':');

    if (prefix.trim().toLowerCase() !== 'badge') {
      const capability = tag.trim();

      if (capability) capabilityTags.push(capability);

      return;
    }

    // The colour is the trailing segment, so a label may itself contain the
    // separator; a tag carrying no colour at all is nothing but a label.
    const label = (rest.length > 1 ? rest.slice(0, -1) : rest)
      .join(':')
      .trim()
      .toLowerCase();

    if (label) labels.push(label);
  });
  const has = (candidates: readonly string[]) =>
    labels.some((label) => candidates.includes(label)) || undefined;

  return {
    capabilityTags: capabilityTags.length ? capabilityTags : undefined,
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
    contextLengths: entry.contextWindow?.supportedLengths,
    contextWindow: entry.contextWindow?.defaultLength,
    defaultEffort: entry.reasoning?.effort,
    displayName: entry.name,
    supportedEfforts: entry.reasoning?.supportedEfforts,
    ...readBadges(entry.tags),
  });
};

const asCampaignModelIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === 'string' && item.trim() ? [item.trim()] : [],
      )
    : [];

const asCampaignPriority = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Resolves the catalog-wide promotion and tier lists down to one entry per
 * model.
 *
 * Upstream ships no documented order between two campaigns naming the same
 * model, so the console picks one itself: the highest `priority` wins, and the
 * first entry wins a tie. Whichever is chosen, the card quotes one campaign
 * rather than whichever happened to come last.
 */
const resolveCampaignsByModel = (
  entries: unknown,
  build: (entry: UpstreamCampaignEntry) => Record<string, unknown> | undefined,
): Map<string, Record<string, unknown>> => {
  const byModel = new Map<string, Record<string, unknown>>();
  const priorities = new Map<string, number>();

  if (!Array.isArray(entries)) return byModel;

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;

    const entry = raw as UpstreamCampaignEntry;
    // Anything upstream marks off — boolean or not — is withdrawn.
    const withdrawn =
      entry.enabled === false ||
      entry.enabled === 0 ||
      entry.enabled === 'false';
    const built = withdrawn ? undefined : build(entry);

    // An entry that says nothing — an empty badge, a schedule without a date —
    // must not claim the model: it would otherwise win on priority and hide a
    // campaign below it that does have something to show.
    if (!built || !Object.values(built).some((value) => value !== undefined)) {
      continue;
    }

    const priority = asCampaignPriority(entry.priority);

    for (const modelId of asCampaignModelIds(entry.modelIds)) {
      const current = priorities.get(modelId);

      if (current !== undefined && current >= priority) continue;

      priorities.set(modelId, priority);
      byModel.set(modelId, built);
    }
  }

  return byModel;
};

/**
 * Reads a promotion, keeping what the console can print.
 *
 * Only the outer validity window is kept: a promotion may also be scoped to a
 * daily window, which the client upstream of this one re-evaluates against the
 * clock. This console reports the offer as upstream advertises it and settles
 * nothing, so a daily window is out of scope rather than evaluated wrongly.
 */
const readPromotions = (entries: unknown) =>
  resolveCampaignsByModel(entries, (entry) => ({
    discountedCredits: entry.discount?.discountedCredits,
    endsAt: entry.schedule?.validUntil,
    label: entry.badge?.label,
    startsAt: entry.schedule?.validFrom,
    textEn: entry.hover?.textEn,
    textZh: entry.hover?.textZh,
  }));

const readTiers = (entries: unknown) =>
  resolveCampaignsByModel(entries, (entry) => ({
    label: entry.badge?.label,
    level: entry.tier,
  }));

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
      modelPromotions?: unknown;
      modelTiers?: unknown;
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
  const promotionsByModel = readPromotions(payload.data?.modelPromotions);
  const tiersByModel = readTiers(payload.data?.modelTiers);
  // The campaign lists are upstream data too, so they are merged into the
  // model and read back through the same normalizer that vets everything else
  // on it — a cap or a type the console rejects applies to them as well.
  const withCampaigns = (model: DiscoveredModel): DiscoveredModel => {
    const promotion = promotionsByModel.get(model.id);
    const tier = tiersByModel.get(model.id);

    if (!promotion && !tier) return model;

    return (
      normalizeModelFields({
        ...model,
        ...(promotion ? { promotion } : {}),
        ...(tier ? { tier } : {}),
      }) ?? model
    );
  };

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
      model ? withCampaigns(model) : { displayName: modelId, id: modelId },
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
