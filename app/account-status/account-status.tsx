'use client';

import {
  Alert,
  Block,
  Empty,
  Flexbox,
  SkeletonButton,
  SkeletonParagraph,
  SkeletonTags,
  SkeletonTitle,
  Tag,
  Text,
  Tooltip,
} from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import { CalendarClock, Check, Copy, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useId, useMemo, useState } from 'react';

import type { CredentialSummary } from '@/app/credentials/credentials';

/**
 * A model an account can use, as advertised by the upstream model catalog.
 *
 * Mirrors `DiscoveredModel` on the server; the client cannot import from
 * `lib/server`, and only keeps the fields the console renders.
 */
export interface AccountStatusModel {
  contextWindow?: number;
  /** Credit multiplier upstream bills, for example `"x3.33"`. */
  credits?: string;
  descriptionEn?: string;
  descriptionZh?: string;
  displayName: string;
  id: string;
  isEnterprise?: boolean;
  isFree?: boolean;
  isInternal?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
}

interface AccountStatusProps {
  credentials: CredentialSummary[];
  initialStatuses?: AccountStatusSnapshot[];
}

export interface AccountStatusSnapshot {
  checkin: { claimed: boolean | null; message: string | null };
  credits: {
    total: number | null;
    used: number | null;
    remaining: number | null;
    plan: string | null;
    resetAt: string | null;
  };
  error: string | null;
  filename: string;
  models: AccountStatusModel[];
  queriedAt: string;
}

/**
 * Models shown before the list has to be expanded. Accounts routinely offer a
 * few dozen models, so the collapsed card stays scannable.
 */
const MODEL_PREVIEW_COUNT = 8;

/**
 * Fallback when a credential has no stored time. Mirrors
 * `DEFAULT_AUTO_CHECKIN_TIME` on the server; the client must not import from
 * `lib/server`, so the value is restated here.
 */
const DEFAULT_AUTO_CHECKIN_TIME = '09:00';

/**
 * Times offered for automatic check-in.
 *
 * The server accepts any `HH:MM`; these are simply the slots worth offering, so
 * a schedule is a choice rather than a typing exercise.
 */
const AUTO_CHECKIN_TIMES = Array.from({ length: 48 }, (_, index) => {
  const hours = String(Math.floor(index / 2)).padStart(2, '0');
  const minutes = index % 2 === 0 ? '00' : '30';

  return { label: `${hours}:${minutes}`, value: `${hours}:${minutes}` };
});

const initialSnapshot = (filename: string): AccountStatusSnapshot => ({
  checkin: { claimed: null, message: null },
  credits: {
    total: null,
    used: null,
    remaining: null,
    plan: null,
    resetAt: null,
  },
  error: null,
  filename,
  models: [],
  queriedAt: '',
});

const unavailableSnapshot = (filename: string): AccountStatusSnapshot => ({
  ...initialSnapshot(filename),
  error: 'Credential is unavailable',
});

const failedSnapshot = (
  filename: string,
  error: unknown,
): AccountStatusSnapshot => ({
  ...initialSnapshot(filename),
  error: error instanceof Error ? error.message : 'Account status query failed',
  queriedAt: new Date().toISOString(),
});

const quotaPercent = (snapshot: AccountStatusSnapshot): number | null => {
  const { total, remaining } = snapshot.credits;
  if (total === null || total <= 0 || remaining === null) return null;
  return Math.min(100, Math.max(0, (remaining / total) * 100));
};

const QuotaProgress = ({
  plan,
  snapshot,
  unknownLabel,
  remainingLabel,
}: {
  plan: string;
  snapshot: AccountStatusSnapshot;
  unknownLabel: string;
  remainingLabel: (percent: number) => string;
}) => {
  const percent = quotaPercent(snapshot);
  const hasQuota =
    snapshot.credits.total !== null && snapshot.credits.total > 0;
  const tone =
    percent === null
      ? 'unknown'
      : percent <= 0
        ? 'exhausted'
        : percent <= 20
          ? 'warning'
          : 'normal';
  return (
    <Flexbox direction="vertical" gap={8}>
      <Flexbox align="center" distribution="space-between" horizontal>
        <Text strong>{plan}</Text>
        <Flexbox align="center" distribution="flex-end" gap={8} horizontal>
          <Text type="secondary">
            {hasQuota && snapshot.credits.remaining !== null
              ? `${snapshot.credits.remaining} / ${snapshot.credits.total}`
              : '— / —'}
          </Text>
          <Text>{percent === null ? '—' : `${percent.toFixed(0)}%`}</Text>
        </Flexbox>
      </Flexbox>
      <progress
        aria-label={percent === null ? unknownLabel : remainingLabel(percent)}
        className={`account-status-progress account-status-progress-${tone}`}
        max={100}
        value={percent ?? 0}
      />
    </Flexbox>
  );
};

