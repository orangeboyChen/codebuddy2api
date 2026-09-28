/**
 * The strings the Electron shell itself shows: the menu bar item, its menu,
 * and the window that picks a backend.
 *
 * They live here rather than in `messages/*.json` because the shell is not the
 * console — it cannot call `next-intl`, and it needs them before any server
 * exists to ask. The console's own locale cookie decides which set is used.
 */
export interface DesktopText {
  about: string;
  /** The address of a deployment, asked for in a dialog of the system's own. */
  address: string;
  appVersion: string;
  backend: string;
  backendLocal: string;
  backendLocalHint: string;
  backendRemote: string;
  backendRemoteHint: string;
  backendUrlPlaceholder: string;
  cancel: string;
  changeBackend: string;
  checkForUpdates: string;
  chooseBackend: string;
  copyAddress: string;
  invalidBackendUrl: string;
  invalidPort: string;
  openConsole: string;
  openInBrowser: string;
  port: string;
  portHint: string;
  portInUseBody: string;
  portInUseTitle: string;
  quit: string;
  retry: string;
  save: string;
  serverVersion: string;
  settings: string;
  statusFailed: string;
  statusPortBusy: string;
  statusRunning: string;
  statusStarting: string;
  statusUnreachable: string;
  todayUsage: string;
  unreachableBodyForeign: string;
  unreachableBodyUnreachable: string;
  unreachableTitle: string;
  updateAvailableBody: string;
  updateAvailableTitle: string;
  updateChecking: string;
  updateDownloading: string;
  updateFailed: string;
  updateInstall: string;
  updateLater: string;
  updateNoBuild: string;
  updateUpToDate: string;
  usageUnavailable: string;
}

