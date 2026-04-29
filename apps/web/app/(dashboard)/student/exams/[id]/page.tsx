'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function StudentExamPage() {
  const { id } = useParams();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/student/exams/${id}`).then((res) => {
      if (res.data.success) setData(res.data.data);
    }).finally(() => setLoading(false));
  }, [id]);

  const handleStart = async () => {
    try {
      const res = await api.post(`/student/exams/${id}/start`);
      if (res.data.success) {
        router.push(`/student/exams/${id}/take`);
      }
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to start exam');
    }
  };

  if (loading) {
    return (
      <DashboardShell title="Exam">
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      </DashboardShell>
    );
  }

  if (!data?.exam) {
    return (
      <DashboardShell title="Exam">
        <p className="text-center py-20 text-gray-500">Exam not found</p>
      </DashboardShell>
    );
  }

  const { exam, attempt } = data;

  return (
    <DashboardShell title={exam.title}>
      <PageHeader title={exam.title} />
      <Card className="p-6 rounded-xl border border-gray-200 bg-white shadow-sm max-w-2xl">
        <CardContent className="p-0 space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-gray-500">Subject:</span> <strong>{exam.subject?.name}</strong></div>
            <div><span className="text-gray-500">Duration:</span> <strong>{exam.durationMinutes} min</strong></div>
            <div><span className="text-gray-500">Questions:</span> <strong>{exam.questions?.length}</strong></div>
            <div><span className="text-gray-500">Status:</span> <strong>{attempt?.isSubmitted ? 'Completed' : attempt ? 'In Progress' : 'Not Started'}</strong></div>
          </div>
          {exam.instructions && (
            <div className="text-sm text-gray-600 bg-gray-50 p-4 rounded-md">{exam.instructions}</div>
          )}

          {attempt?.isSubmitted ? (
            <Button onClick={() => router.push(`/student/exams/${id}/results`)} className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
              View Results
            </Button>
          ) : (
            <Button onClick={handleStart} className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
              {attempt ? 'Resume Exam' : 'Start Exam'}
            </Button>
          )}
        </CardContent>
      </Card>
    </DashboardShell>
  );
}
