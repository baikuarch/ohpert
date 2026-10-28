import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createOrder, listOrders, getOrderDetail, cancelOrder } from '../services/order.service.js';

export const orderRouter = Router();

orderRouter.get('/list', requireAuth, async (req, res) => {
  const data = await listOrders(req.user.id, { status: req.query.status, page: Number(req.query.page || 1) });
  res.json({ code: 0, data });
});

orderRouter.get('/:id', requireAuth, async (req, res) => {
  const data = await getOrderDetail(req.params.id);
  res.json({ code: 0, data });
});

orderRouter.post('/', requireAuth, async (req, res) => {
  const data = await createOrder(req.user.id, req.body);
  res.json({ code: 0, data });
});

orderRouter.post('/:id/cancel', requireAuth, async (req, res) => {
  const data = await cancelOrder(req.params.id, req.user.id);
  res.json({ code: 0, data });
});
