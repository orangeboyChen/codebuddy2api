/**
 * The strings the Electron shell itself shows: the menu bar item, its menu,
 * and the window that picks a backend.
 *
 * They live here rather than in `messages/*.json` because the shell is not the
 * console — it cannot call `next-intl`, and it needs them before any server
 * exists to ask. The console's own locale cookie decides which set is used.
 */
export interface DesktopText {
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
  openConsole: string;
  quit: string;
  save: string;
  serverVersion: string;
  statusFailed: string;
  statusRunning: string;
  statusStarting: string;
  todayUsage: string;
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
    appVersion: 'Version {version}',
    backend: 'Backend',
    backendLocal: 'This machine',
    backendLocalHint:
      'Runs the gateway bundled into the app on 127.0.0.1. Nothing leaves this computer, and no sign-in is needed.',
    backendRemote: 'A deployment I already run',
    backendRemoteHint:
      'Opens that console instead of starting one here. It may ask you to sign in.',
    backendUrlPlaceholder: 'https://codebuddy.example.com',
    cancel: 'Cancel',
    changeBackend: 'Change backend…',
    checkForUpdates: 'Check for updates…',
    chooseBackend: 'Choose a backend',
    copyAddress: 'Copy address',
    invalidBackendUrl: 'Enter an address starting with http:// or https://',
    openConsole: 'Open console',
    quit: 'Quit',
    save: 'Save',
    serverVersion: 'Server version {version}',
    statusFailed: 'Gateway failed to start',
    statusRunning: 'Running · {address}',
    statusStarting: 'Starting gateway…',
    todayUsage: 'Today {input} / {output}',
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
    appVersion: 'バージョン {version}',
    backend: 'バックエンド',
    backendLocal: 'このマシン',
    backendLocalHint:
      'アプリに同梱されたゲートウェイを 127.0.0.1 で起動します。データはこのコンピュータから外に出ず、サインインも不要です。',
    backendRemote: 'すでに運用しているデプロイ',
    backendRemoteHint:
      'ここでゲートウェイを起動せず、そのコンソールを開きます。サインインを求められる場合があります。',
    backendUrlPlaceholder: 'https://codebuddy.example.com',
    cancel: 'キャンセル',
    changeBackend: 'バックエンドを変更…',
    checkForUpdates: 'アップデートを確認…',
    chooseBackend: 'バックエンドを選択',
    copyAddress: 'アドレスをコピー',
    invalidBackendUrl:
      'http:// または https:// で始まるアドレスを入力してください',
    openConsole: 'コンソールを開く',
    quit: '終了',
    save: '保存',
    serverVersion: 'サーバーバージョン {version}',
    statusFailed: 'ゲートウェイの起動に失敗しました',
    statusRunning: '動作中 · {address}',
    statusStarting: 'ゲートウェイを起動しています…',
    todayUsage: '本日の消費 {input} / {output}',
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
    appVersion: '版本 {version}',
    backend: '后端',
    backendLocal: '本机',
    backendLocalHint:
      '在 127.0.0.1 上运行应用内置的网关。数据不会离开这台电脑，也不需要登录。',
    backendRemote: '我自己部署的服务',
    backendRemoteHint:
      '不再在本机启动网关，而是直接打开那个控制台。它可能会要求登录。',
    backendUrlPlaceholder: 'https://codebuddy.example.com',
    cancel: '取消',
    changeBackend: '切换后端…',
    checkForUpdates: '检查更新…',
    chooseBackend: '选择后端',
    copyAddress: '复制地址',
    invalidBackendUrl: '请输入以 http:// 或 https:// 开头的地址',
    openConsole: '打开控制台',
    quit: '退出',
    save: '保存',
    serverVersion: '服务端版本 {version}',
    statusFailed: '网关启动失败',
    statusRunning: '运行中 · {address}',
    statusStarting: '正在启动网关…',
    todayUsage: '今日消耗 {input} / {output}',
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
 * The status line under the menu bar item. The address is whichever backend is
 * in use: `127.0.0.1:8001` for the bundled gateway, the host of a deployment
 * the user already runs for a remote one.
 */
export const statusText = (
  text: DesktopText,
  status: 'failed' | 'running' | 'starting',
  address: string,
): string =>
  status === 'running'
    ? fill(text.statusRunning, { address })
    : status === 'failed'
      ? text.statusFailed
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
