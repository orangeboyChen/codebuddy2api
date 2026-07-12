import type {
  AccessKeySummary,
  ApiTestState,
  AuthState,
  CredentialSummary,
  CredentialsState,
  CurrentCredentialInfo,
  DebugState,
  DashboardState,
  SettingsState,
  TabKey,
  UsageRange,
  UsageState,
} from '@/app/admin/_components/admin-store';
import {
  ActionIcon,
  Block,
  Avatar,
  Checkbox,
  Flexbox,
  Input,
  Tag,
  TextArea,
} from '@lobehub/ui';
import { Button, Select, Switch, Tabs } from '@lobehub/ui/base-ui';
import {
  BarChart3,
  Bug,
  ChartLine,
  ChartNoAxesCombined,
  Check,
  CalendarDays,
  ExternalLink,
  Eye,
  FileCode2,
  Globe2,
  Copy,
  Clock3,
  Info,
  KeyRound,
  Layers3,
  Link,
  LayoutDashboard,
  LoaderCircle,
  MousePointerClick,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Server,
  Send,
  Settings2,
  Trash2,
  UserRound,
  WandSparkles,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  DEFAULT_TEST_MODELS,
  TAB_ITEMS,
  USAGE_RING_CIRCUMFERENCE,
} from '@/app/admin/_components/admin-store';
import AdminAuthSettings from '@/app/admin/_components/admin-auth-settings';
import type { AppLocale } from '@/lib/i18n/routing';

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
  onRefreshAccessKeys: () => void;
  onRefreshCredentialList: () => void;
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

const CHART_COLORS = [
  '#1d4ed8',
  '#ea580c',
  '#059669',
  '#9333ea',
  '#dc2626',
  '#0891b2',
];

const FOLLOW_CURRENT_CREDENTIAL_VALUE = '__follow_current_rotation__';

const parseSseEvents = (value: unknown) => {
  if (typeof value !== 'string' || !/(?:^|\n)data:/.test(value)) {
    return null;
  }

  const events = value
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n'),
    )
    .filter(Boolean);

  return events.length ? events : null;
};

const TAB_ICONS: Record<TabKey, LucideIcon> = {
  'api-test': Send,
  credentials: KeyRound,
  dashboard: LayoutDashboard,
  debug: Bug,
  settings: Settings2,
  usage: ChartLine,
};

