import { getWalletBalance } from '../commands/balance.js';
import { resolveTokenMint } from '../utils/tokens.js';
import { 
    parsePriceIntent, 
    parseRouteIntent, 
    parseTriggerIntent, 
    parsePaymentIntent, 
    parseNotificationIntent 
} from '../nlp.js';
import { 
    getWallet,
    savePriceCheckHistory, 
    saveRouteHistory, 
    saveTriggerHistory, 
    savePaymentHistory, 
    saveNotificationHistory,
    updateLastActivity 
} from '../utils/database.js';
import { loadWallet } from '../utils/wallet.js';
import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getJupiterHeaders, getTokenInfoV2, getTokenPrice } from '../utils/jupiterApi.js';
import bs58 from 'bs58';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const WALLET_SECRET = process.env.WALLET_SECRET;

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

export async function handleNLPCommand(bot, msg, intent, userWalletMap, toLamports, notifyWatchers) {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    const username = msg.from.username || null;

    // Update last activity
    await updateLastActivity(chatId);

    try {
        switch (intent) {
            case 'connect_wallet':
            case 'create_wallet':
                return bot.sendMessage(chatId, "💡 Use /createwallet to create your in-app wallet.");

            case 'export_wallet': {
                const walletRecord = await getWallet(chatId);
                if (!walletRecord || !walletRecord.encryptedPrivateKey) {
                    return bot.sendMessage(chatId, "❌ No wallet found. Use /createwallet to create one.");
                }

                try {
                    const keypair = await loadUserWallet(chatId);
                    if (!keypair) {
                        return bot.sendMessage(chatId, "❌ Failed to load wallet. Please try /createwallet again.");
                    }
                    
                    const privateKey = bs58.encode(keypair.secretKey);

                    const message = `🔑 *Your Wallet Private Key*

📝 *Public Key:*
\`${walletRecord.publicKey}\`

🔑 *Private Key:*
\`${privateKey}\`

⚠️ *Keep this private key secure. Anyone with access to it can control your wallet.*`;

                    return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                } catch (error) {
                    console.error("Export wallet error:", error);
                    return bot.sendMessage(chatId, "❌ Failed to export wallet. Please try again.");
                }
            }

            case 'about_wallet':
            case 'get_balance': {
                const walletRecord = await getWallet(chatId);
                if (!walletRecord) {
                    return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
                }
                const wallet = walletRecord.publicKey;
                userWalletMap.set(chatId, wallet);
                const balanceResult = await getWalletBalance(wallet);
                if (balanceResult.success) {
                    return bot.sendMessage(chatId, `💰 Your SOL Balance:\nBalance: ${balanceResult.balance} SOL\nFrozen: ${balanceResult.frozen}`);
                } else {
                    return bot.sendMessage(chatId, balanceResult.error);
                }
            }

            case 'get_price': {
                const tokenSymbol = await parsePriceIntent(text);
                if (!tokenSymbol) {
                    return bot.sendMessage(chatId, "❌ Could not identify the token. Please specify a token name or symbol.");
                }
                
                const tokenInfo = await getTokenInfoV2(tokenSymbol);
                
                if (!tokenInfo || !tokenInfo.price) {
                    return bot.sendMessage(chatId, "❌ Could not retrieve a valid price. Please check the token name or address.");
                }
                
                const msgText = `💰 *${tokenInfo.name}* (${tokenInfo.symbol})\n\n📈 Price: $${tokenInfo.price.toFixed(6)}${tokenInfo.mcap ? `\n💵 Market Cap: $${(tokenInfo.mcap / 1e9).toFixed(2)}B` : ''}${tokenInfo.isVerified ? '\n✅ Verified' : ''}`;
                
                // Save price check history
                await savePriceCheckHistory(chatId, tokenSymbol, tokenInfo.price, username);
                
                return bot.sendPhoto(chatId, tokenInfo.icon, {
                    caption: msgText,
                    parse_mode: "Markdown"
                });
            }

            case 'get_route':
                const routeParams = await parseRouteIntent(text);
                if (!routeParams) {
                    return bot.sendMessage(chatId, "❌ Could not parse route parameters. Please specify input token, output token, and amount.");
                }
                
                // Execute the route command
                const inputMint = resolveTokenMint(routeParams.inputMint);
                const outputMint = resolveTokenMint(routeParams.outputMint);
                const amountInLamports = await toLamports({ sol: routeParams.amount });
                
                // Call the route command logic
                const routeResult = await executeRouteCommand(bot, chatId, inputMint, outputMint, amountInLamports.toString(), userWalletMap);
                
                // Save route history
                await saveRouteHistory(chatId, inputMint, outputMint, routeParams.amount, "Route query executed", username);
                
                return routeResult;

            case 'trigger_swap':
                const triggerParams = await parseTriggerIntent(text);
                if (!triggerParams) {
                    return bot.sendMessage(chatId, "❌ Could not parse trigger parameters. Please specify input token, output token, amount, and target price.");
                }
                
                // Execute the trigger command
                const triggerInputMint = resolveTokenMint(triggerParams.inputMint);
                const triggerOutputMint = resolveTokenMint(triggerParams.outputMint);
                const triggerAmount = triggerParams.amount;
                const targetPrice = triggerParams.targetPrice;
                
                // Call the trigger command logic
                const triggerResult = await executeTriggerCommand(bot, chatId, triggerInputMint, triggerOutputMint, triggerAmount, targetPrice, userWalletMap, toLamports);
                
                // Save trigger history (we'll need to extract orderId from the result)
                if (triggerResult && triggerResult.includes('Order ID:')) {
                    const orderIdMatch = triggerResult.match(/Order ID: `([^`]+)`/);
                    const orderId = orderIdMatch ? orderIdMatch[1] : null;
                    await saveTriggerHistory(chatId, triggerInputMint, triggerOutputMint, triggerAmount, targetPrice, orderId, username);
                }
                
                return triggerResult;

            case 'receive_payment':
                const paymentParams = await parsePaymentIntent(text);
                if (!paymentParams || !paymentParams.amount) {
                    return bot.sendMessage(chatId, "❌ Could not parse payment amount. Please specify an amount.");
                }
                
                // Execute the receivepayment command
                const paymentAmount = paymentParams.amount * 1000000; // Convert to micro USDC
                const receiveResult = await executeReceivePaymentCommand(bot, chatId, paymentAmount, userWalletMap);
                
                // Save payment history
                await savePaymentHistory(chatId, paymentAmount, 'receive', null, username);
                
                return receiveResult;

            case 'pay_to':
                const payParams = await parsePaymentIntent(text);
                if (!payParams || !payParams.amount || !payParams.wallet) {
                    return bot.sendMessage(chatId, "❌ Could not parse payment parameters. Please specify amount and wallet address.");
                }
                
                // Execute the payto command
                const payAmount = payParams.amount * 1000000; // Convert to micro USDC
                const payResult = await executePayToCommand(bot, chatId, payParams.wallet, payAmount, userWalletMap);
                
                // Save payment history
                await savePaymentHistory(chatId, payAmount, 'send', payParams.wallet, username);
                
                return payResult;

            case 'get_tokens':
                // Execute the tokens command
                return await executeTokensCommand(bot, chatId);

            case 'get_notification':
                const notificationParams = await parseNotificationIntent(text);
                if (!notificationParams) {
                    return bot.sendMessage(chatId, "❌ Could not parse notification parameters. Please specify token, condition (above/below), and price.");
                }
                
                // Execute the notify command
                const notificationToken = resolveTokenMint(notificationParams.token);
                const notifyResult = await executeNotifyCommand(bot, chatId, notificationToken, notificationParams.condition, notificationParams.price, notifyWatchers);
                
                // Save notification history
                await saveNotificationHistory(chatId, notificationToken, notificationParams.condition, notificationParams.price, username);
                
                return notifyResult;

            default:
                return bot.sendMessage(chatId, `🤔 Sorry, I didn't understand that.\n\nTry saying:\n• "create wallet"\n• "what's my balance?"\n• "get price of SOL"\n• "get route for 1 SOL to USDC"\n• "trigger 1 SOL to USDC at $50"`);
        }
    } catch (err) {
        console.error('NLP command handling error:', err);
        return bot.sendMessage(chatId, "⚠️ Something went wrong while processing your request. Please try again.");
    }
}

