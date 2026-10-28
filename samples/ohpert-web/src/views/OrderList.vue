<template>
  <div class="order-list">
    <h2>我的订单</h2>
    <select v-model="status" @change="load">
      <option value="">全部</option>
      <option value="pending">待支付</option>
      <option value="paid">已支付</option>
      <option value="cancelled">已取消</option>
    </select>
    <ul>
      <li v-for="order in orders" :key="order.id">
        <router-link :to="`/orders/${order.id}`">订单 {{ order.id }}</router-link>
        <span>{{ order.status }}</span>
        <span>¥{{ order.totalAmount }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { fetchOrders } from '../api/order.js';

const orders = ref([]);
const status = ref('');

async function load() {
  const res = await fetchOrders({ status: status.value });
  orders.value = res.data.list;
}

onMounted(load);
</script>
