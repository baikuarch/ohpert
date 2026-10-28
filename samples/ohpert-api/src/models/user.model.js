const rows = new Map();
let seq = 1;

export const User = {
  create({ username, passwordHash, nickname }) {
    const user = {
      id: String(seq++),
      username,
      passwordHash,
      nickname: nickname || username,
      avatar: '',
      createdAt: new Date().toISOString(),
    };
    rows.set(user.id, user);
    return user;
  },
  findById(id) {
    return rows.get(id) || null;
  },
  findByUsername(username) {
    return [...rows.values()].find((u) => u.username === username) || null;
  },
  all() {
    return [...rows.values()];
  },
  update(id, patch) {
    const user = rows.get(id);
    if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
    Object.assign(user, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return user;
  },
  toPublic(user) {
    const { passwordHash, ...rest } = user;
    return rest;
  },
};