const CopyableModel = ({ model }: { model: string }) => {
  const [copied, setCopied] = useState(false);
  const text = useTranslations('Admin');
  const copy = async () => {
    try {
      let copiedWithModernApi = false;
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(model);
          copiedWithModernApi = true;
        } catch {
          copiedWithModernApi = false;
        }
      }
      if (!copiedWithModernApi) {
        const fallback = document.createElement('textarea');
        fallback.value = model;
        fallback.setAttribute('readonly', '');
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        document.body.append(fallback);
        fallback.select();
        const copiedWithFallback = document.execCommand('copy');
        fallback.remove();
        if (!copiedWithFallback) return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      return;
    }
  };
  return (
    <Tooltip title={copied ? text('common.copy') : text('common.copy')}>
      <Tag className="account-status-model-id" onClick={() => void copy()}>
        <Flexbox align="center" gap={4} horizontal>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span data-model-id={model}>{model}</span>
        </Flexbox>
      </Tag>
    </Tooltip>
  );
};

const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;

  return String(value);
};

const ModelRow = ({ model }: { model: AccountStatusModel }) => {
  const locale = useLocale();
  const text = useTranslations('Admin');
  // Upstream ships both languages; fall back so a missing translation still
  // describes the model instead of leaving the row blank.
  const description = locale.startsWith('zh')
    ? (model.descriptionZh ?? model.descriptionEn)
    : (model.descriptionEn ?? model.descriptionZh);
  // Both server fallbacks derive the display name from the id, so the two are
  // routinely identical. Rendering both would put the same string on the card
  // twice, which reads as a stutter and breaks text-based locators.
  const showDisplayName = model.displayName.trim() !== model.id.trim();
  const context = model.contextWindow ?? model.maxInputTokens;
  const badges = [
    model.isEnterprise
      ? ['enterprise', text('accountStatus.modelEnterprise')]
      : null,
    model.isInternal ? ['internal', text('accountStatus.modelInternal')] : null,
    model.isFree ? ['free', text('accountStatus.modelFree')] : null,
  ].filter((badge): badge is [string, string] => badge !== null);
  const meta = [
    context === undefined
      ? null
      : [
          'context',
          text('accountStatus.modelContext', {
            tokens: formatTokenCount(context),
          }),
        ],
    model.maxOutputTokens === undefined
      ? null
      : [
          'output',
          text('accountStatus.modelOutput', {
            tokens: formatTokenCount(model.maxOutputTokens),
          }),
        ],
    model.supportsImages ? ['images', text('accountStatus.modelImages')] : null,
    model.supportsToolCall ? ['tools', text('accountStatus.modelTools')] : null,
    model.supportsReasoning
      ? ['reasoning', text('accountStatus.modelReasoning')]
      : null,
    // Keyed by field, not by the rendered text: two labels that translate
    // alike would otherwise collide.
  ].filter((item): item is [string, string] => item !== null);

  return (
    <Flexbox className="account-status-model" direction="vertical" gap={6}>
      <Flexbox align="center" gap={8} horizontal wrap="wrap">
        {showDisplayName ? (
          <Text className="account-status-model-name" strong>
            {model.displayName}
          </Text>
        ) : null}
        <CopyableModel model={model.id} />
        {badges.map(([key, label]) => (
          <Tag key={key}>{label}</Tag>
        ))}
        {model.credits ? (
          <Tag className="account-status-model-credits">
            {text('accountStatus.modelCredits')} {model.credits}
          </Tag>
        ) : null}
      </Flexbox>
      {description ? (
        <Text className="account-status-model-description" type="secondary">
          {description}
        </Text>
      ) : null}
      {meta.length ? (
        <Flexbox align="center" gap={8} horizontal wrap="wrap">
          {meta.map(([key, label]) => (
            <Text
              className="account-status-model-meta"
              key={key}
              type="secondary"
            >
              {label}
            </Text>
          ))}
        </Flexbox>
      ) : null}
    </Flexbox>
  );
};

