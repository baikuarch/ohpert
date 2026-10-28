import { createRouter, createWebHistory } from 'vue-router';
import Login from '../views/Login.vue';
import OrderList from '../views/OrderList.vue';
import OrderDetail from '../views/OrderDetail.vue';
import Profile from '../views/Profile.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: Login },
    { path: '/orders', component: OrderList },
    { path: '/orders/:id', component: OrderDetail },
    { path: '/profile', component: Profile },
    { path: '/', redirect: '/orders' },
  ],
});

export default router;
