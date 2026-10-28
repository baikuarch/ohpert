<template>
  <div class="login-page">
    <h2>登录 ohpert</h2>
    <input v-model="form.username" placeholder="用户名" />
    <input v-model="form.password" type="password" placeholder="密码" />
    <button @click="submit">登录</button>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '../api/auth.js';

const router = useRouter();
const form = reactive({ username: '', password: '' });
const error = ref('');

async function submit() {
  try {
    const res = await login(form);
    localStorage.setItem('accessToken', res.data.accessToken);
    router.push('/orders');
  } catch (e) {
    error.value = e.response?.data?.message || '登录失败';
  }
}
</script>
