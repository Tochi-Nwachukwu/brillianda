'use client';

import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function DashboardShell({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <div className="flex-1 ml-60">
        <Topbar title={title} />
        <main className="p-6 bg-gray-50 min-h-[calc(100vh-64px)]">{children}</main>
      </div>
    </div>
  );
}
