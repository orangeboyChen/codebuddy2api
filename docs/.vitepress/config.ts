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
  footer: { message: 'Released under the MIT License.' },
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
) => ({
  ...sharedTheme,
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
      ),
    },
  },
  title: 'CodeBuddy2API',
  themeConfig: sharedTheme,
});
