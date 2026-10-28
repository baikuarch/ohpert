import { http } from './request.js';

export function fetchProfile() {
  return http.get('/user/profile');
}

export function updateProfile(payload) {
  return http.put('/user/profile', payload);
}
