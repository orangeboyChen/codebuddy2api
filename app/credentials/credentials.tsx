'use client';

import { atom } from 'jotai';
import { createContext, useContext, useState } from 'react';
import { Block, Flexbox, Input, TextArea } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import {
  Copy,
  ExternalLink,
  KeyRound,
  Layers3,
  Link,
  LoaderCircle,
  MousePointerClick,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  WandSparkles,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AccessKeyCard } from './access-key-card';
import { CredentialGroup } from './credential-group';
import { SectionTitle } from './section-title';
import { ToggleOption } from './toggle-option';

export interface CredentialSummary {
  created_at: number | null;
  domain: string;
  email: string;
  enterprise_id: string | number | null;
  expires_at: number | null;
  expires_in: number | null;
  filename: string;
  first_message_role_to_system: boolean;
  has_refresh_token: boolean;
  index: number;
  is_expired: boolean;
  name: string | null;
  responses_passthrough: boolean;
  scope: string | null;
  session_state: string | null;
  tenant_id: string | number | null;
  time_remaining: number | null;
  time_remaining_str: string;
  token_type: string;
  user_id: string;
}

export interface AccessKeySummary {
  createdAt: string;
  credentialFilenames: string[];
  id: string;
  maskedSecret: string;
  name: string;
  updatedAt: string;
}

export interface RevealedAccessKeySecret {
  id: string;
  name: string;
  secret: string;
}

export interface CurrentCredentialInfo {
  status: string;
  available_credential_count?: number;
  index?: number;
  filename?: string;
  next_filename?: string | null;
  user_id?: string;
  domain?: string;
  enterprise_id?: string | number | null;
  tenant_id?: string | number | null;
}

export interface AuthState {
  authState: string;
  authUrl: string;
  callbackUrl: string;
  completed: boolean;
  intervalSeconds: number;
  message: string;
  polling: boolean;
  starting: boolean;
  showManualCallback: boolean;
}

export interface CredentialFormState {
  bearerToken: string;
  editingIndex: number | null;
  firstMessageRoleToSystem: boolean;
  responsesPassthrough: boolean;
  userId: string;
}

export interface AccessKeyFormState {
  credentialFilenames: string[];
  editingId: string | null;
  name: string;
}

export interface CredentialsState {
  accessKeyActionId: string | null;
  accessKeyCreating: boolean;
  accessKeyForm: AccessKeyFormState;
  accessKeys: AccessKeySummary[];
  accessKeysLoading: boolean;
  actionIndex: number | null;
  current: CurrentCredentialInfo | null;
  currentLoading: boolean;
  form: CredentialFormState;
  items: CredentialSummary[];
  loading: boolean;
  revealedSecret: RevealedAccessKeySecret | null;
}

export const defaultAuthState: AuthState = {
  authState: '',
  authUrl: '',
  callbackUrl: '',
  completed: false,
  intervalSeconds: 5,
  message: '',
  polling: false,
  starting: false,
  showManualCallback: false,
};

export const authStateAtom = atom<AuthState>(defaultAuthState);

export const defaultCredentialsState: CredentialsState = {
  accessKeyActionId: null,
  accessKeyCreating: false,
  accessKeyForm: { credentialFilenames: [], editingId: null, name: '' },
  accessKeys: [],
  accessKeysLoading: true,
  actionIndex: null,
  current: null,
  currentLoading: true,
  form: {
    bearerToken: '',
    editingIndex: null,
    firstMessageRoleToSystem: false,
    responsesPassthrough: false,
    userId: '',
  },
  items: [],
  loading: true,
  revealedSecret: null,
};

export const credentialsStateAtom = atom<CredentialsState>(
  defaultCredentialsState,
);

export interface CredentialsInitialData {
  accessKeys: AccessKeySummary[];
  credentials: CredentialSummary[];
  currentCredential: CurrentCredentialInfo;
}

export const createCredentialsState = (
  initialData: CredentialsInitialData,
): CredentialsState => ({
  ...defaultCredentialsState,
  accessKeys: initialData.accessKeys,
  accessKeysLoading: false,
  current: initialData.currentCredential,
  currentLoading: false,
  items: initialData.credentials,
  loading: false,
});

