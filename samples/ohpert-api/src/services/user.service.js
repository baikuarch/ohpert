import { User } from '../models/user.model.js';

export async function getProfile(id) {
  const user = User.findById(id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  return User.toPublic(user);
}

export async function updateProfile(id, patch) {
  const user = User.update(id, { nickname: patch.nickname, avatar: patch.avatar });
  return User.toPublic(user);
}

export async function listUsers({ page, size }) {
  const all = User.all();
  const start = (page - 1) * size;
  return { total: all.length, page, size, list: all.slice(start, start + size).map(User.toPublic) };
}
