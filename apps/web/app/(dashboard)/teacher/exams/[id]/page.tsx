'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';

export default function TeacherExamDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [exam, setExam] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/teacher/exams/${id}`).then((res) => {
      if (res.data.success) setExam(res.data.data);
    }).finally(() => setLoading(false));
  }, [id]);

  const handlePublish = async () => {
    await api.patch(`/teacher/exams/${id}/publish`);
    window.location.reload();
  };

  const handleClose = async () => {
    await api.patch(`/teacher/exams/${id}/close`);
    window.location.reload();
  };

  if (loading) {
    return (
      <DashboardShell title="Exam Details">
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      </DashboardShell>
    );
  }

  if (!exam) {
    return (
      <DashboardShell title="Exam Details">
        <p className="text-center py-20 text-gray-500">Exam not found</p>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell title={exam.title}>
      <PageHeader title={exam.title}>
        {exam.status === 'DRAFT' && (
          <Button onClick={handlePublish} className="bg-green-600 text-white hover:bg-green-700">Publish</Button>
        )}
        {exam.status === 'PUBLISHED' && (
          <Button onClick={handleClose} variant="outline">Close</Button>
        )}
        <Link href={`/teacher/exams/${id}/results`}>
          <Button variant="outline">Results</Button>
        </Link>
      </PageHeader>

      <div className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><span className="text-gray-500">Subject:</span> <strong>{exam.subject?.name}</strong></div>
            <div><span className="text-gray-500">Duration:</span> <strong>{exam.durationMinutes} min</strong></div>
            <div><span className="text-gray-500">Status:</span> <strong>{exam.status}</strong></div>
            <div><span className="text-gray-500">Questions:</span> <strong>{exam.questions?.length}</strong></div>
          </div>
          {exam.instructions && (
            <div className="mt-4 text-sm text-gray-600">{exam.instructions}</div>
          )}
        </div>

        <div>
          <h3 className="text-lg font-semibold text-[#0A1F44] mb-4">Questions</h3>
          <div className="space-y-4">
            {exam.questions?.map((q: any, idx: number) => (
              <div key={q.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
                <p className="font-medium text-[#0A1F44] mb-3">{idx + 1}. {q.text} ({q.points} pts)</p>
                <ul className="space-y-2">
                  {q.options.map((o: any) => (
                    <li key={o.id} className={`text-sm px-3 py-2 rounded-md ${o.isCorrect ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-gray-50'}`}>
                      {o.text} {o.isCorrect && '(Correct)'}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
