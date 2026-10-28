import axios from 'axios';

export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export const http = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('accessToken');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);
