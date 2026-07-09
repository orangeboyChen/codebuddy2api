import type {
  ApiTestState,
  AuthState,
  CredentialSummary,
  CredentialsState,
  CurrentCredentialInfo,
  DashboardState,
  NotificationState,
  SettingsState,
  TabKey,
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
  onCredentialTokenChange: (value: string) => void;
  onCredentialUserIdChange: (value: string) => void;
  onDeleteCredential: (index: number) => void;
  onOpenAuthUrl: () => void;
  onPollAuth: () => void;
  onRefreshCredentials: () => void;
  onResumeAutoRotation: () => void;
  onSelectCredential: (index: number) => void;
  onSubmitCallbackUrl: () => void;
  onToggleCallbackMode: (showManual: boolean) => void;
  onToggleRotation: () => void;
}

interface ApiTestSectionProps {
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

interface NotificationBarProps {
  notification: NotificationState | null;
}

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
  if (current?.index === credential.index) {
    if (current.status === 'manual_selected') {
      return {
        className: 'px-3 py-1 text-xs font-medium bg-warning/10 text-warning',
        label: '手动选中',
      };
    }

    return {
      className: 'px-3 py-1 text-xs font-medium bg-success/10 text-success',
      label: '当前使用中',
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

  if (current.status === 'manual_selected') {
    return '当前处于手动选中模式';
  }

  return '当前处于自动轮换模式';
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
          className="block mb-2 font-medium text-text-light dark:text-text-dark"
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
          <option value="api_key">api_key</option>
          <option value="token">token</option>
        </select>
      </div>
    );
  }

  if (settingKey === 'CODEBUDDY_INTERNET_ENVIRONMENT') {
    return (
      <div className="mb-4">
        <label
          className="block mb-2 font-medium text-text-light dark:text-text-dark"
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
          className="block mb-2 font-medium text-text-light dark:text-text-dark"
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

  return (
    <div className="mb-4">
      <label
        className="block mb-2 font-medium text-text-light dark:text-text-dark"
        htmlFor={settingKey}
      >
        {label}
      </label>
      <input
        id={settingKey}
        className="w-full p-3 border border-border-light dark:border-border-dark bg-card-light dark:bg-card-dark text-text-light dark:text-text-dark focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
        type={
          settingKey === 'CODEBUDDY_PASSWORD' ||
          settingKey === 'CODEBUDDY_API_KEY'
            ? 'password'
            : settingKey === 'CODEBUDDY_ROTATION_COUNT'
              ? 'number'
              : 'text'
        }
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
  onDelete,
  onSelect,
}: {
  credential: CredentialSummary;
  current: CurrentCredentialInfo | null;
  onDelete: () => void;
  onSelect: () => void;
}) => {
  const badge = getCredentialBadge(credential, current);
  const avatarText = (credential.name ?? credential.email ?? credential.user_id)
    .slice(0, 1)
    .toUpperCase();

  return (
    <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-5 flex items-center gap-4 transition-all relative hover:-translate-y-px hover:shadow-md hover:border-primary">
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
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
          onClick={onSelect}
        >
          <i className="fas fa-bullseye"></i>
          设为当前
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
  );
};

const CredentialGroup = ({
  current,
  items,
  title,
  onDelete,
  onSelect,
}: {
  current: CurrentCredentialInfo | null;
  items: CredentialSummary[];
  onDelete: (index: number) => void;
  onSelect: (index: number) => void;
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
              onDelete={() => {
                onDelete(credential.index);
              }}
              onSelect={() => {
                onSelect(credential.index);
              }}
            />
          ))}
        </div>
      </div>
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
              ? 'px-6 py-3 bg-none border-none text-primary cursor-pointer border-b-2 border-primary transition-all font-medium hover:text-primary'
              : 'px-6 py-3 bg-none border-none text-secondary cursor-pointer border-b-2 border-transparent transition-all font-medium hover:text-primary'
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

export const CredentialsSection = ({
  auth,
  credentials,
  onAddCredential,
  onAuthAction,
  onCallbackUrlChange,
  onCopyAuthUrl,
  onCredentialTokenChange,
  onCredentialUserIdChange,
  onDeleteCredential,
  onOpenAuthUrl,
  onPollAuth,
  onRefreshCredentials,
  onResumeAutoRotation,
  onSelectCredential,
  onSubmitCallbackUrl,
  onToggleCallbackMode,
  onToggleRotation,
}: CredentialsSectionProps) => {
  const validCredentials = credentials.items.filter((item) => !item.is_expired);
  const expiredCredentials = credentials.items.filter(
    (item) => item.is_expired,
  );
  const rotationEnabled =
    credentials.current?.auto_rotation_enabled ??
    (credentials.current
      ? credentials.current.status !== 'no_credentials'
      : false);

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
            className="w-full p-3 border border-border-light dark:border-border-dark bg-white dark:bg-card-dark font-mono text-sm mb-4 text-text-light dark:text-text-dark"
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
        <button
          className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-success text-white hover:bg-success"
          onClick={onAddCredential}
        >
          <i className="fas fa-plus"></i>
          添加凭证
        </button>
      </div>
      <div className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
        <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            已保存的凭证
          </h3>
          <div>
            <button
              id="rotationToggleBtn"
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-secondary text-white hover:bg-secondary mr-2"
              onClick={
                rotationEnabled ? onToggleRotation : onResumeAutoRotation
              }
            >
              <i
                className={rotationEnabled ? 'fas fa-pause' : 'fas fa-play'}
              ></i>
              {rotationEnabled ? '暂停自动轮换' : '恢复自动轮换'}
            </button>
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
              onClick={onRefreshCredentials}
            >
              <i className="fas fa-sync-alt"></i>
              刷新列表
            </button>
          </div>
        </div>
        <div
          id="currentCredentialStatus"
          className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark"
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
                  <span className="flex items-center gap-1">
                    <i className="fas fa-file"></i>
                    {credentials.current?.filename ?? 'Unknown'}
                  </span>
                  <span className="flex items-center gap-1">
                    <i className="fas fa-user"></i>
                    {credentials.current?.user_id ?? 'Unknown'}
                  </span>
                  <span className="flex items-center gap-1">
                    <i className="fas fa-repeat"></i>
                    轮换频率 {credentials.current?.rotation_count ?? 0}
                  </span>
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
                items={validCredentials}
                onDelete={onDeleteCredential}
                onSelect={onSelectCredential}
                title="可用凭证"
              />
              <CredentialGroup
                current={credentials.current}
                items={expiredCredentials}
                onDelete={onDeleteCredential}
                onSelect={onSelectCredential}
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
            className="bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark p-4 font-mono text-sm overflow-x-auto my-4 bg-bg-dark text-text-dark min-h-[200px]"
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
        <div className="bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark p-4 font-mono text-sm overflow-x-auto my-4">{`curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \\
-H "Authorization: Bearer YOUR_PASSWORD" \\
-H "Content-Type: application/json" \\
-d '{
  "model": "glm-5.1",
  "messages": [{ "role": "user", "content": "Hello!" }]
}'`}</div>
        <h4 className="text-primary mt-6 mb-4">Python 示例:</h4>
        <div className="bg-bg-light dark:bg-bg-dark border border-border-light dark:border-border-dark p-4 font-mono text-sm overflow-x-auto my-4">{`import openai

client = openai.OpenAI(
    api_key="YOUR_PASSWORD",
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
          <small className="text-secondary block mt-4">
            注意：部分设置（如端口号）需要重启服务后才能生效。
          </small>
        </div>
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
