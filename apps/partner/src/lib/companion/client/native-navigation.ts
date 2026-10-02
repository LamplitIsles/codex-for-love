import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { f7 } from 'framework7-svelte';
import { dismissMessageMenu, messageMenuOpen } from './message-menu.ts';

export function syncSystemBars(dark: boolean): void {
  if (!Capacitor.isNativePlatform()) return;
  void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light })
    .catch(error => console.warn('Could not update system bar appearance', error));
}

/** The shell keeps its default Back behavior until Companion takes ownership. */
export function nativeNavigation(): () => void {
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('App')) return () => {};
  let disposed = false;
  const ready = App.addListener('backButton', () => {
    if (disposed) return;
    if (messageMenuOpen()) { dismissMessageMenu(); return; }
    const popover = f7.popover.get('.popover.modal-in');
    if (popover) { popover.close(); return; }
    const popup = f7.popup.get('.popup.modal-in');
    if (popup) { popup.close(); return; }
    const router = f7.views.main.router;
    if (router.history.length > 1) router.back();
    else {
      const panel = f7.panel.get('.panel-in');
      if (panel) panel.close(false);
      else void App.minimizeApp();
    }
  }).then(async listener => {
    if (disposed) { await listener.remove(); return; }
    try { await App.toggleBackButtonHandler({ enabled: true }); }
    catch (error) { await listener.remove(); throw error; }
    return listener;
  }).catch(error => { console.warn("Could not install Android navigation", error); });
  return () => {
    disposed = true;
    void ready.then(async listener => {
      if (!listener) return;
      await listener.remove();
      await App.toggleBackButtonHandler({ enabled: false });
    }).catch(error => console.warn('Could not release Android navigation', error));
  };
}
