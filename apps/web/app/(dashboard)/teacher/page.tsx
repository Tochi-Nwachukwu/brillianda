'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function TeacherDashboardPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/teacher/dashboard').then((res) => {
      if (res.data.success) setData(res.data.data);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <DashboardShell title="Teacher Dashboard">
      <PageHeader title="Dashboard">
        <Link href="/teacher/exams/new">
          <Button className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">New Exam</Button>
        </Link>
      </PageHeader>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-8">
          <div>
            <h2 className="text-lg font-semibold text-[#0A1F44] mb-4">My Subjects</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {data?.subjects?.map((s: any) => (
                <Card key={s.id} className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
                  <CardContent className="p-0">
                    <p className="font-medium text-[#0A1F44]">{s.name}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-[#0A1F44] mb-4">Upcoming Exams</h2>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              {data?.upcomingExams?.length ? (
                <ul className="divide-y divide-gray-100">
                  {data.upcomingExams.map((e: any) => (
                    <li key={e.id} className="px-6 py-4 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-[#0A1F44]">{e.title}</p>
                        <p className="text-sm text-gray-500">{e.startTime ? new Date(e.startTime).toLocaleString() : 'No start time'}</p>
                      </div>
                      <Link href={`/teacher/exams/${e.id}`}>
                        <Button variant="outline" size="sm">View</Button>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-6 py-8 text-gray-500 text-center">No upcoming exams</p>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