const getLocalizedAdminText = (locale: AppLocale) => {
  return {
    'en-US': {
      accessKeyCount: (count: number) => `${count} credentials`,
      accessKeyCreatedAt: (value: string) => `Created ${value}`,
      accessKeyCurrent: 'Current API key',
      accessKeyEdit: 'Edit API key',
      accessKeyEmptyCredentials: 'No active credentials are available to bind.',
      accessKeyExampleName: 'Example: Claude Team / CI Runner',
      accessKeyHelp:
        'The secret is generated by the server automatically. Only the name and bound credentials are editable here.',
      accessKeyLabel: 'API key',
      accessKeyName: 'API key name',
      accessKeyUpdatedAt: (value: string) => `Updated ${value}`,
      apiEndpointTitle: 'API endpoint',
      apiEndpointTooltip: 'Copy API endpoint',
      apiExampleCurl: 'curl example:',
      apiExamplePython: 'Python example:',
      apiExamplesTitle: 'API usage examples',
      apiTestCredential: 'Credential',
      apiTestFollowCurrent: 'Follow current rotation',
      apiTestMessage: 'Test message',
      apiTestPlaceholder: 'Enter a test message...',
      apiTestResult: 'Response',
      apiTestIdle: 'Click "Send test" to view the API response...',
      apiTestSend: 'Send test',
      apiTestRunning: 'Sending request...',
      apiTestStream: 'Stream response',
      apiTestTitle: 'Chat completion test',
      autoAuthDescription:
        'Start the CodeBuddy OAuth flow and the console will save the credential automatically after sign-in.',
      autoAuthGenerated: 'Authorization link ready',
      autoAuthGeneratedDescription:
        'Open the link below to sign in to your CodeBuddy account:',
      autoAuthManual: 'Manual callback',
      autoAuthManualBack: 'Back to automatic mode',
      autoAuthManualDescription:
        'If automatic detection fails, paste the full callback URL from your browser address bar after sign-in.',
      autoAuthManualInput: 'Paste callback URL...',
      autoAuthManualTitle: 'Paste callback URL manually',
      autoAuthOpen: 'Open link',
      autoAuthPending: 'Waiting for authentication...',
      autoAuthPendingHint:
        'The console will fetch and save the credential after sign-in completes.',
      autoAuthPoll: 'Check authentication status',
      autoAuthStart: 'Start authentication',
      autoAuthTitle: 'Automatic authentication',
      availableCredentials: 'Available credentials',
      copyLink: 'Copy link',
      copyLinkHint: 'Copy endpoint',
      credentialBadgeActive: 'Active',
      credentialBadgeExpired: 'Expired',
      credentialBadgeNext: 'Next in rotation',
      credentialBindings: 'Bound credentials',
      credentialCurrentNone: 'No current credential status yet.',
      credentialCurrentNoCredentials: 'No credentials are currently available.',
      credentialCurrentWithAccessKeys:
        'API keys are enabled. Requests rotate within each key’s bound credential subset.',
      credentialCurrentWithoutAccessKeys:
        'API keys are not configured. Requests rotate across all available credentials.',
      credentialEditTitle: 'Edit credential settings',
      credentialEmpty:
        'No credentials yet. Authenticate or add one manually first.',
      credentialExpired: 'Expired credentials',
      credentialRefreshList: 'Refresh',
      credentialResponsesDirect: 'Send Responses requests upstream directly',
      credentialResponsesDirectHelp:
        'When enabled, `/v1/responses` requests using this credential are sent upstream directly instead of being converted into Chat Completions.',
      credentialResponsesProxy:
        'Convert Responses requests to Chat Completions before sending upstream',
      credentialResponsesProxyTag: 'Responses → Chat',
      credentialRoleAsSystem: 'Normalize developer messages for upstream',
      credentialRoleAsSystemTag: 'developer → system',
      credentialRoleAsSystemHelp:
        'Sends the first developer message as system and later developer messages as user.',
      credentialRoleKeepDeveloper: 'Keep developer',
      credentialSave: 'Save',
      credentialSectionTitle: 'Saved credentials',
      credentialUserId: 'User ID (optional)',
      credentialUserIdPlaceholder: 'Enter the user ID (optional)',
      dashboardActive: (count: number) => `${count} active`,
      dashboardApiCalls: 'Total API calls',
      dashboardCredentialUsage: 'Credential usage',
      dashboardCredentials: 'Total credentials',
      dashboardModelName: 'Model',
      dashboardModelUsage: 'Model usage',
      dashboardNoCredentialUsage: 'No credential usage yet',
      dashboardNoModelUsage: 'No model usage yet',
      dashboardRefreshPending: 'Waiting for refresh',
      dashboardServiceStatus: 'Service status',
      debugClear: 'Clear',
      debugCopy: 'Copy',
      debugEventData: 'Data',
      debugEventIndex: 'Event',
      debugCredential: 'Credential',
      debugCredentialUnknown: 'Not recorded',
      debugEmpty: 'No debug records yet.',
      debugEnable: 'Enable debug capture',
      debugEnableHelp:
        'Capture timestamp, request key, request body, upstream request, upstream response, and transformed response.',
      debugLoading: 'Loading debug records...',
      debugMaxEntries: 'Max retained records',
      debugRefresh: 'Refresh',
      debugRefreshInterval: 'Auto-refresh interval',
      debugRequest: 'Original request',
      debugResponse: 'Transformed response',
      debugSave: 'Save',
      debugSectionTitle: 'Debug records',
      debugUpstreamRequest: 'Upstream request',
      debugUpstreamResponse: 'Upstream response',
      debugUpstreamStatus: (value: string | number) => `Upstream: ${value}`,
      debugReturnedStatus: (value: string | number) => `Returned: ${value}`,
      delete: 'Delete',
      edit: 'Edit',
      expiredCredentials: 'Expired credentials',
      loading: 'Loading...',
      manualCredentialPlaceholder: 'Enter your CodeBuddy bearer token...',
      manualCredentialTitle: 'Add credential manually',
      noCurrentState: 'Loading current state...',
      range1h: '1 hour',
      range3h: '3 hours',
      range6h: '6 hours',
      range12h: '12 hours',
      range24h: '24 hours',
      range3d: '3 days',
      range7d: '7 days',
      rangeToday: 'Today',
      rangeYesterday: 'Yesterday',
      refresh: 'Refresh',
      save: 'Save',
      serviceCheckedAt: (value: string) => `Last checked ${value}`,
      settingsLoading: 'Loading settings...',
      settingsSave: 'Save',
      settingsTitle: 'Service settings',
      statusUnavailable: 'Unavailable',
      statusRunning: 'Running',
      submit: 'Submit',
      usageAccessKey: 'API key',
      usageAllAccessKeys: 'All API keys',
      usageAllCredentials: 'All credentials',
      usageAutoRefresh: 'Auto-refresh',
      usageCallTrend: 'Call trend',
      usageCallsToday: 'Calls today',
      usageCacheHitToday: 'Cache-hit tokens today',
      usageClearHistory: 'Clear history',
      usageCredential: 'Credential',
      usageEmptyCalls: 'No call trend data for the current filters.',
      usageEmptySummary: 'No model summary data yet',
      usageEmptyTokens: 'No token trend data for the current filters.',
      usageFirstLoad: 'Waiting for the first usage load',
      usageLastUpdated: (value: string) => `Last updated ${value}`,
      usageMetricCalls: 'Calls',
      usageMetricTokens: 'Total tokens',
      usageModel: 'Model',
      usageModelSummary: 'Model summary',
      usageRange: 'Time range',
      usageRefresh: 'Refresh',
      usageTableCacheHit: 'Cache hits',
      usageTableCalls: 'Calls',
      usageTableTokens: 'Total tokens',
      usageTokensToday: 'Tokens today',
      usageTokenTrend: 'Token trend',
      viewKey: 'Reveal key',
      waitForCompletion: 'Complete sign-in to continue.',
    },
    'ja-JP': {
      accessKeyCount: (count: number) => `${count} 件の認証情報`,
      accessKeyCreatedAt: (value: string) => `作成: ${value}`,
      accessKeyCurrent: '現在の API key',
      accessKeyEdit: 'API key を編集',
      accessKeyEmptyCredentials: '紐付け可能な有効な認証情報がまだありません。',
      accessKeyExampleName: '例: Claude Team / CI Runner',
      accessKeyHelp:
        'secret はサーバー側で自動生成されます。ここでは名前と紐付ける認証情報のみ変更できます。',
      accessKeyLabel: 'API key',
      accessKeyName: 'API key 名',
      accessKeyUpdatedAt: (value: string) => `更新: ${value}`,
      apiEndpointTitle: 'API エンドポイント',
      apiEndpointTooltip: 'API エンドポイントをコピー',
      apiExampleCurl: 'curl 例:',
      apiExamplePython: 'Python 例:',
      apiExamplesTitle: 'API 利用例',
      apiTestCredential: '認証情報',
      apiTestFollowCurrent: '現在のローテーションに従う',
      apiTestMessage: 'テストメッセージ',
      apiTestPlaceholder: 'テストメッセージを入力...',
      apiTestResult: 'レスポンス',
      apiTestIdle: '「送信テスト」をクリックすると API 応答を表示します...',
      apiTestSend: '送信テスト',
      apiTestRunning: 'リクエスト送信中...',
      apiTestStream: 'ストリーミング応答',
      apiTestTitle: 'チャット補完テスト',
      autoAuthDescription:
        'CodeBuddy OAuth フローを開始すると、サインイン完了後にコンソールが認証情報を自動保存します。',
      autoAuthGenerated: '認証リンクを生成しました',
      autoAuthGeneratedDescription:
        '以下のリンクを開いて CodeBuddy アカウントにサインインしてください:',
      autoAuthManual: '手動コールバック',
      autoAuthManualBack: '自動モードに戻る',
      autoAuthManualDescription:
        '自動検出に失敗した場合は、サインイン後にブラウザのアドレスバーの URL 全体を貼り付けてください。',
      autoAuthManualInput: 'コールバック URL を貼り付け...',
      autoAuthManualTitle: 'コールバック URL を手動入力',
      autoAuthOpen: 'リンクを開く',
      autoAuthPending: '認証完了を待っています...',
      autoAuthPendingHint:
        'サインイン完了後、コンソールが認証情報を取得して保存します。',
      autoAuthPoll: '認証状態を確認',
      autoAuthStart: '認証を開始',
      autoAuthTitle: '自動認証',
      availableCredentials: '有効な認証情報',
      copyLink: 'リンクをコピー',
      copyLinkHint: 'リンクをコピー',
      credentialBadgeActive: '有効',
      credentialBadgeExpired: '期限切れ',
      credentialBadgeNext: '次のローテーション',
      credentialBindings: '紐付け認証情報',
      credentialCurrentNone: '現在の認証情報状態はまだありません。',
      credentialCurrentNoCredentials: '現在利用可能な認証情報はありません。',
      credentialCurrentWithAccessKeys:
        'API key が有効です。リクエストは各 key に紐付いた認証情報の範囲でローテーションします。',
      credentialCurrentWithoutAccessKeys:
        'API key は未設定です。リクエストは利用可能な全認証情報でローテーションします。',
      credentialEditTitle: '認証情報設定を編集',
      credentialEmpty:
        '認証情報がありません。先に認証するか手動で追加してください。',
      credentialExpired: '期限切れの認証情報',
      credentialRefreshList: '更新',
      credentialResponsesDirect: 'Responses リクエストを上流へ直接送信',
      credentialResponsesDirectHelp:
        '有効にすると、この認証情報で処理される `/v1/responses` リクエストは Chat Completions へ変換せず上流へ直接送信されます。',
      credentialResponsesProxy:
        'Responses リクエストを Chat Completions に変換してから上流へ送信',
      credentialResponsesProxyTag: 'Responses → Chat',
      credentialRoleAsSystem: 'developer メッセージを上流向けに正規化',
      credentialRoleAsSystemTag: 'developer → system',
      credentialRoleAsSystemHelp:
        '先頭の developer メッセージは system、それ以降の developer メッセージは user として送信します。',
      credentialRoleKeepDeveloper: 'developer を保持',
      credentialSave: '保存',
      credentialSectionTitle: '保存済み認証情報',
      credentialUserId: 'ユーザー ID (任意)',
      credentialUserIdPlaceholder: 'ユーザー ID を入力 (任意)',
      dashboardActive: (count: number) => `${count} 件が有効`,
      dashboardApiCalls: 'API 呼び出し総数',
      dashboardCredentialUsage: '認証情報利用状況',
      dashboardCredentials: '認証情報総数',
      dashboardModelName: 'モデル名',
      dashboardModelUsage: 'モデル利用統計',
      dashboardNoCredentialUsage: '認証情報の利用記録はまだありません',
      dashboardNoModelUsage: 'モデル利用記録はまだありません',
      dashboardRefreshPending: '更新待ち',
      dashboardServiceStatus: 'サービス稼働状況',
      debugClear: 'クリア',
      debugCopy: 'コピー',
      debugEventData: 'データ',
      debugEventIndex: 'イベント',
      debugCredential: '認証情報',
      debugCredentialUnknown: '記録なし',
      debugEmpty: 'Debug 記録はまだありません。',
      debugEnable: 'Debug 収集を有効化',
      debugEnableHelp:
        '時刻、request key、リクエスト内容、上流リクエスト、上流レスポンス、変換後レスポンスを記録します。',
      debugLoading: 'Debug 記録を読み込み中...',
      debugMaxEntries: '保持する最大件数',
      debugRefresh: '更新',
      debugRefreshInterval: '自動更新間隔',
      debugRequest: '元のリクエスト',
      debugResponse: '変換後レスポンス',
      debugSave: '保存',
      debugSectionTitle: 'Debug 記録',
      debugUpstreamRequest: '上流リクエスト',
      debugUpstreamResponse: '上流レスポンス',
      debugUpstreamStatus: (value: string | number) => `上流: ${value}`,
      debugReturnedStatus: (value: string | number) => `返却: ${value}`,
      delete: '削除',
      edit: '編集',
      expiredCredentials: '期限切れの認証情報',
      loading: '読み込み中...',
      manualCredentialPlaceholder:
        'CodeBuddy の Bearer Token を入力してください...',
      manualCredentialTitle: '認証情報を手動追加',
      noCurrentState: '現在の状態を読み込み中...',
      range1h: '1 時間',
      range3h: '3 時間',
      range6h: '6 時間',
      range12h: '12 時間',
      range24h: '24 時間',
      range3d: '3 日',
      range7d: '7 日',
      rangeToday: '今日',
      rangeYesterday: '昨日',
      refresh: '更新',
      save: '保存',
      serviceCheckedAt: (value: string) => `最終確認 ${value}`,
      settingsLoading: '設定を読み込んでいます...',
      settingsSave: '保存',
      settingsTitle: 'サービス設定',
      statusUnavailable: '利用不可',
      statusRunning: '稼働中',
      submit: '送信',
      usageAccessKey: 'API key',
      usageAllAccessKeys: 'すべての API key',
      usageAllCredentials: 'すべての認証情報',
      usageAutoRefresh: '自動更新',
      usageCallTrend: '呼び出し推移',
      usageCallsToday: '本日の呼び出し回数',
      usageCacheHitToday: '本日の Cache ヒット Tokens',
      usageClearHistory: '履歴をクリア',
      usageCredential: '認証情報',
      usageEmptyCalls: '現在のフィルターでは呼び出し推移データがありません。',
      usageEmptySummary: 'モデル集計データはまだありません',
      usageEmptyTokens: '現在のフィルターでは Token 推移データがありません。',
      usageFirstLoad: '最初の使用量読み込み待ち',
      usageLastUpdated: (value: string) => `最終更新 ${value}`,
      usageMetricCalls: '呼び出し回数',
      usageMetricTokens: '総 Tokens',
      usageModel: 'モデル',
      usageModelSummary: 'モデル集計',
      usageRange: '期間',
      usageRefresh: '更新',
      usageTableCacheHit: 'Cache ヒット',
      usageTableCalls: '呼び出し回数',
      usageTableTokens: '総 Tokens',
      usageTokensToday: '本日の総 Tokens',
      usageTokenTrend: 'Token 推移',
      viewKey: 'Key を表示',
      waitForCompletion: 'サインイン完了後に続行してください。',
    },
    'zh-CN': {
      accessKeyCount: (count: number) => `${count} 个凭证`,
      accessKeyCreatedAt: (value: string) => `创建于 ${value}`,
      accessKeyCurrent: '当前 API Key',
      accessKeyEdit: '编辑 API Key',
      accessKeyEmptyCredentials: '还没有可绑定的有效凭证。',
      accessKeyExampleName: '例如：Claude Team / CI Runner',
      accessKeyHelp: 'secret 由服务端自动生成；这里只修改名称和绑定凭证。',
      accessKeyLabel: 'API Key',
      accessKeyName: 'API Key 名称',
      accessKeyUpdatedAt: (value: string) => `更新于 ${value}`,
      apiEndpointTitle: 'API 服务端点',
      apiEndpointTooltip: '点击复制 API 端点',
      apiExampleCurl: 'curl 示例:',
      apiExamplePython: 'Python 示例:',
      apiExamplesTitle: 'API 使用示例',
      apiTestCredential: '凭证',
      apiTestFollowCurrent: '跟随当前轮询',
      apiTestMessage: '测试消息',
      apiTestPlaceholder: '输入测试消息...',
      apiTestResult: '响应结果',
      apiTestIdle: '点击“发送测试”查看 API 响应...',
      apiTestSend: '发送测试',
      apiTestRunning: '请求发送中...',
      apiTestStream: '流式响应',
      apiTestTitle: '聊天完成测试',
      autoAuthDescription:
        '点击下方按钮自动启动 CodeBuddy OAuth2 认证流程，系统将自动获取并保存您的认证凭证。',
      autoAuthGenerated: '认证链接已生成',
      autoAuthGeneratedDescription: '请点击下面的链接完成 CodeBuddy 账号登录：',
      autoAuthManual: '手动回调',
      autoAuthManualBack: '返回自动模式',
      autoAuthManualDescription:
        '如果自动检测失败，请在完成登录后，将浏览器地址栏中的完整 URL 粘贴到下面：',
      autoAuthManualInput: '粘贴回调 URL...',
      autoAuthManualTitle: '手动输入回调链接',
      autoAuthOpen: '打开链接',
      autoAuthPending: '等待认证完成...',
      autoAuthPendingHint: '完成登录后系统将自动获取凭证',
      autoAuthPoll: '检查认证状态',
      autoAuthStart: '开始认证',
      autoAuthTitle: '自动获取认证',
      availableCredentials: '可用凭证',
      copyLink: '复制链接',
      copyLinkHint: '点击复制链接',
      credentialBadgeActive: '有效',
      credentialBadgeExpired: '已过期',
      credentialBadgeNext: '下一次轮询',
      credentialBindings: '绑定凭证',
      credentialCurrentNone: '暂无当前凭证信息',
      credentialCurrentNoCredentials: '当前没有可用凭证',
      credentialCurrentWithAccessKeys:
        '已启用 API Key，业务请求会在各自绑定的凭证子集里轮询。',
      credentialCurrentWithoutAccessKeys:
        '当前未配置 API Key，请求会在全局可用凭证之间轮询。',
      credentialEditTitle: '编辑凭证配置',
      credentialEmpty: '暂无凭证，请先认证或手动添加。',
      credentialExpired: '已过期凭证',
      credentialRefreshList: '刷新',
      credentialResponsesDirect: '直接转发 Responses 请求至上游',
      credentialResponsesDirectHelp:
        '开启后，该凭证命中的 `/v1/responses` 请求将直接发送至上游，不再转换为 Chat Completions。',
      credentialResponsesProxy:
        'Responses 请求先转换为 Chat Completions 再发送至上游',
      credentialResponsesProxyTag: 'Responses → Chat',
      credentialRoleAsSystem: '转换 developer 消息角色以兼容上游',
      credentialRoleAsSystemTag: 'developer → system',
      credentialRoleAsSystemHelp:
        '首条 developer 消息作为 system 发送，其余 developer 消息作为 user 发送。',
      credentialRoleKeepDeveloper: '保留 developer',
      credentialSave: '保存',
      credentialSectionTitle: '已保存的凭证',
      credentialUserId: '用户 ID (可选)',
      credentialUserIdPlaceholder: '输入用户 ID (可选)',
      dashboardActive: (count: number) => `${count} 个有效`,
      dashboardApiCalls: '总 API 调用次数',
      dashboardCredentialUsage: '凭证使用统计',
      dashboardCredentials: '总凭证数量',
      dashboardModelName: '模型名称',
      dashboardModelUsage: '模型使用统计',
      dashboardNoCredentialUsage: '暂无凭证使用记录',
      dashboardNoModelUsage: '暂无模型使用记录',
      dashboardRefreshPending: '等待刷新',
      dashboardServiceStatus: '服务运行状态',
      debugClear: '清空',
      debugCopy: '复制',
      debugEventData: '内容',
      debugEventIndex: '事件',
      debugCredential: '凭据',
      debugCredentialUnknown: '未记录',
      debugEmpty: '暂无 Debug 记录。',
      debugEnable: '启用 Debug 采集',
      debugEnableHelp:
        '记录时间、请求 key、请求内容、上游请求、上游回包、转换后回包。',
      debugLoading: '加载 Debug 记录中...',
      debugMaxEntries: '最大保留条数',
      debugRefresh: '刷新',
      debugRefreshInterval: '自动刷新时间',
      debugRequest: '原始请求',
      debugResponse: '转换后回包',
      debugSave: '保存',
      debugSectionTitle: 'Debug 记录',
      debugUpstreamRequest: '上游请求',
      debugUpstreamResponse: '上游回包',
      debugUpstreamStatus: (value: string | number) => `上游状态: ${value}`,
      debugReturnedStatus: (value: string | number) => `返回状态: ${value}`,
      delete: '删除',
      edit: '编辑',
      expiredCredentials: '已过期凭证',
      loading: '加载中...',
      manualCredentialPlaceholder: '输入您的 CodeBuddy Bearer Token...',
      manualCredentialTitle: '手动添加凭证',
      noCurrentState: '加载当前状态...',
      range1h: '1 小时',
      range3h: '3 小时',
      range6h: '6 小时',
      range12h: '12 小时',
      range24h: '24 小时',
      range3d: '3 天',
      range7d: '7 天',
      rangeToday: '今天',
      rangeYesterday: '昨天',
      refresh: '刷新',
      save: '保存',
      serviceCheckedAt: (value: string) => `最后检查 ${value}`,
      settingsLoading: '加载配置中...',
      settingsSave: '保存',
      settingsTitle: '服务配置',
      statusUnavailable: '不可用',
      statusRunning: '运行中',
      submit: '提交',
      usageAccessKey: 'API Key',
      usageAllAccessKeys: '全部 API Key',
      usageAllCredentials: '全部凭据',
      usageAutoRefresh: '自动刷新',
      usageCallTrend: '调用次数趋势',
      usageCallsToday: '今日调用次数',
      usageCacheHitToday: '今日 Cache 命中 Tokens',
      usageClearHistory: '清空历史',
      usageCredential: '凭证',
      usageEmptyCalls: '当前筛选条件下暂无调用趋势数据',
      usageEmptySummary: '暂无模型汇总数据',
      usageEmptyTokens: '当前筛选条件下暂无 Token 趋势数据',
      usageFirstLoad: '等待首次加载用量统计数据',
      usageLastUpdated: (value: string) => `最后更新于 ${value}`,
      usageMetricCalls: '调用次数',
      usageMetricTokens: '总 Tokens',
      usageModel: '模型',
      usageModelSummary: '模型汇总',
      usageRange: '时间范围',
      usageRefresh: '刷新',
      usageTableCacheHit: 'Cache 命中',
      usageTableCalls: '调用次数',
      usageTableTokens: '总 Tokens',
      usageTokensToday: '今日总 Tokens',
      usageTokenTrend: 'Token 消耗趋势',
      viewKey: '查看 Key',
      waitForCompletion: '完成登录后系统将自动获取凭证',
    },
  }[locale];
};

