const rows = new Map();
let seq = 1000;

export const Order = {
  create({ userId, items, remark, status }) {
    const order = {
      id: String(seq++),
      userId,
      items,
      remark: remark || '',
      status,
      totalAmount: items.reduce((sum, it) => sum + it.price * it.qty, 0),
      createdAt: new Date().toISOString(),
    };
    rows.set(order.id, order);
    return order;
  },
  findById(id) {
    return rows.get(id) || null;
  },
  byUser(userId) {
    return [...rows.values()].filter((o) => o.userId === userId);
  },
  update(id, patch) {
    const order = rows.get(id);
    Object.assign(order, patch);
    return order;
  },
};
