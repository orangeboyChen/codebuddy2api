'use client';

import {
  Alert,
  Block,
  Collapse,
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
import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CredentialSummary } from '@/app/credentials/credentials';

interface AccountStatusProps {
  credentials: CredentialSummary[];
}

interface AccountStatusSnapshot {
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

const quotaPercent = (snapshot: AccountStatusSnapshot): number | null => {
  const { total, used } = snapshot.credits;
  if (total === null || total <= 0 || used === null) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
};

const QuotaProgress = ({ snapshot }: { snapshot: AccountStatusSnapshot }) => {
  const percent = quotaPercent(snapshot);
  const tone =
    percent === null
      ? 'unknown'
      : percent >= 100
        ? 'exhausted'
        : percent >= 80
          ? 'warning'
          : 'normal';
  return (
    <Flexbox direction="vertical" gap={8}>
      <Flexbox align="center" distribution="space-between" horizontal>
        <Text>{percent === null ? '—' : `${percent.toFixed(0)}%`}</Text>
        <Text type="secondary">
          {snapshot.credits.used ?? '—'} / {snapshot.credits.total ?? '—'}
        </Text>
      </Flexbox>
      <progress
        aria-label={
          percent === null ? 'Unknown quota' : `${percent.toFixed(0)}% used`
        }
        className={`account-status-progress account-status-progress-${tone}`}
        max={100}
        value={percent ?? 0}
      />
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
  const percent = quotaPercent(snapshot);
  const models = snapshot.models.slice(0, 8);
  const hasMoreModels = snapshot.models.length > models.length;
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
      <Flexbox direction="vertical" gap={4}>
        <Tooltip title={credential.email || credential.user_id}>
          <Text strong>{credential.email || credential.user_id}</Text>
        </Tooltip>
        <Tooltip title={credential.filename}>
          <Text ellipsis type="secondary">
            {credential.filename}
          </Text>
        </Tooltip>
      </Flexbox>
      {snapshot.error ? <Alert type="error" title={snapshot.error} /> : null}
      <Flexbox direction="vertical" gap={8}>
        <Text strong>{text('accountStatus.quota')}</Text>
        <QuotaProgress snapshot={snapshot} />
        <Flexbox
          className="account-status-quota-values"
          gap={16}
          horizontal
          wrap="wrap"
        >
          <Text type="secondary">
            {text('accountStatus.total')}: {snapshot.credits.total ?? '—'}
          </Text>
          <Text type="secondary">
            {text('accountStatus.used')}: {snapshot.credits.used ?? '—'}
          </Text>
          <Text type="secondary">
            {text('accountStatus.remaining')}:{' '}
            {snapshot.credits.remaining ?? '—'}
          </Text>
        </Flexbox>
        <Text type="secondary">
          {text('accountStatus.plan')}: {snapshot.credits.plan ?? '—'}
        </Text>
        <Text type="secondary">
          {text('accountStatus.resetAt')}: {snapshot.credits.resetAt ?? '—'}
        </Text>
        {percent !== null && percent >= 100 ? (
          <Text type="secondary">{text('accountStatus.exhausted')}</Text>
        ) : null}
      </Flexbox>
      <Flexbox align="center" distribution="space-between" horizontal>
        <Text type="secondary">
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
        {models.length ? (
          <Collapse
            items={[
              {
                key: 'models',
                label: hasMoreModels
                  ? text('accountStatus.showModels', {
                      count: snapshot.models.length,
                    })
                  : text('accountStatus.modelCount', {
                      count: snapshot.models.length,
                    }),
                children: (
                  <Flexbox gap={8} wrap="wrap">
                    {snapshot.models.map((model) => (
                      <Tag key={model}>{model}</Tag>
                    ))}
                  </Flexbox>
                ),
              },
            ]}
            variant="borderless"
          />
        ) : (
          <Text type="secondary">{text('accountStatus.noModels')}</Text>
        )}
      </Flexbox>
      <Flexbox align="center" distribution="space-between" horizontal>
        <Text type="secondary">
          {snapshot.queriedAt
            ? new Date(snapshot.queriedAt).toLocaleString()
            : '—'}
        </Text>
        <Button
          icon={RefreshCw}
          loading={busy === 'refresh'}
          disabled={Boolean(busy)}
          onClick={onRefresh}
        >
          {text('accountStatus.refresh')}
        </Button>
      </Flexbox>
    </Block>
  );
};

const AccountStatus = ({ credentials }: AccountStatusProps) => {
  const text = useTranslations('Admin');
  const [snapshots, setSnapshots] = useState<
    Record<string, AccountStatusSnapshot>
  >({});
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
        const payload = (await response.json()) as {
          status?: AccountStatusSnapshot;
          statuses?: AccountStatusSnapshot[];
        };
        const snapshot = payload.status ?? payload.statuses?.[0];
        if (snapshot)
          setSnapshots((current) => ({ ...current, [filename]: snapshot }));
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
      await Promise.all(
        credentials.map((credential) => loadOne(credential.filename, action)),
      );
      setBatchBusy(null);
    },
    [credentials, loadOne],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAll('refresh');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAll]);
  const pageCredentials = useMemo(
    () =>
      credentials.length > 50
        ? credentials.slice((page - 1) * 12, page * 12)
        : credentials,
    [credentials, page],
  );
  const pageCount =
    credentials.length > 50 ? Math.ceil(credentials.length / 12) : 1;
  if (!credentials.length) return <Empty title={text('accountStatus.empty')} />;
  return (
    <Flexbox direction="vertical" gap={24}>
      <Flexbox
        align="center"
        distribution="space-between"
        horizontal
        wrap="wrap"
      >
        <Text strong>{text('accountStatus.title')}</Text>
        <Flexbox gap={8} horizontal>
          <Button
            loading={batchBusy === 'refresh'}
            disabled={Boolean(batchBusy)}
            onClick={() => void loadAll('refresh')}
          >
            {text('accountStatus.refreshAll')}
          </Button>
          <Button
            loading={batchBusy === 'checkin'}
            disabled={Boolean(batchBusy)}
            onClick={() => void loadAll('checkin')}
          >
            {text('accountStatus.checkinAll')}
          </Button>
        </Flexbox>
      </Flexbox>
      {snapshots && Object.keys(snapshots).length === 0 ? (
        <AccountStatusSkeleton />
      ) : (
        pageCredentials.map((credential) => (
          <AccountStatusCard
            credential={credential}
            key={credential.filename}
            snapshot={
              snapshots[credential.filename] ??
              initialSnapshot(credential.filename)
            }
            busy={busy[credential.filename] ?? null}
            onCheckin={() => void loadOne(credential.filename, 'checkin')}
            onRefresh={() => void loadOne(credential.filename)}
          />
        ))
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
