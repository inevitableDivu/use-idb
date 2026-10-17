import { describe, it, expect } from "vitest";
import {
  createEncryptionMiddleware,
  CryptographicContextUnavailableError,
} from "../src";

describe("Encryption Middleware & Cryptographic Hardening", () => {
  async function generateAesKey(): Promise<CryptoKey> {
    return await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
  }

  it("encrypts and decrypts deep nested field paths", async () => {
    const key = await generateAesKey();
    const middleware = createEncryptionMiddleware(
      key,
      ["profile.secret.ssn", "financial.accountNumber"],
    );

    const original = {
      id: "rec_1",
      name: "Alice",
      profile: {
        secret: {
          ssn: "123-45-6789",
        },
      },
      financial: {
        accountNumber: 987654321,
      },
    };

    const writeCtx = { storeName: "users", operation: "put" as const, key: "rec_1", value: original };
    const encrypted = (await middleware.beforeWrite?.(writeCtx)) as typeof original & {
      profile: { secret: { ssn: { __encrypted: boolean } } };
    };

    // In encrypted state, field is replaced with an envelope
    expect(encrypted.profile.secret.ssn).toHaveProperty("__encrypted", true);
    expect(encrypted.financial.accountNumber).toHaveProperty("__encrypted", true);
    expect(encrypted.name).toBe("Alice"); // Unencrypted field untouched

    // Decryption restores original values
    const readCtx = { storeName: "users", key: "rec_1", value: encrypted };
    const decrypted = (await middleware.afterRead?.(readCtx)) as typeof original;
    expect(decrypted.profile.secret.ssn).toBe("123-45-6789");
    expect(decrypted.financial.accountNumber).toBe(987654321);
  });

  it("rejects ciphertext transposition across stores or keys via context-bound AAD", async () => {
    const key = await generateAesKey();
    const middleware = createEncryptionMiddleware(key, ["secret"]);

    const writeCtx = { storeName: "vault_a", operation: "put" as const, key: "key_1", value: { id: "key_1", secret: "classified" } };
    const encrypted = (await middleware.beforeWrite?.(writeCtx)) as any;

    // Legitimate read succeeds
    const readOk = await middleware.afterRead?.({
      storeName: "vault_a",
      key: "key_1",
      value: encrypted,
    });
    expect((readOk as any).secret).toBe("classified");

    // Transposition Attack 1: Relocating ciphertext to a different store
    await expect(
      middleware.afterRead?.({
        storeName: "vault_b",
        key: "key_1",
        value: encrypted,
      }),
    ).rejects.toThrow();

    // Transposition Attack 2: Relocating ciphertext to a different primary key
    await expect(
      middleware.afterRead?.({
        storeName: "vault_a",
        key: "key_2",
        value: encrypted,
      }),
    ).rejects.toThrow();
  });

  it("rejects tampered ciphertext envelopes", async () => {
    const key = await generateAesKey();
    const middleware = createEncryptionMiddleware(key, ["secret"]);

    const encrypted = (await middleware.beforeWrite?.({
      storeName: "secure",
      operation: "put" as const,
      key: "k1",
      value: { secret: "top-secret" },
    })) as any;

    // Tamper with the ciphertext base64 payload
    const tampered = structuredClone(encrypted);
    const rawCt = atob(tampered.secret.ciphertext);
    const modifiedCt = btoa(rawCt.slice(0, -1) + "X");
    tampered.secret.ciphertext = modifiedCt;

    await expect(
      middleware.afterRead?.({
        storeName: "secure",
        key: "k1",
        value: tampered,
      }),
    ).rejects.toThrow();
  });

  it("supports key rotation via KeyRing", async () => {
    const keyV1 = await generateAesKey();
    const keyV2 = await generateAesKey();

    // Middleware configured with keyV1
    const middlewareV1 = createEncryptionMiddleware(
      {
        primaryKeyId: "v1",
        keys: { v1: keyV1 },
      },
      ["secret"],
    );

    const recordV1 = (await middlewareV1.beforeWrite?.({
      storeName: "records",
      operation: "put" as const,
      key: "r1",
      value: { secret: "created-with-v1" },
    })) as any;
    expect(recordV1.secret.keyId).toBe("v1");

    // Rotate to KeyRing containing both v1 and v2, with v2 as primary
    const middlewareV2 = createEncryptionMiddleware(
      {
        primaryKeyId: "v2",
        keys: { v1: keyV1, v2: keyV2 },
      },
      ["secret"],
    );

    // Old v1 record can still be decrypted by v2 keyring
    const readV1 = (await middlewareV2.afterRead?.({
      storeName: "records",
      key: "r1",
      value: recordV1,
    })) as any;
    expect(readV1.secret).toBe("created-with-v1");

    // New records are encrypted with v2
    const recordV2 = (await middlewareV2.beforeWrite?.({
      storeName: "records",
      operation: "put" as const,
      key: "r2",
      value: { secret: "created-with-v2" },
    })) as any;
    expect(recordV2.secret.keyId).toBe("v2");

    const readV2 = (await middlewareV2.afterRead?.({
      storeName: "records",
      key: "r2",
      value: recordV2,
    })) as any;
    expect(readV2.secret).toBe("created-with-v2");
  });

  it("fails closed with CryptographicContextUnavailableError when crypto.subtle is absent", async () => {
    const key = await generateAesKey();
    const originalSubtle = crypto.subtle;
    try {
      // Mock WebCrypto absence
      Object.defineProperty(crypto, "subtle", {
        value: undefined,
        configurable: true,
      });

      expect(() => {
        createEncryptionMiddleware(key, ["secret"]);
      }).toThrow(CryptographicContextUnavailableError);
    } finally {
      Object.defineProperty(crypto, "subtle", {
        value: originalSubtle,
        configurable: true,
      });
    }
  });
});
