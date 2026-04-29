'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  BookOpen,
  School,
  FlaskConical,
  Palette,
  LogOut,
} from 'lucide-react';
import { useAuthContext } from '@/context/AuthContext';
import { useTenantContext } from '@/context/TenantContext';

const adminLinks = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/students', label: 'Students', icon: GraduationCap },
  { href: '/admin/teachers', label: 'Teachers', icon: Users },
  { href: '/admin/classes', label: 'Classes', icon: School },
  { href: '/admin/subjects', label: 'Subjects', icon: BookOpen },
  { href: '/admin/branding', label: 'Branding', icon: Palette },
];

const teacherLinks = [
  { href: '/teacher', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/teacher/exams', label: 'Exams', icon: FlaskConical },
];

const studentLinks = [
  { href: '/student', label: 'Dashboard', icon: LayoutDashboard },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuthContext();
  const { tenant } = useTenantContext();

  const links =
    user?.role === 'ADMIN'
      ? adminLinks
      : user?.role === 'TEACHER'
      ? teacherLinks
      : studentLinks;

  return (
    <aside className="w-60 h-screen fixed left-0 top-0 bg-[var(--brand-primary,#0A1F44)] text-white flex flex-col">
      <div className="p-6 border-b border-white/10">
        <h1 className="text-xl font-bold truncate">
          {tenant?.name || 'Brillianda'}
        </h1>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {links.map((link) => {
          const Icon = link.icon;
          const active = pathname === link.href || pathname.startsWith(link.href + '/');
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-md transition-colors',
                active
                  ? 'bg-white/10 border-l-4 border-[#FF6B00]'
                  : 'hover:bg-white/5 border-l-4 border-transparent'
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="font-medium">{link.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-white/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-sm font-bold">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {user?.firstName} {user?.lastName}
            </p>
            <p className="text-xs text-white/60 truncate">{user?.email}</p>
          </div>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-2 w-full px-4 py-2 text-sm rounded-md hover:bg-white/10 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Logout
        </button>
      </div>
    </aside>
  );
}