// Helper functions to execute the actual commands
async function executeRouteCommand(bot, chatId, inputMint, outputMint, amount, userWalletMap) {
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ You must create your wallet first. Use /createwallet.");
    }
    
    const wallet = walletRecord.publicKey;
    userWalletMap.set(chatId, wallet);

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

        return await bot.sendMessage(chatId, routeDetails, { parse_mode: "Markdown" });
    } catch (err) {
        console.error("Signing/execution error:", err);
        return bot.sendMessage(chatId, `❌ Failed to sign and execute transaction: ${err.message}`);
    }
}

async function executeTriggerCommand(bot, chatId, inputMint, outputMint, amount, targetPrice, userWalletMap, toLamports) {
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ You haven't created your wallet yet. Use /createwallet first.");
    }
    
    const wallet = walletRecord.publicKey;
    userWalletMap.set(chatId, wallet);

    try {
        const createPayload = {
            inputMint,
            outputMint,
            maker: wallet,
            payer: wallet,
            params: {
                makingAmount: (await toLamports({ sol: amount })).toString(),
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

        return await bot.sendMessage(chatId, `✅ *Limit order created and executed!*\n\n🆔 Order ID: \`${orderId}\`\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
            parse_mode: "Markdown"
        });

    } catch (err) {
        console.error("Trigger error:", err?.response?.data || err.message);
        return bot.sendMessage(chatId, "❌ Failed to create trigger.");
    }
}

async function executeReceivePaymentCommand(bot, chatId, amount, userWalletMap) {
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ Please create wallet first using /createwallet.");
    }
    
    const merchantWallet = walletRecord.publicKey;
    userWalletMap.set(chatId, merchantWallet);

    try {
        const { PublicKey } = await import('@solana/web3.js');
        const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
        const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

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
                userPublicKey: merchantWallet,
                destinationTokenAccount: merchantUSDCATA.toBase58()
            })
        })).json();

        const message = `🧾 *Payment Request*

💰 Amount: ${amount / 1e6} USDC

📝 *Your Wallet Address:*
\`${merchantWallet}\`

💡 Share this address with the payer to receive payment.`;

        return await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

    } catch (err) {
        console.error("/receivepayment error:", err);
        return bot.sendMessage(chatId, "❌ Failed to generate payment link.");
    }
}

async function executePayToCommand(bot, chatId, merchantWallet, amount, userWalletMap) {
    // Load wallet from database
    const walletRecord = await getWallet(chatId);
    if (!walletRecord) {
        return bot.sendMessage(chatId, "❌ Please create wallet first using /createwallet.");
    }
    
    const payerWallet = walletRecord.publicKey;
    userWalletMap.set(chatId, payerWallet);

    try {
        const { PublicKey } = await import('@solana/web3.js');
        const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
        const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

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

        return await bot.sendMessage(chatId, `✅ *Payment Executed!*\n\n💸 Amount: ${amount / 1e6} USDC\n🔗 [View on Solscan](https://solscan.io/tx/${signature})\n📦 Status: *${status}*`, {
            parse_mode: "Markdown"
        });

    } catch (err) {
        console.error("/payto error:", err);
        return bot.sendMessage(chatId, "❌ Failed to generate payment transaction.");
    }
}

async function executeTokensCommand(bot, chatId) {
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

        return bot.sendMessage(chatId, '📊 *Top Trending Tokens (24h)*\n\nSelect a token to view details:', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: inlineKeyboard
            }
        });
    } catch (err) {
        console.error(err);
        return bot.sendMessage(chatId, '❌ Failed to fetch token list.');
    }
}

async function executeNotifyCommand(bot, chatId, tokenMint, condition, price, notifyWatchers) {
    try {
        const tokenInfo = await getTokenInfoV2(tokenMint);

        if (!tokenInfo || !tokenInfo.price) {
            return bot.sendMessage(chatId, "❌ Couldn't fetch valid token price.");
        }

        const currentPrice = tokenInfo.price;

        await bot.sendMessage(chatId,
            `📊 *${tokenInfo.name}* (${tokenInfo.symbol})\n` +
            `💵 Current Price: $${currentPrice.toFixed(6)}\n\n` +
            `🔔 Monitoring for price *${condition}* $${price}`,
            { parse_mode: "Markdown" }
        );

        // Set up the notification monitoring
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
                    (condition === "above" && priceNow >= price) ||
                    (condition === "below" && priceNow <= price);

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

        return bot.sendMessage(chatId, `✅ Notification set up successfully for ${tokenInfo.symbol} ${condition} $${price}`);

    } catch (err) {
        console.error("Notify command error:", err.message);
        return bot.sendMessage(chatId, "⚠️ Failed to fetch token info. Please check the token name.");
    }
}