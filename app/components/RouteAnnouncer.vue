<script setup lang="ts">
import { useRoute } from "vue-router";
const route = useRoute();
</script>
<template><span class="visually-hidden absolute size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]" role="status" aria-live="polite">{{ route.meta.title }}</span></template>
