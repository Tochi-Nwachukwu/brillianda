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
import { Trash2 } from 'lucide-react';

export default function StudentsPage() {
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStudents = () => {
    api.get('/admin/students').then((res) => {
      if (res.data.success) setStudents(res.data.data);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchStudents();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this student?')) return;
    await api.delete(`/admin/students/${id}`);
    fetchStudents();
  };

  return (
    <DashboardShell title="Students">
      <PageHeader title="Students">
        <Link href="/admin/students/bulk">
          <Button variant="outline">Bulk Upload</Button>
        </Link>
        <Link href="/admin/students/new">
          <Button className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">Add Student</Button>
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
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Class</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.firstName} {s.lastName}</TableCell>
                  <TableCell>{s.email}</TableCell>
                  <TableCell>{s.studentProfile?.class?.name || '-'}</TableCell>
                  <TableCell>
                    <button onClick={() => handleDelete(s.id)} className="text-red-600 hover:text-red-700">
                      <Trash2 className="w-4 h-4" />
                    </button>
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
