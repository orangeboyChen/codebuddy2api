import type {
  AccessKeySummary,
  ApiTestState,
  AuthState,
  CredentialSummary,
  CredentialsState,
  CurrentCredentialInfo,
  DebugState,
  DashboardState,
  NotificationState,
  SettingsState,
  TabKey,
  UsageRange,
  UsageState,
} from '@/app/admin/_components/admin-store';
import {
  DEFAULT_TEST_MODELS,
  TAB_ITEMS,
  USAGE_RING_CIRCUMFERENCE,
} from '@/app/admin/_components/admin-store';

interface TabNavProps {
  activeTab: TabKey;
  onChange: (tab: TabKey) => void;
}

interface DashboardSectionProps {
  onCopyEndpoint: () => void;
  onRefresh: () => void;
  state: DashboardState;
}

interface CredentialsSectionProps {
  auth: AuthState;
  credentials: CredentialsState;
  onAddCredential: () => void;
  onAuthAction: () => void;
  onCallbackUrlChange: (value: string) => void;
  onCopyAuthUrl: () => void;
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onCredentialTokenChange: (value: string) => void;
  onCredentialUserIdChange: (value: string) => void;
  onDeleteCredential: (index: number) => void;
  onDeleteAccessKey: (id: string) => void;
  onEditCredential: (credential: CredentialSummary) => void;
  onEditAccessKey: (accessKey: AccessKeySummary) => void;
  onOpenAuthUrl: () => void;
  onPollAuth: () => void;
  onRefreshCredentials: () => void;
  onResetCredentialForm: () => void;
  onResetAccessKeyForm: () => void;
  onRevealAccessKeySecret: (id: string) => void;
  onSaveAccessKey: () => void;
  onSubmitCallbackUrl: () => void;
  onToggleCallbackMode: (showManual: boolean) => void;
  onToggleCredentialSelection: (filename: string) => void;
  onUpdateAccessKeyName: (value: string) => void;
}

interface ApiTestSectionProps {
  credentialOptions: CredentialSummary[];
  onCredentialChange: (value: string) => void;
  models: string[];
  onMessageChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onStreamChange: (checked: boolean) => void;
  onSubmit: () => void;
  state: ApiTestState;
}

interface SettingsSectionProps {
  onChange: (key: string, value: string) => void;
  onSave: () => void;
  state: SettingsState;
}

interface UsageSectionProps {
  onAccessKeyChange: (value: string) => void;
  onClearHistory: () => void;
  onCredentialChange: (value: string) => void;
  onHoverPoint: (point: UsageState['hoveredPoint']) => void;
  onRangeChange: (value: UsageRange) => void;
  onRefresh: () => void;
  onAutoRefreshSecondsChange: (value: number) => void;
  state: UsageState;
}

interface DebugSectionProps {
  autoRefreshOptions: Array<{ label: string; value: number }>;
  onClear: () => void;
  onCopy: (value: string) => void;
  onAutoRefreshSecondsChange: (value: number) => void;
  onEnabledChange: (value: boolean) => void;
  onMaxEntriesChange: (value: number) => void;
  onRefresh: () => void;
  onSave: () => void;
  state: DebugState;
}

interface NotificationBarProps {
  notification: NotificationState | null;
}

const USAGE_RANGE_OPTIONS: Array<{ label: string; value: UsageRange }> = [
  { label: '1 小时', value: '1h' },
  { label: '3 小时', value: '3h' },
  { label: '6 小时', value: '6h' },
  { label: '12 小时', value: '12h' },
  { label: '24 小时', value: '24h' },
  { label: '3 天', value: '3d' },
  { label: '7 天', value: '7d' },
  { label: '今天', value: 'today' },
  { label: '昨天', value: 'yesterday' },
];

const CHART_COLORS = [
  '#1d4ed8',
  '#ea580c',
  '#059669',
  '#9333ea',
  '#dc2626',
  '#0891b2',
];

const USAGE_AUTO_REFRESH_OPTIONS = [
  { label: '关闭', value: 0 },
  { label: '5 秒', value: 5 },
  { label: '15 秒', value: 15 },
  { label: '30 秒', value: 30 },
  { label: '60 秒', value: 60 },
  { label: '300 秒', value: 300 },
] as const;

const getRingStyle = (percent: number) => {
  const normalizedPercent = Math.min(100, Math.max(0, percent));

  return {
    strokeDasharray: `${USAGE_RING_CIRCUMFERENCE}`,
    strokeDashoffset: `${
      USAGE_RING_CIRCUMFERENCE -
      (USAGE_RING_CIRCUMFERENCE * normalizedPercent) / 100
    }`,
  };
};

const getCredentialBadge = (
  credential: CredentialSummary,
  current: CurrentCredentialInfo | null,
) => {
  if (
    current?.status === 'round_robin' &&
    current.next_filename === credential.filename
  ) {
    return {
      className: 'px-3 py-1 text-xs font-medium bg-success/10 text-success',
      label: '下一次轮询',
    };
  }

  if (credential.is_expired) {
    return {
      className: 'px-3 py-1 text-xs font-medium bg-error/10 text-error',
      label: '已过期',
    };
  }

  return {
    className: 'px-3 py-1 text-xs font-medium bg-success/10 text-success',
    label: '有效',
  };
};

const getCredentialAvatarClassName = (credential: CredentialSummary) => {
  const base =
    'w-12 h-12 flex items-center justify-center text-xl text-white font-semibold shrink-0';

  if (credential.is_expired) {
    return `${base} bg-error`;
  }

  if (!credential.email && !credential.user_id) {
    return `${base} bg-secondary`;
  }

  return `${base} bg-success`;
};

const formatDateTime = (timestamp: number | null | undefined) => {
  if (!timestamp) {
    return 'Unknown';
  }

  return new Date(timestamp * 1000).toLocaleString('zh-CN');
};

const formatCurrentStatus = (current: CurrentCredentialInfo | null) => {
  if (!current) {
    return '暂无当前凭证信息';
  }

  if (current.status === 'no_credentials') {
    return '当前没有可用凭证';
  }

  if (current.status === 'access_keys_enabled') {
    return '已启用 API Key，业务请求会在各自绑定的凭证子集里轮询。';
  }

  return '当前未配置 API Key，请求会在全局可用凭证之间轮询。';
};

const formatNumber = (value: number) => {
  return new Intl.NumberFormat('zh-CN').format(value);
};

