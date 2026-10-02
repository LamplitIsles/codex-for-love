<script lang="ts">
  import type { Snippet } from 'svelte';
  let { href, title, children }: { href?: string; title?: string; children?: Snippet } = $props();
</script>

<a class="external" {href} {title} target="_blank" rel="noopener noreferrer">
  {@render children?.()}
</a>
