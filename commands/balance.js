// commands/balance.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const JUP_API_KEY = process.env.JUP_API_KEY;

// Helper function to get Jupiter API headers
function getJupiterHeaders() {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (JUP_API_KEY) {
        headers['x-api-key'] = JUP_API_KEY;
    }
    return headers;
}

export async function getWalletBalance(wallet) {
    try {
        const response = await axios.get(`https://api.jup.ag/ultra/v1/balances/${wallet}`, {
            headers: getJupiterHeaders()
        });
        const data = response.data;

        if (data.error) {
            throw new Error(data.error);
        }

        const sol = data.SOL?.uiAmount ?? 0;
        const isFrozen = data.SOL?.isFrozen ? "Yes" : "No";

        return {
            success: true,
            balance: sol,
            frozen: isFrozen
        };
    } catch (error) {
        console.error("Error fetching balance:", error);
        return {
            success: false,
            error: "Failed to fetch balance. Please try again later."
        };
    }
} 