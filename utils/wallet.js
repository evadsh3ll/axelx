import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // For AES, this is always 16

/**
 * Get a 32-byte key from secret (AES-256 requires 32 bytes)
 */
function getKey(secret) {
    // Use crypto.createHash to ensure we get exactly 32 bytes
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt text using AES-256-CBC
 */
export function encrypt(text, secret) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getKey(secret);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text using AES-256-CBC
 */
export function decrypt(ciphertext, secret) {
    const parts = ciphertext.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encrypted = parts.join(':');
    const key = getKey(secret);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Generate a new Solana keypair
 */
export function generateKeypair() {
    return Keypair.generate();
}

/**
 * Convert keypair secret key to base58 string
 */
export function keypairToBase58(keypair) {
    return bs58.encode(keypair.secretKey);
}

/**
 * Convert base58 string back to keypair
 */
export function base58ToKeypair(base58PrivateKey) {
    const secretKey = bs58.decode(base58PrivateKey);
    return Keypair.fromSecretKey(secretKey);
}

/**
 * Create wallet: generate keypair, encrypt private key, return wallet data
 */
export function createWallet(walletSecret) {
    const keypair = generateKeypair();
    const publicKey = keypair.publicKey.toBase58();
    const privateKey = keypairToBase58(keypair);
    const encryptedPrivateKey = encrypt(privateKey, walletSecret);
    
    return {
        publicKey,
        privateKey, // Show this once to user
        encryptedPrivateKey
    };
}

/**
 * Load wallet from encrypted private key
 */
export function loadWallet(encryptedPrivateKey, walletSecret) {
    const privateKey = decrypt(encryptedPrivateKey, walletSecret);
    return base58ToKeypair(privateKey);
}

