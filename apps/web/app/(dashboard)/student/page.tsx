'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function StudentDashboardPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/student/dashboard').then((res) => {
      if (res.data.success) setData(res.data.data);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <DashboardShell title="Student Dashboard">
      <PageHeader title="Dashboard" />
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-8">
          <div>
            <h2 className="text-lg font-semibold text-[#0A1F44] mb-4">Class</h2>
            <Card className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm max-w-sm">
              <CardContent className="p-0">
                <p className="font-medium text-[#0A1F44]">{data?.classInfo?.name || 'No class assigned'}</p>
              </CardContent>
            </Card>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-[#0A1F44] mb-4">Upcoming Exams</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {data?.upcomingExams?.map((exam: any) => (
                <Card key={exam.id} className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
                  <CardContent className="p-0">
                    <p className="font-medium text-[#0A1F44]">{exam.title}</p>
                    <p className="text-sm text-gray-500">{exam.subject?.name}</p>
                    <p className="text-sm text-gray-500">{exam.durationMinutes} minutes</p>
                    <Link href={`/student/exams/${exam.id}`}>
                      <Button className="mt-3 bg-[#0D0D0D] text-white hover:bg-[#FF6B00]" size="sm">View Exam</Button>
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>
            {(!data?.upcomingExams || data.upcomingExams.length === 0) && (
              <p className="text-gray-500">No upcoming exams</p>
            )}
          </div>

          <div>
            <h2 className="text-lg font-semibold text-[#0A1F44] mb-4">Recent Results</h2>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              {data?.completedAttempts?.length ? (
                <ul className="divide-y divide-gray-100">
                  {data.completedAttempts.map((a: any) => (
                    <li key={a.id} className="px-6 py-4 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-[#0A1F44]">{a.exam?.title}</p>
                        <p className="text-sm text-gray-500">{a.exam?.subject?.name}</p>
                      </div>
                      <div className="text-right">
                        {a.exam?.showResultsImmediately ? (
                          <p className="text-lg font-bold text-[#0A1F44]">{a.score} / {a.maxScore}</p>
                        ) : (
                          <p className="text-sm text-gray-500">Results pending</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-6 py-8 text-gray-500 text-center">No completed exams yet</p>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
