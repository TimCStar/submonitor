import crypto from "node:crypto";

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
      const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
      if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
        throw new Error("Stored credential has an unsupported format");
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
    },
  };
}
