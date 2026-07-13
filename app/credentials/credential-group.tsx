import { Block, Flexbox, Tag } from '@lobehub/ui';
import { Layers3 } from 'lucide-react';

import type {
  CredentialFormState,
  CredentialSummary,
  CurrentCredentialInfo,
} from './credentials';
import { CredentialCard } from './credential-card';
import { SectionTitle } from './section-title';

interface CredentialGroupProps {
  current: CurrentCredentialInfo | null;
  form: CredentialFormState;
  items: CredentialSummary[];
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onDelete: (index: number) => void;
  onEdit: (credential: CredentialSummary) => void;
  onResetCredentialForm: () => void;
  onSaveCredential: () => void;
  title?: string;
}

export const CredentialGroup = ({
  current,
  form,
  items,
  onCredentialFirstMessageRoleToSystemChange,
  onCredentialResponsesPassthroughChange,
  onDelete,
  onEdit,
  onResetCredentialForm,
  onSaveCredential,
  title,
}: CredentialGroupProps) => {
  if (!items.length) return null;

  const cards = (
    <div className="grid gap-4">
      {items.map((credential) => (
        <CredentialCard
          credential={credential}
          current={current}
          form={form}
          key={credential.filename}
          onCredentialFirstMessageRoleToSystemChange={
            onCredentialFirstMessageRoleToSystemChange
          }
          onCredentialResponsesPassthroughChange={
            onCredentialResponsesPassthroughChange
          }
          onDelete={() => onDelete(credential.index)}
          onEdit={() => onEdit(credential)}
          onResetCredentialForm={onResetCredentialForm}
          onSaveCredential={onSaveCredential}
        />
      ))}
    </div>
  );

  if (!title) return <div className="mb-6">{cards}</div>;

  return (
    <div className="mb-6">
      <Block
        className="credentials-group"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <Flexbox
          align="center"
          className="credential-group-heading"
          distribution="space-between"
          horizontal
        >
          <SectionTitle icon={Layers3} title={title} />
          <Tag>{items.length}</Tag>
        </Flexbox>
        {cards}
      </Block>
    </div>
  );
};
