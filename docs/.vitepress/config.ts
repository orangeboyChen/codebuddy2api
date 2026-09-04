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
              { text: 'Dashboard', link: '/guide/dashboard' },
              { text: 'Usage', link: '/guide/usage' },
              { text: 'Credentials', link: '/guide/credentials' },
              { text: 'Account Status', link: '/guide/account-status' },
              { text: 'API Test', link: '/guide/api-test' },
              { text: 'Debug', link: '/guide/debug' },
              { text: 'Settings', link: '/guide/settings' },
            ],
            text: '管理控制台',
          },
        ],
        text: '指南',
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
        ],
      },
      ja: {
        nav: [
          { text: 'ガイド', link: '/ja/guide/quick-start' },
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
                  { text: 'Dashboard', link: '/ja/guide/dashboard' },
                  { text: 'Usage', link: '/ja/guide/usage' },
                  { text: 'Credentials', link: '/ja/guide/credentials' },
                  { text: 'Account Status', link: '/ja/guide/account-status' },
                  { text: 'API Test', link: '/ja/guide/api-test' },
                  { text: 'Debug', link: '/ja/guide/debug' },
                  { text: 'Settings', link: '/ja/guide/settings' },
                ],
                text: '管理コンソール',
              },
            ],
            text: 'ガイド',
          },
        ],
      },
    },
  },
});
