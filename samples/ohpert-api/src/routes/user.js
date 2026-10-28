import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getProfile, listUsers, updateProfile } from '../services/user.service.js';

export const userRouter = Router();

userRouter.get('/profile', requireAuth, async (req, res) => {
  const data = await getProfile(req.user.id);
  res.json({ code: 0, data });
});

userRouter.put('/profile', requireAuth, async (req, res) => {
  const data = await updateProfile(req.user.id, req.body);
  res.json({ code: 0, data });
});

userRouter.get('/list', requireAuth, async (req, res) => {
  const data = await listUsers({ page: Number(req.query.page || 1), size: Number(req.query.size || 20) });
  res.json({ code: 0, data });
});