const getUsageRangeOptions = (
  text: ReturnType<typeof getLocalizedAdminText>,
) => {
  return [
    { label: text.range1h, value: '1h' },
    { label: text.range3h, value: '3h' },
    { label: text.range6h, value: '6h' },
    { label: text.range12h, value: '12h' },
    { label: text.range24h, value: '24h' },
    { label: text.range3d, value: '3d' },
    { label: text.range7d, value: '7d' },
    { label: text.rangeToday, value: 'today' },
    { label: text.rangeYesterday, value: 'yesterday' },
  ] satisfies Array<{ label: string; value: UsageRange }>;
};

const getUsageAutoRefreshOptions = (
  locale: AppLocale,
): Array<{ label: string; value: number }> => {
  const units = {
    'en-US': { minute: 'min', second: 'sec', off: 'Off' },
    'ja-JP': { minute: '分', second: '秒', off: 'オフ' },
    'zh-CN': { minute: '秒', second: '秒', off: '关闭' },
  }[locale];

  return [
    { label: units.off, value: 0 },
    { label: `5 ${units.second}`, value: 5 },
    { label: `15 ${units.second}`, value: 15 },
    { label: `30 ${units.second}`, value: 30 },
    {
      label: locale === 'en-US' ? `60 ${units.second}` : `60 ${units.second}`,
      value: 60,
    },
    {
      label: locale === 'en-US' ? `300 ${units.second}` : `300 ${units.second}`,
      value: 300,
    },
  ];
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
  text: ReturnType<typeof getLocalizedAdminText>,
) => {
  if (
    current?.status === 'round_robin' &&
    current.next_filename === credential.filename
  ) {
    return {
      color: 'green',
      label: text.credentialBadgeNext,
    };
  }

  if (credential.is_expired) {
    return {
      color: 'red',
      label: text.credentialBadgeExpired,
    };
  }

  return {
    color: 'green',
    label: text.credentialBadgeActive,
  };
};

const formatDateTime = (
  locale: AppLocale,
  timestamp: number | null | undefined,
) => {
  if (!timestamp) {
    return 'Unknown';
  }

  return new Date(timestamp * 1000).toLocaleString(locale);
};

const formatCurrentStatus = (
  current: CurrentCredentialInfo | null,
  text: ReturnType<typeof getLocalizedAdminText>,
) => {
  if (!current) {
    return text.credentialCurrentNone;
  }

  if (current.status === 'no_credentials') {
    return text.credentialCurrentNoCredentials;
  }

  if (current.status === 'access_keys_enabled') {
    return text.credentialCurrentWithAccessKeys;
  }

  return text.credentialCurrentWithoutAccessKeys;
};

const formatNumber = (locale: AppLocale, value: number) => {
  return new Intl.NumberFormat(locale).format(value);
};

