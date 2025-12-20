import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import express from 'express';
import bs58 from 'bs58';
import axios from 'axios';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { parseIntent } from './nlp.js';
import { handleNLPCommand } from './handlers/commandHandler.js';
import { resolveTokenMint } from './utils/tokens.js';
import { 
    connectToDatabase, 
    saveWallet, 
    getWallet,
    saveRouteHistory, 
    saveTriggerHistory,
    saveRecurringHistory,
    savePaymentHistory, 
    savePriceCheckHistory, 
    saveNotificationHistory, 
    getHistory, 
    updateLastActivity,
    closeDatabase 
} from './utils/database.js';
import { createWallet, loadWallet } from './utils/wallet.js';
import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getJupiterHeaders, getTokenInfoV2, getTokenPrice } from './utils/jupiterApi.js';
// const qr = require('qr-image');
import qr from "qr-image"

const app = express();
dotenv.config();
const port = process.env.PORT;
const token = process.env.TELEGRAM_BOT_TOKEN;
const server_url = process.env.SERVER_URL;
const WALLET_SECRET = process.env.WALLET_SECRET;
const userWalletMap = new Map(); // chat_id → walletAddress (public key)
const bot = new TelegramBot(token, { polling: true });
app.use(express.json());
const notifyWatchers = {}; // To track active notify sessions per chat
const pendingOrders = new Map(); // requestId → { chatId, transaction, inputMint, outputMint, amount, targetPrice, orderId }
const pendingRecurringOrders = new Map(); // requestId → { chatId, transaction, inputMint, outputMint, inAmount, numberOfOrders, interval, orderId }
const LAMPORTS_PER_SOL = 1_000_000_000;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Helper function to load wallet keypair from database
async function loadUserWallet(chatId) {
    if (!WALLET_SECRET) {
        throw new Error("WALLET_SECRET not configured");
    }
    
    const walletRecord = await getWallet(chatId);
    if (!walletRecord || !walletRecord.encryptedPrivateKey) {
        return null;
    }
    
    return loadWallet(walletRecord.encryptedPrivateKey, WALLET_SECRET);
}

// Helper function to sign and send transaction
async function signAndSendTransaction(transactionBase64, keypair) {
    try {
        // Deserialize transaction
        const txBuffer = Buffer.from(transactionBase64, 'base64');
        let transaction;
        
        // Try VersionedTransaction first, fallback to Transaction
        try {
            transaction = VersionedTransaction.deserialize(txBuffer);
        } catch {
            transaction = Transaction.from(txBuffer);
        }
        
        // Sign transaction
        transaction.sign(keypair);
        
        // Serialize signed transaction
        const signedTxBase64 = transaction.serialize().toString('base64');
        
        return signedTxBase64;
    } catch (error) {
        console.error("Error signing transaction:", error);
        throw error;
    }
}
bot.on('polling_error', console.error);

// Connect to database on startup
connectToDatabase().catch(console.error);

async function toLamports({ sol = null, usd = null } = {}) {
    if (sol !== null) {
        return Math.round(sol * LAMPORTS_PER_SOL);
    }

    if (usd !== null) {
        try {
            const solPrice = await getTokenPrice('SOL');
            if (!solPrice) {
                throw new Error("Failed to fetch SOL price");
            }
            return Math.round((usd / solPrice) * LAMPORTS_PER_SOL);
        } catch (e) {
            console.error("Error fetching SOL price:", e.message);
            throw new Error("❌ Failed to convert USD to lamports.");
        }
    }

    throw new Error("❌ Must provide either SOL or USD for conversion.");
}
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `Hey ${msg.from.first_name}! 👋 I'm your bot.`);
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `🤖 *AXELX Bot Help*

*Traditional Commands:*
/start - Start the bot
/createwallet - Create your in-app wallet
/exportwallet - Export your wallet private key
/about - Check your balance
/price <token> - Get token price
/tokens - List available tokens
/route <input> <output> <amount> - Get swap route
/trigger <input> <output> <amount> <price> - Create trigger order
/trigger orders - Show active orders with cancel buttons
/trigger orderhistory - Show order history
/recurring <input> <output> <totalAmount> <numberOfOrders> <intervalDays> - Create recurring order
/recurring orders - Show active recurring orders with cancel buttons
/recurring orderhistory - Show recurring order history
/receivepayment <amount> - Generate payment request
/payto <wallet> <amount> - Pay to specific wallet
/notify <token> <above/below> <price> - Set price alerts (checks every 2 seconds)
/history [type] - Show your activity history

*Trigger Orders Flow:*
1️⃣ Request trigger order (via command or natural language)
2️⃣ Confirm order details with button
3️⃣ Order is created (not executed yet)
4️⃣ Click "Execute Order" button to execute
5️⃣ View orders with /trigger orders
6️⃣ Cancel orders using cancel buttons

*Prerequisites for Trigger Orders:*
✅ Wallet must be created (/createwallet)
✅ Minimum order size: 5 USD worth
✅ Sufficient balance in your wallet
✅ Valid token pairs (e.g., SOL/USDC, SOL/JUP)

*Recurring Orders Flow:*
1️⃣ Request recurring order (via command or natural language)
2️⃣ Confirm order details with button
3️⃣ Order is created (not executed yet)
4️⃣ Click "Execute Order" button to execute
5️⃣ View orders with /recurring orders
6️⃣ Cancel orders using cancel buttons

*Prerequisites for Recurring Orders:*
✅ Wallet must be created (/createwallet)
✅ Minimum total amount: 100 USD
✅ Minimum per order: 50 USD
✅ Minimum number of orders: 2
✅ Sufficient balance in your wallet
✅ Valid token pairs (e.g., USDC/SOL, USDC/JUP)

*Natural Language Commands (Auto-Execute):*
• "create wallet" → Executes /createwallet
• "what's my balance?" → Executes /about
• "get price of SOL" → Executes /price SOL
• "get route for 1 SOL to USDC" → Executes /route SOL USDC 1
• "trigger 1 SOL to USDC at $50" → Shows confirmation button
• "show my orders" → Shows active trigger orders
• "recurring order 1000 USDC to SOL 10 orders every day" → Shows confirmation button
• "dollar cost average 500 USDC into SOL over 5 weeks" → Shows confirmation button
• "show my recurring orders" → Shows active recurring orders
• "receive payment of 10 USDC" → Executes /receivepayment 10000000
• "pay 5 USDC to [wallet]" → Executes /payto [wallet] 5000000
• "notify me when SOL goes above $100" → Sets price alert (checks every 2s)

*Examples (All Auto-Execute):*
• "I want to create a wallet"
• "Show me the price of Bitcoin"
• "Get me a route for 2 SOL to USDC"
• "Create a trigger order for 1 SOL to USDC at $45"
• "Show my trigger orders"
• "Create recurring order 1000 USDC to SOL 10 orders every day"
• "Dollar cost average 500 USDC into JUP weekly for 4 weeks"
• "I need to receive 20 USDC"
• "Alert me when JUP goes below $0.5"

*Token Names Supported:*
• SOL, USDC, USDT, WBTC, WETH
• JUP (Jupiter), BONK, SRM (Serum)
• And many more! Just type the token name

*History Types:*
• /history - All activities
• /history route - Route queries
• /history trigger - Trigger orders
• /history recurring - Recurring orders
• /history payment - Payment history
• /history price - Price checks
• /history notification - Notifications

⚠️ *This is a beta demo wallet. Save your private key. Only deposit test funds.*

🚀 *Just type what you want - the bot will automatically execute the commands!*`;
    
    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