const texts: Record<'en-US' | 'ja-JP' | 'zh-CN', DesktopText> = {
  'en-US': {
    about: 'CodeBuddy2API on GitHub',
    address: 'Address',
    appVersion: 'Version {version}',
    backend: 'Backend',
    backendLocal: 'This machine',
    backendLocalHint:
      'Runs the gateway bundled into the app on 127.0.0.1. Nothing leaves this computer, and no sign-in is needed.',
    backendRemote: 'A deployment I already run',
    backendRemoteHint:
      'Shows this app’s own console with that deployment’s data, forwarded from there. It may ask you to sign in.',
    backendUrlPlaceholder: 'https://codebuddy.example.com',
    cancel: 'Cancel',
    changeBackend: 'Change backend…',
    checkForUpdates: 'Check for updates…',
    chooseBackend: 'Choose a backend',
    copyAddress: 'Copy address',
    invalidBackendUrl: 'Enter an address starting with http:// or https://',
    invalidPort: 'Enter a whole number between {min} and {max}.',
    openConsole: 'Open console',
    openInBrowser: 'Open in browser',
    port: 'Port',
    portHint:
      'The port this app serves its own console and API on, on this machine.',
    portInUseBody:
      'Something else on this machine is already serving 127.0.0.1:{port}. Pick another port, or stop what is using this one and try again.',
    portInUseTitle: 'Port {port} is already in use',
    quit: 'Quit',
    retry: 'Try again',
    save: 'Save',
    serverVersion: 'Server version {version}',
    settings: 'Settings…',
    statusFailed: 'Gateway failed to start',
    statusPortBusy: 'Port {port} in use',
    statusRunning: 'Running · {address}',
    statusStarting: 'Starting gateway…',
    statusUnreachable: 'Deployment unreachable',
    todayUsage: 'Today {input} / {output}',
    unreachableBodyForeign:
      '{host} answered, but it is not a CodeBuddy2API deployment.',
    unreachableBodyUnreachable:
      '{host} did not answer. It may be offline, or the address may be wrong.',
    unreachableTitle: 'Could not use this deployment',
    updateAvailableBody: 'Version {version} is available. You have {current}.',
    updateAvailableTitle: 'A new version is available',
    updateChecking: 'Checking for updates…',
    updateDownloading: 'Downloading…',
    updateFailed: 'Could not check for updates.',
    updateInstall: 'Install',
    updateLater: 'Not now',
    updateNoBuild:
      'Version {version} is available, but there is no build for this computer.',
    updateUpToDate: 'CodeBuddy2API {version} is up to date.',
    usageUnavailable: 'Usage unavailable',
  },
  'ja-JP': {
    about: 'GitHub の CodeBuddy2API',
    address: 'アドレス',
    appVersion: 'バージョン {version}',
    backend: 'バックエンド',
    backendLocal: 'このマシン',
    backendLocalHint:
      'アプリに同梱されたゲートウェイを 127.0.0.1 で起動します。データはこのコンピュータから外に出ず、サインインも不要です。',
    backendRemote: 'すでに運用しているデプロイ',
    backendRemoteHint:
      'ここで起動せず、このアプリのコンソールにそのデプロイのデータを表示します。サインインを求められる場合があります。',
    backendUrlPlaceholder: 'https://codebuddy.example.com',
    cancel: 'キャンセル',
    changeBackend: 'バックエンドを変更…',
    checkForUpdates: 'アップデートを確認…',
    chooseBackend: 'バックエンドを選択',
    copyAddress: 'アドレスをコピー',
    invalidBackendUrl:
      'http:// または https:// で始まるアドレスを入力してください',
    invalidPort: '{min} から {max} までの整数を入力してください。',
    openConsole: 'コンソールを開く',
    openInBrowser: 'ブラウザで開く',
    port: 'ポート',
    portHint:
      'このアプリが自身のコンソールと API を提供する、このマシン上のポートです。',
    portInUseBody:
      'このマシン上の別のプログラムが 127.0.0.1:{port} を使用しています。別のポートを選ぶか、使用しているプログラムを止めてから再試行してください。',
    portInUseTitle: 'ポート {port} はすでに使用されています',
    quit: '終了',
    retry: '再試行',
    save: '保存',
    serverVersion: 'サーバーバージョン {version}',
    settings: '設定…',
    statusFailed: 'ゲートウェイの起動に失敗しました',
    statusPortBusy: 'ポート {port} は使用中',
    statusRunning: '動作中 · {address}',
    statusStarting: 'ゲートウェイを起動しています…',
    statusUnreachable: 'デプロイに到達できません',
    todayUsage: '本日の消費 {input} / {output}',
    unreachableBodyForeign:
      '{host} は応答しましたが、CodeBuddy2API のデプロイではありません。',
    unreachableBodyUnreachable:
      '{host} は応答しませんでした。オフラインか、アドレスが違う可能性があります。',
    unreachableTitle: 'このデプロイを利用できません',
    updateAvailableBody:
      'バージョン {version} が利用できます。現在は {current} です。',
    updateAvailableTitle: '新しいバージョンがあります',
    updateChecking: 'アップデートを確認しています…',
    updateDownloading: 'ダウンロードしています…',
    updateFailed: 'アップデートを確認できませんでした。',
    updateInstall: 'インストール',
    updateLater: '後で',
    updateNoBuild:
      'バージョン {version} が利用できますが、このコンピュータ向けのビルドはありません。',
    updateUpToDate: 'CodeBuddy2API {version} は最新です。',
    usageUnavailable: '使用量を取得できません',
  },
  'zh-CN': {
    about: 'GitHub 上的 CodeBuddy2API',
    address: '地址',
    appVersion: '版本 {version}',
    backend: '后端',
    backendLocal: '本机',
    backendLocalHint:
      '在 127.0.0.1 上运行应用内置的网关。数据不会离开这台电脑，也不需要登录。',
    backendRemote: '我自己部署的服务',
    backendRemoteHint:
      '在本机显示应用自带的控制台，数据从该服务转发而来。它可能会要求登录。',
    backendUrlPlaceholder: 'https://codebuddy.example.com',
    cancel: '取消',
    changeBackend: '切换后端…',
    checkForUpdates: '检查更新…',
    chooseBackend: '选择后端',
    copyAddress: '复制地址',
    invalidBackendUrl: '请输入以 http:// 或 https:// 开头的地址',
    invalidPort: '请输入 {min} 到 {max} 之间的整数。',
    openConsole: '打开控制台',
    openInBrowser: '在浏览器中打开',
    port: '端口',
    portHint: '本机上应用提供控制台与 API 的端口。',
    portInUseBody:
      '本机上已有其他程序占用 127.0.0.1:{port}。请换一个端口，或停掉占用它的程序后重试。',
    portInUseTitle: '端口 {port} 已被占用',
    quit: '退出',
    retry: '重试',
    save: '保存',
    serverVersion: '服务端版本 {version}',
    settings: '设置…',
    statusFailed: '网关启动失败',
    statusPortBusy: '端口 {port} 被占用',
    statusRunning: '运行中 · {address}',
    statusStarting: '正在启动网关…',
    statusUnreachable: '无法访问该服务',
    todayUsage: '今日消耗 {input} / {output}',
    unreachableBodyForeign: '{host} 有响应，但它不是 CodeBuddy2API 的部署。',
    unreachableBodyUnreachable: '{host} 没有响应。它可能离线，或地址不对。',
    unreachableTitle: '无法使用这个服务',
    updateAvailableBody: '新版本 {version} 可用，当前为 {current}。',
    updateAvailableTitle: '有新版本可用',
    updateChecking: '正在检查更新…',
    updateDownloading: '正在下载…',
    updateFailed: '检查更新失败。',
    updateInstall: '安装',
    updateLater: '稍后',
    updateNoBuild: '新版本 {version} 可用，但没有适用于这台电脑的安装包。',
    updateUpToDate: 'CodeBuddy2API {version} 已是最新版本。',
    usageUnavailable: '用量不可用',
  },
};

