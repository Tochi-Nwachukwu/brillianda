'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Users, GraduationCap, School, BookOpen, FlaskConical } from 'lucide-react';

export default function AdminDashboardPage() {
  const [stats, setStats] = useState({ students: 0, teachers: 0, classes: 0, subjects: 0, exams: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/admin/dashboard').then((res) => {
      if (res.data.success) setStats(res.data.data);
    }).finally(() => setLoading(false));
  }, []);

  const items = [
    { label: 'Students', value: stats.students, icon: GraduationCap },
    { label: 'Teachers', value: stats.teachers, icon: Users },
    { label: 'Classes', value: stats.classes, icon: School },
    { label: 'Subjects', value: stats.subjects, icon: BookOpen },
    { label: 'Exams', value: stats.exams, icon: FlaskConical },
  ];

  return (
    <DashboardShell title="Admin Dashboard">
      <PageHeader title="Dashboard" />
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Card key={item.label} className="p-6 rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="flex items-start justify-between mb-4">
                  <Icon className="w-6 h-6 text-[#FF6B00]" />
                </div>
                <div className="text-3xl font-bold text-[#0A1F44]">{item.value}</div>
                <div className="text-sm text-gray-500 mt-1">{item.label}</div>
              </Card>
            );
          })}
        </div>
      )}
    </DashboardShell>
  );
}