// Create wallet command
bot.onText(/\/createwallet/, async (msg) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || null;

    if (!WALLET_SECRET) {
        return bot.sendMessage(chatId, "❌ Server configuration error. Please contact support.");
    }

    try {
        // Check if wallet already exists
        const existingWallet = await getWallet(chatId);
        if (existingWallet) {
            return bot.sendMessage(chatId, "⚠️ You already have a wallet. Use /exportwallet to view your private key.");
        }

        // Create new wallet
        const walletData = createWallet(WALLET_SECRET);
        
        // Save to database
        await saveWallet(chatId, walletData.publicKey, walletData.encryptedPrivateKey, username);
        
        // Update in-memory map
        userWalletMap.set(chatId, walletData.publicKey);

        const message = `✅ *Your AXELX Wallet is ready*

📝 *Public Key:*
\`${walletData.publicKey}\`

🔑 *Private Key (SAVE THIS):*
\`${walletData.privateKey}\`

⚠️ *We cannot recover this for you. Save it securely!*

This is a beta demo wallet. Only deposit test funds.`;

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Create wallet error:", error);
        bot.sendMessage(chatId, "❌ Failed to create wallet. Please try again.");
    }
});

// Export wallet command
bot.onText(/\/exportwallet/, async (msg) => {
    const chatId = String(msg.chat.id);

    if (!WALLET_SECRET) {
        return bot.sendMessage(chatId, "❌ Server configuration error. Please contact support.");
    }

    try {
        const walletRecord = await getWallet(chatId);
        if (!walletRecord || !walletRecord.encryptedPrivateKey) {
            return bot.sendMessage(chatId, "❌ No wallet found. Use /createwallet to create one.");
        }

        // Load wallet to decrypt private key
        const keypair = loadWallet(walletRecord.encryptedPrivateKey, WALLET_SECRET);
        const privateKey = bs58.encode(keypair.secretKey);

        const message = `🔑 *Your Wallet Private Key*

📝 *Public Key:*
\`${walletRecord.publicKey}\`

🔑 *Private Key:*
\`${privateKey}\`

⚠️ *Keep this private key secure. Anyone with access to it can control your wallet.*`;

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Export wallet error:", error);
        bot.sendMessage(chatId, "❌ Failed to export wallet. Please try again.");
    }
});
bot.onText(/\/receivepayment (\d+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const username = msg.from.username || null;
  
  // Load wallet from database
  const walletRecord = await getWallet(chatId);
  if (!walletRecord) {
    return bot.sendMessage(chatId, "❌ Please create wallet first using /createwallet.");
  }
  
  const merchantWallet = walletRecord.publicKey;
  userWalletMap.set(chatId, merchantWallet); // Update in-memory map
  
  const amount = Number(match[1]); // in micro USDC (e.g. 1 USDC = 1_000_000)

  try {
    const merchantPublicKey = new PublicKey(merchantWallet);
    const merchantUSDCATA = await getAssociatedTokenAddress(
      USDC_MINT,
      merchantPublicKey,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Save payment history
    await savePaymentHistory(chatId, amount, 'receive', null, username);

    const message = `🧾 *Payment Request*

💰 Amount: ${amount / 1e6} USDC

📝 *Your Wallet Address:*
\`${merchantWallet}\`

💡 Share this address with the payer to receive payment.`;

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

  } catch (err) {
    console.error("/receivepayment error:", err);
    bot.sendMessage(chatId, "❌ Failed to generate payment request.");
  }
});

bot.onText(/\/payto (\w{32,44}) (\d+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const username = msg.from.username || null;
  
  // Load wallet from database
  const walletRecord = await getWallet(chatId);
  if (!walletRecord) {
    return bot.sendMessage(chatId, "❌ Please create wallet first using /createwallet.");
  }
  
  const payerWallet = walletRecord.publicKey;
  userWalletMap.set(chatId, payerWallet); // Update in-memory map
  
  const merchantWallet = match[1];
  const amount = Number(match[2]); // in micro USDC

  try {
    const merchantPublicKey = new PublicKey(merchantWallet);
    const merchantUSDCATA = await getAssociatedTokenAddress(
      USDC_MINT,
      merchantPublicKey,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=50&swapMode=ExactOut`;
    const quote = await (await fetch(quoteUrl, {
        headers: getJupiterHeaders()
    })).json();

   const swapRes = await (await fetch(`https://api.jup.ag/swap/v1/swap`, {
  method: "POST",
  headers: getJupiterHeaders(),
  body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: payerWallet,
        destinationTokenAccount: merchantUSDCATA.toBase58()
      })
    })).json();

    if (!swapRes.swapTransaction) {
      return bot.sendMessage(chatId, "❌ Failed to create swap transaction.");
    }

    // Load wallet and sign transaction
    const keypair = await loadUserWallet(chatId);
    if (!keypair) {
      return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
    }

    const signedTxBase64 = await signAndSendTransaction(swapRes.swapTransaction, keypair);

    // Execute the signed transaction
        const execRes = await axios.post("https://api.jup.ag/ultra/v1/execute", {
            signedTransaction: signedTxBase64,
            requestId: swapRes.requestId
        }, {
            headers: getJupiterHeaders()
        });

    const { signature, status } = execRes.data;

    // Save payment history
    await savePaymentHistory(chatId, amount, 'send', merchantWallet, username);

    await bot.sendMessage(chatId, `✅ *Payment Executed!*\n\n💸 Amount: ${amount / 1e6} USDC\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
      parse_mode: "Markdown"
    });

  } catch (err) {
    console.error("/payto error:", err);
    bot.sendMessage(chatId, `❌ Failed to execute payment: ${err.message}`);
  }
});

//ULTRA API balance
bot.onText(/\/about/, async (msg) => {
    const chatId = String(msg.chat.id);
    
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
    }
    
    const wallet = walletRecord.publicKey;
    userWalletMap.set(chatId, wallet); // Update in-memory map

    try {
        const response = await axios.get(`https://api.jup.ag/ultra/v1/balances/${wallet}`, {
            headers: getJupiterHeaders()
        });
        const data = response.data;

        if (data.error) {
            return bot.sendMessage(chatId, `❌ Error: ${data.error}`);
        }

        const sol = data.SOL?.uiAmount ?? 0;
        const isFrozen = data.SOL?.isFrozen ? "Yes" : "No";

        bot.sendMessage(chatId, `💰 Your SOL Balance:\n\nBalance: ${sol} SOL\nFrozen: ${isFrozen}`);
    } catch (error) {
        console.error("Error fetching balance:", error);
        bot.sendMessage(chatId, "⚠️ Failed to fetch balance. Please try again later.");
    }
});
//PRICE API
bot.onText(/\/price (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || null;
    const mintAddress = match[1].trim();
    
    try {
        const tokenInfo = await getTokenInfoV2(mintAddress);

        if (!tokenInfo || !tokenInfo.price) {
            return bot.sendMessage(chatId, "❌ Could not retrieve a valid price. Please check the token name or address.");
        }

        const msgText = `💰 *${tokenInfo.name}* (${tokenInfo.symbol})\n\n📈 Price: $${tokenInfo.price.toFixed(6)}${tokenInfo.mcap ? `\n💵 Market Cap: $${(tokenInfo.mcap / 1e9).toFixed(2)}B` : ''}${tokenInfo.isVerified ? '\n✅ Verified' : ''}`;

        // Save price check history
        await savePriceCheckHistory(chatId, mintAddress, tokenInfo.price, username);

        await bot.sendPhoto(chatId, tokenInfo.icon, {
            caption: msgText,
            parse_mode: "Markdown"
        });

    } catch (err) {
        console.error("Error fetching price/token info:", err.message);
        bot.sendMessage(chatId, "⚠️ Failed to fetch data. Double-check the mint address.");
    }
});
//TOKEN API
bot.onText(/\/tokens/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        // Use V2 API to get top trending tokens
        const response = await fetch('https://api.jup.ag/tokens/v2/toptrending/24h?limit=5', {
            headers: getJupiterHeaders()
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const tokens = await response.json();

        if (!tokens || tokens.length === 0) {
            return bot.sendMessage(chatId, '❌ No tokens found.');
        }

        const inlineKeyboard = tokens.map((token) => [{
            text: `${token.symbol} - $${token.price?.toFixed(4) || 'N/A'}`,
            callback_data: `token_${token.id}`
        }]);

        bot.sendMessage(chatId, '📊 *Top Trending Tokens (24h)*\n\nSelect a token to view details:', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: inlineKeyboard
            }
        });
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, '❌ Failed to fetch token list.');
    }
});
//TRIGGER API
bot.onText(/\/trigger (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || null;
    
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
    }
    
    const wallet = walletRecord.publicKey;
    userWalletMap.set(chatId, wallet); // Update in-memory map

    const args = match[1].trim().split(" ");

    if (args[0] === 'orders' || args[0] === 'show' || args[0] === 'list') {
        try {
            const res = await axios.get(`https://api.jup.ag/trigger/v1/getTriggerOrders?user=${wallet}&orderStatus=active`, {
                headers: getJupiterHeaders()
            });
            
            // Check if response is valid and has data
            if (!res || !res.data || !Array.isArray(res.data) || res.data.length === 0) {
                return bot.sendMessage(chatId, "📭 No active orders.");
            }
            
            const keyboard = res.data.map(o => [{
                text: `🗑️ Cancel Order ${o.order?.slice(0, 8) || 'Unknown'}...`,
                callback_data: `cancel_${o.order}`
            }]);
            
            const ordersText = res.data.map((o, idx) => {
                const inputAmount = Number(o.params?.makingAmount || 0) / 1e9;
                const outputAmount = Number(o.params?.takingAmount || 0) / 1e6;
                return `${idx + 1}. 🆔 \`${o.order || 'Unknown'}\`\n   📥 ${inputAmount} → 📤 ${outputAmount}`;
            }).join('\n\n');
            
            return bot.sendMessage(chatId, `📋 *Active Orders*\n\n${ordersText}\n\n*Select an order to cancel:*`, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        } catch (err) {
            console.error("Error fetching trigger orders:", err?.response?.data || err.message);
            return bot.sendMessage(chatId, "📭 No active orders or error fetching orders.");
        }
    }

    if (args[0] === 'orderhistory') {
        const res = await axios.get(`https://api.jup.ag/trigger/v1/getTriggerOrders?user=${wallet}&orderStatus=history`, {
            headers: getJupiterHeaders()
        });
        if (!res.data.length) return bot.sendMessage(chatId, "📭 No order history found.");
        const orders = res.data.map(o => `• 🆔 ${o.order} (${o.params.makingAmount} → ${o.params.takingAmount})`);
        return bot.sendMessage(chatId, `📜 *Order History*\n\n${orders.join('\n')}`, { parse_mode: "Markdown" });
    }

    if (args[0] === 'cancelorder') {
        const res = await axios.get(`https://api.jup.ag/trigger/v1/getTriggerOrders?user=${wallet}&orderStatus=active`, {
            headers: getJupiterHeaders()
        });
        const orders = res.data;
        if (!orders.length) return bot.sendMessage(chatId, "📭 No active orders to cancel.");

        const keyboard = orders.map(o => [{
            text: `Cancel ${o.params.makingAmount} → ${o.params.takingAmount}`,
            callback_data: `cancel_${o.order}`
        }]);

        return bot.sendMessage(chatId, `🗑️ *Choose an order to cancel:*`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    // Default fallback to actual order trigger
    if (args.length !== 4) {
        return bot.sendMessage(chatId, `⚠️ Usage:\n/trigger <inputMint> <outputMint> <amount> <targetPrice>\n/trigger orders - Show active orders\n/trigger orderhistory - Show order history`);
    }

    const [inputMintName, outputMintName, amountStr, targetPriceStr] = args;
    const inputMint = resolveTokenMint(inputMintName);
    const outputMint = resolveTokenMint(outputMintName);
    const amount = parseFloat(amountStr);
    const targetPrice = parseFloat(targetPriceStr);

    if (isNaN(amount) || isNaN(targetPrice)) {
        return bot.sendMessage(chatId, "❌ Invalid amount or price.");
    }

    // Show confirmation button
    const orderHash = Buffer.from(`${chatId}_${Date.now()}_${amount}_${targetPrice}`).toString('base64').slice(0, 16);
    
    // Store pending order details temporarily
    pendingOrders.set(orderHash, {
        chatId,
        inputMint,
        outputMint,
        amount,
        targetPrice,
        username
    });
    
    // Get token info for display
    const inputTokenInfo = await getTokenInfoV2(inputMint);
    const outputTokenInfo = await getTokenInfoV2(outputMint);
    
    const confirmMessage = `⚡ *Trigger Order Confirmation*\n\n` +
        `📥 Input: ${amount} ${inputTokenInfo?.symbol || inputMint.slice(0, 4)}\n` +
        `📤 Output: ${outputTokenInfo?.symbol || outputMint.slice(0, 4)}\n` +
        `💰 Target Price: $${targetPrice}\n\n` +
        `⚠️ *Minimum order size: 5 USD*\n` +
        `Please confirm to create this trigger order:`;
    
    return bot.sendMessage(chatId, confirmMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ Confirm & Create Order", callback_data: `confirm_trigger_${orderHash}` },
                { text: "❌ Cancel", callback_data: `cancel_trigger_${orderHash}` }
            ]]
        }
    });
});

