'use client';

import { Block, Flexbox, TextArea } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import { FileCode2, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DEFAULT_TEST_MODELS, useApiTestTab } from '@/lib/client/console';

const ApiTest = () => {
  const apiTestText = useTranslations('Admin.apiTest');
  const context = useApiTestTab();
  const models = context.models.length
    ? context.models
    : [...DEFAULT_TEST_MODELS];
  const model = models.includes(context.apiTest.model)
    ? context.apiTest.model
    : (models[0] ?? '');

  return (
    <div id="api-test" className="block space-y-4">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <h2 className="dashboard-data-title">{apiTestText('title')}</h2>
        <label className="grid gap-2" htmlFor="testCredential">
          <span>{apiTestText('credential')}</span>
          <Select
            id="testCredential"
            options={[
              { label: apiTestText('followCurrent'), value: '' },
              ...context.credentialOptions.map((credential) => ({
                label: credential.email || credential.filename,
                value: credential.filename,
              })),
            ]}
            value={context.apiTest.credentialFilename}
            onChange={(value) => {
              context.onCredentialChange(String(value));
            }}
          />
        </label>
        <label className="grid gap-2" htmlFor="testModel">
          <span>{apiTestText('model')}</span>
          <Select
            id="testModel"
            options={models.map((value) => ({ label: value, value }))}
            value={model}
            onChange={(value) => {
              context.onModelChange(String(value));
            }}
          />
        </label>
        <label className="grid gap-2" htmlFor="testMessage">
          <span>{apiTestText('message')}</span>
          <TextArea
            id="testMessage"
            rows={4}
            value={context.apiTest.message}
            onChange={(event) => {
              context.onMessageChange(event.target.value);
            }}
          />
        </label>
        <Flexbox align="center" gap={8} horizontal>
          <Switch
            checked={context.apiTest.stream}
            onChange={context.onStreamChange}
          />
          <span>{apiTestText('stream')}</span>
        </Flexbox>
        <Flexbox horizontal>
          <Button
            icon={Send}
            loading={context.apiTest.submitting}
            onClick={context.onSubmit}
            type="primary"
          >
            {apiTestText('send')}
          </Button>
        </Flexbox>
        <h3>{apiTestText('result')}</h3>
        <Block padding={16} variant="outlined">
          <pre className="m-0 whitespace-pre-wrap">
            {context.apiTest.result}
          </pre>
        </Block>
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <FileCode2 aria-hidden="true" size={18} />
          <h3 className="dashboard-data-title">{apiTestText('examples')}</h3>
        </Flexbox>
        <pre className="overflow-x-auto whitespace-pre-wrap">{`curl -X POST /v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello!"}]}'`}</pre>
      </Block>
    </div>
  );
};

export default ApiTest;
