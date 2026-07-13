'use client';

import { Block, Flexbox, TextArea } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import { atom } from 'jotai';
import { FileCode2, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';
import type { AdminConsoleInitialData } from '@/app/page-data';

const defaultModels = [
  'glm-5.1',
  'glm-5.0',
  'glm-5.0-turbo',
  'glm-5v-turbo',
  'glm-4.7',
  'minimax-m3-play',
  'minimax-m2.7',
  'minimax-m2.5',
  'kimi-k2.6',
  'kimi-k2.5',
  'hy3-preview-agent',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v3-2-volc',
  'glm-5.1-ioa',
  'glm-5.0-ioa',
  'glm-5.0-turbo-ioa',
  'glm-5v-turbo-ioa',
  'glm-4.7-ioa',
  'minimax-m3-ioa',
  'minimax-m2.7-ioa',
  'minimax-m2.5-ioa',
  'kimi-k2.6-ioa',
  'kimi-k2.5-ioa',
  'hy3-preview-agent-ioa',
  'deepseek-v4-pro-ioa',
  'deepseek-v4-flash-ioa',
  'deepseek-v3-2-volc-ioa',
] as const;

const followCurrentCredentialValue = '__follow_current_rotation__';

export interface ApiTestController {
  apiTest: {
    credentialFilename: string;
    message: string;
    model: string;
    result: string;
    stream: boolean;
    submitting: boolean;
  };
  credentialOptions: Array<{
    email: string;
    filename: string;
    user_id?: string;
  }>;
  models: string[];
  onCredentialChange: (value: string) => void;
  onMessageChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onStreamChange: (value: boolean) => void;
  onSubmit: () => void;
}

export interface ApiTestState {
  credentialFilename: string;
  message: string;
  model: string;
  result: string;
  stream: boolean;
  submitting: boolean;
}

export const defaultApiTestState: ApiTestState = {
  credentialFilename: '',
  message: 'Hello, what is 2+2?',
  model: '',
  result: '',
  stream: false,
  submitting: false,
};

export const apiTestStateAtom = atom<ApiTestState>(defaultApiTestState);

export const createApiTestState = (
  initialData: AdminConsoleInitialData,
): ApiTestState => {
  const validCredentials = initialData.credentials.filter(
    (credential) => !credential.is_expired,
  );
  const currentCredential = validCredentials.find(
    (credential) =>
      credential.filename === initialData.currentCredential.filename,
  );

  return {
    ...defaultApiTestState,
    credentialFilename:
      currentCredential?.filename ?? validCredentials[0]?.filename ?? '',
  };
};

const ApiTestContext = createContext<ApiTestController | null>(null);
export const ApiTestProvider = ApiTestContext.Provider;

const useApiTest = (): ApiTestController => {
  const controller = useContext(ApiTestContext);

  if (!controller) {
    throw new Error('API test controller is unavailable');
  }

  return controller;
};

const ApiTest = () => {
  const context = useApiTest();
  const apiTestText = useTranslations('Admin.apiTest');
  const models = context.models.length ? context.models : [...defaultModels];
  const model = models.includes(context.apiTest.model)
    ? context.apiTest.model
    : (models[0] ?? '');

  return (
    <div id="api-test" className="block">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <Send aria-hidden="true" size={18} strokeWidth={2} />
          <h3 className="section-title">{apiTestText('title')}</h3>
        </Flexbox>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testCredential"
          >
            {apiTestText('credential')}
          </label>
          <Select
            className="w-full"
            id="testCredential"
            options={[
              {
                label: apiTestText('followCurrent'),
                value: followCurrentCredentialValue,
              },
              ...context.credentialOptions.map((credential) => ({
                label: `${credential.filename} · ${credential.email || credential.user_id}`,
                value: credential.filename,
              })),
            ]}
            value={
              context.apiTest.credentialFilename || followCurrentCredentialValue
            }
            onChange={(value) => {
              context.onCredentialChange(
                value === followCurrentCredentialValue ? '' : String(value),
              );
            }}
          />
        </div>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testModel"
          >
            {apiTestText('model')}
          </label>
          <Select
            className="w-full"
            id="testModel"
            options={models.map((value) => ({ label: value, value }))}
            value={model}
            onChange={(value) => {
              context.onModelChange(String(value));
            }}
          />
        </div>
        <div className="mb-4">
          <label
            className="block mb-2 font-medium text-text-light dark:text-text-dark"
            htmlFor="testMessage"
          >
            {apiTestText('message')}
          </label>
          <TextArea
            id="testMessage"
            placeholder={apiTestText('placeholder')}
            rows={3}
            value={context.apiTest.message}
            onChange={(event) => {
              context.onMessageChange(event.target.value);
            }}
          />
        </div>
        <Flexbox align="center" className="mb-4" gap={8} horizontal>
          <span className="font-medium text-text-light dark:text-text-dark">
            {apiTestText('stream')}
          </span>
          <Switch
            aria-label={apiTestText('stream')}
            checked={context.apiTest.stream}
            onChange={context.onStreamChange}
          />
        </Flexbox>
        <Flexbox horizontal>
          <Button
            disabled={context.apiTest.submitting}
            icon={Send}
            loading={context.apiTest.submitting}
            onClick={context.onSubmit}
            type="primary"
          >
            {apiTestText('send')}
          </Button>
        </Flexbox>
        <div className="mb-4 mt-6">
          <label className="block mb-2 font-medium text-text-light dark:text-text-dark">
            {apiTestText('result')}
          </label>
          <Block id="testResult" padding={16} variant="outlined">
            <pre className="m-0 whitespace-pre-wrap">
              {context.apiTest.result || apiTestText('idle')}
            </pre>
          </Block>
        </div>
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <FileCode2 aria-hidden="true" size={18} strokeWidth={2} />
          <h3 className="section-title">{apiTestText('examples')}</h3>
        </Flexbox>
        <h4 className="code-sample-title">{apiTestText('examplesCurl')}</h4>
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
        <h4 className="code-sample-title">{apiTestText('examplesPython')}</h4>
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

export default ApiTest;
