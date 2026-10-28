<template>
  <div class="profile">
    <h2>个人资料</h2>
    <input v-model="form.nickname" placeholder="昵称" />
    <button @click="save">保存</button>
  </div>
</template>

<script setup>
import { onMounted, reactive } from 'vue';
import { fetchProfile, updateProfile } from '../api/user.js';

const form = reactive({ nickname: '', avatar: '' });

async function save() {
  await updateProfile(form);
}

onMounted(async () => {
  const res = await fetchProfile();
  Object.assign(form, res.data);
});
</script>
