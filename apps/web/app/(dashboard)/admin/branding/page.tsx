'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function BrandingPage() {
  const [logoUrl, setLogoUrl] = useState('');
  const [brandColor, setBrandColor] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.patch('/admin/branding', {
        logoUrl: logoUrl || undefined,
        brandColor: brandColor || undefined,
      });
      if (res.data.success) setMessage('Branding updated successfully');
    } catch {
      setMessage('Failed to update branding');
    }
  };

  return (
    <DashboardShell title="Branding">
      <PageHeader title="Branding" />
      <div className="max-w-xl bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        {message && <p className="mb-4 text-sm text-green-700">{message}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Logo URL</Label>
            <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://..." />
          </div>
          <div>
            <Label>Brand Color (hex)</Label>
            <Input value={brandColor} onChange={(e) => setBrandColor(e.target.value)} placeholder="#0A1F44" />
          </div>
          <Button type="submit" className="bg-[#0D0D0D] text-white hover:bg-[#FF6B00]">Save</Button>
        </form>
      </div>
    </DashboardShell>
  );
}
