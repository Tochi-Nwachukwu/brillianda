'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export default function BulkUploadPage() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const lines = text.trim().split('\n').filter(Boolean);
    const students = lines.map((line) => {
      const [email, firstName, lastName, classId] = line.split(',').map((s) => s.trim());
      return { email, firstName, lastName, classId };
    });

    setLoading(true);
    try {
      const res = await api.post('/admin/students/bulk', { students });
      if (res.data.success) setResult(res.data.data);
    } finally {
      setLoading(false);
    }
  };

  return (
    <DashboardShell title="Bulk Upload Students">
      <PageHeader title="Bulk Upload Students" />
      <div className="max-w-2xl bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <p className="text-sm text-gray-600 mb-4">
          Enter one student per line, comma-separated: <code>email,firstName,lastName,classId</code>
        </p>
        <Textarea
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="student1@school.com,John,Doe,class-id-here"
        />
        <div className="mt-4 flex gap-3">
          <Button onClick={handleSubmit} disabled={loading} className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
            {loading ? 'Uploading...' : 'Upload'}
          </Button>
          <Button variant="outline" onClick={() => router.push('/admin/students')}>
            Cancel
          </Button>
        </div>

        {result && (
          <div className="mt-6 space-y-3">
            <p className="text-green-700 font-medium">Created: {result.created}</p>
            {result.errors?.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-md p-4">
                <p className="text-red-800 font-medium mb-2">Errors ({result.errors.length}):</p>
                <ul className="text-sm text-red-700 space-y-1">
                  {result.errors.map((e: any, i: number) => (
                    <li key={i}>Row {e.row}: {e.error}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
