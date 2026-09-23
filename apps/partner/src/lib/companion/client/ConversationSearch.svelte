<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import Search from 'lucide-svelte/icons/search';
  import X from 'lucide-svelte/icons/x';
  import type { CompanionTranslate } from './locale.js';
  import { contextTargetIndex, snippetParts, textParts } from './conversation-search-highlight.js';

  type Card = { id: string; kind: 'message' | 'compaction'; sessionId: string; sessionName?: string; cwd: string; role?: 'user' | 'assistant'; phase?: string; createdAt?: string; snippet: string };
  type RecordItem = Omit<Card, 'snippet'> & { content: string };
  type ContextItem = { sourceRecordIndex: number; kind: 'message' | 'compaction' | 'tool'; role?: 'user' | 'assistant'; content: string; truncated?: boolean };
  type Expanded = { record: RecordItem; context: { targetSourceRecordIndex: number; truncated: boolean; items: ContextItem[] } };

  export let t: CompanionTranslate;
  export let locale: string;
  export let companionName: string;
  export let onClose: () => void;

  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let reader: HTMLDivElement;
  let query = '';
  let searched = '';
  let results: Card[] = [];
  let estimatedTotal = 0;
  let searchedOnce = false;
  let searching = false;
  let searchError = false;
  let selected: Card | undefined;
  let expanded: Expanded | undefined;
  let reading = false;
  let readError = false;
  let searchRequest: AbortController | undefined;
  let readRequest: AbortController | undefined;

  onMount(() => { dialog.showModal(); requestAnimationFrame(() => input?.focus()); });
  onDestroy(() => { searchRequest?.abort(); readRequest?.abort(); });

  function close() { dialog.close(); }
  function date(value?: string): string {
    if (!value || Number.isNaN(Date.parse(value))) return '';
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }
  function sender(item: { kind: string; role?: string }): string {
    if (item.kind === 'compaction') return t('search.summary');
    return item.role === 'user' ? t('you') : companionName;
  }
  async function search(event: SubmitEvent) {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    searchRequest?.abort();
    const request = new AbortController();
    searchRequest = request;
    searched = value; searchedOnce = true; searching = true; searchError = false;
    results = []; selected = undefined; expanded = undefined;
    try {
      const response = await fetch(`/api/conversation-search?q=${encodeURIComponent(value)}`, { signal: request.signal });
      if (!response.ok) throw new Error('Search unavailable');
      const data = await response.json() as { estimatedTotalHits: number; hits: Card[] };
      if (searchRequest !== request) return;
      results = data.hits; estimatedTotal = data.estimatedTotalHits;
    } catch (error) {
      if (searchRequest === request && (error as Error).name !== 'AbortError') searchError = true;
    } finally { if (searchRequest === request) searching = false; }
  }
  async function openRecord(card: Card) {
    readRequest?.abort();
    const request = new AbortController();
    readRequest = request;
    selected = card; expanded = undefined; reading = true; readError = false;
    try {
      const response = await fetch(`/api/conversation-search/${card.id}`, { signal: request.signal });
      if (!response.ok) throw new Error('Record unavailable');
      const data = await response.json() as Expanded;
      if (readRequest === request) expanded = data;
    } catch (error) {
      if (readRequest === request && (error as Error).name !== 'AbortError') readError = true;
    } finally { if (readRequest === request) reading = false; }
    if (readRequest !== request || !expanded) return;
    await tick();
    if (readRequest !== request || selected?.id !== card.id) return;
    const target = reader?.querySelector<HTMLElement>('.search-target');
    if (!target) return;
    const targetIndex = contextTargetIndex(expanded.context.targetSourceRecordIndex, expanded.context.items);
    if (targetIndex <= 0) {
      reader.scrollTop = 0;
      return;
    }
    if (targetIndex === expanded.context.items.length - 1) {
      reader.scrollTop = reader.scrollHeight;
      return;
    }
    const focus = target.querySelector<HTMLElement>('mark') ?? target;
    const readerRect = reader.getBoundingClientRect();
    const focusRect = focus.getBoundingClientRect();
    reader.scrollTop += focusRect.top - readerRect.top - (reader.clientHeight - focusRect.height) / 2;
  }
  function backToResults() { readRequest?.abort(); selected = undefined; expanded = undefined; }
</script>

