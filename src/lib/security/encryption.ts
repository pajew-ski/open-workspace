import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SECURE_DIR = path.join(process.cwd(), 'data', 'secure');
const KEY_FILE = path.join(SECURE_DIR, 'master.key');

function ensureSecureDir() {
    if (!fs.existsSync(SECURE_DIR)) {
        fs.mkdirSync(SECURE_DIR, { recursive: true, mode: 0o700 });
    }
}

function getMasterKey(): Buffer {
    ensureSecureDir();
    if (fs.existsSync(KEY_FILE)) {
        return fs.readFileSync(KEY_FILE);
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
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
