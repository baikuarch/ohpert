import { Order } from '../models/order.model.js';

export async function listOrders(userId, { status, page }) {
  const rows = Order.byUser(userId).filter((o) => !status || o.status === status);
  return { page, total: rows.length, list: rows };
}

export async function getOrderDetail(id) {
  const order = Order.findById(id);
  if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
  return order;
}

export async function createOrder(userId, payload) {
  return Order.create({ userId, items: payload.items, remark: payload.remark, status: 'pending' });
}

export async function cancelOrder(id, userId) {
  const order = Order.findById(id);
  if (!order || order.userId !== userId) throw Object.assign(new Error('无权操作'), { status: 403 });
  if (order.status !== 'pending') throw Object.assign(new Error('当前状态不可取消'), { status: 400 });
  return Order.update(id, { status: 'cancelled' });
}