const renderUsageChart = ({
  chart,
  emptyLabel,
  hoveredPoint,
  metric,
  onHoverPoint,
  series,
  title,
}: {
  chart: 'calls' | 'tokens';
  emptyLabel: string;
  hoveredPoint: UsageState['hoveredPoint'];
  metric: 'callCount' | 'totalTokens';
  onHoverPoint: UsageSectionProps['onHoverPoint'];
  series: UsageState['callSeries'];
  title: string;
}) => {
  const width = 760;
  const height = 240;
  const padding = { bottom: 34, left: 46, right: 16, top: 20 };
  const firstSeries = series[0];
  const labels = firstSeries?.points.map((point) => point.label) ?? [];
  const pointCount = labels.length;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(
    1,
    ...series.flatMap((item) => item.points.map((point) => point[metric] ?? 0)),
  );

  const getX = (index: number) => {
    if (pointCount <= 1) {
      return padding.left + chartWidth / 2;
    }

    return padding.left + (chartWidth / (pointCount - 1)) * index;
  };

  const getY = (value: number) => {
    return padding.top + chartHeight - (value / maxValue) * chartHeight;
  };

  return (
    <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
          {title}
        </h3>
      </div>
      {series.length && pointCount ? (
        <div className="relative">
          <svg
            aria-label={title}
            className="w-full h-auto overflow-visible"
            viewBox={`0 0 ${width} ${height}`}
          >
            {Array.from({ length: 4 }, (_, index) => {
              const value = (maxValue / 4) * (index + 1);
              const y = getY(value);

              return (
                <g key={`grid-${value}`}>
                  <line
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y}
                    y2={y}
                    className="stroke-border-light dark:stroke-border-dark"
                    strokeDasharray="4 6"
                  />
                  <text
                    x={padding.left - 10}
                    y={y + 4}
                    className="fill-secondary text-[10px]"
                    textAnchor="end"
                  >
                    {formatNumber(Math.round(value))}
                  </text>
                </g>
              );
            })}
            {series.map((item, seriesIndex) => {
              const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
              const path = item.points
                .map((point, pointIndex) => {
                  const x = getX(pointIndex);
                  const y = getY(point[metric] ?? 0);
                  return `${pointIndex === 0 ? 'M' : 'L'} ${x} ${y}`;
                })
                .join(' ');

              return (
                <g key={item.model}>
                  <path d={path} fill="none" stroke={color} strokeWidth="3" />
                  {item.points.map((point, pointIndex) => {
                    const value = point[metric] ?? 0;
                    const x = getX(pointIndex);
                    const y = getY(value);

                    return (
                      <circle
                        key={`${item.model}-${point.start}`}
                        cx={x}
                        cy={y}
                        fill={color}
                        r="5"
                        tabIndex={0}
                        onBlur={() => {
                          onHoverPoint(null);
                        }}
                        onFocus={() => {
                          onHoverPoint({
                            chart,
                            label: point.label,
                            metricLabel:
                              metric === 'callCount' ? '调用次数' : '总 Tokens',
                            model: item.model,
                            value,
                            x,
                            y,
                          });
                        }}
                        onMouseEnter={() => {
                          onHoverPoint({
                            chart,
                            label: point.label,
                            metricLabel:
                              metric === 'callCount' ? '调用次数' : '总 Tokens',
                            model: item.model,
                            value,
                            x,
                            y,
                          });
                        }}
                        onMouseLeave={() => {
                          onHoverPoint(null);
                        }}
                      />
                    );
                  })}
                </g>
              );
            })}
            {labels.map((label, index) => (
              <text
                key={`${title}-${label}`}
                x={getX(index)}
                y={height - 10}
                className="fill-secondary text-[10px]"
                textAnchor="middle"
              >
                {label}
              </text>
            ))}
          </svg>
          {hoveredPoint?.chart === chart ? (
            <div
              className="pointer-events-none absolute z-10 min-w-44 -translate-x-1/2 -translate-y-full border border-primary/30 bg-card-light dark:bg-card-dark px-3 py-2 text-xs text-text-light dark:text-text-dark shadow-lg"
              // eslint-disable-next-line react/forbid-dom-props
              style={{
                left: `${(hoveredPoint.x / width) * 100}%`,
                top: `${(hoveredPoint.y / height) * 100}%`,
              }}
            >
              <div className="font-semibold">{hoveredPoint.model}</div>
              <div className="mt-1 text-secondary">{hoveredPoint.label}</div>
              <div className="mt-1">
                {hoveredPoint.metricLabel}:{' '}
                <span className="font-semibold">
                  {formatNumber(hoveredPoint.value)}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-center py-12 text-secondary">
          <i className="fas fa-chart-line"></i>
          <div className="mt-2">{emptyLabel}</div>
        </div>
      )}
      {series.length ? (
        <div className="flex flex-wrap gap-3 mt-4">
          {series.map((item, index) => (
            <div key={item.model} className="flex items-center gap-2 text-sm">
              <span
                className="w-3 h-3"
                // eslint-disable-next-line react/forbid-dom-props
                style={{
                  backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
                }}
              ></span>
              <span className="text-text-light dark:text-text-dark">
                {item.model}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const SettingsInput = ({
  label,
  settingKey,
  value,
  onChange,
}: {
  label: string;
  onChange: (value: string) => void;
  settingKey: string;
  value: string;
}) => {
  if (settingKey === 'CODEBUDDY_AUTH_MODE') {
    return (
      <div className="mb-4">
        <label
          className="block mb-2 font-medium text-text-light dark:text-text-dark whitespace-normal break-words"
          htmlFor={settingKey}
        >
          {label}
        </label>
        <select
          id={settingKey}
          className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="auto">auto</option>
          <option value="token">token</option>
        </select>
      </div>
    );
  }

  if (settingKey === 'CODEBUDDY_INTERNET_ENVIRONMENT') {
    return (
      <div className="mb-4">
        <label
          className="block mb-2 font-medium text-text-light dark:text-text-dark whitespace-normal break-words"
          htmlFor={settingKey}
        >
          {label}
        </label>
        <select
          id={settingKey}
          className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="ioa">ioa</option>
          <option value="internal">internal</option>
          <option value="public">public</option>
        </select>
      </div>
    );
  }

  if (settingKey === 'CODEBUDDY_LOG_LEVEL') {
    return (
      <div className="mb-4">
        <label
          className="block mb-2 font-medium text-text-light dark:text-text-dark whitespace-normal break-words"
          htmlFor={settingKey}
        >
          {label}
        </label>
        <select
          id={settingKey}
          className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
        </select>
      </div>
    );
  }

  if (settingKey === 'CODEBUDDY_MODELS') {
    return (
      <div className="mb-4">
        <label
          className="block mb-2 font-medium text-text-light dark:text-text-dark whitespace-normal break-words"
          htmlFor={settingKey}
        >
          {label}
        </label>
        <textarea
          id={settingKey}
          className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10 resize-y min-h-[120px] whitespace-pre-wrap break-words"
          rows={6}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        ></textarea>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <label
        className="block mb-2 font-medium text-text-light dark:text-text-dark whitespace-normal break-words"
        htmlFor={settingKey}
      >
        {label}
      </label>
      <input
        id={settingKey}
        className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
        type="text"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
};

const CredentialCard = ({
  credential,
  current,
  form,
  onCredentialFirstMessageRoleToSystemChange,
  onCredentialResponsesPassthroughChange,
  onDelete,
  onEdit,
  onResetCredentialForm,
  onSaveCredential,
}: {
  credential: CredentialSummary;
  current: CurrentCredentialInfo | null;
  form: CredentialsState['form'];
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onDelete: () => void;
  onEdit: () => void;
  onResetCredentialForm: () => void;
  onSaveCredential: () => void;
}) => {
  const badge = getCredentialBadge(credential, current);
  const avatarText = (credential.name ?? credential.email ?? credential.user_id)
    .slice(0, 1)
    .toUpperCase();
  const isEditing = form.editingIndex === credential.index;

  return (
    <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-5 transition-all relative hover:-translate-y-px hover:shadow-md hover:border-primary">
      <div className="flex items-center gap-4">
        <div className={getCredentialAvatarClassName(credential)}>
          {avatarText || 'C'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-semibold text-text-light dark:text-text-dark">
              {credential.filename}
            </div>
            <span className={badge.className}>{badge.label}</span>
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-secondary">
            <span className="flex items-center gap-1">
              <i className="fas fa-user"></i>
              {credential.email || credential.user_id}
            </span>
            <span className="flex items-center gap-1">
              <i className="fas fa-globe"></i>
              {credential.domain}
            </span>
            <span className="flex items-center gap-1">
              <i className="fas fa-clock"></i>
              {credential.time_remaining_str}
            </span>
            <span className="flex items-center gap-1">
              <i className="fas fa-calendar"></i>
              {formatDateTime(credential.created_at)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="px-2 py-1 text-xs bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark">
              {credential.responses_passthrough
                ? 'Responses 请求直接转发至上游'
                : 'Responses 请求先转换为 Chat Completions 再发送至上游'}
            </span>
            <span className="px-2 py-1 text-xs bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark">
              {credential.first_message_role_to_system
                ? '转换为 Chat Completions 时按消息位置处理 developer 角色'
                : '转换为 Chat Completions 时保留 developer 角色'}
            </span>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
            onClick={onEdit}
          >
            <i className="fas fa-pen"></i>
            编辑
          </button>
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-error text-white hover:bg-error"
            onClick={onDelete}
          >
            <i className="fas fa-trash"></i>
            删除
          </button>
        </div>
      </div>
      {isEditing ? (
        <div className="mt-4 border-t border-border-light dark:border-border-dark pt-4">
          <div className="mb-3 font-medium text-text-light dark:text-text-dark">
            编辑凭证配置
          </div>
          <div className="mb-4 grid gap-3">
            <label className="flex items-start gap-3 p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark cursor-pointer">
              <input
                checked={form.responsesPassthrough}
                type="checkbox"
                onChange={(event) => {
                  onCredentialResponsesPassthroughChange(event.target.checked);
                }}
              />
              <div>
                <div className="font-medium text-text-light dark:text-text-dark">
                  直接转发 Responses 请求至上游
                </div>
                <div className="text-sm text-secondary">
                  开启后，该凭证命中的 `/v1/responses`
                  请求将直接发送至上游，不再转换为 Chat Completions。
                </div>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark cursor-pointer">
              <input
                checked={form.firstMessageRoleToSystem}
                type="checkbox"
                onChange={(event) => {
                  onCredentialFirstMessageRoleToSystemChange(
                    event.target.checked,
                  );
                }}
              />
              <div>
                <div className="font-medium text-text-light dark:text-text-dark">
                  将首条 developer 消息转换为 system
                </div>
                <div className="text-sm text-secondary">
                  仅在该凭证通过 Chat Completions 代理链路转发时生效。
                </div>
              </div>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-success text-white hover:bg-success"
              onClick={onSaveCredential}
            >
              <i className="fas fa-save"></i>
              保存凭证
            </button>
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary"
              onClick={onResetCredentialForm}
            >
              <i className="fas fa-times"></i>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const CredentialGroup = ({
  current,
  form,
  items,
  title,
  onDelete,
  onEdit,
  onCredentialFirstMessageRoleToSystemChange,
  onCredentialResponsesPassthroughChange,
  onResetCredentialForm,
  onSaveCredential,
}: {
  current: CurrentCredentialInfo | null;
  form: CredentialsState['form'];
  items: CredentialSummary[];
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onDelete: (index: number) => void;
  onEdit: (credential: CredentialSummary) => void;
  onResetCredentialForm: () => void;
  onSaveCredential: () => void;
  title: string;
}) => {
  if (!items.length) {
    return null;
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between px-4 py-3 bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark mb-0">
        <div className="font-semibold text-text-light dark:text-text-dark flex items-center gap-2">
          <i className="fas fa-layer-group"></i>
          {title}
        </div>
        <span className="bg-primary text-white text-xs px-2 py-1 font-medium">
          {items.length}
        </span>
      </div>
      <div className="border border-border-light dark:border-border-dark border-t-0 bg-card-light dark:bg-card-dark p-3">
        <div className="grid gap-3">
          {items.map((credential) => (
            <CredentialCard
              key={credential.filename}
              credential={credential}
              current={current}
              form={form}
              onCredentialFirstMessageRoleToSystemChange={
                onCredentialFirstMessageRoleToSystemChange
              }
              onCredentialResponsesPassthroughChange={
                onCredentialResponsesPassthroughChange
              }
              onDelete={() => {
                onDelete(credential.index);
              }}
              onEdit={() => {
                onEdit(credential);
              }}
              onResetCredentialForm={onResetCredentialForm}
              onSaveCredential={onSaveCredential}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const AccessKeyCard = ({
  accessKey,
  actionId,
  form,
  revealedSecret,
  validCredentials,
  onDelete,
  onEdit,
  onResetAccessKeyForm,
  onRevealSecret,
  onSaveAccessKey,
  onToggleCredentialSelection,
  onUpdateAccessKeyName,
}: {
  accessKey: AccessKeySummary;
  actionId: string | null;
  form: CredentialsState['accessKeyForm'];
  revealedSecret: CredentialsState['revealedSecret'];
  validCredentials: CredentialSummary[];
  onDelete: () => void;
  onEdit: () => void;
  onResetAccessKeyForm: () => void;
  onRevealSecret: () => void;
  onSaveAccessKey: () => void;
  onToggleCredentialSelection: (filename: string) => void;
  onUpdateAccessKeyName: (value: string) => void;
}) => {
  const isEditing = form.editingId === accessKey.id;
  const isRevealed = revealedSecret?.id === accessKey.id;
  const isBusy = actionId === accessKey.id;

  return (
    <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-5 transition-all relative hover:-translate-y-px hover:shadow-md hover:border-primary">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-semibold text-text-light dark:text-text-dark">
              {accessKey.name}
            </div>
            <span className="px-3 py-1 text-xs font-medium bg-primary/10 text-primary">
              {accessKey.credentialFilenames.length} 个凭证
            </span>
          </div>
          <div className="font-mono text-sm text-secondary break-all">
            {accessKey.maskedSecret}
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-secondary mt-3">
            <span className="flex items-center gap-1">
              <i className="fas fa-calendar"></i>
              创建于 {new Date(accessKey.createdAt).toLocaleString('zh-CN')}
            </span>
            <span className="flex items-center gap-1">
              <i className="fas fa-pen"></i>
              更新于 {new Date(accessKey.updatedAt).toLocaleString('zh-CN')}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {accessKey.credentialFilenames.map((filename) => (
              <span
                key={filename}
                className="px-2 py-1 text-xs bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark font-mono"
              >
                {filename}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="inline-flex items-center gap-2 px-4 py-2 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary"
            disabled={isBusy}
            onClick={onRevealSecret}
          >
            <i className="fas fa-eye"></i>
            查看 Key
          </button>
          <button
            className="inline-flex items-center gap-2 px-4 py-2 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
            onClick={onEdit}
          >
            <i className="fas fa-pen"></i>
            编辑
          </button>
          <button
            className="inline-flex items-center gap-2 px-4 py-2 border-none font-medium cursor-pointer transition-all text-sm bg-error text-white hover:bg-error"
            disabled={isBusy}
            onClick={onDelete}
          >
            <i className="fas fa-trash"></i>
            删除
          </button>
        </div>
      </div>
      {isRevealed ? (
        <div className="mt-4 border-t border-border-light dark:border-border-dark pt-4">
          <div className="mb-2 font-medium text-text-light dark:text-text-dark">
            当前 API Key
          </div>
          <div className="p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark font-mono text-sm break-all">
            {revealedSecret?.secret.replace(/^Bearer\s+/i, '')}
          </div>
        </div>
      ) : null}
      {isEditing ? (
        <div className="mt-4 border-t border-border-light dark:border-border-dark pt-4">
          <div className="font-medium text-text-light dark:text-text-dark">
            编辑 API Key
          </div>
          <div className="text-sm text-secondary mt-2">
            secret 由服务端自动生成；这里只修改名称和绑定凭证。
          </div>
          <div className="mt-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor={`accessKeyName-${accessKey.id}`}
            >
              API Key 名称
            </label>
            <input
              id={`accessKeyName-${accessKey.id}`}
              className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
              placeholder="例如：Claude Team / CI Runner"
              type="text"
              value={form.name}
              onChange={(event) => {
                onUpdateAccessKeyName(event.target.value);
              }}
            />
          </div>
          <div className="mt-4">
            <div className="block mb-2 font-medium text-text-light dark:text-text-dark">
              绑定凭证
            </div>
            <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
              {validCredentials.length ? (
                validCredentials.map((credential) => {
                  const selected = form.credentialFilenames.includes(
                    credential.filename,
                  );

                  return (
                    <label
                      key={credential.filename}
                      className="flex items-center justify-between gap-4 p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-text-light dark:text-text-dark">
                          {credential.filename}
                        </div>
                        <div className="text-sm text-secondary">
                          {credential.email || credential.user_id}
                        </div>
                      </div>
                      <input
                        checked={selected}
                        type="checkbox"
                        onChange={() => {
                          onToggleCredentialSelection(credential.filename);
                        }}
                      />
                    </label>
                  );
                })
              ) : (
                <div className="text-sm text-secondary">
                  还没有可绑定的有效凭证。
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-success text-white hover:bg-success"
              disabled={isBusy}
              onClick={onSaveAccessKey}
            >
              <i className="fas fa-save"></i>
              保存 API Key
            </button>
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary"
              onClick={onResetAccessKeyForm}
            >
              <i className="fas fa-times"></i>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const TabNav = ({ activeTab, onChange }: TabNavProps) => {
  return (
    <div className="flex gap-2 mb-8 border-b-2 border-border-light dark:border-border-dark">
      {TAB_ITEMS.map((tab) => (
        <button
          key={tab.key}
          className={
            tab.key === activeTab
              ? 'inline-flex items-center gap-2 px-6 py-3 bg-none border-none text-primary cursor-pointer border-b-2 border-primary transition-all font-medium hover:text-primary'
              : 'inline-flex items-center gap-2 px-6 py-3 bg-none border-none text-secondary cursor-pointer border-b-2 border-transparent transition-all font-medium hover:text-primary'
          }
          onClick={() => {
            onChange(tab.key);
          }}
        >
          <i className={tab.icon}></i>
          {tab.label}
        </button>
      ))}
    </div>
  );
};

export const DashboardSection = ({
  onCopyEndpoint,
  onRefresh,
  state,
}: DashboardSectionProps) => {
  return (
    <div id="dashboard" className="block">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-6 mb-8">
        <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 transition-all relative overflow-hidden hover:-translate-y-1 hover:shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 flex items-center justify-center text-xl text-white bg-primary">
              <i className="fas fa-key"></i>
            </div>
            <div className="relative w-15 h-15" id="credentialUsageRing">
              <svg width="60" height="60">
                <circle
                  cx="30"
                  cy="30"
                  r="26"
                  className="fill-none stroke-border-light dark:stroke-border-dark stroke-4"
                />
                <circle
                  cx="30"
                  cy="30"
                  r="26"
                  className="fill-none stroke-primary stroke-4 transition-all"
                  id="credentialRingProgress"
                  // eslint-disable-next-line react/forbid-dom-props
                  style={getRingStyle(state.credentialUsagePercent)}
                />
              </svg>
              <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xs font-semibold text-text-light dark:text-text-dark"
                id="credentialUsagePercent"
              >
                {Math.round(state.credentialUsagePercent)}%
              </div>
            </div>
          </div>
          <div
            className="text-2xl font-bold mb-1 text-text-light dark:text-text-dark leading-none"
            id="totalCredentials"
          >
            {state.totalCredentials}
          </div>
          <div className="text-sm text-secondary font-medium">总凭证数量</div>
          <div
            className="text-xs mt-2 flex items-center gap-1"
            id="credentialTrend"
          >
            <i className="fas fa-check"></i>
            <span id="validCredentials">{state.validCredentials}</span>
            个有效
          </div>
        </div>
        <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 transition-all relative overflow-hidden hover:-translate-y-1 hover:shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <div
              className="w-12 h-12 flex items-center justify-center text-xl text-white bg-success"
              id="serviceStatusIcon"
            >
              <i className="fas fa-server"></i>
            </div>
            <div className="inline-flex items-center gap-2" id="serviceStatus">
              <span
                className={`w-2 h-2 rounded-full animate-pulse ${
                  state.serviceStatus === 'online'
                    ? 'bg-success'
                    : state.serviceStatus === 'offline'
                      ? 'bg-error'
                      : 'bg-warning'
                }`}
                id="statusDot"
              ></span>
            </div>
          </div>
          <div
            className="text-2xl font-bold mb-1 text-text-light dark:text-text-dark leading-none"
            id="statusText"
          >
            {state.statusText}
          </div>
          <div className="text-sm text-secondary font-medium">服务运行状态</div>
          <div
            className="text-xs mt-2 flex items-center gap-1"
            id="uptimeTrend"
          >
            <i className="fas fa-clock"></i>
            <span id="uptime">{state.uptimeText}</span>
          </div>
        </div>
        <button
          className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 transition-all relative overflow-hidden hover:-translate-y-1 hover:shadow-lg cursor-pointer text-left"
          onClick={onCopyEndpoint}
          title="点击复制API端点"
          type="button"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 flex items-center justify-center text-xl text-white bg-warning">
              <i className="fas fa-link"></i>
            </div>
            <div className="opacity-60">
              <i className="fas fa-copy"></i>
            </div>
          </div>
          <div
            className="text-2xl font-bold mb-1 text-text-light dark:text-text-dark leading-none text-lg break-all"
            id="apiEndpoint"
          >
            {state.apiEndpoint || '-'}
          </div>
          <div className="text-sm text-secondary font-medium">API 服务端点</div>
          <div className="text-xs mt-2 flex items-center gap-1">
            <i className="fas fa-info-circle"></i>
            点击复制链接
          </div>
        </button>
        <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 transition-all relative overflow-hidden hover:-translate-y-1 hover:shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 flex items-center justify-center text-xl text-white bg-primary">
              <i className="fas fa-chart-line"></i>
            </div>
            <div className="relative w-15 h-15" id="totalUsageRing">
              <svg width="60" height="60">
                <circle
                  cx="30"
                  cy="30"
                  r="26"
                  className="fill-none stroke-border-light dark:stroke-border-dark stroke-4"
                />
                <circle
                  cx="30"
                  cy="30"
                  r="26"
                  className="fill-none stroke-primary stroke-4 transition-all"
                  id="usageRingProgress"
                  // eslint-disable-next-line react/forbid-dom-props
                  style={getRingStyle(state.totalApiCalls > 0 ? 100 : 0)}
                />
              </svg>
              <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xs font-semibold text-text-light dark:text-text-dark"
                id="totalUsagePercent"
              >
                {state.totalApiCalls}
              </div>
            </div>
          </div>
          <div
            className="text-2xl font-bold mb-1 text-text-light dark:text-text-dark leading-none"
            id="totalApiCalls"
          >
            {state.totalApiCalls}
          </div>
          <div className="text-sm text-secondary font-medium">
            总 API 调用次数
          </div>
          <div
            className="text-xs mt-2 flex items-center gap-1"
            id="apiCallsTrend"
          >
            <i className="fas fa-sync-alt"></i>
            {state.lastCheckedAt || '等待刷新'}
          </div>
        </div>
      </div>
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            <i className="fas fa-chart-bar"></i>
            模型使用统计
          </h3>
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
            onClick={onRefresh}
          >
            <i className="fas fa-sync-alt"></i>
            刷新
          </button>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark">
                  模型名称
                </th>
                <th className="p-3 px-4 text-left font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark text-right">
                  使用次数
                </th>
              </tr>
            </thead>
            <tbody id="modelUsageTableBody">
              {state.modelUsage.length ? (
                state.modelUsage.map(([model, count]) => (
                  <tr key={model}>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark">
                      {model}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {count}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={2}
                    className="p-3 px-4 border-b border-border-light dark:border-border-dark text-center"
                  >
                    暂无模型使用记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            <i className="fas fa-key"></i>
            凭证使用统计
          </h3>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark">
                  凭证文件
                </th>
                <th className="p-3 px-4 text-left font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark text-right">
                  使用次数
                </th>
              </tr>
            </thead>
            <tbody id="credentialUsageTableBody">
              {state.credentialUsage.length ? (
                state.credentialUsage.map(([filename, count]) => (
                  <tr key={filename}>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark">
                      {filename}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {count}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={2}
                    className="p-3 px-4 border-b border-border-light dark:border-border-dark text-center"
                  >
                    暂无凭证使用记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export const UsageSection = ({
  onAccessKeyChange,
  onClearHistory,
  onCredentialChange,
  onHoverPoint,
  onRangeChange,
  onRefresh,
  onAutoRefreshSecondsChange,
  state,
}: UsageSectionProps) => {
  return (
    <div id="usage" className="block">
      {state.autoRefreshVisible ? (
        <div className="mb-6 p-4 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm text-text-light dark:text-text-dark">
            <label className="inline-flex items-center gap-2 text-secondary">
              自动刷新
              <select
                aria-label="用量统计自动刷新间隔"
                className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark text-text-light dark:text-text-dark px-3 py-2 cursor-pointer transition-all hover:border-primary focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
                value={state.autoRefreshSeconds}
                onChange={(event) => {
                  onAutoRefreshSecondsChange(Number(event.target.value));
                }}
              >
                {USAGE_AUTO_REFRESH_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ) : null}

      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 flex-1">
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                时间范围
              </div>
              <select
                aria-label="用量统计时间范围"
                className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
                value={state.request.range}
                onChange={(event) => {
                  onRangeChange(event.target.value as UsageRange);
                }}
              >
                {USAGE_RANGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                凭证
              </div>
              <select
                aria-label="用量统计凭证筛选"
                className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
                value={state.request.credential}
                onChange={(event) => {
                  onCredentialChange(event.target.value);
                }}
              >
                {state.filters.credentials.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                API Key
              </div>
              <select
                aria-label="用量统计 API Key 筛选"
                className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
                value={state.request.accessKey}
                onChange={(event) => {
                  onAccessKeyChange(event.target.value);
                }}
              >
                {state.filters.accessKeys.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
              onClick={onRefresh}
              type="button"
            >
              <i
                className={
                  state.loading ? 'fas fa-spinner fa-spin' : 'fas fa-sync-alt'
                }
              ></i>
              刷新
            </button>
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-error text-white hover:bg-error"
              onClick={onClearHistory}
              type="button"
            >
              <i className="fas fa-trash-alt"></i>
              清空历史
            </button>
          </div>
        </div>
        <div className="mt-4 text-sm text-secondary">
          {state.lastUpdatedAt
            ? `最后更新于 ${state.lastUpdatedAt}`
            : '等待首次加载用量统计数据'}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-6 mb-6">
        <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 shadow-sm">
          <div className="text-sm text-secondary mb-2">今日调用次数</div>
          <div className="text-3xl font-bold text-text-light dark:text-text-dark">
            {formatNumber(state.todaySummary.callCount)}
          </div>
        </div>
        <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 shadow-sm">
          <div className="text-sm text-secondary mb-2">今日总 Tokens</div>
          <div className="text-3xl font-bold text-text-light dark:text-text-dark">
            {formatNumber(state.todaySummary.totalTokens)}
          </div>
        </div>
        <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 shadow-sm">
          <div className="text-sm text-secondary mb-2">
            今日 Cache 命中 Tokens
          </div>
          <div className="text-3xl font-bold text-text-light dark:text-text-dark">
            {formatNumber(state.todaySummary.cacheHitTokens)}
          </div>
        </div>
      </div>

      <div className="grid gap-6 mb-6">
        {renderUsageChart({
          chart: 'calls',
          emptyLabel: '当前筛选条件下暂无调用趋势数据',
          hoveredPoint: state.hoveredPoint,
          metric: 'callCount',
          onHoverPoint,
          series: state.callSeries,
          title: '调用次数趋势',
        })}
        {renderUsageChart({
          chart: 'tokens',
          emptyLabel: '当前筛选条件下暂无 Token 趋势数据',
          hoveredPoint: state.hoveredPoint,
          metric: 'totalTokens',
          onHoverPoint,
          series: state.tokenSeries,
          title: 'Token 消耗趋势',
        })}
      </div>

      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 shadow-sm">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            <i className="fas fa-table"></i>
            模型汇总
          </h3>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark">
                  模型
                </th>
                <th className="p-3 px-4 text-right font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark">
                  调用次数
                </th>
                <th className="p-3 px-4 text-right font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark">
                  总 Tokens
                </th>
                <th className="p-3 px-4 text-right font-semibold bg-bg-light dark:bg-bg-dark border-b border-border-light dark:border-border-dark">
                  Cache 命中
                </th>
              </tr>
            </thead>
            <tbody>
              {state.tableRows.length ? (
                state.tableRows.map((row) => (
                  <tr key={row.model}>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark">
                      {row.model}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(row.callCount)}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(row.totalTokens)}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(row.cacheHitTokens)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={4}
                    className="p-3 px-4 border-b border-border-light dark:border-border-dark text-center"
                  >
                    暂无模型汇总数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export const CredentialsSection = ({
  auth,
  credentials,
  onAddCredential,
  onAuthAction,
  onCallbackUrlChange,
  onCopyAuthUrl,
  onCredentialFirstMessageRoleToSystemChange,
  onCredentialResponsesPassthroughChange,
  onCredentialTokenChange,
  onCredentialUserIdChange,
  onDeleteCredential,
  onDeleteAccessKey,
  onEditCredential,
  onEditAccessKey,
  onOpenAuthUrl,
  onPollAuth,
  onRefreshCredentials,
  onResetCredentialForm,
  onResetAccessKeyForm,
  onRevealAccessKeySecret,
  onSaveAccessKey,
  onSubmitCallbackUrl,
  onToggleCallbackMode,
  onToggleCredentialSelection,
  onUpdateAccessKeyName,
}: CredentialsSectionProps) => {
  const validCredentials = credentials.items.filter((item) => !item.is_expired);
  const expiredCredentials = credentials.items.filter(
    (item) => item.is_expired,
  );

  return (
    <div id="credentials" className="block">
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all border-l-4 border-primary pl-4">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            <i className="fas fa-magic"></i>
            自动获取认证
          </h3>
        </div>
        <p className="text-secondary mb-4">
          点击下方按钮自动启动CodeBuddy
          OAuth2认证流程，系统将自动获取并保存您的认证凭证。
        </p>
        <button
          className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
          id="getAuthBtn"
          disabled={auth.starting}
          onClick={onAuthAction}
        >
          <i
            className={auth.starting ? 'fas fa-spinner fa-spin' : 'fas fa-play'}
          ></i>
          开始认证
        </button>
        <div
          id="authUrlSection"
          className={
            auth.authUrl
              ? 'mt-4 p-4 bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark'
              : 'mt-4 p-4 bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark hidden'
          }
        >
          <h4 className="text-primary mb-4">认证链接已生成</h4>
          <p className="text-secondary mb-4">
            请点击下面的链接完成CodeBuddy账号登录：
          </p>
          <input
            id="authUrlInput"
            className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark font-mono text-sm mb-4 text-text-light dark:text-text-dark"
            readOnly
            type="text"
            value={auth.authUrl}
          />
          <div className="flex gap-2 flex-wrap">
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-success text-white hover:bg-success"
              onClick={onOpenAuthUrl}
            >
              <i className="fas fa-external-link-alt"></i>
              打开链接
            </button>
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary"
              onClick={onCopyAuthUrl}
            >
              <i className="fas fa-copy"></i>
              复制链接
            </button>
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-warning text-white hover:bg-warning"
              onClick={() => {
                onToggleCallbackMode(true);
              }}
            >
              <i className="fas fa-hand-pointer"></i>
              手动回调
            </button>
          </div>
          <div
            id="autoCallbackSection"
            className="mt-4 p-4 bg-primary/8 border border-primary"
          >
            <div className="text-center p-4">
              <i className="fas fa-clock"></i>
              <div>{auth.message || '等待认证完成...'}</div>
              <small className="text-secondary">
                完成登录后系统将自动获取凭证
              </small>
            </div>
            <div className="mt-4 text-center">
              <button
                className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary"
                onClick={onPollAuth}
              >
                <i
                  className={
                    auth.polling ? 'fas fa-spinner fa-spin' : 'fas fa-sync-alt'
                  }
                ></i>
                检查认证状态
              </button>
            </div>
          </div>
          <div
            id="manualCallbackSection"
            className={
              auth.showManualCallback
                ? 'mt-4 p-4 bg-primary/8 border border-primary'
                : 'mt-4 p-4 bg-primary/8 border border-primary hidden'
            }
          >
            <h5 className="mb-4">手动输入回调链接</h5>
            <p className="text-secondary text-sm mb-4">
              如果自动检测失败，请在完成登录后，将浏览器地址栏中的完整URL粘贴到下面：
            </p>
            <input
              id="callbackUrl"
              className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
              placeholder="粘贴回调URL..."
              type="text"
              value={auth.callbackUrl}
              onChange={(event) => {
                onCallbackUrlChange(event.target.value);
              }}
            />
            <div className="mt-4 text-right">
              <button
                className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary mr-2"
                onClick={() => {
                  onToggleCallbackMode(false);
                }}
              >
                返回自动模式
              </button>
              <button
                className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-success text-white hover:bg-success"
                onClick={onSubmitCallbackUrl}
              >
                提交
              </button>
            </div>
          </div>
        </div>
      </div>
      {credentials.form.editingIndex === null ? (
        <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
          <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
            <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
              <i className="fas fa-edit"></i>
              手动添加凭证
            </h3>
          </div>
          <div className="mb-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="bearerToken"
            >
              Bearer Token
              <span className="text-error">*</span>
            </label>
            <textarea
              id="bearerToken"
              className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10 resize-y min-h-[100px]"
              placeholder="输入您的 CodeBuddy Bearer Token..."
              rows={3}
              value={credentials.form.bearerToken}
              onChange={(event) => {
                onCredentialTokenChange(event.target.value);
              }}
            ></textarea>
          </div>
          <div className="mb-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="userId"
            >
              用户ID (可选)
            </label>
            <input
              id="userId"
              className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
              placeholder="输入用户ID (可选)"
              type="text"
              value={credentials.form.userId}
              onChange={(event) => {
                onCredentialUserIdChange(event.target.value);
              }}
            />
          </div>
          <div className="mb-4 grid gap-3">
            <label className="flex items-start gap-3 p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark cursor-pointer">
              <input
                checked={credentials.form.responsesPassthrough}
                type="checkbox"
                onChange={(event) => {
                  onCredentialResponsesPassthroughChange(event.target.checked);
                }}
              />
              <div>
                <div className="font-medium text-text-light dark:text-text-dark">
                  直接转发 Responses 请求至上游
                </div>
                <div className="text-sm text-secondary">
                  开启后，该凭证命中的 `/v1/responses`
                  请求将直接发送至上游，不再转换为 Chat Completions。
                </div>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark cursor-pointer">
              <input
                checked={credentials.form.firstMessageRoleToSystem}
                type="checkbox"
                onChange={(event) => {
                  onCredentialFirstMessageRoleToSystemChange(
                    event.target.checked,
                  );
                }}
              />
              <div>
                <div className="font-medium text-text-light dark:text-text-dark">
                  将首条 developer 消息转换为 system
                </div>
                <div className="text-sm text-secondary">
                  仅在该凭证通过 Chat Completions 代理链路转发时生效。
                </div>
              </div>
            </label>
          </div>
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-success text-white hover:bg-success"
            onClick={onAddCredential}
          >
            <i className="fas fa-plus"></i>
            添加凭证
          </button>
        </div>
      ) : null}
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            API Key
          </h3>
          <div>
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
              onClick={onRefreshCredentials}
            >
              <i className="fas fa-sync-alt"></i>
              刷新列表
            </button>
          </div>
        </div>
        <div id="accessKeysList">
          {credentials.accessKeysLoading ? (
            <div className="text-center py-8 text-secondary">
              <i className="fas fa-spinner fa-spin"></i>
              <div>加载中...</div>
            </div>
          ) : credentials.accessKeys.length ? (
            <div className="grid gap-3">
              {credentials.accessKeys.map((accessKey) => (
                <AccessKeyCard
                  key={accessKey.id}
                  accessKey={accessKey}
                  actionId={credentials.accessKeyActionId}
                  form={credentials.accessKeyForm}
                  revealedSecret={credentials.revealedSecret}
                  validCredentials={validCredentials}
                  onDelete={() => {
                    onDeleteAccessKey(accessKey.id);
                  }}
                  onEdit={() => {
                    onEditAccessKey(accessKey);
                  }}
                  onRevealSecret={() => {
                    onRevealAccessKeySecret(accessKey.id);
                  }}
                  onResetAccessKeyForm={onResetAccessKeyForm}
                  onSaveAccessKey={onSaveAccessKey}
                  onToggleCredentialSelection={onToggleCredentialSelection}
                  onUpdateAccessKeyName={onUpdateAccessKeyName}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-secondary">
              <i className="fas fa-key"></i>
              <div>还没有 API Key，创建后即可按 key 绑定凭证。</div>
            </div>
          )}
        </div>
      </div>
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            已保存的凭证
          </h3>
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
            onClick={onRefreshCredentials}
          >
            <i className="fas fa-sync-alt"></i>
            刷新列表
          </button>
        </div>
        <div
          id="currentCredentialStatus"
          className="mb-4 pb-4 border-b border-border-light dark:border-border-dark"
        >
          {credentials.currentLoading ? (
            <div className="text-center py-8 text-secondary">
              <i className="fas fa-spinner fa-spin"></i>
              <div>加载当前状态...</div>
            </div>
          ) : (
            <div>
              <div className="font-semibold text-text-light dark:text-text-dark">
                {formatCurrentStatus(credentials.current)}
              </div>
              {credentials.current?.status !== 'no_credentials' ? (
                <div className="flex flex-wrap gap-4 text-sm text-secondary mt-2">
                  {credentials.current?.next_filename ? (
                    <span className="flex items-center gap-1">
                      <i className="fas fa-file"></i>
                      下一凭证 {credentials.current.next_filename}
                    </span>
                  ) : null}
                  {credentials.current?.available_credential_count !==
                  undefined ? (
                    <span className="flex items-center gap-1">
                      <i className="fas fa-layer-group"></i>
                      可用凭证 {credentials.current.available_credential_count}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
        <div id="credentialsList">
          {credentials.loading ? (
            <div className="text-center py-8 text-secondary">
              <i className="fas fa-spinner fa-spin"></i>
              <div>加载中...</div>
            </div>
          ) : credentials.items.length ? (
            <>
              <CredentialGroup
                current={credentials.current}
                form={credentials.form}
                items={validCredentials}
                onCredentialFirstMessageRoleToSystemChange={
                  onCredentialFirstMessageRoleToSystemChange
                }
                onCredentialResponsesPassthroughChange={
                  onCredentialResponsesPassthroughChange
                }
                onDelete={onDeleteCredential}
                onEdit={onEditCredential}
                onResetCredentialForm={onResetCredentialForm}
                onSaveCredential={onAddCredential}
                title="可用凭证"
              />
              <CredentialGroup
                current={credentials.current}
                form={credentials.form}
                items={expiredCredentials}
                onCredentialFirstMessageRoleToSystemChange={
                  onCredentialFirstMessageRoleToSystemChange
                }
                onCredentialResponsesPassthroughChange={
                  onCredentialResponsesPassthroughChange
                }
                onDelete={onDeleteCredential}
                onEdit={onEditCredential}
                onResetCredentialForm={onResetCredentialForm}
                onSaveCredential={onAddCredential}
                title="已过期凭证"
              />
            </>
          ) : (
            <div className="text-center py-8 text-secondary">
              <i className="fas fa-folder-open"></i>
              <div>暂无凭证，请先认证或手动添加。</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const ApiTestSection = ({
  credentialOptions,
  onCredentialChange,
  models,
  onMessageChange,
  onModelChange,
  onStreamChange,
  onSubmit,
  state,
}: ApiTestSectionProps) => {
  const availableModels = models.length ? models : [...DEFAULT_TEST_MODELS];

  return (
    <div id="api-test" className="block">
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all border-l-4 border-primary pl-4">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            聊天完成测试
          </h3>
        </div>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testCredential"
          >
            凭证
          </label>
          <select
            id="testCredential"
            className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
            value={state.credentialFilename}
            onChange={(event) => {
              onCredentialChange(event.target.value);
            }}
          >
            <option value="">跟随当前轮询</option>
            {credentialOptions.map((credential) => (
              <option key={credential.filename} value={credential.filename}>
                {credential.filename} · {credential.email || credential.user_id}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testModel"
          >
            模型
          </label>
          <select
            id="testModel"
            className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
            value={state.model}
            onChange={(event) => {
              onModelChange(event.target.value);
            }}
          >
            {availableModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testMessage"
          >
            测试消息
          </label>
          <textarea
            id="testMessage"
            className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10 resize-y min-h-[100px]"
            placeholder="输入测试消息..."
            rows={3}
            value={state.message}
            onChange={(event) => {
              onMessageChange(event.target.value);
            }}
          ></textarea>
        </div>
        <div className="mb-4">
          <label className="block mb-2 font-medium text-text-light dark:text-text-dark">
            <input
              id="testStream"
              className="mr-2"
              type="checkbox"
              checked={state.stream}
              onChange={(event) => {
                onStreamChange(event.target.checked);
              }}
            />
            流式响应
          </label>
        </div>
        <button
          className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
          disabled={state.submitting}
          onClick={onSubmit}
        >
          <i
            className={
              state.submitting ? 'fas fa-spinner fa-spin' : 'fas fa-paper-plane'
            }
          ></i>
          发送测试
        </button>
        <div className="mb-4 mt-6">
          <label className="block mb-2 font-medium text-text-light dark:text-text-dark">
            响应结果
          </label>
          <div
            id="testResult"
            className="bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark p-4 font-mono text-sm text-text-light dark:text-text-dark overflow-x-auto my-4 min-h-[200px]"
          >
            <pre className="m-0 whitespace-pre-wrap">{state.result}</pre>
          </div>
        </div>
      </div>
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            API 使用示例
          </h3>
        </div>
        <h4 className="text-primary mb-4">curl 示例:</h4>
        <div className="bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark p-4 font-mono text-sm text-text-light dark:text-text-dark overflow-x-auto my-4">{`curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \\
-H "Authorization: Bearer YOUR_API_KEY" \\
-H "Content-Type: application/json" \\
-d '{
  "model": "glm-5.1",
  "messages": [{ "role": "user", "content": "Hello!" }]
}'`}</div>
        <h4 className="text-primary mt-6 mb-4">Python 示例:</h4>
        <div className="bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark p-4 font-mono text-sm text-text-light dark:text-text-dark overflow-x-auto my-4">{`import openai

client = openai.OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://127.0.0.1:8001/v1",
)
response = client.chat.completions.create(
    model="glm-5.1",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`}</div>
      </div>
    </div>
  );
};

export const SettingsSection = ({
  onChange,
  onSave,
  state,
}: SettingsSectionProps) => {
  return (
    <div id="settings" className="block">
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            服务配置
          </h3>
        </div>
        <div id="settingsForm">
          {state.loading ? (
            <div className="text-center py-8 text-secondary">
              <i className="fas fa-spinner fa-spin"></i>
              <div>加载配置中...</div>
            </div>
          ) : (
            Object.entries(state.labels).map(([key, label]) => (
              <SettingsInput
                key={key}
                label={label}
                onChange={(value) => {
                  onChange(key, value);
                }}
                settingKey={key}
                value={String(state.values[key] ?? '')}
              />
            ))
          )}
        </div>
        <div className="mt-6">
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
            disabled={state.saving}
            onClick={onSave}
          >
            <i
              className={
                state.saving ? 'fas fa-spinner fa-spin' : 'fas fa-save'
              }
            ></i>
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
};

export const DebugSection = ({
  autoRefreshOptions,
  onClear,
  onCopy,
  onAutoRefreshSecondsChange,
  onEnabledChange,
  onMaxEntriesChange,
  onRefresh,
  onSave,
  state,
}: DebugSectionProps) => {
  const renderDebugBlock = (title: string, value: unknown) => {
    const content = JSON.stringify(value, null, 2);
    const singleLinePreview = content.replace(/\s+/g, ' ').trim() || 'null';

    return (
      <details className="w-full min-w-0 max-w-full overflow-hidden border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark">
        <summary className="list-none cursor-pointer p-3 flex items-start justify-between gap-3 w-full min-w-0 max-w-full overflow-hidden">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-text-light dark:text-text-dark mb-1">
              {title}
            </div>
            <div className="block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-secondary">
              {singleLinePreview}
            </div>
          </div>
          <button
            className="inline-flex items-center gap-2 px-3 py-2 border-none font-medium cursor-pointer transition-all text-xs bg-secondary text-white hover:bg-secondary shrink-0"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCopy(content);
            }}
            type="button"
          >
            <i className="fas fa-copy"></i>
            复制
          </button>
        </summary>
        <pre className="w-full min-w-0 max-w-full overflow-hidden p-3 pt-0 whitespace-pre-wrap break-all text-xs text-text-light dark:text-text-dark">
          {content}
        </pre>
      </details>
    );
  };

  return (
    <div id="debug" className="block">
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            Debug 记录
          </h3>
          <div className="flex gap-2">
            <div className="min-w-[160px]">
              <label className="sr-only" htmlFor="debugAutoRefreshSeconds">
                自动刷新时间
              </label>
              <select
                id="debugAutoRefreshSeconds"
                className="w-full p-2 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-sm text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
                disabled={!state.enabled || state.saving}
                value={state.autoRefreshSeconds}
                onChange={(event) => {
                  onAutoRefreshSecondsChange(
                    Number.parseInt(event.target.value, 10) || 0,
                  );
                }}
              >
                {autoRefreshOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="inline-flex items-center gap-2 px-4 py-2 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary"
              onClick={onRefresh}
            >
              <i className="fas fa-sync-alt"></i>
              刷新
            </button>
            <button
              className="inline-flex items-center gap-2 px-4 py-2 border-none font-medium cursor-pointer transition-all text-sm bg-error text-white hover:bg-error"
              disabled={state.saving}
              onClick={onClear}
            >
              <i className="fas fa-trash"></i>
              清空
            </button>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_auto] items-end mb-6">
          <label className="flex items-center gap-3 p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark cursor-pointer">
            <input
              checked={state.enabled}
              type="checkbox"
              onChange={(event) => {
                onEnabledChange(event.target.checked);
              }}
            />
            <div>
              <div className="font-medium text-text-light dark:text-text-dark">
                启用 Debug 采集
              </div>
              <div className="text-sm text-secondary">
                记录时间、请求 key、请求内容、上游请求、上游回包、转换后回包。
              </div>
            </div>
          </label>
          <div>
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="debugMaxEntries"
            >
              最大保留条数
            </label>
            <input
              id="debugMaxEntries"
              className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
              min={1}
              type="number"
              value={state.maxEntries}
              onChange={(event) => {
                onMaxEntriesChange(
                  Number.parseInt(event.target.value || '0', 10) || 1,
                );
              }}
            />
          </div>
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
            disabled={state.saving}
            onClick={onSave}
          >
            <i
              className={
                state.saving ? 'fas fa-spinner fa-spin' : 'fas fa-save'
              }
            ></i>
            保存 Debug 设置
          </button>
        </div>
        {state.loading ? (
          <div className="text-center py-8 text-secondary">
            <i className="fas fa-spinner fa-spin"></i>
            <div>加载 Debug 记录中...</div>
          </div>
        ) : state.items.length ? (
          <div className="grid gap-4 w-full min-w-0">
            {state.items.map((item) => (
              <details
                key={item.id}
                className="w-full min-w-0 max-w-full overflow-hidden border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark"
              >
                <summary className="cursor-pointer list-none p-4 flex flex-wrap items-center justify-between gap-3 w-full min-w-0 max-w-full overflow-hidden">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-text-light dark:text-text-dark">
                      {item.route}
                    </div>
                    <div className="text-sm text-secondary break-all min-w-0 max-w-full">
                      {item.createdAt} · key: {item.requestKey ?? 'none'}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs min-w-0 max-w-full">
                    <span className="px-2 py-1 bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark">
                      上游状态: {item.upstreamResponse?.status ?? '-'}
                    </span>
                    <span className="px-2 py-1 bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark">
                      返回状态: {item.transformedResponse?.status ?? '-'}
                    </span>
                    {item.error ? (
                      <span className="px-2 py-1 bg-error/10 text-error">
                        {item.error}
                      </span>
                    ) : null}
                  </div>
                </summary>
                <div className="p-4 pt-0 grid gap-4 w-full min-w-0">
                  {renderDebugBlock('原始请求', item.requestBody)}
                  {renderDebugBlock('上游请求', item.upstreamRequest)}
                  {renderDebugBlock('上游回包', item.upstreamResponse)}
                  {renderDebugBlock('转换后回包', item.transformedResponse)}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-secondary">
            <i className="fas fa-bug"></i>
            <div>暂无 Debug 记录。</div>
          </div>
        )}
      </div>
    </div>
  );
};

export const NotificationBar = ({ notification }: NotificationBarProps) => {
  const notificationTypeBg: Record<string, string> = {
    success: 'bg-success',
    error: 'bg-error',
    warning: 'bg-warning',
    info: 'bg-primary',
  };
  const base =
    'fixed top-[100px] right-8 p-4 px-6 text-white font-medium z-1000 max-w-[400px] transition-transform';
  const positionClass = notification ? 'translate-x-0' : 'translate-x-full';
  const typeClass = notification
    ? (notificationTypeBg[notification.type] ?? '')
    : '';

  return (
    <div id="notification" className={`${base} ${positionClass} ${typeClass}`}>
      {notification?.message ?? ''}
    </div>
  );
};
