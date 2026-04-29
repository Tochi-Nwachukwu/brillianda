'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const schema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  classId: z.string().min(1),
  password: z.string().min(8).optional(),
});

type FormData = z.infer<typeof schema>;

export default function NewStudentPage() {
  const router = useRouter();
  const [classes, setClasses] = useState<any[]>([]);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const { register, handleSubmit, setValue, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  useEffect(() => {
    api.get('/admin/classes').then((res) => {
      if (res.data.success) setClasses(res.data.data);
    });
  }, []);

  const onSubmit = async (data: FormData) => {
    const res = await api.post('/admin/students', data);
    if (res.data.success) {
      if (res.data.data.generatedPassword) {
        setGeneratedPassword(res.data.data.generatedPassword);
      } else {
        router.push('/admin/students');
      }
    }
  };

  return (
    <DashboardShell title="Add Student">
      <PageHeader title="Add Student" />
      <div className="max-w-xl bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        {generatedPassword && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-md">
            <p className="text-sm text-green-800 font-medium">Student created successfully!</p>
            <p className="text-sm text-green-700 mt-1">Generated password: <strong>{generatedPassword}</strong></p>
            <Button onClick={() => router.push('/admin/students')} className="mt-3 bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
              Back to Students
            </Button>
          </div>
        )}
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label>First Name</Label>
            <Input {...register('firstName')} />
            {errors.firstName && <p className="text-sm text-red-600 mt-1">{errors.firstName.message}</p>}
          </div>
          <div>
            <Label>Last Name</Label>
            <Input {...register('lastName')} />
            {errors.lastName && <p className="text-sm text-red-600 mt-1">{errors.lastName.message}</p>}
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" {...register('email')} />
            {errors.email && <p className="text-sm text-red-600 mt-1">{errors.email.message}</p>}
          </div>
          <div>
            <Label>Class</Label>
            <Select onValueChange={(v: string | null) => v && setValue('classId', v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select class" />
              </SelectTrigger>
              <SelectContent>
                {classes.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.classId && <p className="text-sm text-red-600 mt-1">{errors.classId.message}</p>}
          </div>
          <div>
            <Label>Password (optional)</Label>
            <Input type="password" {...register('password')} />
            {errors.password && <p className="text-sm text-red-600 mt-1">{errors.password.message}</p>}
          </div>
          <Button type="submit" disabled={isSubmitting} className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">
            {isSubmitting ? 'Creating...' : 'Create Student'}
          </Button>
        </form>
      </div>
    </DashboardShell>
  );
}