//RECURRING API
bot.onText(/\/recurring (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || null;
    
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
    }
    
    const wallet = walletRecord.publicKey;
    userWalletMap.set(chatId, wallet);

    const args = match[1].trim().split(" ");

    if (args[0] === 'orders' || args[0] === 'show' || args[0] === 'list') {
        try {
            const res = await axios.get(`https://api.jup.ag/recurring/v1/getRecurringOrders?user=${wallet}&orderStatus=active&recurringType=time`, {
                headers: getJupiterHeaders()
            });
            
            if (!res || !res.data || !Array.isArray(res.data) || res.data.length === 0) {
                return bot.sendMessage(chatId, "📭 No active recurring orders.");
            }
            
            const keyboard = res.data.map(o => [{
                text: `🗑️ Cancel Order ${o.order?.slice(0, 8) || 'Unknown'}...`,
                callback_data: `cancel_recurring_order_${o.order}`
            }]);
            
            const ordersText = res.data.map((o, idx) => {
                const inAmount = Number(o.params?.time?.inAmount || 0) / 1e6; // Assuming USDC
                const numOrders = o.params?.time?.numberOfOrders || 0;
                const interval = o.params?.time?.interval || 0;
                const intervalDays = Math.floor(interval / 86400);
                return `${idx + 1}. 🆔 \`${o.order || 'Unknown'}\`\n   💰 ${inAmount} USDC\n   📊 ${numOrders} orders, every ${intervalDays} day(s)`;
            }).join('\n\n');
            
            return bot.sendMessage(chatId, `📋 *Active Recurring Orders*\n\n${ordersText}\n\n*Select an order to cancel:*`, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        } catch (err) {
            console.error("Error fetching recurring orders:", err?.response?.data || err.message);
            return bot.sendMessage(chatId, "📭 No active recurring orders or error fetching orders.");
        }
    }

    if (args[0] === 'orderhistory') {
        try {
            const res = await axios.get(`https://api.jup.ag/recurring/v1/getRecurringOrders?user=${wallet}&orderStatus=history&recurringType=time`, {
                headers: getJupiterHeaders()
            });
            if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
                return bot.sendMessage(chatId, "📭 No recurring order history found.");
            }
            const orders = res.data.map((o, idx) => {
                const inAmount = Number(o.params?.time?.inAmount || 0) / 1e6;
                const numOrders = o.params?.time?.numberOfOrders || 0;
                return `${idx + 1}. 🆔 ${o.order} (${inAmount} USDC, ${numOrders} orders)`;
            });
            return bot.sendMessage(chatId, `📜 *Recurring Order History*\n\n${orders.join('\n')}`, { parse_mode: "Markdown" });
        } catch (err) {
            console.error("Error fetching recurring order history:", err);
            return bot.sendMessage(chatId, "📭 No recurring order history found.");
        }
    }

    // Default: Create recurring order
    // Format: /recurring <inputMint> <outputMint> <totalAmount> <numberOfOrders> <intervalDays>
    if (args.length !== 5) {
        return bot.sendMessage(chatId, `⚠️ Usage:\n/recurring <inputMint> <outputMint> <totalAmount> <numberOfOrders> <intervalDays>\n/recurring orders - Show active orders\n/recurring orderhistory - Show order history\n\nExample: /recurring USDC SOL 1000 10 1\n(1000 USDC total, 10 orders, every 1 day)`);
    }

    const [inputMintName, outputMintName, totalAmountStr, numberOfOrdersStr, intervalDaysStr] = args;
    const inputMint = resolveTokenMint(inputMintName);
    const outputMint = resolveTokenMint(outputMintName);
    const totalAmount = parseFloat(totalAmountStr);
    const numberOfOrders = parseInt(numberOfOrdersStr);
    const intervalDays = parseFloat(intervalDaysStr);
    const intervalSeconds = Math.floor(intervalDays * 86400);

    if (isNaN(totalAmount) || isNaN(numberOfOrders) || isNaN(intervalDays) || numberOfOrders < 2) {
        return bot.sendMessage(chatId, "❌ Invalid parameters. Minimum 2 orders required.");
    }

    // Validate minimums: 100 USD total, 50 USD per order
    const amountPerOrder = totalAmount / numberOfOrders;
    if (totalAmount < 100) {
        return bot.sendMessage(chatId, "❌ Minimum total amount is 100 USD.");
    }
    if (amountPerOrder < 50) {
        return bot.sendMessage(chatId, `❌ Minimum amount per order is 50 USD. With ${numberOfOrders} orders, you need at least ${numberOfOrders * 50} USD total.`);
    }

    // Show confirmation button
    const orderHash = Buffer.from(`${chatId}_${Date.now()}_${totalAmount}_${numberOfOrders}`).toString('base64').slice(0, 16);
    
    // Store pending order details temporarily
    pendingRecurringOrders.set(orderHash, {
        chatId,
        inputMint,
        outputMint,
        totalAmount,
        numberOfOrders,
        intervalSeconds,
        username
    });
    
    // Get token info for display
    const inputTokenInfo = await getTokenInfoV2(inputMint);
    const outputTokenInfo = await getTokenInfoV2(outputMint);
    
    const confirmMessage = `🔄 *Recurring Order Confirmation*\n\n` +
        `📥 Input: ${totalAmount} ${inputTokenInfo?.symbol || inputMint.slice(0, 4)}\n` +
        `📤 Output: ${outputTokenInfo?.symbol || outputMint.slice(0, 4)}\n` +
        `📊 Number of Orders: ${numberOfOrders}\n` +
        `💰 Amount per Order: ${amountPerOrder.toFixed(2)} ${inputTokenInfo?.symbol || 'USD'}\n` +
        `⏰ Interval: Every ${intervalDays} day(s)\n` +
        `📅 Total Duration: ${(numberOfOrders * intervalDays).toFixed(1)} days\n\n` +
        `⚠️ *Requirements:*\n` +
        `• Minimum total: 100 USD\n` +
        `• Minimum per order: 50 USD\n` +
        `• Minimum orders: 2\n\n` +
        `Please confirm to create this recurring order:`;
    
    return bot.sendMessage(chatId, confirmMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ Confirm & Create Order", callback_data: `confirm_recurring_${orderHash}` },
                { text: "❌ Cancel", callback_data: `cancel_recurring_${orderHash}` }
            ]]
        }
    });
});