<dialog bind:this={dialog} class="cmp-modal companion-search-dialog" aria-label={t('search.title')} on:close={onClose}>
  <section class="cmp-modal-box companion-search-box" aria-label={t('search.title')}>
    <header class="companion-search-header">
      <button type="button" class="cmp-btn cmp-btn-ghost cmp-btn-circle" aria-label={selected ? t('search.back') : t('close')} on:click={selected ? backToResults : close}>
        {#if selected}<ArrowLeft size={20} aria-hidden="true" />{:else}<X size={20} aria-hidden="true" />{/if}
      </button>
      <div class="companion-search-heading"><h2>{t('search.title')}</h2></div>
    </header>

    {#if selected}
      <div bind:this={reader} class="companion-search-reader" role="region" aria-label={t('search.reader')}>
        {#if reading}<p class="companion-search-state" role="status"><span class="cmp-loading cmp-loading-spinner cmp-loading-sm"></span>{t('loading')}</p>
        {:else if readError}<div class="companion-search-state" role="alert"><p>{t('search.readFailed')}</p><button type="button" class="cmp-btn cmp-btn-ghost cmp-btn-sm" on:click={() => void openRecord(selected!)}>{t('retry')}</button></div>
        {:else if expanded}
          {@const targetIndex = contextTargetIndex(expanded.context.targetSourceRecordIndex, expanded.context.items)}
          <div class="companion-search-dayline">{date(expanded.record.createdAt)}</div>
          {#if targetIndex < 0}
            <article class="companion-search-message" class:from-human={expanded.record.role === 'user'} class:search-target={true}>
              <div class="companion-search-sender">{sender(expanded.record)}</div>
              <div class="companion-search-bubble">{#each textParts(expanded.record.content, searched) as part}{#if part.matched}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</div>
            </article>
          {/if}
          {#each expanded.context.items as item, index (item.sourceRecordIndex)}
            {@const active = index === targetIndex}
            <article class="companion-search-message" class:from-human={item.role === 'user'} class:search-target={active}>
              <div class="companion-search-sender">{sender(item)}</div>
              <div class="companion-search-bubble">{#each textParts(active ? expanded.record.content : item.content, active ? searched : '') as part}{#if part.matched}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</div>
            </article>
          {/each}
          {#if expanded.context.truncated}<p class="companion-search-truncated">{t('search.contextTruncated')}</p>{/if}
        {/if}
      </div>
    {:else}
      <form class="companion-search-form" role="search" on:submit={search}>
        <label class="companion-search-input-wrap">
          <Search size={19} strokeWidth={2} aria-hidden="true" />
          <input bind:this={input} bind:value={query} type="search" class="cmp-input cmp-input-ghost" aria-label={t('search.open')} placeholder={t('search.placeholder')} maxlength="500" autocomplete="off" />
        </label>
        <button type="submit" class="cmp-btn cmp-btn-primary" disabled={!query.trim() || searching}>{t('search.submit')}</button>
      </form>
      <div class="companion-search-results" role="region" aria-label={t('search.results')}>
        {#if searching}<p class="companion-search-state" role="status"><span class="cmp-loading cmp-loading-spinner cmp-loading-sm"></span>{t('search.searching')}</p>
        {:else if searchError}<div class="companion-search-state" role="alert"><p>{t('search.failed')}</p><button type="button" class="cmp-btn cmp-btn-ghost cmp-btn-sm" on:click={() => input?.form?.requestSubmit()}>{t('retry')}</button></div>
        {:else if !searchedOnce}<div class="companion-search-welcome"><p>{t('search.prompt')}</p></div>
        {:else if results.length === 0}<p class="companion-search-state">{t('search.empty')}</p>
        {:else}
          <div class="companion-search-count" aria-live="polite">{t('search.count', { count: estimatedTotal })}{#if estimatedTotal > results.length} · {t('search.limit')}{/if}</div>
          <div class="companion-search-list">
            {#each results as card (card.id)}
              <button type="button" class="cmp-btn cmp-btn-ghost companion-search-result" on:click={() => void openRecord(card)}>
                <span class="companion-search-avatar" class:human={card.role === 'user'} aria-hidden="true">{card.role === 'user' ? t('you').slice(0, 1) : '✦'}</span>
                <span class="companion-search-result-body">
                  <span class="companion-search-result-top"><strong>{sender(card)}</strong><time datetime={card.createdAt ?? undefined}>{date(card.createdAt)}</time></span>
                  <span class="companion-search-snippet">{#each snippetParts(card.snippet) as part}{#if part.matched}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>
  <form method="dialog" class="cmp-modal-backdrop"><button type="submit" aria-label={t('close')}>{t('close')}</button></form>
</dialog>
