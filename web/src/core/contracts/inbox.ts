/*
 * Contract of the share inbox (spec/FORMAT.md section 16): what the service worker does with content another app
 * shares to Aparté (the manifest's `share_target`) while nothing may be decrypted, and how the page reads it back once
 * the vault is unlocked. Implemented by web/src/core/inbox/inbox.ts (the format) and web/src/core/inbox/store.ts (the
 * IndexedDB database `aparte-inbox-v1`).
 *
 * Invariants:
 * - Shared content never touches storage in clear. The service worker seals each share, as it arrives, to this
 *   device's inbox public key (X25519, an ephemeral key per share, AES-256-GCM under an HKDF of the shared secret), and
 *   stores only the sealed item. It holds no secret: it cannot open what it stored.
 * - The inbox private key exists in clear only inside `createInboxKey` and `unwrapInboxKey`, and is otherwise kept
 *   wrapped by K_local("inbox-key"), a key derived from the vault's master key; once unwrapped it is a non-extractable
 *   CryptoKey of the unlocked session, dropped on lock.
 * - The key file and the items live in their own database, beside the keyslots of `aparte-v1`, whose frozen schema is
 *   left unchanged. The key file holds only public values and ciphertext; it is bound to one vault.
 * - A share is offered to the user, never acted on: opening an item only returns its content, which the interface shows
 *   for the user to start a chat with or discard (a page of another site can post to the share target too).
 * - At most `MAX_ITEMS` items wait at a time, each at most `MAX_ITEM_PAYLOAD` bytes; the worker refuses more.
 */

import type { Bytes, Rng } from './crypto.ts'

/** One file of a share, as the sharing app named it. */
export interface SharedFileInfo {
  readonly name: string
  /** Media type, lowercase (`image/jpeg`); `application/octet-stream` when the sharing app gave none. */
  readonly type: string
  readonly size: number
}

/** What another app shared, as the item payload's header describes it (spec/FORMAT.md section 16.4). */
export interface ShareHeader {
  readonly v: 1
  /** When the service worker received it, Unix milliseconds. */
  readonly time: number
  readonly title?: string
  readonly text?: string
  readonly url?: string
  readonly files: readonly SharedFileInfo[]
}

/** A share, opened: its header and each file's bytes, in the header's order. */
export interface SharedContent {
  readonly header: ShareHeader
  readonly files: readonly Bytes[]
}

/** The parsed inbox key file (spec/FORMAT.md section 16.2). */
export interface InboxKeyFile {
  readonly format: 'aparte/1'
  readonly type: 'inbox-key'
  /** base32 vaultId. */
  readonly vault: string
  /** base64url of the 32-byte X25519 public key. */
  readonly key: string
  readonly wrap: { readonly iv: string; readonly ct: string }
}

/** The inbox key of an unlocked vault: the public key and the private key as a non-extractable CryptoKey. */
export interface InboxKeyPair {
  readonly vaultId: Bytes
  readonly publicKey: Bytes
  readonly privateKey: CryptoKey
}

/** What the service worker needs to seal a share: public values only. */
export interface InboxRecipient {
  readonly vaultId: Bytes
  readonly publicKey: Bytes
}

export interface InboxModule {
  /** Items waiting at most; a share past it is refused. */
  readonly MAX_ITEMS: 32
  /** Payload bytes of one item at most (2^26, as an envelope's payload). */
  readonly MAX_ITEM_PAYLOAD: 67108864
  /**
   * A new key pair for the vault, drawing the 32-byte private scalar then the 12-byte wrap IV from `rng`, wrapped with
   * `wrapKey` (K_local("inbox-key")). Returns the file bytes and the pair.
   */
  createInboxKey(input: {
    readonly vaultId: Uint8Array
    readonly wrapKey: CryptoKey
    readonly rng: Rng
  }): Promise<{ readonly file: Bytes; readonly pair: InboxKeyPair }>
  /** Strict parse of a key file: canonical bytes only, else CorruptError. */
  parseInboxKey(bytes: Uint8Array): InboxKeyFile
  serializeInboxKey(file: InboxKeyFile): Bytes
  /** The public values of a parsed file, for sealing. */
  recipientOf(file: InboxKeyFile): InboxRecipient
  /**
   * Unwraps the private key of a file. CorruptError when the file names another vault; TamperedError when the wrap
   * does not open or the private key does not match the public one.
   */
  unwrapInboxKey(
    file: InboxKeyFile,
    input: { readonly vaultId: Uint8Array; readonly wrapKey: CryptoKey },
  ): Promise<InboxKeyPair>
  /** The item payload of a share (spec/FORMAT.md section 16.4); InvalidInputError for content the format refuses. */
  encodeShare(content: SharedContent): Bytes
  /** Inverse of encodeShare; CorruptError for anything but a canonical payload. */
  decodeShare(payload: Uint8Array): SharedContent
  /** Seals a payload to the recipient, drawing the 32-byte ephemeral scalar then the 12-byte IV from `rng`. */
  sealItem(recipient: InboxRecipient, payload: Uint8Array, rng: Rng): Promise<Bytes>
  /** Opens a sealed item per spec/FORMAT.md section 16.5 and returns the payload. */
  openItem(pair: InboxKeyPair, bytes: Uint8Array): Promise<Bytes>
}

/** One sealed item as the inbox database stores it. */
export interface StoredItem {
  /** 26-character base32 of 16 random bytes. */
  readonly id: string
  readonly bytes: Bytes
}

/** The inbox database: usable while locked, holding the key file and sealed items only. */
export interface InboxStore {
  keyFile(): Promise<Bytes | null>
  putKeyFile(bytes: Uint8Array): Promise<void>
  /** Adds an item; InvalidStateError when MAX_ITEMS wait already, InvalidInputError for a malformed one. */
  addItem(item: StoredItem): Promise<void>
  /** Every waiting item, by id. */
  items(): Promise<readonly StoredItem[]>
  deleteItem(id: string): Promise<void>
  count(): Promise<number>
  close(): void
}

export interface InboxStoreModule {
  readonly INBOX_DB_NAME: 'aparte-inbox-v1'
  /**
   * Opens (creating if needed) the database. With `create: false` (the service worker), resolves null instead of
   * creating a database that does not exist yet.
   */
  openInboxStore(options?: {
    readonly name?: string
    readonly indexedDB?: IDBFactory
    readonly create?: boolean
  }): Promise<InboxStore | null>
}
