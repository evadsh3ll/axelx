import { getWalletBalance } from '../commands/balance.js';
import { resolveTokenMint } from '../utils/tokens.js';
import { 
    parsePriceIntent, 
    parseRouteIntent, 
    parseTriggerIntent,
    parseRecurringIntent,
    parsePaymentIntent, 
    parseNotificationIntent 
} from '../nlp.js';
import { 
    getWallet,
    savePriceCheckHistory, 
    saveRouteHistory, 
    saveTriggerHistory,
    saveRecurringHistory,
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
                const routeResult = await executeRouteCommand(bot, chatId, inputMint, outputMint, amountInLamports.toString(), userWalletMap, username);
                
                return routeResult;

            case 'trigger_swap':
                const triggerParams = await parseTriggerIntent(text);
                if (!triggerParams) {
                    return bot.sendMessage(chatId, "❌ Could not parse trigger parameters. Please specify input token, output token, amount, and target price.");
                }
                
                // Show confirmation button
                const triggerInputMint = resolveTokenMint(triggerParams.inputMint);
                const triggerOutputMint = resolveTokenMint(triggerParams.outputMint);
                const triggerAmount = triggerParams.amount;
                const targetPrice = triggerParams.targetPrice;
                
                // Create a unique hash for this order request
                const orderHash = Buffer.from(`${chatId}_${Date.now()}_${triggerAmount}_${targetPrice}`).toString('base64').slice(0, 16);
                
            // Store pending order details temporarily
            // Note: pendingOrders should be passed from index.js or use global
            if (!global.pendingOrders) global.pendingOrders = new Map();
            global.pendingOrders.set(orderHash, {
                    chatId,
                    inputMint: triggerInputMint,
                    outputMint: triggerOutputMint,
                    amount: triggerAmount,
                    targetPrice,
                    username
                });
                
                // Get token info for display
                const inputTokenInfo = await getTokenInfoV2(triggerInputMint);
                const outputTokenInfo = await getTokenInfoV2(triggerOutputMint);
                
                const confirmMessage = `⚡ *Trigger Order Confirmation*\n\n` +
                    `📥 Input: ${triggerAmount} ${inputTokenInfo?.symbol || triggerInputMint.slice(0, 4)}\n` +
                    `📤 Output: ${outputTokenInfo?.symbol || triggerOutputMint.slice(0, 4)}\n` +
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

            case 'recurring_order':
                const recurringParams = await parseRecurringIntent(text);
                if (!recurringParams) {
                    return bot.sendMessage(chatId, "❌ Could not parse recurring order parameters. Please specify input token, output token, total amount, number of orders, and interval (e.g., 'recurring order 1000 USDC to SOL 10 orders every day').");
                }
                
                // Show confirmation button (similar to trigger)
                const recurringInputMint = resolveTokenMint(recurringParams.inputMint);
                const recurringOutputMint = resolveTokenMint(recurringParams.outputMint);
                const recurringTotalAmount = recurringParams.totalAmount;
                const recurringNumberOfOrders = recurringParams.numberOfOrders;
                const recurringIntervalDays = recurringParams.intervalDays;
                
                // Validate minimums
                const amountPerOrder = recurringTotalAmount / recurringNumberOfOrders;
                if (recurringTotalAmount < 100) {
                    return bot.sendMessage(chatId, "❌ Minimum total amount is 100 USD.");
                }
                if (amountPerOrder < 50) {
                    return bot.sendMessage(chatId, `❌ Minimum amount per order is 50 USD. With ${recurringNumberOfOrders} orders, you need at least ${recurringNumberOfOrders * 50} USD total.`);
                }
                
                // Create a unique hash for this order request
                const recurringOrderHash = Buffer.from(`${chatId}_${Date.now()}_${recurringTotalAmount}_${recurringNumberOfOrders}`).toString('base64').slice(0, 16);
                
                // Store pending order details temporarily
                if (!global.pendingRecurringOrders) global.pendingRecurringOrders = new Map();
                global.pendingRecurringOrders.set(recurringOrderHash, {
                    chatId,
                    inputMint: recurringInputMint,
                    outputMint: recurringOutputMint,
                    totalAmount: recurringTotalAmount,
                    numberOfOrders: recurringNumberOfOrders,
                    intervalSeconds: Math.floor(recurringIntervalDays * 86400),
                    username
                });
                
                // Get token info for display
                const recurringInputTokenInfo = await getTokenInfoV2(recurringInputMint);
                const recurringOutputTokenInfo = await getTokenInfoV2(recurringOutputMint);
                
                const recurringConfirmMessage = `🔄 *Recurring Order Confirmation*\n\n` +
                    `📥 Input: ${recurringTotalAmount} ${recurringInputTokenInfo?.symbol || recurringInputMint.slice(0, 4)}\n` +
                    `📤 Output: ${recurringOutputTokenInfo?.symbol || recurringOutputMint.slice(0, 4)}\n` +
                    `📊 Number of Orders: ${recurringNumberOfOrders}\n` +
                    `💰 Amount per Order: ${amountPerOrder.toFixed(2)} ${recurringInputTokenInfo?.symbol || 'USD'}\n` +
                    `⏰ Interval: Every ${recurringIntervalDays} day(s)\n` +
                    `📅 Total Duration: ${(recurringNumberOfOrders * recurringIntervalDays).toFixed(1)} days\n\n` +
                    `⚠️ *Requirements:*\n` +
                    `• Minimum total: 100 USD\n` +
                    `• Minimum per order: 50 USD\n` +
                    `• Minimum orders: 2\n\n` +
                    `Please confirm to create this recurring order:`;
                
                return bot.sendMessage(chatId, recurringConfirmMessage, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "✅ Confirm & Create Order", callback_data: `confirm_recurring_${recurringOrderHash}` },
                            { text: "❌ Cancel", callback_data: `cancel_recurring_${recurringOrderHash}` }
                        ]]
                    }
                });

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
                return bot.sendMessage(chatId, `🤔 Sorry, I didn't understand that.\n\nTry saying:\n• "create wallet"\n• "what's my balance?"\n• "get price of SOL"\n• "get route for 1 SOL to USDC"\n• "trigger 1 SOL to USDC at $50"\n• "recurring order 1000 USDC to SOL 10 orders every day"`);
        }
    } catch (err) {
        console.error('NLP command handling error:', err);
        return bot.sendMessage(chatId, "⚠️ Something went wrong while processing your request. Please try again.");
    }
}

