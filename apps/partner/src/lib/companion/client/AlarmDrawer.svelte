<script lang="ts">
  import { AccordionContent, Block, Button, List, ListItem, Preloader } from 'framework7-svelte';
  import AlarmClock from 'lucide-svelte/icons/alarm-clock';
  import CircleAlert from 'lucide-svelte/icons/circle-alert';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import type { Alarm } from '../../../../runtime/alarms.ts';
  import type { CompanionTranslate } from './locale.ts';

  export let t: CompanionTranslate;
  export let locale: string;
  export let alarms: readonly Alarm[];
  export let loading: boolean;
  export let error: boolean;
  export let refresh: () => void;

  $: language = locale === 'zh' ? 'zh-CN' : 'en';
  function scheduleLabel(alarm: Alarm): string {
    const schedule = alarm.schedule;
    if (schedule.kind === 'once') return t('alarm.once');
    if (schedule.kind === 'interval') return t('alarm.interval', { minutes: schedule.everyMinutes });
    const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
    if (schedule.kind === 'daily') return t('alarm.daily', { time, zone: schedule.timeZone });
    const weekday = new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + schedule.weekday));
    return t('alarm.weekly', { weekday, time, zone: schedule.timeZone });
  }
</script>

<section class="companion-alarms" aria-label={t('drawer.alarms')}>
  <div class="companion-alarms-heading">
    <h3>{t('drawer.alarms')}</h3>
    <Button round class="companion-alarm-refresh" disabled={loading} aria-busy={loading} aria-label={t('alarm.refresh')} title={t('alarm.refresh')} onClick={refresh}><RefreshCw size={18} aria-hidden="true" /></Button>
  </div>
  <p class="companion-alarm-intro">{t('alarm.intro')}</p>
  {#if loading}
    <div class="companion-alarm-loading" role="status"><Preloader size={20} /><span>{t('loading')}</span></div>
  {:else if error}
    <Block class="companion-alarm-empty" role="alert"><CircleAlert size={30} aria-hidden="true" /><h4>{t('alarm.failed')}</h4><Button tonal onClick={refresh}>{t('retry')}</Button></Block>
  {:else if !alarms.length}
    <Block class="companion-alarm-empty"><AlarmClock size={30} aria-hidden="true" /><h4>{t('alarm.empty')}</h4><p>{t('alarm.emptyHint')}</p></Block>
  {:else}
    <p class="companion-alarm-next">{t('alarm.next')}</p>
    <List accordionList mediaList dividers class="companion-alarm-list">
      {#each alarms as alarm (alarm.id)}
        <ListItem accordionItem title={scheduleLabel(alarm)} text={alarm.message}>
          {#snippet media()}
            <div class="companion-alarm-time">
              <span>{new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' }).format(alarm.nextAt)}</span>
              <time datetime={new Date(alarm.nextAt).toISOString()}>{new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(alarm.nextAt)}</time>
            </div>
          {/snippet}
          <AccordionContent><p class="companion-alarm-message">{alarm.message}</p></AccordionContent>
        </ListItem>
      {/each}
    </List>
  {/if}
</section>