export interface CredentialsTabController {
  auth: AuthState;
  credentials: CredentialsState;
  onAddAccessKey: () => void;
  onAddCredential: () => void;
  onAuthAction: () => void;
  onCallbackUrlChange: (value: string) => void;
  onCopyAuthUrl: () => void;
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onCredentialTokenChange: (value: string) => void;
  onCredentialUserIdChange: (value: string) => void;
  onDeleteCredential: (index: number) => void;
  onDeleteAccessKey: (id: string) => void;
  onEditCredential: (credential: CredentialSummary) => void;
  onEditAccessKey: (accessKey: AccessKeySummary) => void;
  onOpenAuthUrl: () => void;
  onPollAuth: () => void;
  onRefreshAccessKeys: () => void;
  onRefreshCredentialList: () => void;
  onResetCredentialForm: () => void;
  onResetAccessKeyForm: () => void;
  onRevealAccessKeySecret: (id: string) => void;
  onSaveAccessKey: () => void;
  onSubmitCallbackUrl: () => void;
  onToggleCallbackMode: (showManual: boolean) => void;
  onToggleCredentialSelection: (filename: string) => void;
  onUpdateAccessKeyName: (value: string) => void;
}

const CredentialsControllerContext =
  createContext<CredentialsTabController | null>(null);

export const CredentialsProvider = CredentialsControllerContext.Provider;

const useCredentials = (): CredentialsTabController => {
  const controller = useContext(CredentialsControllerContext);
  if (!controller)
    throw new Error('Credentials must be rendered inside the admin page');
  return controller;
};