//ULTRA API 
bot.onText(/\/route (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || null;
    
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ You must create your wallet first. Use /createwallet.");
    }
    
    const wallet = walletRecord.publicKey;
    userWalletMap.set(chatId, wallet); // Update in-memory map

    const input = match[1]?.trim()?.split(" ");
    if (!input || input.length !== 3) {
        return bot.sendMessage(chatId, "❌ Usage:\n/route <inputMint> <outputMint> <amountInLamports>");
    }

    const [inputMint, outputMint, amount] = input;

    const fetchOrder = async (includeWallet = true) => {
        const base = `https://api.jup.ag/ultra/v1/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;
        const url = includeWallet ? `${base}&taker=${wallet}` : base;
        const res = await fetch(url, {
            headers: getJupiterHeaders()
        });
        return res.json();
    };

    let data = await fetchOrder(true);
    let retried = false;
    if (data.error || !data.transaction) {
        data = await fetchOrder(false);
        retried = true;
    }

    if (data.error || !data.routePlan) {
        return bot.sendMessage(chatId, `❌ Could not fetch route.\nReason: ${data.error || 'Unknown error'}`);
    }

    const {
        swapType,
        requestId,
        inAmount,
        outAmount,
        slippageBps,
        priceImpactPct,
        routePlan,
        gasless,
        transaction,
    } = data;

    let routeDetails = `
🔀 *Route ${retried ? "Preview (No Wallet)" : "Details"}*
Swap Type: *${swapType?.toUpperCase() || 'Unknown'}*
Gasless: *${gasless ? "Yes" : "No"}*
💸 Slippage: ${slippageBps / 100}%
📉 Price Impact: ${priceImpactPct}%
🆔 Request ID: \`${requestId?.slice(0, 8)}...\`
${retried ? "⚠️ *Insufficient balance. Preview only.*" : ""}
`;

    routePlan.forEach((route, idx) => {
        const s = route.swapInfo;
        const pct = route.percent || 100;
        const fee = Number(s.feeAmount || 0) / 1e9;
        routeDetails += `
\n🔁 *Route ${idx + 1} (${pct}% via ${s.label})*
• 🧩 AMM: \`${s.ammKey.slice(0, 8)}...\`
• 📥 In: ${Number(s.inAmount) / 1e9} ${s.inputMint.slice(0, 4)}...
• 📤 Out: ${Number(s.outAmount) / 1e6} ${s.outputMint.slice(0, 4)}...
• 💰 Fee: ${fee} ${s.feeMint.slice(0, 4)}...`;
    });

    // Save route history
    await saveRouteHistory(chatId, inputMint, outputMint, amount, routeDetails, username);

    if (retried || !transaction) {
        return bot.sendMessage(chatId, routeDetails, { parse_mode: "Markdown" });
    }

    try {
        // Load wallet and sign transaction
        const keypair = await loadUserWallet(chatId);
        if (!keypair) {
            return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
        }

        const signedTxBase64 = await signAndSendTransaction(transaction, keypair);

        // Execute the signed transaction
        const execRes = await axios.post("https://api.jup.ag/ultra/v1/execute", {
            signedTransaction: signedTxBase64,
            requestId: requestId
        }, {
            headers: getJupiterHeaders()
        });

        const { signature, status } = execRes.data;

        routeDetails += `\n\n✅ *Transaction Executed!*\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`;

        await bot.sendMessage(chatId, routeDetails, { parse_mode: "Markdown" });
    } catch (err) {
        console.error("Signing/execution error:", err);
        bot.sendMessage(chatId, `❌ Failed to sign and execute transaction: ${err.message}`);
    }
});

