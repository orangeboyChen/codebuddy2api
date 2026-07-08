import React from 'react';

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

type TabNavProps = {
  activeTab: TabKey;
  onChange: (tab: TabKey) => void;
};

type DashboardSectionProps = {
  onCopyEndpoint: () => void;
  onRefresh: () => void;
  state: DashboardState;
};

type CredentialsSectionProps = {
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
};

type ApiTestSectionProps = {
  models: string[];
  onMessageChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onStreamChange: (checked: boolean) => void;
  onSubmit: () => void;
  state: ApiTestState;
};

type SettingsSectionProps = {
  onChange: (key: string, value: string) => void;
  onSave: () => void;
  state: SettingsState;
};

type NotificationBarProps = {
  notification: NotificationState | null;
};

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
        className: 'status status-warning',
        label: '手动选中',
      };
    }

    return {
      className: 'status status-success',
      label: '当前使用中',
    };
  }

  if (credential.is_expired) {
    return {
      className: 'status status-error',
      label: '已过期',
    };
  }

  return {
    className: 'status status-success',
    label: '有效',
  };
};

const getCredentialAvatarClassName = (credential: CredentialSummary) => {
  if (credential.is_expired) {
    return 'credential-avatar expired';
  }

  if (!credential.email && !credential.user_id) {
    return 'credential-avatar unknown';
  }

  return 'credential-avatar valid';
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
      <div className="form-group">
        <label className="form-label" htmlFor={settingKey}>
          {label}
        </label>
        <select
          id={settingKey}
          className="form-input"
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
      <div className="form-group">
        <label className="form-label" htmlFor={settingKey}>
          {label}
        </label>
        <select
          id={settingKey}
          className="form-input"
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
      <div className="form-group">
        <label className="form-label" htmlFor={settingKey}>
          {label}
        </label>
        <select
          id={settingKey}
          className="form-input"
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
    <div className="form-group">
      <label className="form-label" htmlFor={settingKey}>
        {label}
      </label>
      <input
        id={settingKey}
        className="form-input"
        type={
          settingKey === 'CODEBUDDY_PASSWORD' ||
          settingKey === 'CODEBUDDY_API_KEY'
            ? 'password'
            : settingKey === 'CODEBUDDY_PORT' ||
                settingKey === 'CODEBUDDY_ROTATION_COUNT'
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
    <div className="credential-item">
      <div className={getCredentialAvatarClassName(credential)}>
        {avatarText || 'C'}
      </div>
      <div className="credential-info">
        <div className="credential-header">
          <div className="credential-title">{credential.filename}</div>
          <span className={badge.className}>{badge.label}</span>
        </div>
        <div className="credential-meta">
          <span className="credential-meta-item">
            <i className="fas fa-user"></i>
            {credential.email || credential.user_id}
          </span>
          <span className="credential-meta-item">
            <i className="fas fa-globe"></i>
            {credential.domain}
          </span>
          <span className="credential-meta-item">
            <i className="fas fa-clock"></i>
            {credential.time_remaining_str}
          </span>
          <span className="credential-meta-item">
            <i className="fas fa-calendar"></i>
            {formatDateTime(credential.created_at)}
          </span>
        </div>
      </div>
      <div className="credential-actions">
        <button className="btn btn-primary" onClick={onSelect}>
          <i className="fas fa-bullseye"></i>
          设为当前
        </button>
        <button className="btn btn-danger" onClick={onDelete}>
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
    <div className="credential-group">
      <div className="credential-group-header">
        <div className="credential-group-title">
          <i className="fas fa-layer-group"></i>
          {title}
        </div>
        <span className="credential-group-badge">{items.length}</span>
      </div>
      <div className="credential-group-list">
        <div className="credential-list">
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
    <div className="nav-tabs">
      {TAB_ITEMS.map((tab) => (
        <button
          key={tab.key}
          className={tab.key === activeTab ? 'nav-tab active' : 'nav-tab'}
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
    <div id="dashboard" className="tab-panel active">
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-card-header">
            <div className="stat-card-icon primary">
              <i className="fas fa-key"></i>
            </div>
            <div className="usage-ring" id="credentialUsageRing">
              <svg width="60" height="60">
                <circle cx="30" cy="30" r="26" className="usage-ring-bg" />
                <circle
                  cx="30"
                  cy="30"
                  r="26"
                  className="usage-ring-progress"
                  id="credentialRingProgress"
                  style={getRingStyle(state.credentialUsagePercent)}
                />
              </svg>
              <div className="usage-ring-text" id="credentialUsagePercent">
                {Math.round(state.credentialUsagePercent)}%
              </div>
            </div>
          </div>
          <div className="stat-value" id="totalCredentials">
            {state.totalCredentials}
          </div>
          <div className="stat-label">总凭证数量</div>
          <div className="stat-trend positive" id="credentialTrend">
            <i className="fas fa-check"></i>
            <span id="validCredentials">{state.validCredentials}</span>
            个有效
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-header">
            <div className="stat-card-icon success" id="serviceStatusIcon">
              <i className="fas fa-server"></i>
            </div>
            <div className="status-indicator" id="serviceStatus">
              <span
                className={`status-dot ${state.serviceStatus}`}
                id="statusDot"
              ></span>
            </div>
          </div>
          <div className="stat-value" id="statusText">
            {state.statusText}
          </div>
          <div className="stat-label">服务运行状态</div>
          <div className="stat-trend" id="uptimeTrend">
            <i className="fas fa-clock"></i>
            <span id="uptime">{state.uptimeText}</span>
          </div>
        </div>
        <button
          className="stat-card"
          onClick={onCopyEndpoint}
          style={{ cursor: 'pointer', textAlign: 'left' }}
          title="点击复制API端点"
          type="button"
        >
          <div className="stat-card-header">
            <div className="stat-card-icon warning">
              <i className="fas fa-link"></i>
            </div>
            <div style={{ opacity: '0.6' }}>
              <i className="fas fa-copy"></i>
            </div>
          </div>
          <div
            className="stat-value"
            id="apiEndpoint"
            style={{ fontSize: '1.2rem', wordBreak: 'break-all' }}
          >
            {state.apiEndpoint || '-'}
          </div>
          <div className="stat-label">API 服务端点</div>
          <div className="stat-trend">
            <i className="fas fa-info-circle"></i>
            点击复制链接
          </div>
        </button>
        <div className="stat-card">
          <div className="stat-card-header">
            <div className="stat-card-icon primary">
              <i className="fas fa-chart-line"></i>
            </div>
            <div className="usage-ring" id="totalUsageRing">
              <svg width="60" height="60">
                <circle cx="30" cy="30" r="26" className="usage-ring-bg" />
                <circle
                  cx="30"
                  cy="30"
                  r="26"
                  className="usage-ring-progress"
                  id="usageRingProgress"
                  style={getRingStyle(state.totalApiCalls > 0 ? 100 : 0)}
                />
              </svg>
              <div className="usage-ring-text" id="totalUsagePercent">
                {state.totalApiCalls}
              </div>
            </div>
          </div>
          <div className="stat-value" id="totalApiCalls">
            {state.totalApiCalls}
          </div>
          <div className="stat-label">总 API 调用次数</div>
          <div className="stat-trend" id="apiCallsTrend">
            <i className="fas fa-sync-alt"></i>
            {state.lastCheckedAt || '等待刷新'}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <i className="fas fa-chart-bar"></i>
            模型使用统计
          </h3>
          <button className="btn btn-primary" onClick={onRefresh}>
            <i className="fas fa-sync-alt"></i>
            刷新
          </button>
        </div>
        <div className="usage-table-container">
          <table className="usage-table">
            <thead>
              <tr>
                <th>模型名称</th>
                <th style={{ textAlign: 'right' }}>使用次数</th>
              </tr>
            </thead>
            <tbody id="modelUsageTableBody">
              {state.modelUsage.length ? (
                state.modelUsage.map(([model, count]) => (
                  <tr key={model}>
                    <td>{model}</td>
                    <td style={{ textAlign: 'right' }}>{count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} style={{ textAlign: 'center' }}>
                    暂无模型使用记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <i className="fas fa-key"></i>
            凭证使用统计
          </h3>
        </div>
        <div className="usage-table-container">
          <table className="usage-table">
            <thead>
              <tr>
                <th>凭证文件</th>
                <th style={{ textAlign: 'right' }}>使用次数</th>
              </tr>
            </thead>
            <tbody id="credentialUsageTableBody">
              {state.credentialUsage.length ? (
                state.credentialUsage.map(([filename, count]) => (
                  <tr key={filename}>
                    <td>{filename}</td>
                    <td style={{ textAlign: 'right' }}>{count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} style={{ textAlign: 'center' }}>
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
    <div id="credentials" className="tab-panel active">
      <div className="card auth-section">
        <div className="card-header">
          <h3 className="card-title">
            <i className="fas fa-magic"></i>
            自动获取认证
          </h3>
        </div>
        <p style={{ color: 'var(--secondary-color)', marginBottom: '1rem' }}>
          点击下方按钮自动启动CodeBuddy
          OAuth2认证流程，系统将自动获取并保存您的认证凭证。
        </p>
        <button
          className="btn btn-primary"
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
            auth.authUrl ? 'auth-url-section' : 'auth-url-section hidden'
          }
        >
          <h4 style={{ color: 'var(--primary-color)', marginBottom: '1rem' }}>
            认证链接已生成
          </h4>
          <p style={{ color: 'var(--secondary-color)', marginBottom: '1rem' }}>
            请点击下面的链接完成CodeBuddy账号登录：
          </p>
          <input
            id="authUrlInput"
            className="auth-url-input"
            readOnly
            type="text"
            value={auth.authUrl}
          />
          <div className="auth-buttons">
            <button className="btn btn-success" onClick={onOpenAuthUrl}>
              <i className="fas fa-external-link-alt"></i>
              打开链接
            </button>
            <button className="btn btn-secondary" onClick={onCopyAuthUrl}>
              <i className="fas fa-copy"></i>
              复制链接
            </button>
            <button
              className="btn btn-warning"
              onClick={() => {
                onToggleCallbackMode(true);
              }}
            >
              <i className="fas fa-hand-pointer"></i>
              手动回调
            </button>
          </div>
          <div id="autoCallbackSection" className="callback-section">
            <div className="auth-progress">
              <i className="fas fa-clock"></i>
              <div>{auth.message || '等待认证完成...'}</div>
              <small style={{ color: 'var(--secondary-color)' }}>
                完成登录后系统将自动获取凭证
              </small>
            </div>
            <div style={{ marginTop: '1rem', textAlign: 'center' }}>
              <button className="btn btn-secondary" onClick={onPollAuth}>
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
                ? 'callback-section'
                : 'callback-section hidden'
            }
          >
            <h5 style={{ marginBottom: '1rem' }}>手动输入回调链接</h5>
            <p
              style={{
                color: 'var(--secondary-color)',
                fontSize: '0.9rem',
                marginBottom: '1rem',
              }}
            >
              如果自动检测失败，请在完成登录后，将浏览器地址栏中的完整URL粘贴到下面：
            </p>
            <input
              id="callbackUrl"
              className="form-input"
              placeholder="粘贴回调URL..."
              type="text"
              value={auth.callbackUrl}
              onChange={(event) => {
                onCallbackUrlChange(event.target.value);
              }}
            />
            <div style={{ marginTop: '1rem', textAlign: 'right' }}>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  onToggleCallbackMode(false);
                }}
                style={{ marginRight: '0.5rem' }}
              >
                返回自动模式
              </button>
              <button className="btn btn-success" onClick={onSubmitCallbackUrl}>
                提交
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <i className="fas fa-edit"></i>
            手动添加凭证
          </h3>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="bearerToken">
            Bearer Token
            <span style={{ color: 'var(--error-color)' }}>*</span>
          </label>
          <textarea
            id="bearerToken"
            className="form-input form-textarea"
            placeholder="输入您的 CodeBuddy Bearer Token..."
            rows={3}
            value={credentials.form.bearerToken}
            onChange={(event) => {
              onCredentialTokenChange(event.target.value);
            }}
          ></textarea>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="userId">
            用户ID (可选)
          </label>
          <input
            id="userId"
            className="form-input"
            placeholder="输入用户ID (可选)"
            type="text"
            value={credentials.form.userId}
            onChange={(event) => {
              onCredentialUserIdChange(event.target.value);
            }}
          />
        </div>
        <button className="btn btn-success" onClick={onAddCredential}>
          <i className="fas fa-plus"></i>
          添加凭证
        </button>
      </div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">已保存的凭证</h3>
          <div>
            <button
              id="rotationToggleBtn"
              className="btn btn-secondary"
              onClick={
                rotationEnabled ? onToggleRotation : onResumeAutoRotation
              }
              style={{ marginRight: '0.5rem' }}
            >
              <i
                className={rotationEnabled ? 'fas fa-pause' : 'fas fa-play'}
              ></i>
              {rotationEnabled ? '暂停自动轮换' : '恢复自动轮换'}
            </button>
            <button className="btn btn-primary" onClick={onRefreshCredentials}>
              <i className="fas fa-sync-alt"></i>
              刷新列表
            </button>
          </div>
        </div>
        <div
          id="currentCredentialStatus"
          className="card-header"
          style={{
            borderBottom: '1px solid var(--border-light)',
            marginBottom: '1rem',
          }}
        >
          {credentials.currentLoading ? (
            <div className="loading">
              <i className="fas fa-spinner fa-spin"></i>
              <div>加载当前状态...</div>
            </div>
          ) : (
            <div>
              <div className="credential-title">
                {formatCurrentStatus(credentials.current)}
              </div>
              {credentials.current?.status !== 'no_credentials' ? (
                <div
                  className="credential-meta"
                  style={{ marginTop: '0.5rem' }}
                >
                  <span className="credential-meta-item">
                    <i className="fas fa-file"></i>
                    {credentials.current?.filename ?? 'Unknown'}
                  </span>
                  <span className="credential-meta-item">
                    <i className="fas fa-user"></i>
                    {credentials.current?.user_id ?? 'Unknown'}
                  </span>
                  <span className="credential-meta-item">
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
            <div className="loading">
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
            <div className="loading">
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
    <div id="api-test" className="tab-panel active">
      <div className="card api-test">
        <div className="card-header">
          <h3 className="card-title">聊天完成测试</h3>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="testModel">
            模型
          </label>
          <select
            id="testModel"
            className="form-input"
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
        <div className="form-group">
          <label className="form-label" htmlFor="testMessage">
            测试消息
          </label>
          <textarea
            id="testMessage"
            className="form-input form-textarea"
            placeholder="输入测试消息..."
            rows={3}
            value={state.message}
            onChange={(event) => {
              onMessageChange(event.target.value);
            }}
          ></textarea>
        </div>
        <div className="form-group">
          <label className="form-label">
            <input
              id="testStream"
              style={{ marginRight: '0.5rem' }}
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
          className="btn btn-primary"
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
        <div className="form-group" style={{ marginTop: '1.5rem' }}>
          <label className="form-label">响应结果</label>
          <div
            id="testResult"
            className="code-block"
            style={{
              backgroundColor: '#1e1e1e',
              color: '#ffffff',
              minHeight: '200px',
            }}
          >
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {state.result}
            </pre>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">API 使用示例</h3>
        </div>
        <h4 style={{ color: 'var(--primary-color)', marginBottom: '1rem' }}>
          curl 示例:
        </h4>
        <div className="code-block">{`curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \\
-H "Authorization: Bearer YOUR_PASSWORD" \\
-H "Content-Type: application/json" \\
-d '{
  "model": "glm-5.1",
  "messages": [{ "role": "user", "content": "Hello!" }]
}'`}</div>
        <h4
          style={{
            color: 'var(--primary-color)',
            margin: '1.5rem 0 1rem',
          }}
        >
          Python 示例:
        </h4>
        <div className="code-block">{`import openai

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
    <div id="settings" className="tab-panel active">
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">服务配置</h3>
        </div>
        <div id="settingsForm">
          {state.loading ? (
            <div className="loading">
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
        <div style={{ marginTop: '1.5rem' }}>
          <button
            className="btn btn-primary"
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
          <small
            style={{
              color: 'var(--secondary-color)',
              display: 'block',
              marginTop: '1rem',
            }}
          >
            注意：部分设置（如端口号）需要重启服务后才能生效。
          </small>
        </div>
      </div>
    </div>
  );
};

export const NotificationBar = ({ notification }: NotificationBarProps) => {
  return (
    <div
      id="notification"
      className={
        notification ? `notification show ${notification.type}` : 'notification'
      }
    >
      {notification?.message ?? ''}
    </div>
  );
};
