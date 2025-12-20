// utils/jupiterApi.js
// Centralized Jupiter API utilities
import dotenv from 'dotenv';
import { resolveTokenMint } from './tokens.js';

dotenv.config();
const JUP_API_KEY = process.env.JUP_API_KEY;

/**
 * Get Jupiter API headers with API key
 */
export function getJupiterHeaders() {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (JUP_API_KEY) {
        headers['x-api-key'] = JUP_API_KEY;
    }
    return headers;
}

/**
 * Fetch token information and price using Tokens API V2
 * @param {string} query - Token symbol, name, or mint address
 * @returns {Promise<Object|null>} - Token info with price, or null if not found
 */
export async function getTokenInfoV2(query) {
    try {
        // First resolve the token mint if it's a symbol/name
        const resolvedMint = resolveTokenMint(query);
        const searchQuery = resolvedMint || query;

        const response = await fetch(
            `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(searchQuery)}`,
            {
                headers: getJupiterHeaders()
            }
        );

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const tokens = await response.json();

        if (!tokens || tokens.length === 0) {
            return null;
        }

        // Return the first matching token (most relevant)
        const token = tokens[0];
        
        return {
            id: token.id,
            name: token.name,
            symbol: token.symbol,
            icon: token.icon,
            decimals: token.decimals,
            price: token.usdPrice || 0,
            mcap: token.mcap || 0,
            fdv: token.fdv || 0,
            liquidity: token.liquidity || 0,
            isVerified: token.isVerified || false,
            organicScore: token.organicScore || null,
            organicScoreLabel: token.organicScoreLabel || null,
            holderCount: token.holderCount || 0,
            stats24h: token.stats24h || null,
            // Legacy format compatibility
            logoURI: token.icon,
            daily_volume: token.stats24h?.buyVolume + token.stats24h?.sellVolume || 0
        };
    } catch (error) {
        console.error("Error fetching token info V2:", error);
        return null;
    }
}

/**
 * Get token price only (lightweight)
 * @param {string} query - Token symbol, name, or mint address
 * @returns {Promise<number|null>} - Price in USD, or null if not found
 */
export async function getTokenPrice(query) {
    const tokenInfo = await getTokenInfoV2(query);
    return tokenInfo ? tokenInfo.price : null;
}

/**
 * Get multiple token prices
 * @param {string[]} queries - Array of token symbols, names, or mint addresses
 * @returns {Promise<Object>} - Object mapping mint to price
 */
export async function getMultipleTokenPrices(queries) {
    try {
        const searchQuery = queries.join(',');
        const response = await fetch(
            `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(searchQuery)}`,
            {
                headers: getJupiterHeaders()
            }
        );

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const tokens = await response.json();
        const priceMap = {};

        tokens.forEach(token => {
            priceMap[token.id] = token.usdPrice || 0;
        });

        return priceMap;
    } catch (error) {
        console.error("Error fetching multiple token prices:", error);
        return {};
    }
}

