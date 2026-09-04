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
import { Button } from '@lobehub/ui/base-ui';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';

import type { CredentialSummary } from '@/app/credentials/credentials';

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
  models: string[];
  queriedAt: string;
}

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
      <Tag onClick={() => void copy()}>
        <Flexbox align="center" gap={4} horizontal>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span data-model-id={model}>{model}</span>
        </Flexbox>
      </Tag>
    </Tooltip>
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

const AccountStatusCard = ({
  credential,
  snapshot,
  busy,
  onRefresh,
  onCheckin,
}: {
  credential: CredentialSummary;
  snapshot: AccountStatusSnapshot;
  busy: string | null;
  onRefresh: () => void;
  onCheckin: () => void;
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
      <Flexbox direction="vertical" gap={8}>
        <Text strong>{text('accountStatus.models')}</Text>
        {snapshot.models.length ? (
          <Flexbox gap={8} horizontal wrap="wrap">
            {snapshot.models.map((model) => (
              <CopyableModel key={model} model={model} />
            ))}
          </Flexbox>
        ) : (
          <Text type="secondary">{text('accountStatus.noModels')}</Text>
        )}
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
