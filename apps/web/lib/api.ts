import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN || 'brillianda.com';
const ENV_SUBDOMAIN = process.env.NEXT_PUBLIC_TENANT_SUBDOMAIN || null;

export const api = axios.create({
  baseURL: API_URL + '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

function getSubdomain(): string | null {
  if (typeof window === 'undefined') {
    return ENV_SUBDOMAIN;
  }

  // 1. Environment variable (highest priority — used for deployed frontends)
  if (ENV_SUBDOMAIN) {
    return ENV_SUBDOMAIN;
  }

  // 2. Derive from hostname
  const host = window.location.hostname;
  if (host !== 'localhost' && host !== `www.${BASE_DOMAIN}` && host !== BASE_DOMAIN) {
    if (host.endsWith(`.${BASE_DOMAIN}`)) {
      return host.slice(0, -BASE_DOMAIN.length - 1);
    }
  }

  // 3. Cookie fallback
  const match = document.cookie.match(/tenant_subdomain=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

api.interceptors.request.use((config) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const subdomain = getSubdomain();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (subdomain) {
    config.headers['X-Tenant-Subdomain'] = subdomain;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('token');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);
