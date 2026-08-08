import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Secret encryption for connection credentials (AES-256-GCM).
 *
 * Master key resolution order:
 * 1. `WORKSPACE_MASTER_KEY` environment variable (64 hex chars = 32 bytes).
 *    Preferred for real deployments: the key never touches the data directory.
 * 2. Fallback: auto-generated key file at data/secure/master.key
 *    (directory mode 0o700, file mode 0o600).
 *
 * SECURITY NOTE: the key-file variant only protects secrets at rest against
 * offline copies of the data directory (e.g. backups synced elsewhere).
 * Anyone with read access to BOTH data/secure/master.key and
 * data/connections/config.json on the same host can decrypt everything.
 * Use WORKSPACE_MASTER_KEY to separate key and ciphertext.
 */

const SECURE_DIR = path.join(process.cwd(), 'data', 'secure');
const KEY_FILE = path.join(SECURE_DIR, 'master.key');

let cachedKey: Buffer | null = null;

function ensureSecureDir() {
    if (!fs.existsSync(SECURE_DIR)) {
        fs.mkdirSync(SECURE_DIR, { recursive: true, mode: 0o700 });
    }
}

function getMasterKey(): Buffer {
    if (cachedKey) return cachedKey;

    // 1. Environment variable takes precedence over the key file
    const envKey = process.env.WORKSPACE_MASTER_KEY;
    if (envKey) {
        const trimmed = envKey.trim();
        if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
            throw new Error(
                'WORKSPACE_MASTER_KEY is set but invalid: expected 64 hex characters (32 bytes)'
            );
        }
        cachedKey = Buffer.from(trimmed, 'hex');
        return cachedKey;
    }

    // 2. Key file fallback (at-rest protection on the same host only, see note above)
    ensureSecureDir();
    if (fs.existsSync(KEY_FILE)) {
        cachedKey = fs.readFileSync(KEY_FILE);
        return cachedKey;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    cachedKey = key;
    return key;
}

const ALGORITHM = 'aes-256-gcm';

export function encrypt(text: string): string {
    const key = getMasterKey();
    const iv = crypto.randomBytes(12); // GCM standard IV size
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(text: string): string {
    const key = getMasterKey();
    const [ivHex, authTagHex, encryptedHex] = text.split(':');

    if (!ivHex || !authTagHex || !encryptedHex) {
        throw new Error('Invalid encrypted format');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
