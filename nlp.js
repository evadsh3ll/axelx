// nlp.js
import Groq from "groq-sdk";
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Parse user intent from natural language text
 * @param {string} text - User's message
 * @returns {Promise<string>} - Intent classification
 */
export async function parseIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are an intent classifier for a Solana DeFi Telegram bot with in-app wallet management. 

Analyze the user's message and return ONLY one of these exact intent names:
- "create_wallet" - User wants to create a new wallet (e.g., "create wallet", "make a wallet", "set up wallet")
- "export_wallet" - User wants to export/view their wallet private key (e.g., "export wallet", "show my private key", "get my wallet key")
- "about_wallet" or "get_balance" - User wants to check their balance (e.g., "what's my balance", "check balance", "show balance")
- "get_price" - User wants token price information (e.g., "price of SOL", "what's SOL worth", "show me SOL price")
- "get_route" - User wants a swap route/quote (e.g., "route for 1 SOL to USDC", "swap 2 SOL for USDC", "get route")
- "trigger_swap" - User wants to create a limit order (e.g., "trigger 1 SOL to USDC at $50", "limit order", "set trigger")
- "receive_payment" - User wants to receive payment (e.g., "receive 10 USDC", "get payment", "request payment")
- "pay_to" - User wants to send payment (e.g., "pay 5 USDC to [address]", "send payment", "transfer")
- "get_tokens" - User wants to see available tokens (e.g., "list tokens", "show tokens", "available tokens")
- "get_notification" - User wants price alerts (e.g., "notify when SOL goes above $100", "alert me", "set notification")
- "unknown" - Cannot determine intent

Rules:
1. Return ONLY the intent name, nothing else
2. Be case-sensitive - use exact names as shown
3. For wallet creation, prefer "create_wallet" over "connect_wallet"
4. If user mentions exporting/showing private key, use "export_wallet"
5. Balance checks can be either "about_wallet" or "get_balance"`

        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.3,
      max_tokens: 20
    });

    const intent = completion.choices[0]?.message?.content?.trim().toLowerCase();
    
    // Normalize common variations
    if (intent === "connect_wallet" || intent.includes("connect")) {
      return "create_wallet";
    }
    
    return intent || "unknown";
  } catch (error) {
    console.error("Error parsing intent:", error);
    return "unknown";
  }
}

/**
 * Extract token symbol/name from price query
 * @param {string} text - User's message
 * @returns {Promise<string>} - Token symbol in uppercase
 */
export async function parsePriceIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Extract the token name or symbol the user is asking the price for. 

Return ONLY the token symbol or name as plain text. Examples:
- "price of SOL" → "SOL"
- "what's Bitcoin worth" → "WBTC" or "BTC"
- "show me USDC price" → "USDC"
- "how much is Jupiter" → "JUP"
- "bonk price" → "BONK"

Common mappings:
- Bitcoin, BTC → "WBTC" (Wrapped Bitcoin on Solana)
- Ethereum, ETH → "WETH" (Wrapped Ethereum on Solana)
- Jupiter → "JUP"
- Solana → "SOL"

Return only the symbol, no sentences, no explanations.`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.2,
      max_tokens: 10
    });

    const token = completion.choices[0]?.message?.content?.trim().toUpperCase();
    return token || null;
  } catch (error) {
    console.error("Error parsing price intent:", error);
    return null;
  }
}

/**
 * Extract route/swap parameters from user message
 * @param {string} text - User's message
 * @returns {Promise<Object|null>} - Route parameters {inputMint, outputMint, amount}
 */
export async function parseRouteIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Extract swap/route parameters from the user's message. Return a valid JSON object with:
{
  "inputMint": "token symbol (e.g., SOL, USDC, JUP)",
  "outputMint": "token symbol (e.g., USDC, SOL, USDT)", 
  "amount": number (the amount of input token)
}

Examples:
- "get route for 1 SOL to USDC" → {"inputMint": "SOL", "outputMint": "USDC", "amount": 1}
- "swap 2.5 SOL for USDT" → {"inputMint": "SOL", "outputMint": "USDT", "amount": 2.5}
- "route 0.1 SOL to JUP" → {"inputMint": "SOL", "outputMint": "JUP", "amount": 0.1}

