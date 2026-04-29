'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function ExamResultsPage() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/teacher/exams/${id}/results`).then((res) => {
      if (res.data.success) setData(res.data.data);
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <DashboardShell title="Exam Results">
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell title="Exam Results">
      <PageHeader title="Exam Results" />
      {data?.stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          {[
            { label: 'Average', value: data.stats.averageScore.toFixed(1) },
            { label: 'Highest', value: data.stats.highestScore.toFixed(1) },
            { label: 'Lowest', value: data.stats.lowestScore.toFixed(1) },
            { label: 'Submitted', value: data.stats.submittedCount },
            { label: 'Pending', value: data.stats.pendingCount },
          ].map((s) => (
            <Card key={s.label} className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
              <CardContent className="p-0">
                <div className="text-2xl font-bold text-[#0A1F44]">{s.value}</div>
                <div className="text-sm text-gray-500">{s.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Submitted At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.attempts?.map((a: any) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.student?.firstName} {a.student?.lastName}</TableCell>
                <TableCell>{a.score !== null ? `${a.score} / ${a.maxScore}` : '-'}</TableCell>
                <TableCell>
                  <span className={`inline-flex px-2 py-1 text-xs rounded-full font-medium ${a.isSubmitted ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                    {a.isSubmitted ? 'Submitted' : 'In Progress'}
                  </span>
                </TableCell>
                <TableCell>{a.completedAt ? new Date(a.completedAt).toLocaleString() : '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </DashboardShell>
  );
}