const formatCompactNumber = (locale: AppLocale, value: number) => {
  const units = [
    { divisor: 1_000_000_000, suffix: 'b' },
    { divisor: 1_000_000, suffix: 'm' },
    { divisor: 1_000, suffix: 'k' },
  ];
  const unit = units.find((item) => Math.abs(value) >= item.divisor);

  if (!unit) {
    return formatNumber(locale, value);
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(value / unit.divisor)}${unit.suffix}`;
};

const SectionTitle = ({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) => {
  return (
    <Flexbox align="center" gap={8} horizontal>
      <Icon aria-hidden="true" size={18} strokeWidth={2} />
      <h3 className="section-title">{title}</h3>
    </Flexbox>
  );
};

const getMonotoneLinePath = (points: Array<{ x: number; y: number }>) => {
  if (!points.length) {
    return '';
  }

  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  const slopes = points.slice(1).map((point, index) => {
    const previousPoint = points[index];

    return (point.y - previousPoint.y) / (point.x - previousPoint.x);
  });
  const tangents = points.map((point, index) => {
    if (index === 0) {
      return slopes[0];
    }

    if (index === points.length - 1) {
      return slopes.at(-1) ?? 0;
    }

    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];

    if (
      previousSlope === 0 ||
      nextSlope === 0 ||
      previousSlope * nextSlope < 0
    ) {
      return 0;
    }

    const previousDistance = point.x - points[index - 1].x;
    const nextDistance = points[index + 1].x - point.x;
    const previousWeight = 2 * nextDistance + previousDistance;
    const nextWeight = nextDistance + 2 * previousDistance;

    return (
      (previousWeight + nextWeight) /
      (previousWeight / previousSlope + nextWeight / nextSlope)
    );
  });
  const segments = points.slice(1).map((point, index) => {
    const previousPoint = points[index];
    const horizontalDistance = point.x - previousPoint.x;
    const firstControlPoint = {
      x: previousPoint.x + horizontalDistance / 3,
      y: previousPoint.y + (tangents[index] * horizontalDistance) / 3,
    };
    const secondControlPoint = {
      x: point.x - horizontalDistance / 3,
      y: point.y - (tangents[index + 1] * horizontalDistance) / 3,
    };

    return `C ${firstControlPoint.x} ${firstControlPoint.y}, ${secondControlPoint.x} ${secondControlPoint.y}, ${point.x} ${point.y}`;
  });

  return `M ${points[0].x} ${points[0].y} ${segments.join(' ')}`;
};

const USAGE_CHART_DESKTOP_WIDTH = 1000;
const USAGE_CHART_MOBILE_WIDTH = 320;

const renderUsageChart = ({
  chart,
  chartWidth: width,
  emptyLabel,
  hoveredPoint,
  locale,
  metric,
  text,
  onHoverPoint,
  series,
  title,
}: {
  chart: 'calls' | 'tokens';
  chartWidth: number;
  emptyLabel: string;
  hoveredPoint: UsageState['hoveredPoint'];
  locale: AppLocale;
  metric: 'callCount' | 'totalTokens';
  text: ReturnType<typeof getLocalizedAdminText>;
  onHoverPoint: UsageSectionProps['onHoverPoint'];
  series: UsageState['callSeries'];
  title: string;
}) => {
  const height = 260;
  const padding = { bottom: 36, left: 52, right: 24, top: 16 };
  const firstSeries = series[0];
  const labels = firstSeries?.points.map((point) => point.label) ?? [];
  const pointCount = labels.length;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const axisLabelFontSize = width < 640 ? 11 : 8;
  const largestValue = Math.max(
    1,
    ...series.flatMap((item) => item.points.map((point) => point[metric] ?? 0)),
  );
  const gridStep = Math.max(5, Math.ceil(largestValue / 20) * 5);
  const gridStepCount = Math.ceil(largestValue / gridStep);
  const maxValue = gridStep * gridStepCount;

  const getX = (index: number) => {
    if (pointCount <= 1) {
      return padding.left + chartWidth / 2;
    }

    return padding.left + (chartWidth / (pointCount - 1)) * index;
  };

  const getY = (value: number) => {
    return padding.top + chartHeight - (value / maxValue) * chartHeight;
  };

  const gridValues = Array.from(
    { length: gridStepCount },
    (_, index) => gridStep * (index + 1),
  ).reverse();
  const xLabelInterval = Math.max(1, Math.ceil((pointCount - 1) / 3));

  return (
    <Block direction="vertical" gap={16} padding={24} variant="outlined">
      <SectionTitle icon={ChartLine} title={title} />
      {series.length && pointCount ? (
        <div className="usage-chart relative">
          <Flexbox className="mb-3" gap={6} wrap="wrap">
            {series.map((item, index) => {
              const color = CHART_COLORS[index % CHART_COLORS.length];

              return (
                <Flexbox align="center" gap={6} horizontal key={item.model}>
                  <span
                    aria-hidden="true"
                    className="h-px w-3 rounded-full"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="text-[11px] font-medium"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ color }}
                  >
                    {item.model}
                  </span>
                </Flexbox>
              );
            })}
          </Flexbox>
          <svg
            aria-label={title}
            className="usage-chart-svg h-auto w-full overflow-visible"
            role="img"
            viewBox={`0 0 ${width} ${height}`}
          >
            <title>{title}</title>
            {gridValues.map((value) => {
              const y = getY(value);

              return (
                <g key={`grid-${value}`}>
                  <line
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y}
                    y2={y}
                    className="stroke-border-light dark:stroke-border-dark"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={padding.left - 10}
                    y={y + 4}
                    className="fill-secondary"
                    fontSize={axisLabelFontSize}
                    textAnchor="end"
                  >
                    {formatCompactNumber(locale, value)}
                  </text>
                </g>
              );
            })}
            {series.map((item, seriesIndex) => {
              const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
              const points = item.points.map((point, pointIndex) => ({
                x: getX(pointIndex),
                y: getY(point[metric] ?? 0),
              }));
              const path = getMonotoneLinePath(points);
              return (
                <g key={item.model}>
                  <path
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
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
                        r="2"
                        stroke="transparent"
                        strokeWidth="8"
                        tabIndex={0}
                        onBlur={() => {
                          onHoverPoint(null);
                        }}
                        onFocus={() => {
                          onHoverPoint({
                            chart,
                            label: point.label,
                            metricLabel:
                              metric === 'callCount'
                                ? text.usageMetricCalls
                                : text.usageMetricTokens,
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
                              metric === 'callCount'
                                ? text.usageMetricCalls
                                : text.usageMetricTokens,
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
                className="fill-secondary"
                fontSize={axisLabelFontSize}
                textAnchor={
                  index === 0
                    ? 'start'
                    : index === labels.length - 1
                      ? 'end'
                      : 'middle'
                }
              >
                {index === 0 ||
                index === labels.length - 1 ||
                index % xLabelInterval === 0
                  ? label
                  : ''}
              </text>
            ))}
          </svg>
          {hoveredPoint?.chart === chart ? (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full"
              // eslint-disable-next-line react/forbid-dom-props
              style={{
                left: `${(hoveredPoint.x / width) * 100}%`,
                top: `${(hoveredPoint.y / height) * 100}%`,
              }}
            >
              <Block
                className="min-w-44 text-xs"
                direction="vertical"
                gap={4}
                padding={12}
                variant="outlined"
              >
                <div className="font-semibold">{hoveredPoint.model}</div>
                <div className="mt-1 text-secondary">{hoveredPoint.label}</div>
                <div className="mt-1">
                  {hoveredPoint.metricLabel}:{' '}
                  <span className="font-semibold">
                    {formatNumber(locale, hoveredPoint.value)}
                  </span>
                </div>
              </Block>
            </div>
          ) : null}
        </div>
      ) : (
        <Flexbox
          align="center"
          className="py-12 text-secondary"
          direction="vertical"
          gap={8}
        >
          <ChartLine aria-hidden="true" size={18} strokeWidth={2} />
          <div className="mt-2">{emptyLabel}</div>
        </Flexbox>
      )}
    </Block>
  );
};

const SettingsInput = ({
  label,
  settingKey,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
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
        <Select
          id={settingKey}
          className="w-full"
          value={value}
          onChange={onChange}
          options={[
            { label: 'auto', value: 'auto' },
            { label: 'token', value: 'token' },
          ]}
        />
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
        <Select
          id={settingKey}
          className="w-full"
          value={value}
          onChange={onChange}
          options={[
            { label: 'ioa', value: 'ioa' },
            { label: 'internal', value: 'internal' },
            { label: 'public', value: 'public' },
          ]}
        />
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
        <Select
          id={settingKey}
          className="w-full"
          value={value}
          onChange={onChange}
          options={[
            { label: 'DEBUG', value: 'DEBUG' },
            { label: 'INFO', value: 'INFO' },
            { label: 'WARNING', value: 'WARNING' },
            { label: 'ERROR', value: 'ERROR' },
          ]}
        />
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
        <TextArea
          id={settingKey}
          rows={6}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
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
      <Input
        id={settingKey}
        placeholder={placeholder}
        type="text"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
};

const ToggleOption = ({
  checked,
  description,
  onChange,
  title,
}: {
  checked: boolean;
  description: string;
  onChange: (checked: boolean) => void;
  title: string;
}) => {
  return (
    <Block
      align="center"
      className="toggle-option"
      distribution="space-between"
      gap={16}
      horizontal
      onClick={(event) => {
        if ((event.target as Element).closest('button')) {
          return;
        }

        onChange(!checked);
      }}
      padding={12}
      variant="outlined"
    >
      <div>
        <div className="font-medium text-text-light dark:text-text-dark">
          {title}
        </div>
        <div className="text-sm text-secondary">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </Block>
  );
};

const CredentialCard = ({
  credential,
  current,
  form,
  locale,
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
  locale: AppLocale;
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onDelete: () => void;
  onEdit: () => void;
  onResetCredentialForm: () => void;
  onSaveCredential: () => void;
}) => {
  const text = getLocalizedAdminText(locale);
  const common = useTranslations('Admin.common');
  const badge = getCredentialBadge(credential, current, text);
  const avatarText = (credential.name ?? credential.email ?? credential.user_id)
    .slice(0, 1)
    .toUpperCase();
  const isEditing = form.editingIndex === credential.index;

  return (
    <Block
      className="credential-card"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <div className="credential-card-header flex items-center gap-4">
        <Avatar avatar={avatarText || 'C'} size={48} />
        <div className="credential-card-content flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-semibold text-text-light dark:text-text-dark">
              {credential.filename}
            </div>
            <Tag color={badge.color}>{badge.label}</Tag>
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-secondary">
            <span className="flex items-center gap-1">
              <UserRound aria-hidden="true" size={14} />
              {credential.email || credential.user_id}
            </span>
            <span className="flex items-center gap-1">
              <Globe2 aria-hidden="true" size={14} />
              {credential.domain}
            </span>
            <span className="flex items-center gap-1">
              <Clock3 aria-hidden="true" size={14} />
              {credential.time_remaining_str}
            </span>
            <span className="flex items-center gap-1">
              <CalendarDays aria-hidden="true" size={14} />
              {formatDateTime(locale, credential.created_at)}
            </span>
          </div>
          <Flexbox gap={8} paddingBlock={8} wrap="wrap">
            <Tag>
              {credential.responses_passthrough
                ? text.credentialResponsesDirect
                : text.credentialResponsesProxyTag}
            </Tag>
            <Tag>
              {credential.first_message_role_to_system
                ? text.credentialRoleAsSystemTag
                : text.credentialRoleKeepDeveloper}
            </Tag>
          </Flexbox>
        </div>
        <div className="credential-card-actions flex gap-2 shrink-0">
          <Button icon={Pencil} onClick={onEdit} type="primary">
            {text.edit}
          </Button>
          <Button danger icon={Trash2} onClick={onDelete}>
            {text.delete}
          </Button>
        </div>
      </div>
      {isEditing ? (
        <Flexbox direction="vertical" gap={12}>
          <div className="mb-3 font-medium text-text-light dark:text-text-dark">
            {text.credentialEditTitle}
          </div>
          <div className="mb-4 grid gap-3">
            <ToggleOption
              checked={form.responsesPassthrough}
              description={text.credentialResponsesDirectHelp}
              onChange={onCredentialResponsesPassthroughChange}
              title={text.credentialResponsesDirect}
            />
            <ToggleOption
              checked={form.firstMessageRoleToSystem}
              description={text.credentialRoleAsSystemHelp}
              onChange={onCredentialFirstMessageRoleToSystemChange}
              title={text.credentialRoleAsSystem}
            />
          </div>
          <Flexbox gap={8} horizontal>
            <Button icon={X} onClick={onResetCredentialForm}>
              {common('cancel')}
            </Button>
            <Button icon={Save} onClick={onSaveCredential} type="primary">
              {text.credentialSave}
            </Button>
          </Flexbox>
        </Flexbox>
      ) : null}
    </Block>
  );
};

const CredentialGroup = ({
  current,
  form,
  items,
  locale,
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
  locale: AppLocale;
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onDelete: (index: number) => void;
  onEdit: (credential: CredentialSummary) => void;
  onResetCredentialForm: () => void;
  onSaveCredential: () => void;
  title?: string;
}) => {
  if (!items.length) {
    return null;
  }

  const cards = (
    <div className="grid gap-4">
      {items.map((credential) => (
        <CredentialCard
          key={credential.filename}
          credential={credential}
          current={current}
          form={form}
          locale={locale}
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
  );

  if (!title) {
    return <div className="mb-6">{cards}</div>;
  }

  return (
    <div className="mb-6">
      <Block
        className="credentials-group"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <Flexbox
          align="center"
          className="credential-group-heading"
          distribution="space-between"
          horizontal
        >
          <SectionTitle icon={Layers3} title={title} />
          <Tag>{items.length}</Tag>
        </Flexbox>
        {cards}
      </Block>
    </div>
  );
};

const AccessKeyCard = ({
  accessKey,
  actionId,
  form,
  locale,
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
  locale: AppLocale;
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
  const text = getLocalizedAdminText(locale);
  const common = useTranslations('Admin.common');
  const isEditing = form.editingId === accessKey.id;
  const isRevealed = revealedSecret?.id === accessKey.id;
  const isBusy = actionId === accessKey.id;

  return (
    <Block
      className="access-key-card"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <div className="access-key-card-header flex items-start justify-between gap-4">
        <div className="access-key-card-content min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-semibold text-text-light dark:text-text-dark">
              {accessKey.name}
            </div>
            <Tag color="blue">
              {text.accessKeyCount(accessKey.credentialFilenames.length)}
            </Tag>
          </div>
          <div className="font-mono text-sm text-secondary break-all">
            {accessKey.maskedSecret}
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-secondary mt-3">
            <span className="flex items-center gap-1">
              <CalendarDays aria-hidden="true" size={14} />
              {text.accessKeyCreatedAt(
                new Date(accessKey.createdAt).toLocaleString(locale),
              )}
            </span>
            <span className="flex items-center gap-1">
              <Pencil aria-hidden="true" size={14} />
              {text.accessKeyUpdatedAt(
                new Date(accessKey.updatedAt).toLocaleString(locale),
              )}
            </span>
          </div>
          <Flexbox gap={8} wrap="wrap">
            {accessKey.credentialFilenames.map((filename) => (
              <Tag key={filename}>{filename}</Tag>
            ))}
          </Flexbox>
        </div>
        <div className="access-key-card-actions flex gap-2 shrink-0">
          <Button disabled={isBusy} icon={Eye} onClick={onRevealSecret}>
            {text.viewKey}
          </Button>
          <Button icon={Pencil} onClick={onEdit} type="primary">
            {text.edit}
          </Button>
          <Button danger disabled={isBusy} icon={Trash2} onClick={onDelete}>
            {text.delete}
          </Button>
        </div>
      </div>
      {isRevealed ? (
        <Flexbox direction="vertical" gap={8}>
          <div className="mb-2 font-medium text-text-light dark:text-text-dark">
            {text.accessKeyCurrent}
          </div>
          <Block
            className="font-mono text-sm break-all"
            padding={12}
            variant="outlined"
          >
            {revealedSecret?.secret.replace(/^Bearer\s+/i, '')}
          </Block>
        </Flexbox>
      ) : null}
      {isEditing ? (
        <Flexbox direction="vertical" gap={16}>
          <div className="font-medium text-text-light dark:text-text-dark">
            {text.accessKeyEdit}
          </div>
          <div className="text-sm text-secondary mt-2">
            {text.accessKeyHelp}
          </div>
          <div className="mt-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor={`accessKeyName-${accessKey.id}`}
            >
              {text.accessKeyName}
            </label>
            <Input
              id={`accessKeyName-${accessKey.id}`}
              placeholder={text.accessKeyExampleName}
              type="text"
              value={form.name}
              onChange={(event) => {
                onUpdateAccessKeyName(event.target.value);
              }}
            />
          </div>
          <div className="mt-4">
            <div className="block mb-2 font-medium text-text-light dark:text-text-dark">
              {text.credentialBindings}
            </div>
            <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
              {validCredentials.length ? (
                validCredentials.map((credential) => {
                  const selected = form.credentialFilenames.includes(
                    credential.filename,
                  );

                  return (
                    <Block
                      as="label"
                      key={credential.filename}
                      align="center"
                      clickable
                      distribution="space-between"
                      gap={16}
                      horizontal
                      padding={12}
                      variant="outlined"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-text-light dark:text-text-dark">
                          {credential.filename}
                        </div>
                        <div className="text-sm text-secondary">
                          {credential.email || credential.user_id}
                        </div>
                      </div>
                      <Checkbox
                        checked={selected}
                        onChange={() => {
                          onToggleCredentialSelection(credential.filename);
                        }}
                      />
                    </Block>
                  );
                })
              ) : (
                <div className="text-sm text-secondary">
                  {text.accessKeyEmptyCredentials}
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button icon={X} onClick={onResetAccessKeyForm}>
              {common('cancel')}
            </Button>
            <Button
              disabled={isBusy}
              icon={Save}
              onClick={onSaveAccessKey}
              type="primary"
            >
              {text.save}
            </Button>
          </div>
        </Flexbox>
      ) : null}
    </Block>
  );
};

export const TabNav = ({ activeTab, onChange }: TabNavProps) => {
  const translations = useTranslations('Admin.tabs');

  return (
    <Tabs
      activeKey={activeTab}
      className="console-tabs"
      classNames={{ indicator: 'console-tabs-indicator' }}
      items={TAB_ITEMS.map((tab) => {
        const Icon = TAB_ICONS[tab.key];

        return {
          icon: <Icon aria-hidden="true" size={16} strokeWidth={2} />,
          key: tab.key,
          label: translations(tab.key === 'api-test' ? 'apiTest' : tab.key),
        };
      })}
      onChange={(key) => {
        onChange(key as TabKey);
      }}
      variant="square"
    />
  );
};

export const DashboardSection = ({
  onCopyEndpoint,
  onRefresh,
  state,
}: DashboardSectionProps) => {
  const locale = useLocale() as AppLocale;
  const text = getLocalizedAdminText(locale);
  const checkedAtText =
    state.lastCheckedAt || state.uptimeText || text.dashboardRefreshPending;
  const statusText =
    state.serviceStatus === 'online'
      ? text.statusRunning
      : state.serviceStatus === 'offline'
        ? text.statusUnavailable
        : state.statusText;

  return (
    <Flexbox direction="vertical" gap={24} id="dashboard">
      <div className="dashboard-metric-grid">
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <KeyRound aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {text.dashboardCredentials}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="whitespace-nowrap text-2xl font-bold text-text-light dark:text-text-dark leading-none"
              id="totalCredentials"
            >
              {state.totalCredentials}
            </div>
            <div
              className="relative h-14 w-14 shrink-0"
              id="credentialUsageRing"
            >
              <svg height="56" width="56">
                <circle
                  cx="28"
                  cy="28"
                  r="20"
                  className="fill-none stroke-border-light dark:stroke-border-dark stroke-4"
                />
                <circle
                  cx="28"
                  cy="28"
                  r="20"
                  className="fill-none stroke-primary stroke-4 transition-all"
                  id="credentialRingProgress"
                  // eslint-disable-next-line react/forbid-dom-props
                  style={getRingStyle(state.credentialUsagePercent)}
                />
              </svg>
              <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold text-text-light dark:text-text-dark"
                id="credentialUsagePercent"
              >
                {Math.round(state.credentialUsagePercent)}%
              </div>
            </div>
          </Flexbox>
          <Flexbox align="center" gap={4} horizontal id="credentialTrend">
            <Check aria-hidden="true" size={14} strokeWidth={2} />
            <span id="validCredentials">
              {text.dashboardActive(state.validCredentials)}
            </span>
          </Flexbox>
        </Block>
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <Server
              aria-hidden="true"
              id="serviceStatusIcon"
              size={18}
              strokeWidth={2}
            />
            <div className="dashboard-metric-label">
              {text.dashboardServiceStatus}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="text-2xl font-bold text-text-light dark:text-text-dark leading-none"
              id="statusText"
            >
              {statusText}
            </div>
            <Tag
              color={
                state.serviceStatus === 'online'
                  ? 'success'
                  : state.serviceStatus === 'offline'
                    ? 'error'
                    : 'warning'
              }
              id="serviceStatus"
              variant="borderless"
            >
              <span id="statusDot" />
            </Tag>
          </Flexbox>
          <Flexbox
            align="center"
            className="dashboard-metric-footer"
            gap={4}
            horizontal
            id="uptimeTrend"
          >
            <Clock3 aria-hidden="true" size={14} strokeWidth={2} />
            <span aria-live="polite" id="uptime">
              {checkedAtText}
            </span>
          </Flexbox>
        </Block>
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <Link aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {text.apiEndpointTitle}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="text-lg font-bold text-text-light dark:text-text-dark leading-none break-all"
              id="apiEndpoint"
            >
              {state.apiEndpoint || '-'}
            </div>
            <ActionIcon
              aria-label={text.copyLink}
              icon={Copy}
              onClick={onCopyEndpoint}
              title={text.copyLink}
            />
          </Flexbox>
        </Block>
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <ChartNoAxesCombined aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {text.dashboardApiCalls}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="text-2xl font-bold text-text-light dark:text-text-dark leading-none"
              id="totalApiCalls"
            >
              {state.totalApiCalls}
            </div>
            <div className="relative h-14 w-14 shrink-0" id="totalUsageRing">
              <svg height="56" width="56">
                <circle
                  cx="28"
                  cy="28"
                  r="20"
                  className="fill-none stroke-border-light dark:stroke-border-dark stroke-4"
                />
                <circle
                  cx="28"
                  cy="28"
                  r="20"
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
          </Flexbox>
          <Flexbox
            align="center"
            className="dashboard-metric-footer"
            gap={4}
            horizontal
            id="apiCallsTrend"
          >
            <Clock3 aria-hidden="true" size={14} strokeWidth={2} />
            <span>{checkedAtText}</span>
          </Flexbox>
        </Block>
      </div>
      <Block
        className="dashboard-data-block"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <Flexbox align="center" distribution="space-between" horizontal>
          <SectionTitle icon={BarChart3} title={text.dashboardModelUsage} />
          <Button
            className="dashboard-refresh"
            icon={RefreshCw}
            onClick={onRefresh}
            type="primary"
          >
            {text.refresh}
          </Button>
        </Flexbox>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  {text.dashboardModelName}
                </th>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark text-right">
                  {text.usageTableCalls}
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
                    {text.dashboardNoModelUsage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Block>
      <Block
        className="dashboard-data-block"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <SectionTitle icon={KeyRound} title={text.dashboardCredentialUsage} />
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  {text.usageCredential}
                </th>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark text-right">
                  {text.usageTableCalls}
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
                    {text.dashboardNoCredentialUsage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Block>
    </Flexbox>
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
  const locale = useLocale() as AppLocale;
  const text = getLocalizedAdminText(locale);
  const autoRefreshOptions = getUsageAutoRefreshOptions(locale);
  const rangeOptions = getUsageRangeOptions(text);
  const credentialOptions = state.filters.credentials.map((option) => ({
    ...option,
    label: option.value === 'all' ? text.usageAllCredentials : option.label,
  }));
  const accessKeyOptions = state.filters.accessKeys.map((option) => ({
    ...option,
    label: option.value === 'all' ? text.usageAllAccessKeys : option.label,
  }));

  return (
    <div id="usage" className="block">
      {state.autoRefreshVisible ? (
        <Block
          className="mb-6"
          direction="vertical"
          gap={12}
          padding={16}
          variant="outlined"
        >
          <div className="flex items-center gap-3 text-sm text-text-light dark:text-text-dark">
            <label className="usage-auto-refresh-label inline-flex items-center gap-2 text-secondary">
              {text.usageAutoRefresh}
              <Select
                aria-label={text.usageAutoRefresh}
                value={state.autoRefreshSeconds}
                onChange={(value) => onAutoRefreshSecondsChange(Number(value))}
                options={autoRefreshOptions}
              />
            </label>
          </div>
        </Block>
      ) : null}

      <Block
        className="mb-6"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 flex-1">
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                {text.usageRange}
              </div>
              <Select
                aria-label={text.usageRange}
                className="w-full"
                value={state.request.range}
                onChange={(value) => onRangeChange(value as UsageRange)}
                options={rangeOptions}
              />
            </label>
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                {text.usageCredential}
              </div>
              <Select
                aria-label={text.usageCredential}
                className="w-full"
                value={state.request.credential}
                onChange={onCredentialChange}
                options={credentialOptions}
              />
            </label>
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                {text.usageAccessKey}
              </div>
              <Select
                aria-label={text.usageAccessKey}
                className="w-full"
                value={state.request.accessKey}
                onChange={onAccessKeyChange}
                options={accessKeyOptions}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              htmlType="button"
              icon={state.loading ? LoaderCircle : RefreshCw}
              onClick={onRefresh}
              type="primary"
            >
              {text.usageRefresh}
            </Button>
            <Button
              danger
              htmlType="button"
              icon={Trash2}
              onClick={onClearHistory}
            >
              {text.usageClearHistory}
            </Button>
          </div>
        </div>
        <div className="mt-4 text-sm text-secondary">
          {state.lastUpdatedAt
            ? text.usageLastUpdated(state.lastUpdatedAt)
            : text.usageFirstLoad}
        </div>
      </Block>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-6 mb-6">
        <Block direction="vertical" gap={8} padding={24} variant="outlined">
          <div className="text-sm text-secondary mb-2">
            {text.usageCallsToday}
          </div>
          <div className="text-3xl font-bold text-text-light dark:text-text-dark">
            {formatNumber(locale, state.todaySummary.callCount)}
          </div>
        </Block>
        <Block direction="vertical" gap={8} padding={24} variant="outlined">
          <div className="text-sm text-secondary mb-2">
            {text.usageTokensToday}
          </div>
          <div className="text-3xl font-bold text-text-light dark:text-text-dark">
            {formatNumber(locale, state.todaySummary.totalTokens)}
          </div>
        </Block>
        <Block direction="vertical" gap={8} padding={24} variant="outlined">
          <div className="text-sm text-secondary mb-2">
            {text.usageCacheHitToday}
          </div>
          <div className="text-3xl font-bold text-text-light dark:text-text-dark">
            {formatNumber(locale, state.todaySummary.cacheHitTokens)}
          </div>
        </Block>
      </div>

      <div className="usage-chart-desktop grid gap-6 mb-6">
        {renderUsageChart({
          chart: 'calls',
          chartWidth: USAGE_CHART_DESKTOP_WIDTH,
          emptyLabel: text.usageEmptyCalls,
          hoveredPoint: state.hoveredPoint,
          locale,
          metric: 'callCount',
          onHoverPoint,
          series: state.callSeries,
          text,
          title: text.usageCallTrend,
        })}
        {renderUsageChart({
          chart: 'tokens',
          chartWidth: USAGE_CHART_DESKTOP_WIDTH,
          emptyLabel: text.usageEmptyTokens,
          hoveredPoint: state.hoveredPoint,
          locale,
          metric: 'totalTokens',
          onHoverPoint,
          series: state.tokenSeries,
          text,
          title: text.usageTokenTrend,
        })}
      </div>
      <div className="usage-chart-mobile grid gap-6 mb-6">
        {renderUsageChart({
          chart: 'calls',
          chartWidth: USAGE_CHART_MOBILE_WIDTH,
          emptyLabel: text.usageEmptyCalls,
          hoveredPoint: state.hoveredPoint,
          locale,
          metric: 'callCount',
          onHoverPoint,
          series: state.callSeries,
          text,
          title: text.usageCallTrend,
        })}
        {renderUsageChart({
          chart: 'tokens',
          chartWidth: USAGE_CHART_MOBILE_WIDTH,
          emptyLabel: text.usageEmptyTokens,
          hoveredPoint: state.hoveredPoint,
          locale,
          metric: 'totalTokens',
          onHoverPoint,
          series: state.tokenSeries,
          text,
          title: text.usageTokenTrend,
        })}
      </div>

      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <SectionTitle
          icon={ChartNoAxesCombined}
          title={text.usageModelSummary}
        />
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  {text.usageModel}
                </th>
                <th className="p-3 px-4 text-right font-semibold border-b border-border-light dark:border-border-dark">
                  {text.usageTableCalls}
                </th>
                <th className="p-3 px-4 text-right font-semibold border-b border-border-light dark:border-border-dark">
                  {text.usageTableTokens}
                </th>
                <th className="p-3 px-4 text-right font-semibold border-b border-border-light dark:border-border-dark">
                  {text.usageTableCacheHit}
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
                      {formatNumber(locale, row.callCount)}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(locale, row.totalTokens)}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(locale, row.cacheHitTokens)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={4}
                    className="p-3 px-4 border-b border-border-light dark:border-border-dark text-center"
                  >
                    {text.usageEmptySummary}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Block>
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
  onRefreshAccessKeys,
  onRefreshCredentialList,
  onResetCredentialForm,
  onResetAccessKeyForm,
  onRevealAccessKeySecret,
  onSaveAccessKey,
  onSubmitCallbackUrl,
  onToggleCallbackMode,
  onToggleCredentialSelection,
  onUpdateAccessKeyName,
}: CredentialsSectionProps) => {
  const locale = useLocale() as AppLocale;
  const text = getLocalizedAdminText(locale);
  const validCredentials = credentials.items.filter((item) => !item.is_expired);
  const expiredCredentials = credentials.items.filter(
    (item) => item.is_expired,
  );

  return (
    <div id="credentials" className="block">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <WandSparkles aria-hidden="true" size={18} strokeWidth={2} />
          <h3 className="dashboard-data-title">{text.autoAuthTitle}</h3>
        </Flexbox>
        <p className="text-secondary mb-4">{text.autoAuthDescription}</p>
        <Flexbox horizontal>
          <Button
            id="getAuthBtn"
            disabled={auth.starting}
            icon={Play}
            loading={auth.starting}
            onClick={onAuthAction}
            type="primary"
          >
            {text.autoAuthStart}
          </Button>
        </Flexbox>
        {auth.authUrl ? (
          <Block
            id="authUrlSection"
            direction="vertical"
            gap={16}
            padding={16}
            variant="outlined"
          >
            <SectionTitle icon={Link} title={text.autoAuthGenerated} />
            <p className="text-secondary mb-4">
              {text.autoAuthGeneratedDescription}
            </p>
            <Input
              id="authUrlInput"
              className="font-mono mb-4"
              readOnly
              type="text"
              value={auth.authUrl}
            />
            <Flexbox gap={8} wrap="wrap">
              <Button
                icon={ExternalLink}
                onClick={onOpenAuthUrl}
                type="primary"
              >
                {text.autoAuthOpen}
              </Button>
              <Button icon={Copy} onClick={onCopyAuthUrl}>
                {text.copyLink}
              </Button>
              <Button
                icon={MousePointerClick}
                onClick={() => {
                  onToggleCallbackMode(true);
                }}
              >
                {text.autoAuthManual}
              </Button>
            </Flexbox>
            <Block
              id="autoCallbackSection"
              direction="vertical"
              gap={16}
              padding={16}
              variant="outlined"
            >
              <div className="text-center p-4">
                <div>{auth.message || text.autoAuthPending}</div>
                <small className="text-secondary">
                  {text.autoAuthPendingHint}
                </small>
              </div>
              <div className="mt-4 text-center">
                <Button
                  icon={RefreshCw}
                  loading={auth.polling}
                  onClick={onPollAuth}
                >
                  {text.autoAuthPoll}
                </Button>
              </div>
            </Block>
            {auth.showManualCallback ? (
              <Block
                id="manualCallbackSection"
                direction="vertical"
                gap={16}
                padding={16}
                variant="outlined"
              >
                <h5 className="mb-4">{text.autoAuthManualTitle}</h5>
                <p className="text-secondary text-sm mb-4">
                  {text.autoAuthManualDescription}
                </p>
                <Input
                  id="callbackUrl"
                  className="w-full"
                  placeholder={text.autoAuthManualInput}
                  type="text"
                  value={auth.callbackUrl}
                  onChange={(event) => {
                    onCallbackUrlChange(event.target.value);
                  }}
                />
                <div className="mt-4 text-right">
                  <Button
                    onClick={() => {
                      onToggleCallbackMode(false);
                    }}
                  >
                    {text.autoAuthManualBack}
                  </Button>
                  <Button onClick={onSubmitCallbackUrl} type="primary">
                    {text.submit}
                  </Button>
                </div>
              </Block>
            ) : null}
          </Block>
        ) : null}
      </Block>
      {credentials.form.editingIndex === null ? (
        <Block direction="vertical" gap={16} padding={24} variant="outlined">
          <SectionTitle icon={Pencil} title={text.manualCredentialTitle} />
          <div className="mb-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="bearerToken"
            >
              Bearer Token
              <span className="text-error">*</span>
            </label>
            <TextArea
              id="bearerToken"
              className="w-full"
              placeholder={text.manualCredentialPlaceholder}
              rows={3}
              value={credentials.form.bearerToken}
              onChange={(event) => {
                onCredentialTokenChange(event.target.value);
              }}
            />
          </div>
          <div className="mb-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="userId"
            >
              {text.credentialUserId}
            </label>
            <Input
              id="userId"
              className="w-full"
              placeholder={text.credentialUserIdPlaceholder}
              type="text"
              value={credentials.form.userId}
              onChange={(event) => {
                onCredentialUserIdChange(event.target.value);
              }}
            />
          </div>
          <div className="mb-4 grid gap-3">
            <ToggleOption
              checked={credentials.form.responsesPassthrough}
              description={text.credentialResponsesDirectHelp}
              onChange={onCredentialResponsesPassthroughChange}
              title={text.credentialResponsesDirect}
            />
            <ToggleOption
              checked={credentials.form.firstMessageRoleToSystem}
              description={text.credentialRoleAsSystemHelp}
              onChange={onCredentialFirstMessageRoleToSystemChange}
              title={text.credentialRoleAsSystem}
            />
          </div>
          <Flexbox horizontal>
            <Button icon={Save} onClick={onAddCredential} type="primary">
              {text.save}
            </Button>
          </Flexbox>
        </Block>
      ) : null}
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between">
          <SectionTitle icon={KeyRound} title={text.accessKeyLabel} />
          <Button icon={RefreshCw} onClick={onRefreshAccessKeys}>
            {text.credentialRefreshList}
          </Button>
        </div>
        <div id="accessKeysList">
          {credentials.accessKeysLoading ? (
            <div className="text-center py-8 text-secondary">
              <LoaderCircle />
              <div>{text.loading}</div>
            </div>
          ) : credentials.accessKeys.length ? (
            <div className="grid gap-3">
              {credentials.accessKeys.map((accessKey) => (
                <AccessKeyCard
                  key={accessKey.id}
                  accessKey={accessKey}
                  actionId={credentials.accessKeyActionId}
                  form={credentials.accessKeyForm}
                  locale={locale}
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
              {text.accessKeyEmptyCredentials}
            </div>
          )}
        </div>
      </Block>
      <Block
        className="mb-6"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <div className="flex items-center justify-between">
          <SectionTitle icon={KeyRound} title={text.credentialSectionTitle} />
          <Button icon={RefreshCw} onClick={onRefreshCredentialList}>
            {text.credentialRefreshList}
          </Button>
        </div>
        <div id="currentCredentialStatus">
          {credentials.currentLoading ? (
            <div className="text-center py-8 text-secondary">
              <LoaderCircle />
              <div>{text.noCurrentState}</div>
            </div>
          ) : (
            <div>
              <div className="font-semibold text-text-light dark:text-text-dark">
                {formatCurrentStatus(credentials.current, text)}
              </div>
              {credentials.current?.status !== 'no_credentials' ? (
                <div className="flex flex-wrap gap-4 text-sm text-secondary mt-2">
                  {credentials.current?.available_credential_count !==
                  undefined ? (
                    <span className="flex items-center gap-1">
                      <Layers3 />
                      {text.availableCredentials}{' '}
                      {credentials.current.available_credential_count}
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
              <LoaderCircle />
              <div>{text.loading}</div>
            </div>
          ) : credentials.items.length ? (
            <>
              <CredentialGroup
                current={credentials.current}
                form={credentials.form}
                items={validCredentials}
                locale={locale}
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
              />
              <CredentialGroup
                current={credentials.current}
                form={credentials.form}
                items={expiredCredentials}
                locale={locale}
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
                title={text.credentialExpired}
              />
            </>
          ) : (
            <div className="text-center py-8 text-secondary">
              <Layers3 />
              <div>{text.credentialEmpty}</div>
            </div>
          )}
        </div>
      </Block>
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
  const locale = useLocale() as AppLocale;
  const text = getLocalizedAdminText(locale);
  const availableModels = models.length ? models : [...DEFAULT_TEST_MODELS];
  const selectedModel = availableModels.includes(state.model)
    ? state.model
    : (availableModels[0] ?? '');

  return (
    <div id="api-test" className="block">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <SectionTitle icon={Send} title={text.apiTestTitle} />
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testCredential"
          >
            {text.apiTestCredential}
          </label>
          <Select
            className="w-full"
            id="testCredential"
            value={state.credentialFilename || FOLLOW_CURRENT_CREDENTIAL_VALUE}
            onChange={(value) => {
              onCredentialChange(
                value === FOLLOW_CURRENT_CREDENTIAL_VALUE ? '' : String(value),
              );
            }}
            options={[
              {
                label: text.apiTestFollowCurrent,
                value: FOLLOW_CURRENT_CREDENTIAL_VALUE,
              },
              ...credentialOptions.map((credential) => ({
                label: `${credential.filename} · ${credential.email || credential.user_id}`,
                value: credential.filename,
              })),
            ]}
          />
        </div>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testModel"
          >
            {text.usageModel}
          </label>
          <Select
            className="w-full"
            id="testModel"
            value={selectedModel}
            onChange={onModelChange}
            options={availableModels.map((model) => ({
              label: model,
              value: model,
            }))}
          />
        </div>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testMessage"
          >
            {text.apiTestMessage}
          </label>
          <TextArea
            id="testMessage"
            placeholder={text.apiTestPlaceholder}
            rows={3}
            value={state.message}
            onChange={(event) => {
              onMessageChange(event.target.value);
            }}
          />
        </div>
        <Flexbox align="center" className="mb-4" gap={8} horizontal>
          <span className="font-medium text-text-light dark:text-text-dark">
            {text.apiTestStream}
          </span>
          <Switch
            aria-label={text.apiTestStream}
            checked={state.stream}
            onChange={onStreamChange}
          />
        </Flexbox>
        <Flexbox horizontal>
          <Button
            disabled={state.submitting}
            icon={Send}
            loading={state.submitting}
            onClick={onSubmit}
            type="primary"
          >
            {text.apiTestSend}
          </Button>
        </Flexbox>
        <div className="mb-4 mt-6">
          <label className="block mb-2 font-medium text-text-light dark:text-text-dark">
            {text.apiTestResult}
          </label>
          <Block id="testResult" padding={16} variant="outlined">
            <pre className="m-0 whitespace-pre-wrap">
              {state.result || text.apiTestIdle}
            </pre>
          </Block>
        </div>
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <SectionTitle icon={FileCode2} title={text.apiExamplesTitle} />
        <h4 className="code-sample-title">{text.apiExampleCurl}</h4>
        <Block
          className="code-sample overflow-x-auto font-mono text-sm"
          padding={12}
          variant="outlined"
        >
          <pre>{`curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \\
-H "Authorization: Bearer YOUR_API_KEY" \\
-H "Content-Type: application/json" \\
-d '{
  "model": "glm-5.1",
  "messages": [{ "role": "user", "content": "Hello!" }]
}'`}</pre>
        </Block>
        <h4 className="code-sample-title">{text.apiExamplePython}</h4>
        <Block
          className="code-sample overflow-x-auto font-mono text-sm"
          padding={12}
          variant="outlined"
        >
          <pre>{`import openai

client = openai.OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://127.0.0.1:8001/v1",
)
response = client.chat.completions.create(
    model="glm-5.1",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`}</pre>
        </Block>
      </Block>
    </div>
  );
};

