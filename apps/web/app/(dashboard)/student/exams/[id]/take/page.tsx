'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { CBTInterface } from '@/components/student/CBTInterface';

export default function TakeExamPage() {
  const { id } = useParams();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.post(`/student/exams/${id}/start`)
      .then((res) => {
        if (res.data.success) setData(res.data.data);
      })
      .catch((err) => {
        setError(err.response?.data?.error || 'Failed to start exam');
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <button onClick={() => router.push(`/student/exams/${id}`)} className="text-[#0A1F44] underline">
            Back to Exam
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <CBTInterface
      examId={id as string}
      attemptId={data.attemptId}
      durationMinutes={data.durationMinutes}
      startTime={data.startTime}
      questions={data.questions}
      onSubmitted={() => router.push(`/student/exams/${id}/results`)}
    />
  );
}
