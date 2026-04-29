'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  logoUrl: string | null;
  brandColor: string | null;
}

interface TenantContextValue {
  tenant: Tenant | null;
  loading: boolean;
}

const TenantContext = createContext<TenantContextValue>({ tenant: null, loading: true });

export function TenantProvider({
  children,
  initialTenant,
}: {
  children: React.ReactNode;
  initialTenant: Tenant | null;
}) {
  const [tenant, setTenant] = useState<Tenant | null>(initialTenant);
  const [loading, setLoading] = useState(!initialTenant);

  useEffect(() => {
    if (initialTenant) return;

    const subdomain = document.cookie.match(/tenant_subdomain=([^;]+)/)?.[1];
    if (!subdomain) {
      setLoading(false);
      return;
    }

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    fetch(`${apiUrl}/api/v1/public/tenant/${subdomain}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.success) setTenant(data.data);
      })
      .finally(() => setLoading(false));
  }, [initialTenant]);

  return (
    <TenantContext.Provider value={{ tenant, loading }}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenantContext() {
  return useContext(TenantContext);
}
