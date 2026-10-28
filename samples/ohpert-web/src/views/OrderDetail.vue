<template>
  <div class="order-detail">
    <h2>订单详情</h2>
    <p>状态：{{ order.status }}</p>
    <p>金额：¥{{ order.totalAmount }}</p>
    <button v-if="order.status === 'pending'" @click="onCancel">取消订单</button>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { fetchOrderDetail, cancelOrder } from '../api/order.js';

const route = useRoute();
const order = ref({});

async function load() {
  const res = await fetchOrderDetail(route.params.id);
  order.value = res.data;
}

async function onCancel() {
  await cancelOrder(route.params.id);
  await load();
}

onMounted(load);
</script>
