import { globalIgnores } from 'eslint/config';

import { configs as nextConfigs } from '@next/eslint-plugin-next';
import tseslint from '@typescript-eslint/eslint-plugin/use-at-your-own-risk/raw-plugin';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

const eslintConfig = [
  globalIgnores([
    '.next/**',
    'coverage/**',
    'node_modules/**',
    'next-env.d.ts',
    'tsconfig.tsbuildinfo',
  ]),
  nextConfigs.recommended,
  nextConfigs['core-web-vitals'],
  reactPlugin.configs.flat.recommended,
  reactPlugin.configs.flat['jsx-runtime'],
  reactHooksPlugin.configs.flat.recommended,
  ...tseslint.flatConfigs['flat/recommended'],
  prettierRecommended,
  {
    settings: {
      next: {
        rootDir: '.',
      },
      react: {
        version: 'detect',
      },
    },
    rules: {
      'react/prop-types': 'off',
      'react/forbid-dom-props': [
        'error',
        {
          forbid: ['style'],
        },
      ],
      'react/forbid-component-props': [
        'error',
        {
          forbid: ['style'],
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'func-style': [
        'error',
        'expression',
        {
          allowArrowFunctions: true,
        },
      ],
      'prefer-arrow-callback': [
        'error',
        {
          allowNamedFunctions: false,
          allowUnboundThis: true,
        },
      ],
      'react/function-component-definition': [
        'error',
        {
          namedComponents: 'arrow-function',
          unnamedComponents: 'arrow-function',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },
];

export default eslintConfig;
