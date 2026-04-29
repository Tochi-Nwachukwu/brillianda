'use client';

import { Bell } from 'lucide-react';
import { useTenantContext } from '@/context/TenantContext';

export function Topbar({ title }: { title: string }) {
  const { tenant } = useTenantContext();

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 sticky top-0 z-10">
      <h2 className="text-lg font-semibold text-[#0A1F44]">{title}</h2>
      <div className="flex items-center gap-4">
        <button className="relative p-2 rounded-full hover:bg-gray-100 transition-colors">
          <Bell className="w-5 h-5 text-gray-600" />
          <span className="absolute top-1 right-1 w-2 h-2 bg-[#FF6B00] rounded-full" />
        </button>
        {tenant?.logoUrl && (
          <img src={tenant.logoUrl} alt={tenant.name} className="h-8 w-auto" />
        )}
      </div>
    </header>
  );
}
