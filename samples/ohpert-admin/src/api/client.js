import axios from 'axios';

export const api = axios.create({ baseURL: '/api' });

export function getUsers(params) {
  return api.get('/user/list', { params });
}

export function getAuditLogs(params) {
  return api.get('/admin/audit-logs', { params });
}
