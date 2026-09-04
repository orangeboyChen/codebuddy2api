import { defineConfig } from 'vitepress';

const githubLink = 'https://github.com/orangeboyChen/codebuddy2api';
const consolePaths = [
  'dashboard',
  'usage',
  'credentials',
  'account-status',
  'api-test',
  'debug',
  'settings',
];
const sharedTheme = {
  socialLinks: [{ icon: 'github', link: githubLink }],
};

const createSidebar = (
  prefix: string,
  guide: string,
  config: string,
  quickStart: string,
  configPage: string,
  storagePage: string,
  localPage: string,
  labels: string[],
) => [
  {
    text: config,
    items: [
      { text: quickStart, link: `${prefix}/guide/quick-start` },
      { text: configPage, link: `${prefix}/config/docker` },
      { text: storagePage, link: `${prefix}/config/storage` },
      { text: localPage, link: `${prefix}/config/local` },
    ],
  },
  {
    text: guide,
    items: consolePaths.map((path, index) => ({
      text: labels[index],
      link: `${prefix}/guide/${path}`,
    })),
  },
];

const createTheme = (
  prefix: string,
  guide: string,
  config: string,
  quickStart: string,
  configPage: string,
  storagePage: string,
  localPage: string,
  labels: string[],
  ui: { footer: string; menu: string; top: string; prev: string; next: string },
) => ({
  ...sharedTheme,
  docFooter: { prev: ui.prev, next: ui.next },
  footer: { message: ui.footer },
  outline: { label: ui.menu },
  returnToTopLabel: ui.top,
  sidebarMenuLabel: ui.menu,
  nav: [{ text: guide, link: `${prefix}/guide/dashboard` }],
  sidebar: createSidebar(
    prefix,
    guide,
    config,
    quickStart,
    configPage,
    storagePage,
    localPage,
    labels,
  ),
});

export default defineConfig({
  base: '/codebuddy2api/',
  description: 'CodeBuddy2API 使用文档。',
  lang: 'zh-CN',
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: createTheme(
        '',
        '指南',
        '配置',
        '快速开始',
        'Docker 与存储',
        '存储选择',
        '本地运行（开发）',
        ['仪表盘', '用量', '凭据', '账号状态', 'API 测试', '调试', '设置'],
        {
          footer:
            '基于 <a href="https://github.com/orangeboyChen/codebuddy2api/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License</a> 发布。',
          menu: '目录',
          top: '返回顶部',
          prev: '上一页',
          next: '下一页',
        },
      ),
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: createTheme(
        '/en',
        'Guide',
        'Configuration',
        'Quick Start',
        'Docker and Storage',
        'Storage Choices',
        'Local Development',
        [
          'Dashboard',
          'Usage',
          'Credentials',
          'Account Status',
          'API Test',
          'Debug',
          'Settings',
        ],
        {
          footer:
            'Released under the <a href="https://github.com/orangeboyChen/codebuddy2api/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License</a>.',
          menu: 'On this page',
          top: 'Return to top',
          prev: 'Previous page',
          next: 'Next page',
        },
      ),
    },
    ja: {
      label: '日本語',
      lang: 'ja-JP',
      link: '/ja/',
      themeConfig: createTheme(
        '/ja',
        'ガイド',
        '設定',
        'クイックスタート',
        'Docker とストレージ',
        'ストレージの選択',
        'ローカル開発',
        [
          'ダッシュボード',
          '利用量',
          '認証情報',
          'アカウント状態',
          'API テスト',
          'デバッグ',
          '設定',
        ],
        {
          footer:
            'MIT License（<a href="https://github.com/orangeboyChen/codebuddy2api/blob/main/LICENSE" target="_blank" rel="noreferrer">ライセンス全文</a>）。',
          menu: 'このページの内容',
          top: 'トップへ戻る',
          prev: '前のページ',
          next: '次のページ',
        },
      ),
    },
  },
  title: 'CodeBuddy2API',
  themeConfig: sharedTheme,
});
