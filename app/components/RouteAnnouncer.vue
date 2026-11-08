<script setup lang="ts">
import { useRoute } from "vue-router";
const route = useRoute();
</script>
<template><span class="visually-hidden" role="status" aria-live="polite">{{ route.meta.title }}</span></template>
