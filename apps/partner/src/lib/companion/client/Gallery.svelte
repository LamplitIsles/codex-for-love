<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { f7, f7ready } from 'framework7-svelte';
  import type { VirtualList } from 'framework7/components/virtual-list';
  import type { GalleryRow, GalleryImage } from './gallery.ts';
  export let rows: GalleryRow[];
  export let hasMore: boolean;
  export let loading: boolean;
  export let loadMore: () => Promise<void>;
  export let pick: (image: GalleryImage) => void;
  let viewport: HTMLDivElement, list: HTMLDivElement;
  let virtual: VirtualList.VirtualList | undefined;
  let rendered: VirtualList.VirtualListRenderData = { fromIndex: 0, toIndex: 0, listHeight: 0, topPosition: 0, items: [] };
  let disposed = false;
  onMount(() => f7ready(() => {
    if (disposed) return;
    // Framework7 9 supplies (list, data); its published declaration omits the list argument.
    const params = { el: list, createUl: false, items: rows, height: (row: GalleryRow) => row.kind === 'group' ? 38 : 132,
      renderExternal(_list: VirtualList.VirtualList, data: VirtualList.VirtualListRenderData) { rendered = data; } };
    virtual = f7.virtualList.create(params as unknown as VirtualList.Parameters);
    void tick().then(checkMore);
  }));
  $: if (virtual && rows) { virtual.replaceAllItems(rows); void tick().then(checkMore); }
  function checkMore() { if (hasMore && !loading && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 250) void loadMore(); }
  onDestroy(() => { disposed = true; virtual?.destroy(); });
</script>
<div bind:this={viewport} class="page-content companion-gallery-viewport" on:scroll={checkMore}>
  <div bind:this={list} class="virtual-list companion-gallery-virtual" style={`height:${rendered.listHeight}px`}>
    <div style={`transform:translateY(${rendered.topPosition}px)`}>
      {#each rendered.items as row (row.key)}
        {#if row.kind === 'group'}<div class="companion-gallery-group"><h3>{row.label}</h3></div>
        {:else}<div class="companion-gallery-grid">{#each row.images as image (image.id)}<button type="button" class="companion-gallery-tile" aria-label={image.filename} disabled={!image.available} on:click={() => pick(image)}><img src={image.url} alt={image.filename} loading="lazy" decoding="async" /></button>{/each}</div>{/if}
      {/each}
    </div>
  </div>
</div>