// Helper functions to execute the actual commands
async function executeRouteCommand(bot, chatId, inputMint, outputMint, amount, userWalletMap, username = null) {
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

    // Save route history
    await saveRouteHistory(chatId, inputMint, outputMint, amount, routeDetails, username);

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
        // Note: pendingOrders should be passed from index.js or use global
        if (!global.pendingOrders) global.pendingOrders = new Map();
        global.pendingOrders.set(requestId, {
            chatId,
            transaction: txBase64,
            inputMint,
            outputMint,
            amount,
            targetPrice,
            orderId,
            requestId
        });

        const inputTokenInfo = await getTokenInfoV2(inputMint);
        const outputTokenInfo = await getTokenInfoV2(outputMint);
        
        const orderMessage = `✅ *Order Created Successfully!*\n\n` +
            `📥 Input: ${amount} ${inputTokenInfo?.symbol || inputMint.slice(0, 4)}\n` +
            `📤 Output: ${outputTokenInfo?.symbol || outputMint.slice(0, 4)}\n` +
            `💰 Target Price: $${targetPrice}\n` +
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
        console.error("Trigger error:", err?.response?.data || err.message);
        const errorMsg = err?.response?.data?.error || err?.response?.data?.cause || err.message;
        return bot.sendMessage(chatId, `❌ Failed to create trigger order.\n\n${errorMsg}`, {
            parse_mode: "Markdown"
        });
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

        // Check immediately on first attempt
        const shouldNotifyNow =
            (condition === "above" && currentPrice >= price) ||
            (condition === "below" && currentPrice <= price);

        if (shouldNotifyNow) {
            await bot.sendMessage(chatId,
                `📊 *${tokenInfo.name}* (${tokenInfo.symbol})\n` +
                `💵 Current Price: $${currentPrice.toFixed(6)}\n\n` +
                `🎯 *Price target already reached!*\n` +
                `Target: *${condition}* $${price}\n\n` +
                `💬 Do you want to *buy it*, *trigger it*, or just *get notified*?`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        await bot.sendMessage(chatId,
            `📊 *${tokenInfo.name}* (${tokenInfo.symbol})\n` +
            `💵 Current Price: $${currentPrice.toFixed(6)}\n\n` +
            `🔔 Monitoring for price *${condition}* $${price}\n` +
            `✅ Notification active! Checking every 2 seconds...`,
            { parse_mode: "Markdown" }
        );

        // Set up the notification monitoring
        if (!notifyWatchers[chatId]) notifyWatchers[chatId] = [];

        const intervalId = setInterval(async () => {
            try {
                const priceNow = await getTokenPrice(tokenInfo.id);
                
                if (!priceNow || isNaN(priceNow)) {
                    console.error(`Failed to fetch price for ${tokenInfo.symbol} (${tokenInfo.id})`);
                    return;
                }

                console.log(`[Notify] ${tokenInfo.symbol}: $${priceNow} (target: ${condition} $${price})`);

                const shouldNotify =
                    (condition === "above" && priceNow >= price) ||
                    (condition === "below" && priceNow <= price);

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
        return bot.sendMessage(chatId, "⚠️ Failed to fetch token info. Please check the token name.");
    }
}