const Credentials = () => {
  const controller = useCredentials();
  const credentialsText = useTranslations('Admin');
  const common = useTranslations('Admin.common');
  const [showManualCredential, setShowManualCredential] = useState(false);
  const {
    auth,
    credentials,
    onAddAccessKey,
    onAddCredential,
    onAuthAction,
    onCallbackUrlChange,
    onCopyAuthUrl,
    onCredentialFirstMessageRoleToSystemChange,
    onCredentialResponsesPassthroughChange,
    onCredentialTokenChange,
    onCredentialUserIdChange,
    onDeleteAccessKey,
    onDeleteCredential,
    onEditAccessKey,
    onEditCredential,
    onOpenAuthUrl,
    onPollAuth,
    onRefreshAccessKeys,
    onRefreshCredentialList,
    onResetAccessKeyForm,
    onResetCredentialForm,
    onRevealAccessKeySecret,
    onSaveAccessKey,
    onSubmitCallbackUrl,
    onToggleCallbackMode,
    onToggleCredentialSelection,
    onUpdateAccessKeyName,
  } = controller;
  const validCredentials = credentials.items.filter((item) => !item.is_expired);
  const expiredCredentials = credentials.items.filter(
    (item) => item.is_expired,
  );
  const currentStatus = !credentials.current
    ? credentialsText('credentials.credentialCurrentNone')
    : credentials.current.status === 'no_credentials'
      ? credentialsText('credentials.credentialCurrentNoCredentials')
      : credentials.current.status === 'access_keys_enabled'
        ? credentialsText('credentials.credentialCurrentWithAccessKeys')
        : credentialsText('credentials.credentialCurrentWithoutAccessKeys');

  return (
    <div id="credentials" className="block">
      {!showManualCredential ? (
        <Block direction="vertical" gap={16} padding={24} variant="outlined">
          <Flexbox align="center" justify="space-between" horizontal>
            <Flexbox align="center" gap={8} horizontal>
              <WandSparkles aria-hidden="true" size={18} strokeWidth={2} />
              <h3 className="dashboard-data-title">
                {credentialsText('credentials.autoAuthTitle')}
              </h3>
            </Flexbox>
            <Button onClick={() => setShowManualCredential(true)}>
              {credentialsText('credentials.manualCredentialTitle')}
            </Button>
          </Flexbox>
          <p className="text-secondary mb-4">
            {credentialsText('credentials.autoAuthDescription')}
          </p>
          <Flexbox horizontal>
            <Button
              id="getAuthBtn"
              disabled={auth.starting}
              icon={Play}
              loading={auth.starting}
              onClick={onAuthAction}
              type="primary"
            >
              {credentialsText('credentials.autoAuthStart')}
            </Button>
          </Flexbox>
          {auth.authUrl ? (
            <Block
              id="authUrlSection"
              direction="vertical"
              gap={16}
              padding={16}
              variant="outlined"
            >
              <SectionTitle
                icon={Link}
                title={credentialsText('credentials.autoAuthGenerated')}
              />
              <p className="text-secondary mb-4">
                {credentialsText('credentials.autoAuthGeneratedDescription')}
              </p>
              <Input
                id="authUrlInput"
                className="font-mono mb-4"
                readOnly
                type="text"
                value={auth.authUrl}
              />
              <Flexbox gap={8} wrap="wrap">
                <Button
                  icon={ExternalLink}
                  onClick={onOpenAuthUrl}
                  type="primary"
                >
                  {credentialsText('credentials.autoAuthOpen')}
                </Button>
                <Button icon={Copy} onClick={onCopyAuthUrl}>
                  {common('copy')}
                </Button>
                <Button
                  icon={MousePointerClick}
                  onClick={() => onToggleCallbackMode(true)}
                >
                  {credentialsText('credentials.autoAuthManual')}
                </Button>
              </Flexbox>
              <Block
                id="autoCallbackSection"
                direction="vertical"
                gap={16}
                padding={16}
                variant="outlined"
              >
                <div className="text-center p-4">
                  <div>
                    {auth.message ||
                      credentialsText('credentials.autoAuthPending')}
                  </div>
                  <small className="text-secondary">
                    {credentialsText('credentials.autoAuthPendingHint')}
                  </small>
                </div>
                <div className="mt-4 text-center">
                  <Button
                    icon={RefreshCw}
                    loading={auth.polling}
                    onClick={onPollAuth}
                  >
                    {credentialsText('credentials.autoAuthPoll')}
                  </Button>
                </div>
              </Block>
              {auth.showManualCallback ? (
                <Block
                  id="manualCallbackSection"
                  direction="vertical"
                  gap={16}
                  padding={16}
                  variant="outlined"
                >
                  <h5 className="mb-4">
                    {credentialsText('credentials.autoAuthManualTitle')}
                  </h5>
                  <p className="text-secondary text-sm mb-4">
                    {credentialsText('credentials.autoAuthManualDescription')}
                  </p>
                  <Input
                    id="callbackUrl"
                    className="w-full"
                    placeholder={credentialsText(
                      'credentials.autoAuthManualInput',
                    )}
                    type="text"
                    value={auth.callbackUrl}
                    onChange={(event) =>
                      onCallbackUrlChange(event.target.value)
                    }
                  />
                  <div className="mt-4 text-right">
                    <Button onClick={() => onToggleCallbackMode(false)}>
                      {credentialsText('credentials.autoAuthManualBack')}
                    </Button>
                    <Button onClick={onSubmitCallbackUrl} type="primary">
                      {credentialsText('credentials.submit')}
                    </Button>
                  </div>
                </Block>
              ) : null}
            </Block>
          ) : null}
        </Block>
      ) : null}

      {showManualCredential && credentials.form.editingIndex === null ? (
        <Block direction="vertical" gap={16} padding={24} variant="outlined">
          <Flexbox align="center" justify="space-between" horizontal>
            <SectionTitle
              icon={Pencil}
              title={credentialsText('credentials.manualCredentialTitle')}
            />
            <Button onClick={() => setShowManualCredential(false)}>
              {credentialsText('credentials.autoAuthTitle')}
            </Button>
          </Flexbox>
          <div className="mb-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="bearerToken"
            >
              {credentialsText('credentials.bearerToken')}
              <span className="text-error">*</span>
            </label>
            <TextArea
              id="bearerToken"
              className="w-full"
              placeholder={credentialsText(
                'credentials.manualCredentialPlaceholder',
              )}
              rows={3}
              value={credentials.form.bearerToken}
              onChange={(event) => onCredentialTokenChange(event.target.value)}
            />
          </div>
          <div className="mb-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="userId"
            >
              {credentialsText('credentials.credentialUserId')}
            </label>
            <Input
              id="userId"
              className="w-full"
              placeholder={credentialsText(
                'credentials.credentialUserIdPlaceholder',
              )}
              type="text"
              value={credentials.form.userId}
              onChange={(event) => onCredentialUserIdChange(event.target.value)}
            />
          </div>
          <div className="mb-4 grid gap-3">
            <ToggleOption
              checked={credentials.form.responsesPassthrough}
              description={credentialsText(
                'credentials.credentialResponsesDirectHelp',
              )}
              onChange={onCredentialResponsesPassthroughChange}
              title={credentialsText('credentials.credentialResponsesDirect')}
            />
            <ToggleOption
              checked={credentials.form.firstMessageRoleToSystem}
              description={credentialsText(
                'credentials.credentialRoleAsSystemHelp',
              )}
              onChange={onCredentialFirstMessageRoleToSystemChange}
              title={credentialsText('credentials.credentialRoleAsSystem')}
            />
          </div>
          <Flexbox horizontal>
            <Button icon={Save} onClick={onAddCredential} type="primary">
              {credentialsText('credentials.save')}
            </Button>
          </Flexbox>
        </Block>
      ) : null}

      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between">
          <SectionTitle
            icon={KeyRound}
            title={credentialsText('credentials.accessKeyLabel')}
          />
          <div className="flex gap-2">
            <Button icon={Plus} onClick={onAddAccessKey} type="primary">
              {credentialsText('credentials.accessKeyCreate')}
            </Button>
            <Button icon={RefreshCw} onClick={onRefreshAccessKeys}>
              {common('refresh')}
            </Button>
          </div>
        </div>
        {credentials.accessKeyCreating ? (
          <AccessKeyCard
            accessKey={{
              createdAt: new Date().toISOString(),
              credentialFilenames: [],
              id: '__new__',
              maskedSecret: '',
              name: credentialsText('credentials.accessKeyCreateTitle'),
              updatedAt: new Date().toISOString(),
            }}
            actionId={credentials.accessKeyActionId}
            form={credentials.accessKeyForm}
            isCreating
            revealedSecret={credentials.revealedSecret}
            validCredentials={validCredentials}
            onCancel={onResetAccessKeyForm}
            onResetAccessKeyForm={onResetAccessKeyForm}
            onSaveAccessKey={onSaveAccessKey}
            onToggleCredentialSelection={onToggleCredentialSelection}
            onUpdateAccessKeyName={onUpdateAccessKeyName}
          />
        ) : null}
        <div id="accessKeysList">
          {credentials.accessKeysLoading ? (
            <div className="text-center py-8 text-secondary">
              <LoaderCircle />
              <div>{common('loading')}</div>
            </div>
          ) : credentials.accessKeys.length ? (
            <div className="grid gap-3">
              {credentials.accessKeys.map((accessKey) => (
                <AccessKeyCard
                  accessKey={accessKey}
                  actionId={credentials.accessKeyActionId}
                  form={credentials.accessKeyForm}
                  key={accessKey.id}
                  revealedSecret={credentials.revealedSecret}
                  validCredentials={validCredentials}
                  onDelete={() => onDeleteAccessKey(accessKey.id)}
                  onEdit={() => onEditAccessKey(accessKey)}
                  onResetAccessKeyForm={onResetAccessKeyForm}
                  onRevealSecret={() => onRevealAccessKeySecret(accessKey.id)}
                  onSaveAccessKey={onSaveAccessKey}
                  onToggleCredentialSelection={onToggleCredentialSelection}
                  onUpdateAccessKeyName={onUpdateAccessKeyName}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-secondary">
              {credentialsText('credentials.accessKeyEmptyCredentials')}
            </div>
          )}
        </div>
      </Block>

      <Block
        className="mb-6"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <div className="flex items-center justify-between">
          <SectionTitle
            icon={KeyRound}
            title={credentialsText('credentials.credentialSectionTitle')}
          />
          <Button icon={RefreshCw} onClick={onRefreshCredentialList}>
            {common('refresh')}
          </Button>
        </div>
        <div id="currentCredentialStatus">
          {credentials.currentLoading ? (
            <div className="text-center py-8 text-secondary">
              <LoaderCircle />
              <div>{credentialsText('credentials.noCurrentState')}</div>
            </div>
          ) : (
            <div>
              <div className="font-semibold text-text-light dark:text-text-dark">
                {currentStatus}
              </div>
            </div>
          )}
        </div>
        <div id="credentialsList">
          {credentials.loading ? (
            <div className="text-center py-8 text-secondary">
              <LoaderCircle />
              <div>{common('loading')}</div>
            </div>
          ) : credentials.items.length ? (
            <>
              <CredentialGroup
                current={credentials.current}
                form={credentials.form}
                items={validCredentials}
                onCredentialFirstMessageRoleToSystemChange={
                  onCredentialFirstMessageRoleToSystemChange
                }
                onCredentialResponsesPassthroughChange={
                  onCredentialResponsesPassthroughChange
                }
                onDelete={onDeleteCredential}
                onEdit={onEditCredential}
                onResetCredentialForm={onResetCredentialForm}
                onSaveCredential={onAddCredential}
              />
              <CredentialGroup
                current={credentials.current}
                form={credentials.form}
                items={expiredCredentials}
                onCredentialFirstMessageRoleToSystemChange={
                  onCredentialFirstMessageRoleToSystemChange
                }
                onCredentialResponsesPassthroughChange={
                  onCredentialResponsesPassthroughChange
                }
                onDelete={onDeleteCredential}
                onEdit={onEditCredential}
                onResetCredentialForm={onResetCredentialForm}
                onSaveCredential={onAddCredential}
                title={credentialsText('credentials.credentialExpired')}
              />
            </>
          ) : (
            <div className="text-center py-8 text-secondary">
              <Layers3 />
              <div>{credentialsText('credentials.credentialEmpty')}</div>
            </div>
          )}
        </div>
      </Block>
    </div>
  );
};

export default Credentials;