//custom to send notifications based on price conditions
bot.onText(/\/notify (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || null;
    const input = match[1].trim().split(" ");

    if (input.length !== 3) {
        return bot.sendMessage(chatId, "❌ Usage: /notify <token_name> <above|below> <target_price>");
    }

    const [tokenName, condition, targetStr] = input;
    const targetPrice = parseFloat(targetStr);
    const resolvedMint = resolveTokenMint(tokenName);

    if (!resolvedMint) {
        return bot.sendMessage(chatId, "❌ Invalid token. Please check the token name or symbol.");
    }

    if (isNaN(targetPrice) || !(condition === "above" || condition === "below")) {
        return bot.sendMessage(chatId, "⚠️ Invalid input. Use:\n/notify <token_name> <above|below> <price>");
    }

    try {
        const tokenInfo = await getTokenInfoV2(tokenName);
        
        if (!tokenInfo || !tokenInfo.price) {
            return bot.sendMessage(chatId, "❌ Couldn't fetch valid token price.");
        }

        const currentPrice = tokenInfo.price;

        // Save notification history
        await saveNotificationHistory(chatId, tokenInfo.id, condition, targetPrice, username);

        // Check immediately on first attempt
        const shouldNotifyNow =
            (condition === "above" && currentPrice >= targetPrice) ||
            (condition === "below" && currentPrice <= targetPrice);

        if (shouldNotifyNow) {
            await bot.sendMessage(chatId,
                `📊 *${tokenInfo.name}* (${tokenInfo.symbol})\n` +
                `💵 Current Price: $${currentPrice.toFixed(6)}\n\n` +
                `🎯 *Price target already reached!*\n` +
                `Target: *${condition}* $${targetPrice}\n\n` +
                `💬 Do you want to *buy it*, *trigger it*, or just *get notified*?`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        await bot.sendMessage(chatId,
            `📊 *${tokenInfo.name}* (${tokenInfo.symbol})\n` +
            `💵 Current Price: $${currentPrice.toFixed(6)}\n\n` +
            `🔔 Monitoring for price *${condition}* $${targetPrice}\n` +
            `✅ Notification active! Checking every 2 seconds...`,
            { parse_mode: "Markdown" }
        );

        if (!notifyWatchers[chatId]) notifyWatchers[chatId] = [];

        const intervalId = setInterval(async () => {
            try {
                const priceNow = await getTokenPrice(tokenInfo.id);
                
                if (!priceNow || isNaN(priceNow)) {
                    console.error(`Failed to fetch price for ${tokenInfo.symbol} (${tokenInfo.id})`);
                    return;
                }

                console.log(`[Notify] ${tokenInfo.symbol}: $${priceNow} (target: ${condition} $${targetPrice})`);

                const shouldNotify =
                    (condition === "above" && priceNow >= targetPrice) ||
                    (condition === "below" && priceNow <= targetPrice);

                if (shouldNotify) {
                    try {
                        await bot.sendMessage(chatId, `🎯 *${tokenInfo.symbol}* is now at $${priceNow.toFixed(4)}!\n\n💬 Do you want to *buy it*, *trigger it*, or just *get notified*?`, {
                            parse_mode: "Markdown"
                        });
                    } catch (sendErr) {
                        console.error(`Failed to send notification message: ${sendErr.message}`);
                    }

                    clearInterval(intervalId);
                    // Remove from watchers array
                    if (notifyWatchers[chatId]) {
                        notifyWatchers[chatId] = notifyWatchers[chatId].filter(id => id !== intervalId);
                    }
                }
            } catch (err) {
                console.error(`Polling error for ${tokenInfo.symbol}: ${err.message}`);
            }
        }, 2000); // Check every 2 seconds

        notifyWatchers[chatId].push(intervalId);
    } catch (err) {
        console.error("Notify command error:", err.message);
        bot.sendMessage(chatId, "⚠️ Failed to fetch token info. Please check the token name.");
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
        // Answer callback to remove loading state
        await bot.answerCallbackQuery(query.id);

        if (data.startsWith('token_')) {
            const mint = data.replace('token_', '');

            const tokenInfo = await getTokenInfoV2(mint);

            if (!tokenInfo) {
                return bot.sendMessage(chatId, "❌ Failed to fetch token information.");
            }

            const caption = `💠 *${tokenInfo.name} (${tokenInfo.symbol})*\n\n💵 *Price*: $${tokenInfo.price.toFixed(4)}\n📦 Volume (24h): $${Math.floor(tokenInfo.daily_volume).toLocaleString()}${tokenInfo.mcap ? `\n💵 Market Cap: $${(tokenInfo.mcap / 1e9).toFixed(2)}B` : ''}${tokenInfo.isVerified ? '\n✅ Verified' : ''}`;

            return bot.sendPhoto(chatId, tokenInfo.icon, {
                caption,
                parse_mode: 'Markdown'
            });
        }

        // Handle trigger order confirmation
        if (data.startsWith('confirm_trigger_')) {
            const orderHash = data.replace('confirm_trigger_', '');
            const orderData = pendingOrders.get(orderHash);
            
            if (!orderData) {
                // Try global as fallback
                if (global.pendingOrders) {
                    const globalData = global.pendingOrders.get(orderHash);
                    if (globalData) {
                        // Use global data
                        const walletRecord = await getWallet(String(chatId));
                        if (!walletRecord) {
                            return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
                        }
                        
                        const wallet = walletRecord.publicKey;
                        userWalletMap.set(String(chatId), wallet);

                        try {
                            const makingAmount = (await toLamports({ sol: globalData.amount })).toString();
                            const takingAmount = (await toLamports({ usd: globalData.amount * globalData.targetPrice })).toString();

                            const createPayload = {
                                inputMint: globalData.inputMint,
                                outputMint: globalData.outputMint,
                                maker: wallet,
                                payer: wallet,
                                params: {
                                    makingAmount,
                                    takingAmount
                                },
                                computeUnitPrice: "auto"
                            };

                            const createRes = await axios.post(
                                "https://api.jup.ag/trigger/v1/createOrder",
                                createPayload,
                                { headers: getJupiterHeaders() }
                            );

                            const requestId = createRes.data?.requestId;
                            const orderId = createRes.data?.order;
                            const txBase64 = createRes.data?.transaction;

                            if (!requestId || !txBase64) {
                                const errorMsg = createRes.data?.error || createRes.data?.cause || "Unknown error";
                                return bot.sendMessage(chatId, `❌ Failed to create order.\n\n${errorMsg}`, {
                                    parse_mode: "Markdown"
                                });
                            }

                            // Store pending order for execution
                            pendingOrders.set(requestId, {
                                chatId: String(chatId),
                                transaction: txBase64,
                                inputMint: globalData.inputMint,
                                outputMint: globalData.outputMint,
                                amount: globalData.amount,
                                targetPrice: globalData.targetPrice,
                                orderId,
                                requestId
                            });

                            const inputTokenInfo = await getTokenInfoV2(globalData.inputMint);
                            const outputTokenInfo = await getTokenInfoV2(globalData.outputMint);
                            
                            const orderMessage = `✅ *Order Created Successfully!*\n\n` +
                                `📥 Input: ${globalData.amount} ${inputTokenInfo?.symbol || globalData.inputMint.slice(0, 4)}\n` +
                                `📤 Output: ${outputTokenInfo?.symbol || globalData.outputMint.slice(0, 4)}\n` +
                                `💰 Target Price: $${globalData.targetPrice}\n` +
                                `🆔 Request ID: \`${requestId}\`\n\n` +
                                `⚠️ *Order is ready but not executed yet.*\n` +
                                `Click the button below to execute:`;

                            return await bot.sendMessage(chatId, orderMessage, {
                                parse_mode: "Markdown",
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: "🚀 Execute Order", callback_data: `execute_order_${requestId}` }
                                    ]]
                                }
                            });

                        } catch (err) {
                            console.error("Create order error:", err?.response?.data || err.message);
                            const errorMsg = err?.response?.data?.error || err?.response?.data?.cause || err.message;
                            return bot.sendMessage(chatId, `❌ Failed to create trigger order.\n\n${errorMsg}`, {
                                parse_mode: "Markdown"
                            });
                        }
                    }
                }
                return bot.sendMessage(chatId, "❌ Order data not found. Please try again.");
            }
            
            // If orderData exists in pendingOrders, proceed with creation
            const walletRecord = await getWallet(String(chatId));
            if (!walletRecord) {
                return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
            }
            
            const wallet = walletRecord.publicKey;
            userWalletMap.set(String(chatId), wallet);

            try {
                const makingAmount = (await toLamports({ sol: orderData.amount })).toString();
                const takingAmount = (await toLamports({ usd: orderData.amount * orderData.targetPrice })).toString();

                const createPayload = {
                    inputMint: orderData.inputMint,
                    outputMint: orderData.outputMint,
                    maker: wallet,
                    payer: wallet,
                    params: {
                        makingAmount,
                        takingAmount
                    },
                    computeUnitPrice: "auto"
                };

                const createRes = await axios.post(
                    "https://api.jup.ag/trigger/v1/createOrder",
                    createPayload,
                    { headers: getJupiterHeaders() }
                );

                const requestId = createRes.data?.requestId;
                const orderId = createRes.data?.order;
                const txBase64 = createRes.data?.transaction;

                if (!requestId || !txBase64) {
                    const errorMsg = createRes.data?.error || createRes.data?.cause || "Unknown error";
                    return bot.sendMessage(chatId, `❌ Failed to create order.\n\n${errorMsg}`, {
                        parse_mode: "Markdown"
                    });
                }

                // Store pending order for execution
                pendingOrders.set(requestId, {
                    chatId: String(chatId),
                    transaction: txBase64,
                    inputMint: orderData.inputMint,
                    outputMint: orderData.outputMint,
                    amount: orderData.amount,
                    targetPrice: orderData.targetPrice,
                    orderId,
                    requestId
                });

                const inputTokenInfo = await getTokenInfoV2(orderData.inputMint);
                const outputTokenInfo = await getTokenInfoV2(orderData.outputMint);
                
                const orderMessage = `✅ *Order Created Successfully!*\n\n` +
                    `📥 Input: ${orderData.amount} ${inputTokenInfo?.symbol || orderData.inputMint.slice(0, 4)}\n` +
                    `📤 Output: ${outputTokenInfo?.symbol || orderData.outputMint.slice(0, 4)}\n` +
                    `💰 Target Price: $${orderData.targetPrice}\n` +
                    `🆔 Request ID: \`${requestId}\`\n\n` +
                    `⚠️ *Order is ready but not executed yet.*\n` +
                    `Click the button below to execute:`;

                return await bot.sendMessage(chatId, orderMessage, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "🚀 Execute Order", callback_data: `execute_order_${requestId}` }
                        ]]
                    }
                });

            } catch (err) {
                console.error("Create order error:", err?.response?.data || err.message);
                const errorMsg = err?.response?.data?.error || err?.response?.data?.cause || err.message;
                return bot.sendMessage(chatId, `❌ Failed to create trigger order.\n\n${errorMsg}`, {
                    parse_mode: "Markdown"
                });
            }
        }

        // Handle trigger order cancellation (before creation)
        if (data.startsWith('cancel_trigger_')) {
            const orderHash = data.replace('cancel_trigger_', '');
            pendingOrders.delete(orderHash);
            return bot.sendMessage(chatId, "❌ Order creation cancelled.");
        }

        // Handle order execution
        if (data.startsWith('execute_order_')) {
            const requestId = data.replace('execute_order_', '');
            const orderData = pendingOrders.get(requestId);
            
            if (!orderData) {
                return bot.sendMessage(chatId, "❌ Order not found. It may have expired or already been executed.");
            }

            try {
                // Load wallet and sign transaction
                const keypair = await loadUserWallet(String(chatId));
                if (!keypair) {
                    return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
                }

                // Sign the transaction
                const signedTxBase64 = await signAndSendTransaction(orderData.transaction, keypair);

                // Execute the signed transaction
                const execRes = await axios.post("https://api.jup.ag/trigger/v1/execute", {
                    signedTransaction: signedTxBase64,
                    requestId: requestId
                }, {
                    headers: getJupiterHeaders()
                });

                const { signature, status } = execRes.data;

                // Save trigger history
                const username = query.from.username || null;
                await saveTriggerHistory(String(chatId), orderData.inputMint, orderData.outputMint, orderData.amount, orderData.targetPrice, orderData.orderId || requestId, username);

                // Remove from pending orders
                pendingOrders.delete(requestId);

                return bot.sendMessage(chatId, `✅ *Order Executed Successfully!*\n\n🆔 Order ID: \`${orderData.orderId || requestId}\`\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
                    parse_mode: "Markdown"
                });
            } catch (err) {
                console.error("Execute order error:", err?.response?.data || err.message);
                const errorMsg = err?.response?.data?.error || err?.response?.data?.cause || err.message;
                return bot.sendMessage(chatId, `❌ Failed to execute order.\n\n${errorMsg}`, {
                    parse_mode: "Markdown"
                });
            }
        }

        // Handle recurring order confirmation
        if (data.startsWith('confirm_recurring_')) {
            const orderHash = data.replace('confirm_recurring_', '');
            let orderData = pendingRecurringOrders.get(orderHash);
            
            // Try global as fallback
            if (!orderData && global.pendingRecurringOrders) {
                orderData = global.pendingRecurringOrders.get(orderHash);
            }
            
            if (!orderData) {
                return bot.sendMessage(chatId, "❌ Order data not found. Please try again.");
            }
            
            const walletRecord = await getWallet(String(chatId));
            if (!walletRecord) {
                return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
            }
            
            const wallet = walletRecord.publicKey;
            userWalletMap.set(String(chatId), wallet);

            try {
                // Convert total amount to raw amount (assuming USDC with 6 decimals)
                const inAmount = Math.floor(orderData.totalAmount * 1e6);

                const createPayload = {
                    user: wallet,
                    inputMint: orderData.inputMint,
                    outputMint: orderData.outputMint,
                    params: {
                        time: {
                            inAmount: inAmount.toString(),
                            numberOfOrders: orderData.numberOfOrders,
                            interval: orderData.intervalSeconds,
                            minPrice: null,
                            maxPrice: null,
                            startAt: null
                        }
                    }
                };

                const createRes = await axios.post(
                    "https://api.jup.ag/recurring/v1/createOrder",
                    createPayload,
                    { headers: getJupiterHeaders() }
                );

                const requestId = createRes.data?.requestId;
                const txBase64 = createRes.data?.transaction;

                if (!requestId || !txBase64) {
                    const errorMsg = createRes.data?.error || createRes.data?.status || "Unknown error";
                    return bot.sendMessage(chatId, `❌ Failed to create recurring order.\n\n${errorMsg}`, {
                        parse_mode: "Markdown"
                    });
                }

                // Store pending order for execution
                pendingRecurringOrders.set(requestId, {
                    chatId: String(chatId),
                    transaction: txBase64,
                    inputMint: orderData.inputMint,
                    outputMint: orderData.outputMint,
                    inAmount: orderData.totalAmount,
                    numberOfOrders: orderData.numberOfOrders,
                    intervalSeconds: orderData.intervalSeconds,
                    requestId
                });

                const inputTokenInfo = await getTokenInfoV2(orderData.inputMint);
                const outputTokenInfo = await getTokenInfoV2(orderData.outputMint);
                const amountPerOrder = orderData.totalAmount / orderData.numberOfOrders;
                const intervalDays = orderData.intervalSeconds / 86400;
                
                const orderMessage = `✅ *Recurring Order Created Successfully!*\n\n` +
                    `📥 Input: ${orderData.totalAmount} ${inputTokenInfo?.symbol || orderData.inputMint.slice(0, 4)}\n` +
                    `📤 Output: ${outputTokenInfo?.symbol || orderData.outputMint.slice(0, 4)}\n` +
                    `📊 Number of Orders: ${orderData.numberOfOrders}\n` +
                    `💰 Amount per Order: ${amountPerOrder.toFixed(2)} ${inputTokenInfo?.symbol || 'USD'}\n` +
                    `⏰ Interval: Every ${intervalDays} day(s)\n` +
                    `🆔 Request ID: \`${requestId}\`\n\n` +
                    `⚠️ *Order is ready but not executed yet.*\n` +
                    `Click the button below to execute:`;

                return await bot.sendMessage(chatId, orderMessage, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "🚀 Execute Order", callback_data: `execute_recurring_${requestId}` }
                        ]]
                    }
                });

            } catch (err) {
                console.error("Create recurring order error:", err?.response?.data || err.message);
                const errorMsg = err?.response?.data?.error || err?.response?.data?.status || err.message;
                return bot.sendMessage(chatId, `❌ Failed to create recurring order.\n\n${errorMsg}`, {
                    parse_mode: "Markdown"
                });
            }
        }

        // Handle recurring order cancellation (before creation)
        if (data.startsWith('cancel_recurring_') && !data.includes('_order_')) {
            const orderHash = data.replace('cancel_recurring_', '');
            pendingRecurringOrders.delete(orderHash);
            if (global.pendingRecurringOrders) {
                global.pendingRecurringOrders.delete(orderHash);
            }
            return bot.sendMessage(chatId, "❌ Recurring order creation cancelled.");
        }

        // Handle recurring order execution
        if (data.startsWith('execute_recurring_')) {
            const requestId = data.replace('execute_recurring_', '');
            const orderData = pendingRecurringOrders.get(requestId);
            
            if (!orderData) {
                return bot.sendMessage(chatId, "❌ Order not found. It may have expired or already been executed.");
            }

            try {
                // Load wallet and sign transaction
                const keypair = await loadUserWallet(String(chatId));
                if (!keypair) {
                    return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
                }

                // Sign the transaction
                const signedTxBase64 = await signAndSendTransaction(orderData.transaction, keypair);

                // Execute the signed transaction
                const execRes = await axios.post("https://api.jup.ag/recurring/v1/execute", {
                    signedTransaction: signedTxBase64,
                    requestId: requestId
                }, {
                    headers: getJupiterHeaders()
                });

                const { signature, status, order } = execRes.data;

                // Save recurring history
                const username = query.from.username || null;
                await saveRecurringHistory(String(chatId), orderData.inputMint, orderData.outputMint, orderData.inAmount, orderData.numberOfOrders, orderData.intervalSeconds, order || requestId, username);

                // Remove from pending orders
                pendingRecurringOrders.delete(requestId);

                return bot.sendMessage(chatId, `✅ *Recurring Order Executed Successfully!*\n\n🆔 Order ID: \`${order || requestId}\`\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
                    parse_mode: "Markdown"
                });
            } catch (err) {
                console.error("Execute recurring order error:", err?.response?.data || err.message);
                const errorMsg = err?.response?.data?.error || err?.response?.data?.status || err.message;
                return bot.sendMessage(chatId, `❌ Failed to execute recurring order.\n\n${errorMsg}`, {
                    parse_mode: "Markdown"
                });
            }
        }

        // Handle recurring order cancellation (for active orders)
        if (data.startsWith('cancel_recurring_order_')) {
            const orderId = data.replace('cancel_recurring_order_', '');
            
            // Load wallet from database
            const walletRecord = await getWallet(String(chatId));
            if (!walletRecord) {
                return bot.sendMessage(chatId, "❌ Missing wallet. Use /createwallet first.");
            }
            
            const wallet = walletRecord.publicKey;
            userWalletMap.set(String(chatId), wallet);

            try {
                const cancelPayload = {
                    user: wallet,
                    order: orderId
                };

                const cancelRes = await axios.post("https://api.jup.ag/recurring/v1/cancelOrder", cancelPayload, {
                    headers: getJupiterHeaders()
                });

                const txBase64 = cancelRes.data?.transaction;
                if (!txBase64) {
                    return bot.sendMessage(chatId, "❌ Failed to get cancellation transaction.");
                }

                // Load wallet and sign transaction
                const keypair = await loadUserWallet(String(chatId));
                if (!keypair) {
                    return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
                }

                // Sign the transaction
                const signedTxBase64 = await signAndSendTransaction(txBase64, keypair);

                // Execute the signed transaction
                const execRes = await axios.post("https://api.jup.ag/recurring/v1/execute", {
                    signedTransaction: signedTxBase64,
                    requestId: orderId
                }, {
                    headers: getJupiterHeaders()
                });

                const { signature, status } = execRes.data;

                return bot.sendMessage(chatId, `✅ *Recurring Order Cancelled!*\n\n🆔 Order ID: \`${orderId}\`\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
                    parse_mode: "Markdown"
                });
            } catch (err) {
                console.error("Cancel recurring order error:", err?.response?.data || err.message);
                const errorMsg = err?.response?.data?.error || err?.response?.data?.status || err.message;
                return bot.sendMessage(chatId, `❌ Failed to cancel recurring order.\n\n${errorMsg}`, {
                    parse_mode: "Markdown"
                });
            }
        }

        // Handle trigger order cancellation (for active orders)
        if (data.startsWith('cancel_')) {
            const orderId = data.replace('cancel_', '');
            
            // Load wallet from database
            const walletRecord = await getWallet(String(chatId));
            if (!walletRecord) {
                return bot.sendMessage(chatId, "❌ Missing wallet. Use /createwallet first.");
            }
            
            const wallet = walletRecord.publicKey;
            userWalletMap.set(String(chatId), wallet);

            const cancelPayload = {
                maker: wallet,
                order: orderId,
                computeUnitPrice: "auto"
            };

            const cancelRes = await axios.post("https://api.jup.ag/trigger/v1/cancelOrder", cancelPayload, {
                headers: getJupiterHeaders()
            });

            const txBase64 = cancelRes.data?.transaction;
            if (!txBase64) {
                return bot.sendMessage(chatId, "❌ Failed to get cancellation transaction.");
            }

            try {
                // Load wallet and sign transaction
                const keypair = await loadUserWallet(String(chatId));
                if (!keypair) {
                    return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
                }

                // Sign the transaction (it's already base64)
                const signedTxBase64 = await signAndSendTransaction(txBase64, keypair);

                // Execute the signed transaction
                const execRes = await axios.post("https://api.jup.ag/trigger/v1/execute", {
                    signedTransaction: signedTxBase64,
                    requestId: orderId
                }, {
                    headers: getJupiterHeaders()
                });

                const { signature, status } = execRes.data;

                return bot.sendMessage(chatId, `✅ *Order Cancelled!*\n\n🆔 Order ID: \`${orderId}\`\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
                    parse_mode: "Markdown"
                });
            } catch (err) {
                console.error("Cancel order error:", err);
                return bot.sendMessage(chatId, `❌ Failed to cancel order: ${err.message}`);
            }
        }

        return bot.sendMessage(chatId, "⚠️ Unknown action.");
    } catch (err) {
        console.error("Callback Query Error:", err?.response?.data || err.message);
        return bot.sendMessage(chatId, "❌ Something went wrong while processing your request.");
    }
});

//NLP intent parsing and message handling
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const rawText = msg.text;
    if (!rawText || rawText.startsWith('/')) return;

    const text = rawText.toLowerCase().trim();

    // Ignore regular commands like /start
    if (text.startsWith('/')) return;

    try {
        const intent = await parseIntent(text);
        
        // Use the new command handler for all NLP-based commands
        await handleNLPCommand(bot, msg, intent, userWalletMap, toLamports, notifyWatchers);
    } catch (err) {
        console.error('NLP parse failed:', err);
        bot.sendMessage(chatId, "⚠️ NLP parsing failed. Try again.");
    }
});

app.get('/', (req, res) => {
    res.send('Telegram Bot is running!');
});

// History command
bot.onText(/\/history(.*)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const username = msg.from.username || null;
    const type = match[1].trim() || 'all';
    
    try {
        const history = await getHistory(chatId, type, 10);
        
        if (history.length === 0) {
            return bot.sendMessage(chatId, `📭 No ${type === 'all' ? '' : type + ' '}history found.`);
        }

        let historyText = `🔢 *Your ${type === 'all' ? 'Recent Activity' : type + ' History'}*\n\n`;
        
        history.forEach((item, index) => {
            const date = new Date(item.timestamp).toLocaleString();
            const typeIcon = {
                'route': '🔀',
                'trigger': '⚡',
                'recurring': '🔄',
                'payment': '💸',
                'price': '💰',
                'notification': '🔔'
            }[item.type] || '📝';

            switch (item.type) {
                case 'route':
                    historyText += `${typeIcon} *Route Query* (${date})\n`;
                    historyText += `   ${item.inputMint?.slice(0, 4)}... → ${item.outputMint?.slice(0, 4)}...\n`;
                    historyText += `   Amount: ${item.amount}\n\n`;
                    break;
                    
                case 'trigger':
                    historyText += `${typeIcon} *Trigger Order* (${date})\n`;
                    historyText += `   ${item.inputMint?.slice(0, 4)}... → ${item.outputMint?.slice(0, 4)}...\n`;
                    historyText += `   Amount: ${item.amount} | Target: $${item.targetPrice}\n`;
                    historyText += `   Status: ${item.status} | Order: ${item.orderId?.slice(0, 8)}...\n\n`;
                    break;
                    
                case 'recurring':
                    historyText += `${typeIcon} *Recurring Order* (${date})\n`;
                    historyText += `   ${item.inputMint?.slice(0, 4)}... → ${item.outputMint?.slice(0, 4)}...\n`;
                    historyText += `   Total: ${item.inAmount} | Orders: ${item.numberOfOrders} | Interval: ${Math.floor(item.interval / 86400)} day(s)\n`;
                    historyText += `   Status: ${item.status} | Order: ${item.orderId?.slice(0, 8)}...\n\n`;
                    break;
                    
                case 'payment':
                    historyText += `${typeIcon} *Payment* (${date})\n`;
                    historyText += `   Type: ${item.type === 'receive' ? 'Received' : 'Sent'}\n`;
                    historyText += `   Amount: ${item.amount / 1e6} USDC\n`;
                    if (item.walletAddress) {
                        historyText += `   Wallet: ${item.walletAddress.slice(0, 8)}...\n`;
                    }
                    historyText += '\n';
                    break;
                    
                case 'price':
                    historyText += `${typeIcon} *Price Check* (${date})\n`;
                    historyText += `   Token: ${item.token?.slice(0, 4)}...\n`;
                    historyText += `   Price: $${item.price}\n\n`;
                    break;
                    
                case 'notification':
                    historyText += `${typeIcon} *Notification* (${date})\n`;
                    historyText += `   Token: ${item.token?.slice(0, 4)}...\n`;
                    historyText += `   Condition: ${item.condition} $${item.targetPrice}\n`;
                    historyText += `   Status: ${item.status}\n\n`;
                    break;
                    
                default:
                    historyText += `${typeIcon} *Activity* (${date})\n\n`;
            }
        });

        bot.sendMessage(chatId, historyText, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('History command error:', error);
        bot.sendMessage(chatId, '❌ Failed to fetch history. Please try again.');
    }
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await closeDatabase();
    process.exit(0);
});

