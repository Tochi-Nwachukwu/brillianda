'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function SubjectsPage() {
  const [subjects, setSubjects] = useState<any[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [teacherId, setTeacherId] = useState('');

  const fetchData = () => {
    Promise.all([api.get('/admin/subjects'), api.get('/admin/teachers')]).then(([sRes, tRes]) => {
      if (sRes.data.success) setSubjects(sRes.data.data);
      if (tRes.data.success) setTeachers(tRes.data.data);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post('/admin/subjects', { name, teacherId });
    setName('');
    setTeacherId('');
    fetchData();
  };

  return (
    <DashboardShell title="Subjects">
      <PageHeader title="Subjects" />
      <form onSubmit={handleCreate} className="flex gap-3 mb-6 max-w-xl items-end">
        <div className="flex-1">
          <Label>Subject Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mathematics" required />
        </div>
        <div className="flex-1">
          <Label>Teacher</Label>
          <Select value={teacherId} onValueChange={(v: string | null) => v && setTeacherId(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select teacher" />
            </SelectTrigger>
            <SelectContent>
              {teachers.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.firstName} {t.lastName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">Add</Button>
      </form>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden max-w-xl">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Teacher</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subjects.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.teacher ? `${s.teacher.firstName} ${s.teacher.lastName}` : '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </DashboardShell>
  );
}