const locales = Object.keys(texts) as Array<keyof typeof texts>;
const defaultLocale: keyof typeof texts = 'en-US';

/**
 * The locale the console is showing, which is what the menu bar item should
 * speak. Anything unknown — including a locale the shell has not been
 * translated into — falls back to English rather than to a broken string.
 */
export const resolveDesktopLocale = (value?: string): keyof typeof texts => {
  const trimmed = value?.trim();

  return locales.includes(trimmed as keyof typeof texts)
    ? (trimmed as keyof typeof texts)
    : defaultLocale;
};

export const desktopText = (locale?: string): DesktopText =>
  texts[resolveDesktopLocale(locale)];

export const desktopLocales = (): Array<keyof typeof texts> => locales;

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

/**
 * Fills one of the shell's own templates — a version, a port, a file name.
 *
 * Exported because the shell also fills templates the console never sees: the
 * version rows in its menu, and what it says while an update is on its way.
 */
export const fillText = (
  template: string,
  values: Record<string, string>,
): string => fill(template, values);

/**
 * What the menu bar item reports, and what it needs to report it: the loopback
 * address the bundled gateway is on, and the port it wanted when it has none —
 * a port that is taken is the one number worth naming.
 *
 * The address is the bundled gateway's, which is where the console is served
 * from whether a deployment is configured or not.
 */
export const statusText = (
  text: DesktopText,
  status: 'failed' | 'portBusy' | 'running' | 'starting' | 'unreachable',
  context: { address: string; port: string },
): string =>
  status === 'running'
    ? fill(text.statusRunning, { address: context.address })
    : status === 'failed'
      ? text.statusFailed
      : status === 'portBusy'
        ? fill(text.statusPortBusy, { port: context.port })
        : status === 'unreachable'
          ? text.statusUnreachable
          : text.statusStarting;

/**
 * Token counts compacted for a menu bar, where `1_234_567` is unreadable and
 * the exact number is a click away in the console.
 */
export const formatTokenCount = (value: number, locale?: string): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  return new Intl.NumberFormat(resolveDesktopLocale(locale), {
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(value);
};

export const usageText = (
  text: DesktopText,
  usage: { input: number; output: number } | null,
  locale?: string,
): string => {
  if (!usage) {
    return text.usageUnavailable;
  }

  return fill(text.todayUsage, {
    input: formatTokenCount(usage.input, locale),
    output: formatTokenCount(usage.output, locale),
  });
};
