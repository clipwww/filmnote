<script setup lang="ts">
/**
 * `/film` 先前是 404，使用者從個人頁想「看看還有什麼片」時會撞到死路。這裡不建瀏覽索引頁
 * （那是新功能、要先有設計）而是導到 `/search`——那正是「找片」的入口而且已經能用。
 * 等 design session 定案後再決定要不要做真正的片庫瀏覽頁。
 */
definePageMeta({
  redirect: '/search',
})
</script>
