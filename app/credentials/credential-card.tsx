import { Avatar, Block, Flexbox, Tag } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import {
  CalendarDays,
  Clock3,
  Globe2,
  Pencil,
  Save,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import type {
  CredentialFormState,
  CredentialSummary,
  CurrentCredentialInfo,
} from './credentials';
import { ToggleOption } from './toggle-option';

interface CredentialCardProps {
  credential: CredentialSummary;
  current: CurrentCredentialInfo | null;
  form: CredentialFormState;
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onDelete: () => void;
  onEdit: () => void;
  onResetCredentialForm: () => void;
  onSaveCredential: () => void;
}

export const CredentialCard = ({
  credential,
  current,
  form,
  onCredentialFirstMessageRoleToSystemChange,
  onCredentialResponsesPassthroughChange,
  onDelete,
  onEdit,
  onResetCredentialForm,
  onSaveCredential,
}: CredentialCardProps) => {
  const locale = useLocale();
  const text = useTranslations('Admin');
  const common = useTranslations('Admin.common');
  const isEditing = form.editingIndex === credential.index;
  const badge =
    current?.index === credential.index
      ? {
          color: 'green' as const,
          label: text('credentials.credentialBadgeNext'),
        }
      : credential.is_expired
        ? {
            color: 'red' as const,
            label: text('credentials.credentialBadgeExpired'),
          }
        : {
            color: 'green' as const,
            label: text('credentials.credentialBadgeActive'),
          };
  const avatarText = (credential.name ?? credential.email ?? credential.user_id)
    .slice(0, 1)
    .toUpperCase();

  return (
    <Block
      className="credential-card"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <div className="credential-card-header flex items-center gap-4">
        <Avatar avatar={avatarText || 'C'} size={48} />
        <div className="credential-card-content flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-semibold text-text-light dark:text-text-dark">
              {credential.filename}
            </div>
            <Tag color={badge.color}>{badge.label}</Tag>
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-secondary">
            <span className="flex items-center gap-1">
              <UserRound aria-hidden="true" size={14} />
              {credential.email || credential.user_id}
            </span>
            <span className="flex items-center gap-1">
              <Globe2 aria-hidden="true" size={14} />
              {credential.domain}
            </span>
            <span className="flex items-center gap-1">
              <Clock3 aria-hidden="true" size={14} />
              {credential.time_remaining_str}
            </span>
            <span className="flex items-center gap-1">
              <CalendarDays aria-hidden="true" size={14} />
              {credential.created_at
                ? new Date(credential.created_at * 1000).toLocaleString(locale)
                : text('credentials.unknown')}
            </span>
          </div>
          <Flexbox gap={8} paddingBlock={8} wrap="wrap">
            <Tag>
              {credential.responses_passthrough
                ? text('credentials.credentialResponsesDirect')
                : text('credentials.credentialResponsesProxyTag')}
            </Tag>
            <Tag>
              {credential.first_message_role_to_system
                ? text('credentials.credentialRoleAsSystemTag')
                : text('credentials.credentialRoleKeepDeveloper')}
            </Tag>
          </Flexbox>
        </div>
        <div className="credential-card-actions flex gap-2 shrink-0">
          <Button icon={Pencil} onClick={onEdit} type="primary">
            {text('credentials.edit')}
          </Button>
          <Button danger icon={Trash2} onClick={onDelete}>
            {text('credentials.delete')}
          </Button>
        </div>
      </div>
      {isEditing ? (
        <Flexbox direction="vertical" gap={12}>
          <div className="mb-3 font-medium text-text-light dark:text-text-dark">
            {text('credentials.credentialEditTitle')}
          </div>
          <div className="mb-4 grid gap-3">
            <ToggleOption
              checked={form.responsesPassthrough}
              description={text('credentials.credentialResponsesDirectHelp')}
              onChange={onCredentialResponsesPassthroughChange}
              title={text('credentials.credentialResponsesDirect')}
            />
            <ToggleOption
              checked={form.firstMessageRoleToSystem}
              description={text('credentials.credentialRoleAsSystemHelp')}
              onChange={onCredentialFirstMessageRoleToSystemChange}
              title={text('credentials.credentialRoleAsSystem')}
            />
          </div>
          <Flexbox gap={8} horizontal>
            <Button icon={X} onClick={onResetCredentialForm}>
              {common('cancel')}
            </Button>
            <Button icon={Save} onClick={onSaveCredential} type="primary">
              {text('credentials.save')}
            </Button>
          </Flexbox>
        </Flexbox>
      ) : null}
    </Block>
  );
};
