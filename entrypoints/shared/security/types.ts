export const VAULT_FORMAT = "shadekit-vault/v1" as const;

export interface VaultRecord {
  format: typeof VAULT_FORMAT;
  credentialId: string;
  iv: string;
  ciphertext: string;
}
