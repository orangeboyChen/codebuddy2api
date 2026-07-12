'use client';

import { Block, Checkbox, Flexbox, Input, TextArea } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import {
  Eye,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCredentialsTab } from '@/lib/client/console';

const Credentials = () => {
  const controller = useCredentialsTab();
  const credentialsText = useTranslations('Admin.credentials');
  const common = useTranslations('Admin.common');
  const {
    auth,
    credentials,
    onAddCredential,
    onAuthAction,
    onCredentialFirstMessageRoleToSystemChange,
    onCredentialResponsesPassthroughChange,
    onCredentialTokenChange,
    onCredentialUserIdChange,
    onDeleteAccessKey,
    onDeleteCredential,
    onEditAccessKey,
    onEditCredential,
    onRefreshAccessKeys,
    onRefreshCredentialList,
    onRevealAccessKeySecret,
    onSaveAccessKey,
    onToggleCredentialSelection,
    onUpdateAccessKeyName,
  } = controller;

  return (
    <div id="credentials" className="block space-y-4">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-4">
          <h2 className="dashboard-data-title">{credentialsText('title')}</h2>
          <Button
            icon={Play}
            loading={auth.starting}
            onClick={onAuthAction}
            type="primary"
          >
            {credentialsText('startAuth')}
          </Button>
        </div>
        {auth.message ? <p className="text-secondary">{auth.message}</p> : null}
      </Block>

      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <h3 className="dashboard-data-title">{credentialsText('add')}</h3>
        <label className="grid gap-2" htmlFor="bearerToken">
          <span>{credentialsText('bearerToken')}</span>
          <TextArea
            id="bearerToken"
            rows={3}
            value={credentials.form.bearerToken}
            onChange={(event) => {
              onCredentialTokenChange(event.target.value);
            }}
          />
        </label>
        <label className="grid gap-2" htmlFor="credentialUserId">
          <span>{credentialsText('userId')}</span>
          <Input
            id="credentialUserId"
            value={credentials.form.userId}
            onChange={(event) => {
              onCredentialUserIdChange(event.target.value);
            }}
          />
        </label>
        <Flexbox align="center" gap={8} horizontal>
          <Switch
            checked={credentials.form.responsesPassthrough}
            onChange={onCredentialResponsesPassthroughChange}
          />
          <span>{credentialsText('responsesPassthrough')}</span>
        </Flexbox>
        <Flexbox align="center" gap={8} horizontal>
          <Switch
            checked={credentials.form.firstMessageRoleToSystem}
            onChange={onCredentialFirstMessageRoleToSystemChange}
          />
          <span>{credentialsText('firstMessageRoleToSystem')}</span>
        </Flexbox>
        <Flexbox horizontal>
          <Button icon={Plus} onClick={onAddCredential} type="primary">
            {credentialsText('add')}
          </Button>
        </Flexbox>
      </Block>

      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-4">
          <h3 className="dashboard-data-title">
            {credentialsText('accessKeys')}
          </h3>
          <Button icon={RefreshCw} onClick={onRefreshAccessKeys}>
            {common('refresh')}
          </Button>
        </div>
        <Input
          value={credentials.accessKeyForm.name}
          onChange={(event) => {
            onUpdateAccessKeyName(event.target.value);
          }}
        />
        {credentials.items.map((credential) => (
          <Checkbox
            checked={credentials.accessKeyForm.credentialFilenames.includes(
              credential.filename,
            )}
            key={credential.filename}
            onChange={() => {
              onToggleCredentialSelection(credential.filename);
            }}
          >
            {credential.filename}
          </Checkbox>
        ))}
        <Flexbox horizontal>
          <Button icon={Save} onClick={onSaveAccessKey} type="primary">
            {common('save')}
          </Button>
        </Flexbox>
        {credentials.accessKeys.length ? (
          <div className="grid gap-3">
            {credentials.accessKeys.map((accessKey) => (
              <div
                className="flex items-center justify-between gap-3 rounded border border-border-light p-3 dark:border-border-dark"
                key={accessKey.id}
              >
                <div>
                  <div>{accessKey.name}</div>
                  <code>{accessKey.maskedSecret}</code>
                </div>
                <Flexbox gap={8} horizontal>
                  <Button
                    icon={Eye}
                    onClick={() => {
                      onRevealAccessKeySecret(accessKey.id);
                    }}
                  />
                  <Button
                    icon={KeyRound}
                    onClick={() => {
                      onEditAccessKey(accessKey);
                    }}
                  />
                  <Button
                    icon={Trash2}
                    onClick={() => {
                      onDeleteAccessKey(accessKey.id);
                    }}
                  />
                </Flexbox>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-secondary">{credentialsText('noAccessKeys')}</p>
        )}
        {credentials.revealedSecret ? (
          <code>{credentials.revealedSecret.secret}</code>
        ) : null}
      </Block>

      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-4">
          <h3 className="dashboard-data-title">{credentialsText('current')}</h3>
          <Button icon={RefreshCw} onClick={onRefreshCredentialList}>
            {common('refresh')}
          </Button>
        </div>
        {credentials.items.length ? (
          <div className="grid gap-3">
            {credentials.items.map((credential) => (
              <div
                className="flex items-center justify-between gap-3 rounded border border-border-light p-3 dark:border-border-dark"
                key={credential.filename}
              >
                <div>
                  <div>{credential.name || credential.filename}</div>
                  <small className="text-secondary">{credential.email}</small>
                </div>
                <Flexbox gap={8} horizontal>
                  <Button
                    icon={KeyRound}
                    onClick={() => {
                      onEditCredential(credential);
                    }}
                  >
                    {credentialsText('edit')}
                  </Button>
                  <Button
                    icon={Trash2}
                    onClick={() => {
                      onDeleteCredential(credential.index);
                    }}
                  >
                    {credentialsText('delete')}
                  </Button>
                </Flexbox>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-secondary">{credentialsText('noCredentials')}</p>
        )}
      </Block>
    </div>
  );
};

export default Credentials;
