'use client';

import { useEffect } from 'react';
import { useTenantContext } from '@/context/TenantContext';

export function TenantBrandProvider({ children }: { children: React.ReactNode }) {
  const { tenant } = useTenantContext();

  useEffect(() => {
    if (tenant?.brandColor) {
      document.documentElement.style.setProperty('--brand-primary', tenant.brandColor);
    } else {
      document.documentElement.style.setProperty('--brand-primary', '#0A1F44');
    }
  }, [tenant?.brandColor]);

  return <>{children}</>;
}