const ModelList = ({ models }: { models: AccountStatusModel[] }) => {
  const text = useTranslations('Admin');
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (!models.length) {
    return <Text type="secondary">{text('accountStatus.noModels')}</Text>;
  }

  const visible = expanded ? models : models.slice(0, MODEL_PREVIEW_COUNT);

  return (
    <Flexbox direction="vertical" gap={8}>
      <Flexbox
        align="center"
        distribution="space-between"
        horizontal
        width="100%"
        wrap="wrap"
      >
        <Text strong>
          {text('accountStatus.modelCount', { count: models.length })}
        </Text>
        {models.length > MODEL_PREVIEW_COUNT ? (
          <Button
            aria-controls={listId}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? text('accountStatus.collapseModels')
              : text('accountStatus.showModels', { count: models.length })}
          </Button>
        ) : null}
      </Flexbox>
      <Flexbox direction="vertical" gap={10} id={listId}>
        {visible.map((model, index) => (
          // The id is the row's identity, but a cache edited by hand can still
          // hold one twice; the index keeps the key unique either way.
          <ModelRow key={`${model.id}-${index}`} model={model} />
        ))}
      </Flexbox>
    </Flexbox>
  );
};

const AccountStatusSkeleton = () => (
  <Block direction="vertical" gap={16} padding={20} variant="outlined">
    <SkeletonTitle />
    <SkeletonParagraph rows={1} />
    <SkeletonParagraph rows={3} />
    <SkeletonTags />
    <SkeletonButton />
  </Block>
);

const AutoCheckinRow = ({
  enabled,
  saving,
  time,
  onToggle,
  onTimeChange,
}: {
  enabled: boolean;
  saving: boolean;
  time: string;
  onToggle: (checked: boolean) => void;
  onTimeChange: (time: string) => void;
}) => {
  const text = useTranslations('Admin');
  return (
    <Flexbox
      align="center"
      className="account-status-card-auto-checkin"
      distribution="space-between"
      gap={12}
      horizontal
      wrap="wrap"
      width="100%"
    >
      <Flexbox align="center" gap={8} horizontal>
        <CalendarClock size={16} />
        <Flexbox direction="vertical" gap={2}>
          <Text strong>{text('accountStatus.autoCheckin')}</Text>
          <Text className="text-sm" type="secondary">
            {text('accountStatus.autoCheckinDescription')}
          </Text>
        </Flexbox>
      </Flexbox>
      <Flexbox align="center" gap={12} horizontal>
        <Text type="secondary">{text('accountStatus.autoCheckinTime')}</Text>
        <Select
          className="account-status-card-auto-checkin-time"
          disabled={!enabled || saving}
          onChange={onTimeChange}
          options={AUTO_CHECKIN_TIMES}
          value={time}
        />
        <Switch checked={enabled} disabled={saving} onChange={onToggle} />
      </Flexbox>
    </Flexbox>
  );
};

