import { http } from './request.js';

export function login(payload) {
  return http.post('/auth/login', payload);
}

export function register(payload) {
  return http.post('/auth/register', payload);
}
