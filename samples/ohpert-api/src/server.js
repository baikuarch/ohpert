import express from 'express';
import { authRouter } from './routes/auth.js';
import { userRouter } from './routes/user.js';
import { orderRouter } from './routes/order.js';
import { errorHandler } from './middleware/error.js';

const app = express();
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/orders', orderRouter);

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ohpert-api listening on ${PORT}`));
