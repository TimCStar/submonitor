import crypto from "node:crypto";

export class CredentialDecryptionError extends Error {
  constructor() {
    super("无法解密已保存的 Sub2API 凭据。请恢复加密该凭据时使用的 SUBMONITOR_MASTER_KEY，或在后台重新输入 API Key/JWT 并保存");
    this.name = "CredentialDecryptionError";
    this.code = "CREDENTIAL_DECRYPTION_FAILED";
  }
}

export function createSecretBox(masterSecret) {
  if (!masterSecret || masterSecret.length < 32) {
    throw new Error("SUBMONITOR_MASTER_KEY must contain at least 32 characters");
  }
  const key = crypto.createHash("sha256").update(masterSecret).digest();

  return {
    encrypt(plaintext) {
      if (!plaintext) return "";
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
    },
    decrypt(value) {
      if (!value) return "";
      try {
        const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
        if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
          throw new CredentialDecryptionError();
        }
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(ivValue, "base64url"),
        );
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertextValue, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch (error) {
        if (error instanceof CredentialDecryptionError) throw error;
        throw new CredentialDecryptionError();
      }
    },
  };
}
