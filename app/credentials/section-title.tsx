import { Flexbox } from '@lobehub/ui';
import type { LucideIcon } from 'lucide-react';

interface SectionTitleProps {
  icon: LucideIcon;
  title: string;
}

export const SectionTitle = ({ icon: Icon, title }: SectionTitleProps) => {
  return (
    <Flexbox align="center" gap={8} horizontal>
      <Icon aria-hidden="true" size={18} strokeWidth={2} />
      <h3 className="section-title">{title}</h3>
    </Flexbox>
  );
};
