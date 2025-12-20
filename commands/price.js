// commands/price.js
// Legacy wrapper for backward compatibility
import { getTokenInfoV2 } from '../utils/jupiterApi.js';

export async function getTokenPrice(mintAddress) {
    try {
        const tokenInfo = await getTokenInfoV2(mintAddress);
        
        if (!tokenInfo || !tokenInfo.price) {
            return {
                success: false,
                error: "❌ Invalid token or could not retrieve price. Please check the token name or address."
            };
        }

        return {
            success: true,
            token: {
                name: tokenInfo.name,
                symbol: tokenInfo.symbol,
                logoURI: tokenInfo.icon,
                daily_volume: tokenInfo.daily_volume
            },
            price: tokenInfo.price
        };
    } catch (err) {
        console.error("Error fetching price/token info:", err.message);
        return {
            success: false,
            error: "⚠️ Failed to fetch data. Double-check the mint address."
        };
    }
} 