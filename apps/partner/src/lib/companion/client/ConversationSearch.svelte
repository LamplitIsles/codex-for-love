<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { overlayOpening, overlayOpened, overlayClosed } from './overlay-focus.ts';
  import { Block, BlockFooter, BlockTitle, Button, List, ListItem, Message, Messages, Navbar, Page, PageContent, Preloader, Popup, Searchbar, Subnavbar, f7 } from 'framework7-svelte';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
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

  let dialog: HTMLElement;
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

  onDestroy(() => { searchRequest?.abort(); readRequest?.abort(); });

  function close() { f7.popup.get(dialog)?.close(); }
  function date(value?: string): string {
    if (!value || Number.isNaN(Date.parse(value))) return '';
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }
  function sender(item: { kind: string; role?: string }): string {
    if (item.kind === 'compaction') return t('search.summary');
    return item.role === 'user' ? t('you') : companionName;
  }
  async function search(event?: SubmitEvent) {
    event?.preventDefault();
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
    reader = dialog.querySelector<HTMLDivElement>('.companion-search-reader')!;
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

<Popup opened closeOnEscape class="companion-search-dialog" role="dialog" aria-modal="true" aria-label={t('search.title')}
  onPopupOpen={(instance) => { if (instance) { dialog = instance.el; overlayOpening(instance); } }}
  onPopupOpened={overlayOpened}
  onPopupClosed={(instance) => { overlayClosed(instance); onClose(); }}>
  <Page class="companion-search-page" pageContent={false} subnavbar={!selected}>
    <Navbar class="companion-search-header" title={t('search.title')}>
      {#snippet navLeft()}
        <Button type="button" tonal round class="companion-search-back" aria-label={selected ? t('search.back') : t('close')} onClick={selected ? backToResults : close}>
          {#if selected}<ArrowLeft size={20} aria-hidden="true" />{:else}<X size={20} aria-hidden="true" />{/if}
        </Button>
      {/snippet}
      {#if !selected}
        <Subnavbar>
          <Searchbar class="companion-search-form" customSearch backdrop={false} disableButton={false}
            value={query} placeholder={t('search.placeholder')}
            onInput={(event: Event) => query = (event.target as HTMLInputElement).value}
            onChange={(event: Event) => query = (event.target as HTMLInputElement).value}
            onFocus={(event: FocusEvent) => { const input = event.target as HTMLInputElement; input.maxLength = 500; input.autocomplete = 'off'; input.setAttribute('aria-label', t('search.open')); f7.input.checkEmptyState(input); }}
            onSearchbarClear={() => query = ''} onSubmit={search} />
          <Button fill type="button" class="companion-search-submit" disabled={!query.trim() || searching} onClick={() => void search()}>{t('search.submit')}</Button>
        </Subnavbar>
      {/if}
    </Navbar>

    {#if selected}
      <PageContent class="companion-search-reader" messagesContent role="region" aria-label={t('search.reader')}>
        {#if reading}
          <Block class="companion-search-state" role="status"><Preloader size={24} /><span>{t('loading')}</span></Block>
        {:else if readError}
          <Block class="text-align-center" role="alert"><p>{t('search.readFailed')}</p><Button type="button" tonal onClick={() => void openRecord(selected!)}>{t('retry')}</Button></Block>
        {:else if expanded}
          {@const record = expanded.record}
          {@const targetIndex = contextTargetIndex(expanded.context.targetSourceRecordIndex, expanded.context.items)}
          <Messages scrollMessages={false}>
            <div class="messages-title">{date(expanded.record.createdAt)}</div>
            {#if targetIndex < 0}
              <Message type={expanded.record.role === 'user' ? 'sent' : 'received'} name={sender(expanded.record)} first last tail class="companion-search-message search-target">
                {#snippet text()}
                  <span class="companion-search-bubble">{#each textParts(record.content, searched) as part}{#if part.matched}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                {/snippet}
              </Message>
            {/if}
            {#each expanded.context.items as item, index (item.sourceRecordIndex)}
              {@const active = index === targetIndex}
              <Message type={item.role === 'user' ? 'sent' : 'received'} name={sender(item)} first last tail class={active ? 'companion-search-message search-target' : 'companion-search-message'}>
                {#snippet text()}
                  <span class="companion-search-bubble">{#each textParts(active ? record.content : item.content, active ? searched : '') as part}{#if part.matched}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                {/snippet}
              </Message>
            {/each}
          </Messages>
          {#if expanded.context.truncated}<BlockFooter>{t('search.contextTruncated')}</BlockFooter>{/if}
        {/if}
      </PageContent>
    {:else}
      <PageContent class="companion-search-results" role="region" aria-label={t('search.results')}>
        {#if searching}
          <Block class="companion-search-state" role="status"><Preloader size={24} /><span>{t('search.searching')}</span></Block>
        {:else if searchError}
          <Block class="text-align-center" role="alert"><p>{t('search.failed')}</p><Button type="button" tonal onClick={() => void search()}>{t('retry')}</Button></Block>
        {:else if !searchedOnce}
          <Block class="text-align-center"><p>{t('search.prompt')}</p></Block>
        {:else if results.length === 0}
          <Block class="text-align-center"><p>{t('search.empty')}</p></Block>
        {:else}
          <BlockTitle aria-live="polite">{t('search.count', { count: estimatedTotal })}{#if estimatedTotal > results.length} · {t('search.limit')}{/if}</BlockTitle>
          <List mediaList strong inset dividers class="companion-search-list">
            {#each results as card (card.id)}
              <ListItem link="#" title={sender(card)} subtitle={date(card.createdAt)} class="companion-search-result" onClick={() => void openRecord(card)}>
                {#snippet text()}
                  {#each snippetParts(card.snippet) as part}{#if part.matched}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
                {/snippet}
              </ListItem>
            {/each}
          </List>
        {/if}
      </PageContent>
    {/if}
  </Page>
</Popup>