Important:
- Extract the numeric amount as a number (not string)
- Use uppercase token symbols
- Return ONLY valid JSON, no markdown, no code blocks
- If amount is missing, use 1 as default`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.2,
      max_tokens: 100
    });

    const result = completion.choices[0]?.message?.content?.trim();
    
    // Remove markdown code blocks if present
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(cleaned);
    
    // Validate and normalize
    if (!parsed.inputMint || !parsed.outputMint) {
      return null;
    }
    
    return {
      inputMint: parsed.inputMint.toUpperCase(),
      outputMint: parsed.outputMint.toUpperCase(),
      amount: parseFloat(parsed.amount) || 1
    };
  } catch (error) {
    console.error("Error parsing route intent:", error);
    return null;
  }
}

/**
 * Extract limit order/trigger parameters from user message
 * @param {string} text - User's message
 * @returns {Promise<Object|null>} - Trigger parameters {inputMint, outputMint, amount, targetPrice}
 */
export async function parseTriggerIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Extract limit order/trigger parameters from the user's message. Return a valid JSON object with:
{
  "inputMint": "token symbol (e.g., SOL, USDC)",
  "outputMint": "token symbol (e.g., USDC, SOL)",
  "amount": number (amount of input token),
  "targetPrice": number (target price in USD)
}

Examples:
- "trigger 1 SOL to USDC at $50" → {"inputMint": "SOL", "outputMint": "USDC", "amount": 1, "targetPrice": 50}
- "limit order 2 SOL for USDT when price is $45" → {"inputMint": "SOL", "outputMint": "USDT", "amount": 2, "targetPrice": 45}
- "set trigger for 0.5 SOL to JUP at $100" → {"inputMint": "SOL", "outputMint": "JUP", "amount": 0.5, "targetPrice": 100}

Important:
- Extract targetPrice as a number (remove $ sign)
- Extract amount as a number
- Use uppercase token symbols
- Return ONLY valid JSON, no markdown, no code blocks`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.2,
      max_tokens: 150
    });

    const result = completion.choices[0]?.message?.content?.trim();
    
    // Remove markdown code blocks if present
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(cleaned);
    
    // Validate required fields
    if (!parsed.inputMint || !parsed.outputMint || !parsed.amount || !parsed.targetPrice) {
      return null;
    }
    
    return {
      inputMint: parsed.inputMint.toUpperCase(),
      outputMint: parsed.outputMint.toUpperCase(),
      amount: parseFloat(parsed.amount),
      targetPrice: parseFloat(parsed.targetPrice)
    };
  } catch (error) {
    console.error("Error parsing trigger intent:", error);
    return null;
  }
}

/**
 * Extract payment parameters from user message
 * @param {string} text - User's message
 * @returns {Promise<Object|null>} - Payment parameters {amount, wallet?}
 */
export async function parsePaymentIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Extract payment parameters from the user's message. Return a valid JSON object with:
{
  "amount": number (amount in USDC),
  "wallet": "wallet address" (only if mentioned, otherwise omit this field)
}

Examples:
- "receive payment of 10 USDC" → {"amount": 10}
- "I want to receive 20 USDC" → {"amount": 20}
- "pay 5 USDC to ABC123xyz..." → {"amount": 5, "wallet": "ABC123xyz..."}
- "send 15 USDC to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" → {"amount": 15, "wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"}
- "transfer 3 USDC" → {"amount": 3}

Important:
- Extract amount as a number (not string)
- Wallet address is typically 32-44 characters (Solana addresses)
- If no wallet is mentioned, omit the "wallet" field
- Return ONLY valid JSON, no markdown, no code blocks`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.2,
      max_tokens: 100
    });

    const result = completion.choices[0]?.message?.content?.trim();
    
    // Remove markdown code blocks if present
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(cleaned);
    
    // Validate amount
    if (!parsed.amount || isNaN(parseFloat(parsed.amount))) {
      return null;
    }
    
    return {
      amount: parseFloat(parsed.amount),
      wallet: parsed.wallet || null
    };
  } catch (error) {
    console.error("Error parsing payment intent:", error);
    return null;
  }
}

/**
 * Extract price notification/alert parameters from user message
 * @param {string} text - User's message
 * @returns {Promise<Object|null>} - Notification parameters {token, condition, price}
 */
export async function parseNotificationIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Extract price alert/notification parameters from the user's message. Return a valid JSON object with:
{
  "token": "token symbol (e.g., SOL, USDC, JUP)",
  "condition": "above" or "below",
  "price": number (target price in USD)
}

Examples:
- "notify me when SOL goes above $100" → {"token": "SOL", "condition": "above", "price": 100}
- "alert when JUP drops below $0.5" → {"token": "JUP", "condition": "below", "price": 0.5}
- "notify if USDC goes above $1.10" → {"token": "USDC", "condition": "above", "price": 1.10}
- "tell me when BONK is below $0.00001" → {"token": "BONK", "condition": "below", "price": 0.00001}

Important:
- Condition must be exactly "above" or "below" (lowercase)
- Extract price as a number (remove $ sign)
- Use uppercase token symbols
- Return ONLY valid JSON, no markdown, no code blocks`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.2,
      max_tokens: 100
    });

    const result = completion.choices[0]?.message?.content?.trim();
    
    // Remove markdown code blocks if present
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const parsed = JSON.parse(cleaned);
    
    // Validate required fields
    if (!parsed.token || !parsed.condition || !parsed.price) {
      return null;
    }
    
    // Normalize condition
    const condition = parsed.condition.toLowerCase();
    if (condition !== "above" && condition !== "below") {
      return null;
    }
    
    return {
      token: parsed.token.toUpperCase(),
      condition: condition,
      price: parseFloat(parsed.price)
    };
  } catch (error) {
    console.error("Error parsing notification intent:", error);
    return null;
  }
}
