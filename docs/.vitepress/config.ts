import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/codebuddy2api/',
  description: 'CodeBuddy2API 使用文档。',
  lang: 'zh-CN',
  locales: {
    root: { label: '简体中文', lang: 'zh-CN' },
    en: { label: 'English', lang: 'en-US', link: '/en/' },
    ja: { label: '日本語', lang: 'ja-JP', link: '/ja/' },
  },
  title: 'CodeBuddy2API',
  themeConfig: {
    footer: {
      message: 'Released under the MIT License.',
    },
    nav: [
      { text: '指南', link: '/guide/quick-start' },
      { text: '配置', link: '/config/docker' },
      {
        text: 'GitHub',
        link: 'https://github.com/orangeboyChen/codebuddy2api',
      },
    ],
    sidebar: [
      {
        items: [
          { text: '快速开始', link: '/guide/quick-start' },
          {
            collapsed: false,
            items: [
              { text: '仪表盘', link: '/guide/dashboard' },
              { text: '用量', link: '/guide/usage' },
              { text: '凭据', link: '/guide/credentials' },
              { text: '账号状态', link: '/guide/account-status' },
              { text: 'API 测试', link: '/guide/api-test' },
              { text: '调试', link: '/guide/debug' },
              { text: '设置', link: '/guide/settings' },
            ],
            text: '管理控制台',
          },
        ],
        text: '指南',
      },
      {
        items: [{ text: 'Docker 与存储', link: '/config/docker' }],
        text: '配置',
      },
    ],
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/orangeboyChen/codebuddy2api',
      },
    ],
    locales: {
      en: {
        nav: [
          { text: 'Guide', link: '/en/guide/quick-start' },
          { text: 'Configuration', link: '/en/config/docker' },
          {
            text: 'GitHub',
            link: 'https://github.com/orangeboyChen/codebuddy2api',
          },
        ],
        sidebar: [
          {
            items: [
              { text: 'Quick Start', link: '/en/guide/quick-start' },
              {
                collapsed: false,
                items: [
                  { text: 'Dashboard', link: '/en/guide/dashboard' },
                  { text: 'Usage', link: '/en/guide/usage' },
                  { text: 'Credentials', link: '/en/guide/credentials' },
                  { text: 'Account Status', link: '/en/guide/account-status' },
                  { text: 'API Test', link: '/en/guide/api-test' },
                  { text: 'Debug', link: '/en/guide/debug' },
                  { text: 'Settings', link: '/en/guide/settings' },
                ],
                text: 'Admin Console',
              },
            ],
            text: 'Guide',
          },
          {
            items: [{ text: 'Docker and Storage', link: '/en/config/docker' }],
            text: 'Configuration',
          },
        ],
      },
      ja: {
        nav: [
          { text: 'ガイド', link: '/ja/guide/quick-start' },
          { text: '設定', link: '/ja/config/docker' },
          {
            text: 'GitHub',
            link: 'https://github.com/orangeboyChen/codebuddy2api',
          },
        ],
        sidebar: [
          {
            items: [
              { text: 'クイックスタート', link: '/ja/guide/quick-start' },
              {
                collapsed: false,
                items: [
                  { text: 'ダッシュボード', link: '/ja/guide/dashboard' },
                  { text: '利用量', link: '/ja/guide/usage' },
                  { text: '認証情報', link: '/ja/guide/credentials' },
                  { text: 'アカウント状態', link: '/ja/guide/account-status' },
                  { text: 'API テスト', link: '/ja/guide/api-test' },
                  { text: 'デバッグ', link: '/ja/guide/debug' },
                  { text: '設定', link: '/ja/guide/settings' },
                ],
                text: '管理コンソール',
              },
            ],
            text: 'ガイド',
          },
          {
            items: [{ text: 'Docker とストレージ', link: '/ja/config/docker' }],
            text: '設定',
          },
        ],
      },
    },
  },
});
