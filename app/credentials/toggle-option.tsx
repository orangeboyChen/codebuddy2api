import { Block } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';

interface ToggleOptionProps {
  checked: boolean;
  description: string;
  onChange: (checked: boolean) => void;
  title: string;
}

export const ToggleOption = ({
  checked,
  description,
  onChange,
  title,
}: ToggleOptionProps) => {
  return (
    <Block
      align="center"
      className="toggle-option"
      distribution="space-between"
      gap={16}
      horizontal
      onClick={(event) => {
        if ((event.target as Element).closest('button')) return;
        onChange(!checked);
      }}
      padding={12}
      variant="outlined"
    >
      <div>
        <div className="font-medium text-text-light dark:text-text-dark">
          {title}
        </div>
        <div className="text-sm text-secondary">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </Block>
  );
};
