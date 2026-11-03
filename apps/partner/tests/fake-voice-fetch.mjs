// Loaded only into the real-app-server test's Node child processes. Never use
// network: the synthetic official-host URL resolves to a synthetic MPEG frame.
const audio = Buffer.alloc(417); audio.set([0xff, 0xfb, 0x90, 0]);
globalThis.fetch = async (input) => {
  if (String(input) !== 'https://elevenlabsusercontent.com/synthetic-fixture') throw new Error('Unexpected fixture network access');
  return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
};
