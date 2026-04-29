'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Trash2 } from 'lucide-react';

export default function ClassesPage() {
  const [classes, setClasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');

  const fetchClasses = () => {
    api.get('/admin/classes').then((res) => {
      if (res.data.success) setClasses(res.data.data);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchClasses();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post('/admin/classes', { name });
    setName('');
    fetchClasses();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this class?')) return;
    await api.delete(`/admin/classes/${id}`);
    fetchClasses();
  };

  return (
    <DashboardShell title="Classes">
      <PageHeader title="Classes" />
      <form onSubmit={handleCreate} className="flex gap-3 mb-6 max-w-md">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Class name" required />
        <Button type="submit" className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">Add</Button>
      </form>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden max-w-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {classes.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <button onClick={() => handleDelete(c.id)} className="text-red-600 hover:text-red-700">
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
