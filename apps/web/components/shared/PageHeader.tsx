'use client';

import { cn } from '@/lib/utils';

export function PageHeader({ title, children, className }: { title: string; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between mb-6', className)}>
      <h1 className="text-2xl font-bold text-[#0A1F44]">{title}</h1>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  );
}