const AccountStatusCard = ({
  credential,
  snapshot,
  busy,
  onRefresh,
  onCheckin,
  autoCheckin,
  onAutoCheckinChange,
}: {
  credential: CredentialSummary;
  snapshot: AccountStatusSnapshot;
  busy: string | null;
  onRefresh: () => void;
  onCheckin: () => void;
  autoCheckin: { enabled: boolean; time: string };
  onAutoCheckinChange: (next: { enabled?: boolean; time?: string }) => void;
}) => {
  const text = useTranslations('Admin');
  const quotaUnknown = text('accountStatus.quotaUnknown');
  return (
    <Block
      className={
        busy
          ? 'account-status-card account-status-card-busy'
          : 'account-status-card'
      }
      direction="vertical"
      gap={16}
      padding={20}
      variant="outlined"
    >
      <Flexbox
        align="flex-start"
        className="account-status-card-header"
        distribution="space-between"
        horizontal
        width="100%"
      >
        <Flexbox
          className="account-status-card-identity"
          direction="vertical"
          gap={4}
        >
          <Tooltip title={credential.email || credential.user_id}>
            <Text className="account-status-card-name" strong>
              {credential.email || credential.user_id}
            </Text>
          </Tooltip>
          <Tooltip title={credential.filename}>
            <Text className="account-status-card-filename" type="secondary">
              {credential.filename}
            </Text>
          </Tooltip>
        </Flexbox>
        <Button
          aria-label={text('accountStatus.refresh')}
          icon={RefreshCw}
          loading={busy === 'refresh'}
          disabled={Boolean(busy)}
          onClick={onRefresh}
        >
          {text('accountStatus.refresh')}
        </Button>
      </Flexbox>
      {snapshot.error ? <Alert type="error" title={snapshot.error} /> : null}
      <Flexbox direction="vertical" gap={8}>
        <QuotaProgress
          plan={snapshot.credits.plan ?? '—'}
          snapshot={snapshot}
          unknownLabel={quotaUnknown}
          remainingLabel={(value) =>
            text('accountStatus.quotaUsed', { percent: value.toFixed(0) })
          }
        />
        <Text type="secondary">
          {text('accountStatus.resetAt')}: {snapshot.credits.resetAt ?? '—'}
        </Text>
      </Flexbox>
      <Flexbox
        align="center"
        className="account-status-card-checkin"
        distribution="space-between"
        horizontal
        width="100%"
      >
        <Text className="account-status-card-checkin-label" type="secondary">
          {text('accountStatus.checkin')}:{' '}
          {snapshot.checkin.claimed === true
            ? text('accountStatus.checkedIn')
            : snapshot.checkin.claimed === false
              ? text('accountStatus.notCheckedIn')
              : '—'}
        </Text>
        <Button
          disabled={Boolean(busy) || snapshot.checkin.claimed === true}
          loading={busy === 'checkin'}
          onClick={onCheckin}
        >
          {text('accountStatus.checkinAction')}
        </Button>
      </Flexbox>
      <AutoCheckinRow
        enabled={autoCheckin.enabled}
        saving={busy === 'auto-checkin'}
        time={autoCheckin.time}
        onToggle={(checked) => onAutoCheckinChange({ enabled: checked })}
        onTimeChange={(next) => onAutoCheckinChange({ time: next })}
      />
      <Flexbox direction="vertical" gap={8}>
        <ModelList models={snapshot.models} />
      </Flexbox>
    </Block>
  );
};

