'use client';

import { useTenantContext } from '@/context/TenantContext';

export function useTenant() {
  return useTenantContext();
}
