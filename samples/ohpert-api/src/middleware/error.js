export function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  res.status(status).json({ code: status, message: err.message || '服务器错误' });
}
