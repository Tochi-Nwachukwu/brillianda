import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export const api = axios.create({
  baseURL: API_URL + '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const subdomain = typeof window !== 'undefined'
    ? (document.cookie.match(/tenant_subdomain=([^;]+)/)?.[1] ?? '')
    : '';

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
