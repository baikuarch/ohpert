import { Router } from 'express';
import { login, register, refreshToken } from '../services/auth.service.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const result = await login(username, password);
    res.json({ code: 0, data: result });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const result = await register(req.body);
    res.json({ code: 0, data: result });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const result = await refreshToken(req.body.refreshToken);
    res.json({ code: 0, data: result });
  } catch (err) {
    next(err);
  }
});
