'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function TeacherExamsPage() {
  const [exams, setExams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchExams = () => {
    api.get('/teacher/exams').then((res) => {
      if (res.data.success) setExams(res.data.data);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchExams();
  }, []);

  return (
    <DashboardShell title="Exams">
      <PageHeader title="Exams">
        <Link href="/teacher/exams/new">
          <Button className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">New Exam</Button>
        </Link>
      </PageHeader>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Questions</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.title}</TableCell>
                  <TableCell>{e.subject?.name}</TableCell>
                  <TableCell>
                    <span className={`inline-flex px-2 py-1 text-xs rounded-full font-medium ${
                      e.status === 'PUBLISHED' ? 'bg-green-100 text-green-700' :
                      e.status === 'CLOSED' ? 'bg-gray-100 text-gray-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {e.status}
                    </span>
                  </TableCell>
                  <TableCell>{e._count?.questions ?? 0}</TableCell>
                  <TableCell>{e._count?.attempts ?? 0}</TableCell>
                  <TableCell>
                    <Link href={`/teacher/exams/${e.id}`}>
                      <Button variant="outline" size="sm">View</Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </DashboardShell>
  );
}
