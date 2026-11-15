import { Vault } from './vault.ts';
import { migrateVoiceSecrets } from './vault-migration.ts';

/** Open the shared vault only after the legacy voice migration is complete. */
export async function openMigratedVault(state: string): Promise<Vault> {
  const vault = await Vault.open(state);
  try { await migrateVoiceSecrets(state, vault); return vault; }
  catch (error) { vault.close(); throw error; }
}
