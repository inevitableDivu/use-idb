import { describe, it, expect } from "vitest";
import {
  createDatabase,
  createEncryptionMiddleware,
  CryptographicContextUnavailableError,
  MemoryStorageAdapter,
  store,
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

  it("round-trips encrypted fields through engine get, getAll, and query reads", async () => {
    interface SecretRecord {
      id: string;
      secret: string;
      label: string;
    }

    const key = await generateAesKey();
    const original: SecretRecord = {
      id: "record-1",
      secret: "private value",
      label: "visible metadata",
    };
    const db = createDatabase(
      {
        name: `encrypted-read-regression-${Date.now()}-${Math.random()}`,
        version: 1,
        stores: {
          records: store<SecretRecord>()({
            keyPath: "id",
            indexes: { by_label: { keyPath: "label" } },
          }),
          external: {},
        },
      },
      {
        storage: new MemoryStorageAdapter(),
        middlewares: [createEncryptionMiddleware(key, ["secret"])],
      },
    );

    await db.open();
    try {
      await db.put("records", original);

      // The value persisted by the storage adapter must remain ciphertext at rest.
      const persisted = (await db.storage.get("records", original.id)) as {
        secret: { __encrypted?: boolean; ciphertext?: string };
      };
      expect(persisted.secret.__encrypted).toBe(true);
      expect(persisted.secret.ciphertext).toBeTypeOf("string");

      // Single-record, bulk, and query reads must all provide the same key AAD.
      await expect(db.get("records", original.id)).resolves.toEqual(original);
      await expect(db.getAll("records")).resolves.toEqual([original]);
      await expect(db.query("records").toArray()).resolves.toEqual([original]);
      await expect(
        db.query("records").where("label").equals("visible metadata").toArray(),
      ).resolves.toEqual([original]);

      // Out-of-line stores must retain the actual storage key for middleware AAD too.
      const externalOriginal = { secret: "external private value", label: "metadata" };
      await db.put("external", externalOriginal, "external-1");
      const externalPersisted = (await db.storage.get("external", "external-1")) as {
        secret: { __encrypted?: boolean };
      };
      expect(externalPersisted.secret.__encrypted).toBe(true);
      await expect(db.get("external", "external-1")).resolves.toEqual(externalOriginal);
      await expect(db.getAll("external")).resolves.toEqual([externalOriginal]);
      await expect(db.query("external").toArray()).resolves.toEqual([externalOriginal]);
    } finally {
      await db.destroy();
    }
  });

  it("records wildcard AAD scope when a primary key is unavailable", async () => {
    const key = await generateAesKey();
    const middleware = createEncryptionMiddleware(key, ["secret"]);
    const encrypted = (await middleware.beforeWrite?.({
      storeName: "records",
      operation: "put",
      value: { secret: "generated-key-value" },
    })) as { secret: { keyBound?: boolean } };

    expect(encrypted.secret.keyBound).toBe(false);
    const decrypted = (await middleware.afterRead?.({
      storeName: "records",
      key: 42,
      value: encrypted,
    })) as { secret: string };
    expect(decrypted.secret).toBe("generated-key-value");
  });

  it("uses collision-resistant canonical key context for encryption AAD", async () => {
    const key = await generateAesKey();
    const middleware = createEncryptionMiddleware(key, ["secret"]);

    const numericKeyRecord = await middleware.beforeWrite?.({
      storeName: "records",
      operation: "put",
      key: 1,
      value: { secret: "number-key" },
    });
    await expect(
      middleware.afterRead?.({
        storeName: "records",
        key: "1",
        value: numericKeyRecord,
      }),
    ).rejects.toThrow();

    const compoundKeyRecord = await middleware.beforeWrite?.({
      storeName: "records",
      operation: "put",
      key: ["a,b"],
      value: { secret: "compound-key" },
    });
    await expect(
      middleware.afterRead?.({
        storeName: "records",
        key: ["a", "b"],
        value: compoundKeyRecord,
      }),
    ).rejects.toThrow();

    // Two binary key views with the same visible bytes represent the same key.
    const backing = new Uint8Array([9, 1, 2, 8]);
    const viewKey = backing.subarray(1, 3);
    const binaryRecord = await middleware.beforeWrite?.({
      storeName: "records",
      operation: "put",
      key: viewKey,
      value: { secret: "binary-key" },
    });
    const binaryRead = (await middleware.afterRead?.({
      storeName: "records",
      key: new Uint8Array([1, 2]),
      value: binaryRecord,
    })) as { secret: string };
    expect(binaryRead.secret).toBe("binary-key");
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
