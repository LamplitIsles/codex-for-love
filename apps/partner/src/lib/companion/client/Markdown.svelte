<script lang="ts">
  import SvelteMarkdown, {
    buildUnsupportedHTML,
    defaultRenderers,
  } from "@humanspeak/svelte-markdown";
  import {
    markedKatex,
    KatexRenderer,
  } from "@humanspeak/svelte-markdown/extensions/katex";

  export let text = "";

  // Matches Sliqs: render Markdown tokens as Svelte nodes, never via
  // browser-parsed HTML strings. Raw HTML remains unsupported.
  const renderers = {
    ...defaultRenderers,
    html: buildUnsupportedHTML(),
    inlineKatex: KatexRenderer,
    blockKatex: KatexRenderer,
  };
  const extensions = [markedKatex({ singleDollarInline: true })];
</script>

<div class="markdown">
  <SvelteMarkdown source={text} {renderers} {extensions} />
</div>
