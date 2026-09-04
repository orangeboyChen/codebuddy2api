import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/codebuddy2api/',
  description: 'Documentation for CodeBuddy2API.',
  lang: 'zh-CN',
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
        items: [{ text: '快速开始', link: '/guide/quick-start' }],
        text: '指南',
      },
    ],
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/orangeboyChen/codebuddy2api',
      },
    ],
  },
});