export const SettingsSection = ({
  onChange,
  onSave,
  state,
}: SettingsSectionProps) => {
  const locale = useLocale() as AppLocale;
  const text = getLocalizedAdminText(locale);
  const passkeyRpIdPlaceholder = {
    'en-US': 'Leave empty to follow the current host',
    'ja-JP': '空欄なら現在のホストに追従',
    'zh-CN': '留空则跟随当前访问域名',
  }[locale];
  return (
    <div id="settings" className="block">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <SectionTitle icon={Server} title={text.settingsTitle} />
        <div id="settingsForm">
          {state.loading ? (
            <div className="text-center py-8 text-secondary">
              <LoaderCircle />
              <div>{text.settingsLoading}</div>
            </div>
          ) : (
            Object.entries(state.labels).map(([key, label]) => (
              <SettingsInput
                key={key}
                label={label}
                onChange={(value) => {
                  onChange(key, value);
                }}
                placeholder={
                  key === 'CODEBUDDY_ADMIN_PASSKEY_RP_ID'
                    ? passkeyRpIdPlaceholder
                    : undefined
                }
                settingKey={key}
                value={String(state.values[key] ?? '')}
              />
            ))
          )}
        </div>
        <Flexbox horizontal>
          <Button
            disabled={state.saving}
            icon={Save}
            loading={state.saving}
            onClick={onSave}
            type="primary"
          >
            {text.settingsSave}
          </Button>
        </Flexbox>
      </Block>
      <AdminAuthSettings />
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
  const locale = useLocale() as AppLocale;
  const text = getLocalizedAdminText(locale);
  const renderDebugBlock = (title: string, value: unknown) => {
    const content = JSON.stringify(value ?? null, null, 2);
    const singleLinePreview = content.replace(/\s+/g, ' ').trim() || 'null';
    const sseEvents = parseSseEvents(value);

    return (
      <Block
        as="details"
        className="debug-payload w-full min-w-0 max-w-full"
        padding={12}
        variant="outlined"
      >
        <summary className="debug-payload-summary list-none cursor-pointer p-3 flex items-start justify-between gap-3 w-full min-w-0 max-w-full">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-text-light dark:text-text-dark mb-1">
              {title}
            </div>
            <div className="block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-secondary">
              {singleLinePreview}
            </div>
          </div>
          <Button
            size="small"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCopy(content);
            }}
            icon={Copy}
          >
            {text.debugCopy}
          </Button>
        </summary>
        {sseEvents ? (
          <div className="w-full min-w-0 max-w-full overflow-x-auto p-3 pt-0">
            <table className="w-full min-w-[480px] border-collapse text-xs">
              <thead>
                <tr>
                  <th className="p-3 text-left font-semibold border-b border-border-light dark:border-border-dark">
                    {text.debugEventIndex}
                  </th>
                  <th className="p-3 text-left font-semibold border-b border-border-light dark:border-border-dark">
                    {text.debugEventData}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sseEvents.map((event, index) => {
                  let eventContent = event;

                  try {
                    eventContent = JSON.stringify(JSON.parse(event), null, 2);
                  } catch {
                    eventContent = event;
                  }

                  return (
                    <tr key={`${title}-${index}`}>
                      <td className="p-3 align-top border-b border-border-light dark:border-border-dark text-secondary">
                        {index + 1}
                      </td>
                      <td className="p-3 border-b border-border-light dark:border-border-dark">
                        <pre className="whitespace-pre-wrap break-all text-text-light dark:text-text-dark">
                          {eventContent}
                        </pre>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <pre className="w-full min-w-0 max-w-full overflow-hidden p-3 pt-0 whitespace-pre-wrap break-all text-xs text-text-light dark:text-text-dark">
            {content}
          </pre>
        )}
      </Block>
    );
  };

  return (
    <div id="debug" className="block">
      <Block
        className="debug-section"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <div className="debug-section-header flex items-center justify-between">
          <SectionTitle icon={Info} title={text.debugSectionTitle} />
          <div className="debug-section-actions flex gap-2">
            <div className="min-w-[160px]">
              <label className="sr-only" htmlFor="debugAutoRefreshSeconds">
                {text.debugRefreshInterval}
              </label>
              <Select
                id="debugAutoRefreshSeconds"
                disabled={!state.enabled || state.saving}
                onChange={(value) => {
                  onAutoRefreshSecondsChange(
                    Number.parseInt(String(value), 10) || 0,
                  );
                }}
                options={autoRefreshOptions}
                value={state.autoRefreshSeconds}
              />
            </div>
            <Button icon={RefreshCw} onClick={onRefresh}>
              {text.debugRefresh}
            </Button>
            <Button
              danger
              disabled={state.saving}
              icon={Trash2}
              onClick={onClear}
            >
              {text.debugClear}
            </Button>
          </div>
        </div>
        <div className="debug-settings-grid grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_auto] items-end mb-6">
          <ToggleOption
            checked={state.enabled}
            description={text.debugEnableHelp}
            onChange={onEnabledChange}
            title={text.debugEnable}
          />
          <div>
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="debugMaxEntries"
            >
              {text.debugMaxEntries}
            </label>
            <Input
              id="debugMaxEntries"
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
          <Button
            disabled={state.saving}
            icon={Save}
            loading={state.saving}
            onClick={onSave}
            type="primary"
          >
            {text.debugSave}
          </Button>
        </div>
        {state.loading ? (
          <div className="text-center py-8 text-secondary">
            <LoaderCircle />
            <div>{text.debugLoading}</div>
          </div>
        ) : state.items.length ? (
          <div className="grid gap-4 w-full min-w-0">
            {state.items.map((item) => (
              <Block
                as="details"
                key={item.id}
                className="debug-entry w-full min-w-0 max-w-full"
                padding={16}
                variant="outlined"
              >
                <summary className="debug-entry-summary cursor-pointer list-none p-4 flex flex-wrap items-center justify-between gap-3 w-full min-w-0 max-w-full overflow-hidden">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-text-light dark:text-text-dark">
                      {item.route}
                    </div>
                    <div className="text-sm text-secondary break-all min-w-0 max-w-full">
                      {item.createdAt} · key: {item.requestKey ?? 'none'}
                    </div>
                  </div>
                  <div className="debug-entry-tags flex flex-wrap gap-2 text-xs min-w-0 max-w-full">
                    <Tag variant="borderless">
                      {text.debugUpstreamStatus(
                        item.upstreamResponse?.status ?? '-',
                      )}
                    </Tag>
                    <Tag variant="borderless">
                      {text.debugReturnedStatus(
                        item.transformedResponse?.status ?? '-',
                      )}
                    </Tag>
                    <Tag variant="borderless">
                      {text.debugCredential}:{' '}
                      {item.credentialFilename ?? text.debugCredentialUnknown}
                    </Tag>
                    {item.error ? (
                      <Tag color="red" variant="borderless">
                        {item.error}
                      </Tag>
                    ) : null}
                  </div>
                </summary>
                <div className="debug-entry-content p-4 pt-0 grid gap-4 w-full min-w-0">
                  {renderDebugBlock(text.debugRequest, item.requestBody)}
                  {renderDebugBlock(
                    text.debugUpstreamRequest,
                    item.upstreamRequest?.body,
                  )}
                  {renderDebugBlock(
                    text.debugUpstreamResponse,
                    item.upstreamResponse?.body,
                  )}
                  {renderDebugBlock(
                    text.debugResponse,
                    item.transformedResponse?.body,
                  )}
                </div>
              </Block>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-secondary">
            {text.debugEmpty}
          </div>
        )}
      </Block>
    </div>
  );
};
