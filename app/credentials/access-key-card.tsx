import { Block, Checkbox, Flexbox, Input, Tag } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { CalendarDays, Eye, Pencil, Save, Trash2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import type {
  AccessKeyFormState,
  AccessKeySummary,
  CredentialSummary,
  RevealedAccessKeySecret,
} from './credentials';

interface AccessKeyCardProps {
  accessKey: AccessKeySummary;
  actionId: string | null;
  form: AccessKeyFormState;
  revealedSecret: RevealedAccessKeySecret | null;
  validCredentials: CredentialSummary[];
  onDelete: () => void;
  onEdit: () => void;
  onResetAccessKeyForm: () => void;
  onRevealSecret: () => void;
  onSaveAccessKey: () => void;
  onToggleCredentialSelection: (filename: string) => void;
  onUpdateAccessKeyName: (value: string) => void;
}

export const AccessKeyCard = ({
  accessKey,
  actionId,
  form,
  revealedSecret,
  validCredentials,
  onDelete,
  onEdit,
  onResetAccessKeyForm,
  onRevealSecret,
  onSaveAccessKey,
  onToggleCredentialSelection,
  onUpdateAccessKeyName,
}: AccessKeyCardProps) => {
  const locale = useLocale();
  const text = useTranslations('Admin');
  const common = useTranslations('Admin.common');
  const isEditing = form.editingId === accessKey.id;
  const isRevealed = revealedSecret?.id === accessKey.id;
  const isBusy = actionId === accessKey.id;

  return (
    <Block
      className="access-key-card"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <div className="access-key-card-header flex items-start justify-between gap-4">
        <div className="access-key-card-content min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-semibold text-text-light dark:text-text-dark">
              {accessKey.name}
            </div>
            <Tag color="blue">
              {text('credentials.accessKeyCount', {
                count: accessKey.credentialFilenames.length,
              })}
            </Tag>
          </div>
          <div className="font-mono text-sm text-secondary break-all">
            {accessKey.maskedSecret}
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-secondary mt-3">
            <span className="flex items-center gap-1">
              <CalendarDays aria-hidden="true" size={14} />
              {text('credentials.accessKeyCreatedAt', {
                value: new Date(accessKey.createdAt).toLocaleString(locale),
              })}
            </span>
            <span className="flex items-center gap-1">
              <Pencil aria-hidden="true" size={14} />
              {text('credentials.accessKeyUpdatedAt', {
                value: new Date(accessKey.updatedAt).toLocaleString(locale),
              })}
            </span>
          </div>
          <Flexbox gap={8} wrap="wrap">
            {accessKey.credentialFilenames.map((filename) => (
              <Tag key={filename}>{filename}</Tag>
            ))}
          </Flexbox>
        </div>
        <div className="access-key-card-actions flex gap-2 shrink-0">
          <Button disabled={isBusy} icon={Eye} onClick={onRevealSecret}>
            {text('credentials.viewKey')}
          </Button>
          <Button icon={Pencil} onClick={onEdit} type="primary">
            {text('credentials.edit')}
          </Button>
          <Button danger disabled={isBusy} icon={Trash2} onClick={onDelete}>
            {text('credentials.delete')}
          </Button>
        </div>
      </div>
      {isRevealed ? (
        <Flexbox direction="vertical" gap={8}>
          <div className="mb-2 font-medium text-text-light dark:text-text-dark">
            {text('credentials.accessKeyCurrent')}
          </div>
          <Block
            className="font-mono text-sm break-all"
            padding={12}
            variant="outlined"
          >
            {revealedSecret.secret.replace(/^Bearer\s+/i, '')}
          </Block>
        </Flexbox>
      ) : null}
      {isEditing ? (
        <Flexbox direction="vertical" gap={16}>
          <div className="font-medium text-text-light dark:text-text-dark">
            {text('credentials.accessKeyEdit')}
          </div>
          <div className="text-sm text-secondary mt-2">
            {text('credentials.accessKeyHelp')}
          </div>
          <div className="mt-4">
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor={`accessKeyName-${accessKey.id}`}
            >
              {text('credentials.accessKeyName')}
            </label>
            <Input
              id={`accessKeyName-${accessKey.id}`}
              placeholder={text('credentials.accessKeyExampleName')}
              type="text"
              value={form.name}
              onChange={(event) => onUpdateAccessKeyName(event.target.value)}
            />
          </div>
          <div className="mt-4">
            <div className="block mb-2 font-medium text-text-light dark:text-text-dark">
              {text('credentials.credentialBindings')}
            </div>
            <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
              {validCredentials.length ? (
                validCredentials.map((credential) => (
                  <Block
                    as="label"
                    key={credential.filename}
                    align="center"
                    clickable
                    distribution="space-between"
                    gap={16}
                    horizontal
                    padding={12}
                    variant="outlined"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-text-light dark:text-text-dark">
                        {credential.filename}
                      </div>
                      <div className="text-sm text-secondary">
                        {credential.email || credential.user_id}
                      </div>
                    </div>
                    <Checkbox
                      checked={form.credentialFilenames.includes(
                        credential.filename,
                      )}
                      onChange={() =>
                        onToggleCredentialSelection(credential.filename)
                      }
                    />
                  </Block>
                ))
              ) : (
                <div className="text-sm text-secondary">
                  {text('credentials.accessKeyEmptyCredentials')}
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button icon={X} onClick={onResetAccessKeyForm}>
              {common('cancel')}
            </Button>
            <Button
              disabled={isBusy}
              icon={Save}
              onClick={onSaveAccessKey}
              type="primary"
            >
              {text('credentials.save')}
            </Button>
          </div>
        </Flexbox>
      ) : null}
    </Block>
  );
};
