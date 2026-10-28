import { http } from './request.js';

export function fetchOrders(params) {
  return http.get('/orders/list', { params });
}

export function fetchOrderDetail(id) {
  return http.get(`/orders/${id}`);
}

export function createOrder(payload) {
  return http.post('/orders', payload);
}

export function cancelOrder(id) {
  return http.post(`/orders/${id}/cancel`);
}
