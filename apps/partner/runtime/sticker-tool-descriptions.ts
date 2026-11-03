/** Partner-facing language for sticker tools; behavior remains server-owned. */
export const stickerToolDescriptions = {
  listPacks: 'Browse or search sticker packs by name or description in bounded pages. Inspect one pack to see its stickers.',
  listPackStickers: 'List the stickers in one selected pack in bounded pages, including their names and tags.',
  searchStickers: 'Search available stickers by name or tag in bounded pages.',
  listFavorites: 'List your own favorite stickers in bounded pages. Your favorites are separate from the Human\'s.',
  favorite: 'Add or remove one available sticker from your own favorites.',
  inspect: 'Inspect the current sticker image without sending it or changing favorites. Animated images return sampled frames in order; sampling can miss content.',
  updateMetadata: 'Update the shared name and/or tags of an existing sticker for both participants. Reimporting its pack overwrites these edits with the manifest values.',
  send: 'Send one available sticker into our conversation. Choose it deliberately for the current interaction.',
} as const;
