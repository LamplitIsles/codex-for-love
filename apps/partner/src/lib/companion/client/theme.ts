export type CompanionScheme = "light" | "dark";
export const LIGHT_THEME = "sticker-messenger" as const;
export const DARK_THEME = "night-voyage" as const;

export function companionThemeForScheme(
  scheme: string,
): typeof LIGHT_THEME | typeof DARK_THEME {
  return scheme === "dark" ? DARK_THEME : LIGHT_THEME;
}

/** Layout and visual language layered over the generated prefixed daisyUI primitives. */
export const companionStyles = `
#dsh-companion {
  --cmp-line:color-mix(in srgb,var(--color-base-content) 10%,transparent);
  --cmp-panel:color-mix(in srgb,var(--color-base-100) 94%,transparent);
  box-sizing:border-box;height:100dvh;overflow:hidden;color:var(--color-base-content);-webkit-tap-highlight-color:transparent;
  background:radial-gradient(circle at 8% 3%,color-mix(in srgb,var(--color-secondary) 19%,transparent),transparent 32%),var(--color-base-200);
  font-family:"Noto Sans SC",ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
}
#dsh-companion[data-theme="night-voyage"] {
  --cmp-line:color-mix(in srgb,var(--color-base-content) 11%,transparent);
  --cmp-panel:color-mix(in srgb,var(--color-base-100) 92%,transparent);
}
#dsh-companion *,#dsh-companion *::before,#dsh-companion *::after{box-sizing:border-box}
#dsh-companion button,#dsh-companion textarea,#dsh-companion input{font:inherit}
#dsh-companion + .companion-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
#dsh-companion.companion-shell{height:100dvh;padding:0;overflow:hidden}
#dsh-companion .companion-app{position:relative;display:grid;grid-template-columns:minmax(0,1fr);width:100%;height:100dvh;margin:0;overflow:hidden;border:0;border-radius:0;background:var(--cmp-panel);box-shadow:none;transition:grid-template-columns .24s ease}
#dsh-companion .companion-content{min-width:0;min-height:0;grid-column:1}
#dsh-companion .companion-main{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;height:100%;min-width:0;min-height:0}
#dsh-companion .companion-header{position:relative;z-index:8;display:flex;align-items:center;gap:12px;padding:13px 20px;border-bottom:1px solid var(--cmp-line);background:color-mix(in srgb,var(--color-base-100) 83%,transparent);backdrop-filter:blur(20px)}
#dsh-companion .companion-avatar-anchor{position:relative;flex:none}
#dsh-companion .companion-avatar{width:46px;height:46px;padding:0;border:0;background:transparent;filter:drop-shadow(0 0 2px color-mix(in srgb,var(--color-primary) 48%,transparent)) drop-shadow(0 6px 9px color-mix(in srgb,var(--color-primary) 22%,transparent));cursor:default}
#dsh-companion .companion-header-copy{min-width:0;flex:1}
#dsh-companion .companion-name{font-size:1.02rem;font-weight:780;letter-spacing:-.02em}
#dsh-companion .companion-presence{display:flex;align-items:center;gap:6px;margin-top:2px;color:color-mix(in srgb,var(--color-base-content) 64%,transparent);font-size:.73rem}
#dsh-companion .companion-header-actions{display:flex;flex:none;align-items:center;gap:2px}
#dsh-companion .companion-history-toggle{color:inherit;opacity:.64}
#dsh-companion .companion-history-toggle:hover,#dsh-companion .companion-history-toggle:focus-visible{opacity:1}
#dsh-companion .companion-full-dsh{flex:none;color:inherit;opacity:.64;text-decoration:none}
#dsh-companion .companion-full-dsh-label{display:inline}
#dsh-companion .companion-full-dsh:hover{opacity:1}
#dsh-companion .companion-timeline{min-width:0;min-height:0;overflow-x:clip;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:28px clamp(16px,4vw,48px) 16px}
#dsh-companion .companion-timeline:not(.timeline-ready){visibility:hidden}
#dsh-companion .companion-timeline-content,#dsh-companion .companion-row,#dsh-companion .companion-message-stack{min-width:0;max-width:100%}
#dsh-companion .companion-row{display:grid;grid-template-columns:34px minmax(0,auto);align-items:start;justify-content:start;gap:9px;width:100%;margin:9px 0}
#dsh-companion .companion-row.outgoing{grid-template-columns:minmax(0,auto) 34px;justify-content:end}
#dsh-companion .companion-row.outgoing .message-avatar{grid-column:2}
#dsh-companion .companion-row.outgoing .companion-message-stack{grid-column:1;grid-row:1;display:flex;flex-direction:column;align-items:flex-end}
#dsh-companion .message-avatar{align-self:start;width:34px;height:34px;font-size:.72rem}
#dsh-companion .companion-avatar-crop{display:grid;width:100%;height:100%;place-items:center;overflow:hidden;background:color-mix(in srgb,var(--color-primary) 20%,var(--color-base-200));color:var(--color-primary);font-weight:700}
#dsh-companion .companion-avatar-crop img{display:block;width:100%;height:100%;object-fit:cover}
#dsh-companion .companion-message-stack{max-width:min(76vw,680px)}
#dsh-companion .companion-bubble{min-width:0;max-width:min(76vw,680px);overflow:hidden;padding:11px 15px;border-radius:22px;background:var(--color-base-200);box-shadow:0 5px 18px color-mix(in srgb,var(--color-base-content) 7%,transparent);line-height:1.55;overflow-wrap:anywhere}
#dsh-companion .outgoing .companion-bubble{background:color-mix(in srgb,var(--color-primary) 22%,var(--color-base-100))}
#dsh-companion .companion-bubble::before{display:none}
#dsh-companion .markdown{min-width:0;max-width:100%;overflow-x:clip;overflow-wrap:anywhere}
#dsh-companion .markdown :first-child{margin-top:0}
#dsh-companion .markdown :last-child{margin-bottom:0}
#dsh-companion .markdown p{margin:.45em 0}
#dsh-companion .markdown h1,#dsh-companion .markdown h2,#dsh-companion .markdown h3,#dsh-companion .markdown h4,#dsh-companion .markdown h5,#dsh-companion .markdown h6{margin:.8em 0 .4em;font:inherit;font-weight:750;line-height:1.25}
#dsh-companion .markdown h1{font-size:1.35em}
#dsh-companion .markdown h2{font-size:1.2em}
#dsh-companion .markdown h3{font-size:1.1em}
#dsh-companion .markdown ul,#dsh-companion .markdown ol{margin:.5em 0;padding-inline-start:1.6em;list-style-position:outside}
#dsh-companion .markdown ul{list-style-type:disc}
#dsh-companion .markdown ol{list-style-type:decimal}
#dsh-companion .markdown ul ul{list-style-type:circle}
#dsh-companion .markdown ul ul ul{list-style-type:square}
#dsh-companion .markdown ol ol{list-style-type:lower-alpha}
#dsh-companion .markdown li>ul,#dsh-companion .markdown li>ol{margin:.3em 0}
#dsh-companion .markdown li+li{margin-top:.25em}
#dsh-companion .markdown li:has(>input[type="checkbox"]){list-style:none}
#dsh-companion .markdown input[type="checkbox"]{accent-color:var(--color-primary);margin:0 .4em 0 0;vertical-align:middle}
#dsh-companion .markdown a{color:inherit;font-weight:650;text-decoration-color:color-mix(in srgb,currentColor 45%,transparent);text-underline-offset:.18em}
#dsh-companion .markdown blockquote{border-left:3px solid color-mix(in srgb,var(--color-primary) 55%,transparent);margin:.6em 0;padding-left:.8em;opacity:.82}
#dsh-companion .markdown code{background:color-mix(in srgb,var(--color-base-content) 8%,transparent);border-radius:.4em;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:.9em;padding:.12em .35em}
#dsh-companion .markdown pre{box-sizing:border-box;background:color-mix(in srgb,var(--color-base-content) 8%,var(--color-base-100));border-radius:14px;margin:.65em 0;max-width:100%;overflow-x:auto;padding:.85em 1em}
#dsh-companion .markdown pre code{background:transparent;padding:0}
#dsh-companion .markdown .katex{font-size:1em}
#dsh-companion .markdown .katex-display{max-width:100%;margin:.75em 0;overflow-x:auto;overflow-y:hidden;padding:.15em .1em;text-align:left}
#dsh-companion .markdown table{display:block;width:max-content;min-width:100%;max-width:100%;margin:.65em 0;overflow-x:auto;border-collapse:collapse}
#dsh-companion .markdown th,#dsh-companion .markdown td{overflow-wrap:normal;word-break:normal;border:1px solid color-mix(in srgb,var(--color-base-content) 18%,transparent);padding:.4em .6em;text-align:left;white-space:nowrap}
#dsh-companion .markdown th{background:color-mix(in srgb,var(--color-base-content) 8%,transparent);font-weight:700}
#dsh-companion .markdown img{height:auto;max-width:100%}
#dsh-companion .markdown hr{border:0;border-top:1px solid color-mix(in srgb,var(--color-base-content) 16%,transparent);margin:.9em 0}
#dsh-companion .companion-meta{margin-top:4px;opacity:.55;font-size:.68rem}
#dsh-companion .companion-typing-bubble{display:flex;align-items:center;gap:9px;max-width:min(76vw,340px)}
#dsh-companion .companion-waiting-copy{color:color-mix(in srgb,var(--color-base-content) 68%,transparent);font-size:.76rem;line-height:1.4;animation:companion-waiting-in .24s ease-out}
#dsh-companion .companion-media{width:min(70vw,480px);overflow:hidden;border-radius:24px;background:var(--color-base-200);box-shadow:0 8px 24px color-mix(in srgb,var(--color-base-content) 10%,transparent)}
#dsh-companion .companion-media-button{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in}
#dsh-companion .companion-media img{display:block;width:100%;max-height:520px;object-fit:cover}
#dsh-companion .companion-image-group{display:flex;flex-wrap:wrap;gap:6px;max-width:min(76vw,680px)}
#dsh-companion .outgoing .companion-image-group{justify-content:flex-end}
#dsh-companion .companion-image-group-many{width:min(206px,76vw)}
#dsh-companion .companion-image-group-many .companion-image-entry{width:64px;height:64px}
#dsh-companion .companion-image-group-many .companion-media{width:64px;height:64px;border-radius:16px}
#dsh-companion .companion-image-group-many .companion-media img{width:64px;height:64px;object-fit:cover}
#dsh-companion .companion-media-single{width:auto;max-width:min(76vw,480px)}
#dsh-companion .companion-media-single .companion-media-button{width:auto;max-width:100%}
#dsh-companion .companion-media-single img{max-width:100%;max-height:240px}
#dsh-companion .companion-media-loading,#dsh-companion .companion-media-failure{display:flex;width:100%;min-width:64px;min-height:64px;align-items:center;justify-content:center;gap:8px;padding:14px;color:color-mix(in srgb,var(--color-base-content) 65%,transparent);font-size:.72rem;text-align:center}
#dsh-companion .companion-media-spinner{margin:20px}
#dsh-companion .companion-media-failure{flex-direction:column;color:var(--color-error);background:color-mix(in srgb,var(--color-error) 6%,var(--color-base-100))}
#dsh-companion .companion-media-failure .cmp-btn{color:inherit}
#dsh-companion .companion-voice{display:grid;grid-template-columns:44px minmax(0,1fr);align-items:center;gap:6px 10px;min-width:min(300px,70vw)}
#dsh-companion .companion-audio{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
#dsh-companion .companion-voice-control{width:44px;height:44px;min-width:44px;min-height:44px;color:var(--color-primary)}
#dsh-companion .companion-voice-player{min-width:0}
#dsh-companion .companion-voice-waveform{position:relative;display:flex;height:32px;align-items:center;gap:2px;min-width:150px;cursor:pointer}
#dsh-companion .companion-voice-waveform>span{width:3px;height:var(--voice-bar);flex:1;border-radius:999px;background:color-mix(in srgb,var(--color-base-content) 20%,transparent);transition:background-color .12s ease}
#dsh-companion .companion-voice-waveform>span.played{background:var(--color-primary)}
#dsh-companion .companion-voice-seek{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
#dsh-companion .companion-voice-waveform:has(.companion-voice-seek:focus-visible){outline:2px solid var(--color-primary);outline-offset:3px;border-radius:var(--radius-field)}
#dsh-companion .companion-voice-meta{display:flex;min-height:16px;align-items:center;justify-content:space-between;gap:10px;color:color-mix(in srgb,var(--color-base-content) 55%,transparent);font-size:.66rem;line-height:1.2}
#dsh-companion .companion-voice-meta [role="alert"]{color:var(--color-error)}
#dsh-companion .companion-transcript{grid-column:1/-1;font-size:.72rem}
#dsh-companion .companion-transcript summary{display:flex;width:max-content;align-items:center;gap:5px;color:color-mix(in srgb,var(--color-base-content) 60%,transparent);cursor:pointer;list-style:none}
#dsh-companion .companion-transcript summary::-webkit-details-marker{display:none}
#dsh-companion .companion-transcript[open] summary{color:var(--color-primary)}
#dsh-companion .companion-transcript p{margin:7px 0 0;padding-top:7px;border-top:1px solid var(--cmp-line);color:color-mix(in srgb,var(--color-base-content) 78%,transparent);line-height:1.45}
#dsh-companion .companion-composer{padding:10px 18px max(14px,env(safe-area-inset-bottom));border-top:1px solid var(--cmp-line);background:color-mix(in srgb,var(--color-base-100) 88%,transparent);backdrop-filter:blur(20px)}
#dsh-companion .companion-command-suggestions{max-width:820px;margin:0 auto 7px;padding:4px;border:1px solid color-mix(in srgb,var(--color-primary) 25%,var(--cmp-line));border-radius:18px;background:color-mix(in srgb,var(--color-base-100) 94%,var(--color-base-200));box-shadow:0 8px 24px color-mix(in srgb,var(--color-base-content) 10%,transparent)}
#dsh-companion .companion-command-suggestion{display:grid;width:100%;min-width:0;min-height:40px;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:7px 12px;border-radius:14px;text-align:left}
#dsh-companion .companion-command-name{color:var(--color-primary);font-family:ui-monospace,"SFMono-Regular",Menlo,monospace;font-size:.78rem;font-weight:730}
#dsh-companion .companion-command-description{min-width:0;overflow:hidden;color:color-mix(in srgb,var(--color-base-content) 64%,transparent);font-size:.72rem;text-overflow:ellipsis;white-space:nowrap}
#dsh-companion .companion-command-tab{padding:2px 6px;border:1px solid color-mix(in srgb,var(--color-base-content) 16%,transparent);border-radius:6px;color:color-mix(in srgb,var(--color-base-content) 54%,transparent);font-family:ui-monospace,"SFMono-Regular",Menlo,monospace;font-size:.62rem}
#dsh-companion .companion-image-drafts{display:flex;max-width:820px;gap:8px;margin:0 auto 8px;padding:2px 2px 1px;overflow-x:auto;scrollbar-width:none}
#dsh-companion .companion-image-drafts::-webkit-scrollbar{display:none}
#dsh-companion .companion-image-draft{position:relative;width:64px;height:64px;flex:none;overflow:hidden;border:1px solid color-mix(in srgb,var(--color-primary) 28%,var(--cmp-line));border-radius:17px;background:var(--color-base-200);box-shadow:0 5px 14px color-mix(in srgb,var(--color-base-content) 10%,transparent)}
#dsh-companion .companion-image-draft-preview{display:block;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:zoom-in}
#dsh-companion .companion-image-draft img{display:block;width:100%;height:100%;object-fit:cover}
#dsh-companion .companion-image-draft-remove{position:absolute;top:3px;right:3px}
#dsh-companion .companion-image-input{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
#dsh-companion .companion-compose-row{display:flex;align-items:flex-end;gap:8px;max-width:820px;margin:auto;padding:5px 6px;border:1px solid color-mix(in srgb,var(--color-base-content) 12%,transparent);border-radius:22px;overflow:visible;background:color-mix(in srgb,var(--color-base-100) 92%,var(--color-base-200));box-shadow:0 6px 22px color-mix(in srgb,var(--color-base-content) 7%,transparent);transition:border-color .16s ease,box-shadow .16s ease}
#dsh-companion .companion-compose-row:focus-within{border-color:color-mix(in srgb,var(--color-primary) 65%,transparent);box-shadow:0 0 0 4px color-mix(in srgb,var(--color-primary) 16%,transparent),0 8px 26px color-mix(in srgb,var(--color-base-content) 8%,transparent)}
#dsh-companion .companion-textarea{flex:1;min-width:0;min-height:43px;max-height:150px;padding:11px 2px;border:0;border-radius:0;outline:0;background:transparent;color:inherit;resize:none;line-height:1.42;box-shadow:none}
#dsh-companion .companion-textarea::placeholder{color:color-mix(in srgb,var(--color-base-content) 46%,transparent)}
#dsh-companion .companion-attach{flex:none;margin:0 0 1px;color:color-mix(in srgb,var(--color-base-content) 56%,transparent);touch-action:manipulation;-webkit-touch-callout:none;user-select:none}
#dsh-companion .companion-attach:hover,#dsh-companion .companion-attach:focus-visible{color:var(--color-primary)}
#dsh-companion .companion-microphone{flex:none;margin:0 0 1px;color:color-mix(in srgb,var(--color-base-content) 56%,transparent);transition:color .16s ease,background-color .16s ease,box-shadow .16s ease}
#dsh-companion .companion-microphone:hover,#dsh-companion .companion-microphone:focus-visible{color:var(--color-primary)}
#dsh-companion .companion-microphone[data-state="recording"]{color:var(--color-error);background:color-mix(in srgb,var(--color-error) 12%,transparent);box-shadow:0 0 0 4px color-mix(in srgb,var(--color-error) 12%,transparent)}
#dsh-companion .companion-microphone[data-state="stopping"],#dsh-companion .companion-microphone[data-state="transcribing"]{color:var(--color-primary)}
#dsh-companion .companion-microphone:disabled{cursor:not-allowed;opacity:.52}
#dsh-companion .companion-send{font-size:1.15rem}
#dsh-companion .companion-context-meter-wrap{position:relative;flex:none;align-self:flex-end}
#dsh-companion .companion-context-meter{width:28px;height:28px;margin:0 2px 8px 0;color:color-mix(in srgb,var(--color-base-content) 48%,transparent)}
#dsh-companion .companion-context-meter:hover,#dsh-companion .companion-context-meter:focus-visible,#dsh-companion .companion-context-meter-open{color:var(--color-primary)}
#dsh-companion .companion-context-meter:focus-visible{outline:2px solid color-mix(in srgb,var(--color-primary) 70%,transparent);outline-offset:2px}
#dsh-companion .companion-context-meter svg{display:block;width:28px;height:28px;overflow:visible;transform:rotate(-90deg)}
#dsh-companion .companion-context-meter circle{fill:none;stroke-width:2.6}
#dsh-companion .companion-context-meter-track{stroke:color-mix(in srgb,var(--color-base-content) 13%,transparent)}
#dsh-companion .companion-context-meter-value{stroke:var(--context-meter-color,var(--color-primary));stroke-linecap:round;stroke-dasharray:100;transition:stroke-dashoffset .24s ease,stroke .18s ease}
#dsh-companion .companion-context-meter[data-state="warning"]{--context-meter-color:var(--color-warning)}
#dsh-companion .companion-context-meter[data-state="active"]{--context-meter-color:var(--color-secondary);animation:companion-context-pulse 1.8s ease-in-out infinite}
#dsh-companion .companion-context-meter[data-state="complete"]{--context-meter-color:var(--color-success)}
#dsh-companion .companion-context-meter[data-state="failed"]{--context-meter-color:var(--color-error)}
#dsh-companion .companion-context-popover{position:absolute;right:0;bottom:calc(100% + 9px);z-index:15;width:min(260px,calc(100vw - 28px));margin:0;padding:14px 16px;border:1px solid color-mix(in srgb,var(--color-base-content) 14%,transparent);border-radius:16px;color:var(--color-base-content);background:var(--color-base-100);box-shadow:0 14px 38px rgb(0 0 0 / .2);line-height:1.45}
#dsh-companion .companion-context-popover h2{margin:0 0 3px;font-size:.86rem;font-weight:760}
#dsh-companion .companion-context-popover p{margin:3px 0;font-size:.76rem}
#dsh-companion .companion-context-popover .companion-context-percent{color:var(--color-primary);font-size:1.12rem;font-weight:780}
#dsh-companion .companion-context-popover .companion-context-note{margin-top:9px;color:color-mix(in srgb,var(--color-base-content) 78%,transparent);font-size:.68rem}
#dsh-companion .companion-continuity-status{max-width:820px;margin:0 auto 6px;padding:0 12px;color:color-mix(in srgb,var(--color-base-content) 64%,transparent);font-size:.72rem;line-height:1.4}
#dsh-companion .companion-continuity-status[data-state="running"]{color:var(--color-secondary)}
#dsh-companion .companion-continuity-status[data-state="complete"]{color:var(--color-success)}
#dsh-companion .companion-continuity-status[data-state="failed"]{color:var(--color-error)}
#dsh-companion .companion-continuity-record{display:flex;max-width:min(76vw,620px);align-items:center;gap:8px;margin:16px auto;padding:7px 12px;border:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent);border-radius:999px;color:color-mix(in srgb,var(--color-base-content) 60%,transparent);font-size:.7rem;line-height:1.35;text-align:center}
#dsh-companion[data-theme="sticker-messenger"] .companion-context-meter[data-state="active"]{--context-meter-color:var(--color-primary)}
#dsh-companion[data-theme="sticker-messenger"] .companion-context-popover{border-radius:18px}
#dsh-companion[data-theme="night-voyage"] .companion-context-meter[data-state="active"]{--context-meter-color:var(--color-secondary)}
#dsh-companion[data-theme="night-voyage"] .companion-context-popover{border-radius:12px;box-shadow:0 16px 42px rgb(0 0 0 / .42)}
#dsh-companion .companion-compose-hint{max-width:790px;margin:5px auto 0;padding:0 10px;color:color-mix(in srgb,var(--color-base-content) 47%,transparent);font-size:.66rem}
#dsh-companion .companion-voice-input-status{max-width:820px;margin:6px auto 0;padding:0 12px;color:var(--color-primary);font-size:.7rem;line-height:1.35}
#dsh-companion .companion-voice-input-status[role="status"]{min-height:1.1em}
#dsh-companion .companion-voice-input-unavailable{color:color-mix(in srgb,var(--color-base-content) 55%,transparent)}
#dsh-companion .companion-voice-input-error{color:var(--color-error)}
#dsh-companion .companion-recovery{align-self:center;justify-self:center;max-width:500px;padding:34px 24px;text-align:center}
#dsh-companion .companion-recovery h1{margin:8px 0;font-size:1.32rem}
#dsh-companion .companion-recovery p{opacity:.66}
#dsh-companion .companion-mood-orb{width:86px;height:86px;margin:0 auto 17px;background:radial-gradient(circle at 34% 28%,var(--color-accent),var(--color-primary));filter:drop-shadow(0 0 10px color-mix(in srgb,var(--color-primary) 12%,transparent)) drop-shadow(0 16px 19px color-mix(in srgb,var(--color-primary) 25%,transparent))}
#dsh-companion .companion-sidebar-eyebrow{color:var(--color-primary);font-size:.67rem;font-weight:760;letter-spacing:.08em;text-transform:uppercase}
#dsh-companion .companion-history-backdrop{position:fixed;z-index:29;inset:0;background:color-mix(in srgb,var(--color-neutral) 42%,transparent);backdrop-filter:blur(3px);animation:companion-history-fade-in .18s ease}
#dsh-companion .companion-history-backdrop>button{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:default}
#dsh-companion .companion-history-drawer{position:fixed;z-index:30;top:0;left:0;display:flex;width:min(420px,calc(100vw - 18px));height:100dvh;flex-direction:column;overflow:hidden;border-right:1px solid color-mix(in srgb,var(--color-base-content) 14%,transparent);color:var(--color-base-content);background:color-mix(in srgb,var(--color-base-100) 96%,var(--color-secondary) 4%);box-shadow:18px 0 60px rgb(0 0 0 / .24);animation:companion-history-slide-in .24s cubic-bezier(.2,.8,.2,1);isolation:isolate}
#dsh-companion .companion-history-art{height:100px;flex:none;background:linear-gradient(to bottom,transparent 20%,var(--color-base-100)),var(--relationship-art) center 48%/cover no-repeat;filter:saturate(.78);opacity:.82}
#dsh-companion .companion-history-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:-22px;padding:0 22px 15px}
#dsh-companion .companion-history-head h2{margin:3px 0 0;font-size:1.18rem;letter-spacing:-.02em}
#dsh-companion .companion-history-scroll{flex:1;min-height:0;overflow-y:auto;padding:0 22px max(24px,env(safe-area-inset-bottom));overscroll-behavior:contain}
#dsh-companion .companion-history-scroll h3{margin:0 0 10px;font-size:.78rem;font-weight:760;letter-spacing:.04em;text-transform:uppercase}
#dsh-companion .companion-history-current{padding:14px 0 18px;border-bottom:1px solid var(--cmp-line)}
#dsh-companion .companion-history-current-list{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 15px;margin:0;font-size:.77rem;line-height:1.4}
#dsh-companion .companion-history-current-list dt{color:color-mix(in srgb,var(--color-base-content) 52%,transparent)}
#dsh-companion .companion-history-current-list dd{min-width:0;margin:0;text-align:right;overflow-wrap:anywhere}
#dsh-companion .companion-history-list{padding-top:20px}
#dsh-companion .companion-history-state{display:grid;min-height:86px;place-items:center;gap:8px;padding:22px 12px;color:color-mix(in srgb,var(--color-base-content) 58%,transparent);font-size:.78rem;text-align:center}
#dsh-companion .companion-history-state p{margin:0}
#dsh-companion .companion-history-earlier{display:block;width:100%;margin:0 0 12px}
#dsh-companion .companion-history-entries{display:grid;gap:10px}
#dsh-companion .companion-history-entry{padding:13px 14px;border:1px solid color-mix(in srgb,var(--color-base-content) 10%,transparent);border-radius:15px;background:color-mix(in srgb,var(--color-base-100) 82%,var(--color-base-200));box-shadow:0 5px 18px color-mix(in srgb,var(--color-base-content) 5%,transparent)}
#dsh-companion .companion-history-entry>time{display:block;margin-bottom:8px;color:color-mix(in srgb,var(--color-base-content) 78%,transparent);font-size:.68rem}
#dsh-companion .companion-history-entry ul{display:grid;gap:12px;margin:0;padding:0;list-style:none}
#dsh-companion .companion-history-entry li{display:grid;gap:6px;min-width:0;font-size:.77rem;line-height:1.4}
#dsh-companion .companion-history-entry li+li{padding-top:10px;border-top:1px solid var(--cmp-line)}
#dsh-companion .companion-history-values{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;min-width:0}
#dsh-companion .companion-history-values span{display:grid;min-width:0;gap:2px;padding:7px 8px;border-radius:9px;background:color-mix(in srgb,var(--color-base-content) 5%,transparent);overflow-wrap:anywhere}
#dsh-companion .companion-history-values small{color:color-mix(in srgb,var(--color-base-content) 78%,transparent);font-size:.62rem;text-transform:uppercase}
#dsh-companion .companion-history-reason{margin:0;color:color-mix(in srgb,var(--color-base-content) 62%,transparent);font-size:.7rem;overflow-wrap:anywhere}
#dsh-companion .companion-history-initial{margin:0;color:color-mix(in srgb,var(--color-base-content) 62%,transparent);font-size:.76rem}
#dsh-companion[data-theme="night-voyage"] .companion-history-drawer{background:color-mix(in srgb,var(--color-base-100) 95%,var(--color-secondary) 5%);box-shadow:18px 0 60px rgb(0 0 0 / .42)}
@keyframes companion-history-fade-in{from{opacity:0}to{opacity:1}}
@keyframes companion-history-slide-in{from{opacity:.2;transform:translateX(-100%)}to{opacity:1;transform:none}}
#dsh-companion .companion-lightbox{width:100vw;max-width:none;height:100dvh;max-height:none;margin:0;padding:40px;border:0;background:transparent;place-items:center;overflow:hidden}
#dsh-companion .companion-lightbox::backdrop{background:transparent}
#dsh-companion .companion-lightbox-dialog{position:relative;z-index:1;display:grid;max-width:calc(100vw - 80px);max-height:calc(100dvh - 80px);margin:0;padding:0;border:0;background:transparent;place-items:center;box-shadow:none}
#dsh-companion .companion-lightbox .cmp-modal-box{margin:0;padding:0;background:transparent;box-shadow:none}
#dsh-companion .companion-lightbox img{position:relative;display:block;max-width:min(100%,1600px);max-height:calc(100dvh - 80px);border-radius:12px;background:var(--color-base-200);object-fit:contain;box-shadow:0 20px 60px rgb(0 0 0 / .36)}
#dsh-companion .companion-loading-shell{display:flex;align-items:center;justify-content:center;gap:9px;color:color-mix(in srgb,var(--color-base-content) 60%,transparent);font-size:.8rem}
#dsh-companion .companion-lightbox-backdrop{position:fixed;z-index:0;inset:0;display:block;background:color-mix(in srgb,var(--color-neutral) 72%,transparent);backdrop-filter:blur(12px)}
#dsh-companion .companion-lightbox-backdrop>button{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;opacity:0;cursor:default}
#dsh-companion .companion-lightbox-close{position:fixed;z-index:2;top:20px;right:20px;width:36px;height:36px;padding:0;border:1px solid color-mix(in srgb,var(--color-base-content) 16%,transparent);border-radius:999px;background:var(--color-base-100);color:var(--color-base-content);box-shadow:0 8px 24px rgb(0 0 0 / .18)}
@keyframes companion-waiting-in{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:none}}
@keyframes companion-context-pulse{0%,100%{opacity:.68}50%{opacity:1}}
@media (min-width:821px){#dsh-companion .companion-composer{padding-bottom:max(24px,env(safe-area-inset-bottom))}#dsh-companion .companion-row{grid-template-columns:40px minmax(0,auto)}#dsh-companion .companion-row.outgoing{grid-template-columns:minmax(0,auto) 40px}#dsh-companion .message-avatar{width:40px;height:40px}}
@media (max-width:820px){#dsh-companion .companion-header{padding:calc(10px + env(safe-area-inset-top)) 13px 10px}#dsh-companion .companion-timeline{padding:18px 12px 10px}#dsh-companion .companion-composer{padding-inline:9px}#dsh-companion .companion-compose-hint{display:none}#dsh-companion .companion-message-stack,#dsh-companion .companion-bubble{max-width:78vw}#dsh-companion .companion-full-dsh-label{display:none}}
@media (max-width:520px){#dsh-companion .companion-timeline{padding-bottom:8px}#dsh-companion .companion-composer{padding-inline:9px}#dsh-companion .companion-voice{min-width:0}}
@media (max-width:430px){#dsh-companion .companion-avatar{width:42px;height:42px}#dsh-companion .companion-header{gap:8px}#dsh-companion .companion-row{grid-template-columns:30px minmax(0,auto);gap:7px}#dsh-companion .companion-row.outgoing{grid-template-columns:minmax(0,auto) 30px}#dsh-companion .message-avatar{width:30px;height:30px}#dsh-companion .companion-voice{min-width:0}}
@media (prefers-reduced-motion:reduce){#dsh-companion *,#dsh-companion *::before,#dsh-companion *::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}#dsh-companion .companion-context-meter[data-state="active"]{animation:none!important}#dsh-companion .companion-history-backdrop,#dsh-companion .companion-history-drawer{animation:none!important}}
`;
