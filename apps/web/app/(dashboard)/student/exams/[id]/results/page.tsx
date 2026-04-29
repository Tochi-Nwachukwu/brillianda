'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function StudentResultsPage() {
  const { id } = useParams();
  const router = useRouter();
  const [attempt, setAttempt] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/student/exams/${id}`).then((res) => {
      if (res.data.success) {
        setAttempt(res.data.data.attempt);
      }
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <DashboardShell title="Results">
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      </DashboardShell>
    );
  }

  if (!attempt || !attempt.isSubmitted) {
    return (
      <DashboardShell title="Results">
        <p className="text-center py-20 text-gray-500">No results available yet.</p>
        <div className="text-center">
          <Button onClick={() => router.push('/student')} className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
            Back to Dashboard
          </Button>
        </div>
      </DashboardShell>
    );
  }

  const percentage = attempt.maxScore > 0 ? Math.round((attempt.score / attempt.maxScore) * 100) : 0;

  return (
    <DashboardShell title="Exam Results">
      <PageHeader title="Exam Results" />
      <div className="max-w-xl mx-auto space-y-6">
        <Card className="p-8 rounded-xl border border-gray-200 bg-white shadow-sm text-center">
          <CardContent className="p-0">
            <p className="text-sm text-gray-500 mb-2">Your Score</p>
            <div className="text-5xl font-bold text-[#0A1F44] mb-2">
              {attempt.score} <span className="text-2xl text-gray-400">/ {attempt.maxScore}</span>
            </div>
            <div className={`text-lg font-medium ${percentage >= 60 ? 'text-green-600' : 'text-red-600'}`}>
              {percentage}%
            </div>
          </CardContent>
        </Card>
        <div className="text-center">
          <Button onClick={() => router.push('/student')} className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
            Back to Dashboard
          </Button>
        </div>
      </div>
    </DashboardShell>
  );
}