const AccountStatus = ({
  credentials,
  initialStatuses = [],
}: AccountStatusProps) => {
  const text = useTranslations('Admin');
  const [snapshots, setSnapshots] = useState<
    Record<string, AccountStatusSnapshot>
  >(() =>
    Object.fromEntries(
      initialStatuses.map((status) => [status.filename, status]),
    ),
  );
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  const [autoCheckin, setAutoCheckin] = useState<
    Record<string, { enabled: boolean; time: string }>
  >(() =>
    Object.fromEntries(
      credentials.map((credential) => [
        credential.filename,
        {
          enabled: credential.auto_checkin_enabled === true,
          time: credential.auto_checkin_time || DEFAULT_AUTO_CHECKIN_TIME,
        },
      ]),
    ),
  );
  const loadOne = useCallback(
    async (filename: string, action: 'refresh' | 'checkin' = 'refresh') => {
      setBusy((current) => ({ ...current, [filename]: action }));
      try {
        const response = await fetch('/admin-api/account-status', {
          body: JSON.stringify({ action, filename }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });
        if (!response.ok) {
          throw new Error(`Account status request failed (${response.status})`);
        }
        const payload = (await response.json()) as {
          status?: AccountStatusSnapshot;
          statuses?: AccountStatusSnapshot[];
        };
        const snapshot = payload.status ?? payload.statuses?.[0];
        if (snapshot)
          setSnapshots((current) => ({ ...current, [filename]: snapshot }));
      } catch (error) {
        setSnapshots((current) => ({
          ...current,
          [filename]: {
            ...(current[filename] ?? failedSnapshot(filename, error)),
            error:
              error instanceof Error
                ? error.message
                : 'Account status query failed',
          },
        }));
      } finally {
        setBusy((current) => {
          const next = { ...current };
          delete next[filename];
          return next;
        });
      }
    },
    [],
  );
  const loadAll = useCallback(
    async (action: 'refresh' | 'checkin') => {
      setBatchBusy(action);
      try {
        await Promise.all(
          credentials
            .filter((credential) => {
              if (credential.is_expired) return false;
              if (action !== 'checkin') return true;
              return snapshots[credential.filename]?.checkin.claimed !== true;
            })
            .map((credential) => loadOne(credential.filename, action)),
        );
      } finally {
        setBatchBusy(null);
      }
    },
    [credentials, loadOne, snapshots],
  );
  const saveAutoCheckin = useCallback(
    async (filename: string, next: { enabled?: boolean; time?: string }) => {
      const previous = autoCheckin[filename] ?? {
        enabled: false,
        time: DEFAULT_AUTO_CHECKIN_TIME,
      };
      const merged = {
        enabled: next.enabled ?? previous.enabled,
        time: next.time ?? previous.time,
      };

      // Optimistic: the switch should move immediately, and a failure is
      // reverted with an error on the card rather than leaving the control
      // stuck in the old state.
      setAutoCheckin((current) => ({ ...current, [filename]: merged }));
      setBusy((current) => ({ ...current, [filename]: 'auto-checkin' }));

      try {
        const response = await fetch('/admin-api/account-status', {
          body: JSON.stringify({ action: 'auto-checkin', filename, ...next }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });

        if (!response.ok) {
          throw new Error(`Auto check-in request failed (${response.status})`);
        }

        const payload = (await response.json()) as {
          autoCheckin?: { enabled: boolean; time: string };
          error?: string;
        };

        if (payload.error) throw new Error(payload.error);
        if (payload.autoCheckin)
          setAutoCheckin((current) => ({
            ...current,
            [filename]: payload.autoCheckin as {
              enabled: boolean;
              time: string;
            },
          }));
      } catch (error) {
        setAutoCheckin((current) => ({ ...current, [filename]: previous }));
        setSnapshots((current) => ({
          ...current,
          [filename]: {
            ...(current[filename] ?? failedSnapshot(filename, error)),
            error:
              error instanceof Error
                ? error.message
                : 'Auto check-in update failed',
          },
        }));
      } finally {
        setBusy((current) => {
          const pending = { ...current };
          delete pending[filename];
          return pending;
        });
      }
    },
    [autoCheckin],
  );

  const pageCredentials = useMemo(
    () =>
      credentials.length > 50
        ? credentials.slice((page - 1) * 12, page * 12)
        : credentials,
    [credentials, page],
  );
  const pageCount =
    credentials.length > 50 ? Math.ceil(credentials.length / 12) : 1;
  return (
    <Flexbox direction="vertical" gap={24}>
      <Flexbox
        align="center"
        distribution="space-between"
        horizontal
        wrap="wrap"
      >
        <Flexbox gap={8} horizontal>
          <Button
            loading={batchBusy === 'refresh'}
            disabled={Boolean(batchBusy) || !credentials.length}
            onClick={() => void loadAll('refresh')}
          >
            {text('accountStatus.refreshAll')}
          </Button>
          <Button
            loading={batchBusy === 'checkin'}
            disabled={Boolean(batchBusy) || !credentials.length}
            onClick={() => void loadAll('checkin')}
          >
            {text('accountStatus.checkinAll')}
          </Button>
        </Flexbox>
      </Flexbox>
      {credentials.length ? (
        pageCredentials.map((credential) => {
          const snapshot = snapshots[credential.filename];
          if (!snapshot && !credential.is_expired) {
            return <AccountStatusSkeleton key={credential.filename} />;
          }
          return (
            <AccountStatusCard
              credential={credential}
              key={credential.filename}
              snapshot={snapshot ?? unavailableSnapshot(credential.filename)}
              busy={busy[credential.filename] ?? null}
              onCheckin={() => void loadOne(credential.filename, 'checkin')}
              onRefresh={() => void loadOne(credential.filename)}
              autoCheckin={
                autoCheckin[credential.filename] ?? {
                  enabled: false,
                  time: DEFAULT_AUTO_CHECKIN_TIME,
                }
              }
              onAutoCheckinChange={(next) =>
                void saveAutoCheckin(credential.filename, next)
              }
            />
          );
        })
      ) : (
        <Empty title={text('accountStatus.empty')} />
      )}
      {pageCount > 1 ? (
        <Flexbox align="center" gap={8} horizontal>
          <Button
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            ‹
          </Button>
          <Text>
            {page} / {pageCount}
          </Text>
          <Button
            disabled={page >= pageCount}
            onClick={() => setPage((value) => value + 1)}
          >
            ›
          </Button>
        </Flexbox>
      ) : null}
    </Flexbox>
  );
};

export default AccountStatus;
