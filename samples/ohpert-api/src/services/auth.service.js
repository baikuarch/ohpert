import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/user.model.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret';

export async function login(username, password) {
  const user = User.findByUsername(username);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 401 });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw Object.assign(new Error('密码错误'), { status: 401 });
  return issueTokens(user);
}

export async function register({ username, password, nickname }) {
  if (User.findByUsername(username)) throw Object.assign(new Error('用户名已存在'), { status: 409 });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = User.create({ username, passwordHash, nickname });
  return issueTokens(user);
}

export async function refreshToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    const user = User.findById(payload.id);
    if (!user) throw new Error('no user');
    return issueTokens(user);
  } catch {
    throw Object.assign(new Error('refreshToken 无效'), { status: 401 });
  }
}

function issueTokens(user) {
  const accessToken = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '2h' });
  const refreshToken = jwt.sign({ id: user.id }, SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken, user: User.toPublic(user) };
}
