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
/trigger <input> <output> <amount> <price> - Create limit order
/receivepayment <amount> - Generate payment request
/payto <wallet> <amount> - Pay to specific wallet
/notify <token> <above/below> <price> - Set price alerts
/history [type] - Show your activity history

*Natural Language Commands (Auto-Execute):*
• "create wallet" → Executes /createwallet
• "what's my balance?" → Executes /about
• "get price of SOL" → Executes /price SOL
• "get route for 1 SOL to USDC" → Executes /route SOL USDC 1
• "trigger 1 SOL to USDC at $50" → Executes /trigger SOL USDC 1 50
• "receive payment of 10 USDC" → Executes /receivepayment 10000000
• "pay 5 USDC to [wallet]" → Executes /payto [wallet] 5000000
• "notify me when SOL goes above $100" → Executes /notify SOL above 100

*Examples (All Auto-Execute):*
• "I want to create a wallet"
• "Show me the price of Bitcoin"
• "Get me a route for 2 SOL to USDC"
• "Create a trigger order for 1 SOL to USDC at $45"
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

    if (args[0] === 'orders') {
        const res = await axios.get(`https://api.jup.ag/trigger/v1/getTriggerOrders?user=${wallet}&orderStatus=active`, {
            headers: getJupiterHeaders()
        });
        if (!res.data.length) return bot.sendMessage(chatId, "📭 No active orders.");
        const orders = res.data.map(o => `• 🆔 ${o.order} (${o.params.makingAmount} → ${o.params.takingAmount})`);
        return bot.sendMessage(chatId, `📋 *Active Orders*\n\n${orders.join('\n')}`, { parse_mode: "Markdown" });
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
        return bot.sendMessage(chatId, `⚠️ Usage:\n/trigger <inputMint> <outputMint> <amount> <targetPrice>\n/trigger orders\n/trigger orderhistory\n/trigger cancelorder`);
    }

    const [inputMintName, outputMintName, amountStr, targetPriceStr] = args;
    const inputMint = resolveTokenMint(inputMintName);
    const outputMint = resolveTokenMint(outputMintName);
    console.log(inputMint,outputMint)
    const amount = parseFloat(amountStr);
    const targetPrice = parseFloat(targetPriceStr);

    if (isNaN(amount) || isNaN(targetPrice)) {
        return bot.sendMessage(chatId, "❌ Invalid amount or price.");
    }

    try {
        // 1. Create the order
        const createPayload = {
            inputMint,
            outputMint,
            maker: wallet,
            payer: wallet,
            params: {
                makingAmount:(await toLamports({ sol: amount })).toString(),
                takingAmount: (await toLamports({ usd: amount * targetPrice })).toString()
            },
            computeUnitPrice: "auto"
        };

        const createRes = await axios.post(
            "https://api.jup.ag/trigger/v1/createOrder",
            createPayload,
            { headers: getJupiterHeaders() }
        );

        const orderId = createRes.data?.requestId;
        const txBase58 = createRes.data?.transaction;

        if (!orderId || !txBase58) {
            return bot.sendMessage(chatId, "⚠️ Failed to create order.");
        }

        // Load wallet and sign transaction
        const keypair = await loadUserWallet(chatId);
        if (!keypair) {
            return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
        }

        // Convert base58 transaction to base64 and sign
        const txBuffer = bs58.decode(txBase58);
        const signedTxBase64 = await signAndSendTransaction(txBuffer.toString('base64'), keypair);

        // Execute the signed transaction
        const execRes = await axios.post("https://api.jup.ag/trigger/v1/execute", {
            signedTransaction: signedTxBase64,
            requestId: orderId
        }, {
            headers: getJupiterHeaders()
        });

        const { signature, status } = execRes.data;

        // Save trigger history
        await saveTriggerHistory(chatId, inputMint, outputMint, amount, targetPrice, orderId, username);

        await bot.sendMessage(chatId, `✅ *Limit order created and executed!*\n\n🆔 Order ID: \`${orderId}\`\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
            parse_mode: "Markdown"
        });

    } catch (err) {
        console.error("Trigger error:", err?.response?.data || err.message);
        bot.sendMessage(chatId, `❌ Failed to create trigger: ${err.message}`);
    }
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

        await bot.sendMessage(chatId,
            `📊 *${tokenInfo.name}* (${tokenInfo.symbol})\n` +
            `💵 Current Price: $${currentPrice.toFixed(6)}\n\n` +
            `🔔 Monitoring for price *${condition}* $${targetPrice}`,
            { parse_mode: "Markdown" }
        );

        if (!notifyWatchers[chatId]) notifyWatchers[chatId] = [];

        const intervalId = setInterval(async () => {
            try {
                const priceNow = await getTokenPrice(tokenInfo.id);
                
                if (!priceNow) {
                    console.error(`Failed to fetch price for ${tokenInfo.symbol}`);
                    return;
                }

                console.log(`Current price for ${tokenInfo.symbol}: $${priceNow}`);

                const shouldNotify =
                    (condition === "above" && priceNow >= targetPrice) ||
                    (condition === "below" && priceNow <= targetPrice);

                if (shouldNotify) {
                    bot.sendMessage(chatId, `🎯 *${tokenInfo.symbol}* is now at $${priceNow.toFixed(4)}!\n\n💬 Do you want to *buy it*, *trigger it*, or just *get notified*?`, {
                        parse_mode: "Markdown"
                    });

                    clearInterval(intervalId);
                }
            } catch (err) {
                console.error(`Polling error: ${err.message}`);
            }
        }, 10000);

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

            const txBase58 = cancelRes.data?.transaction;
            if (!txBase58) {
                return bot.sendMessage(chatId, "❌ Failed to get cancellation transaction.");
            }

            try {
                // Load wallet and sign transaction
                const keypair = await loadUserWallet(String(chatId));
                if (!keypair) {
                    return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
                }

                // Convert base58 transaction to base64 and sign
                const txBuffer = bs58.decode(txBase58);
                const signedTxBase64 = await signAndSendTransaction(txBuffer.toString('base64'), keypair);

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

