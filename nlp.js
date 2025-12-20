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
          content: `You are an intent classifier for a Solana DeFi Telegram bot with in-app wallet management. The bot integrates with Jupiter API (Ultra Swap, Trigger Orders, Recurring Orders) for DeFi operations.

Analyze the user's message and return ONLY one of these exact intent names:
- "create_wallet" - User wants to create a new wallet (e.g., "create wallet", "make a wallet", "set up wallet")
- "export_wallet" - User wants to export/view their wallet private key (e.g., "export wallet", "show my private key", "get my wallet key")
- "about_wallet" or "get_balance" - User wants to check their balance (e.g., "what's my balance", "check balance", "show balance")
- "get_price" - User wants token price information (e.g., "price of SOL", "what's SOL worth", "show me SOL price")
- "get_route" - User wants a swap route/quote via Ultra Swap API (e.g., "route for 1 SOL to USDC", "swap 2 SOL for USDC", "get route", "ultra swap")
- "trigger_swap" - User wants to create a limit order via Trigger API (e.g., "trigger 1 SOL to USDC at $50", "limit order", "set trigger")
- "recurring_order" - User wants to create a recurring/DCA order via Recurring API (e.g., "recurring order 1000 USDC to SOL 10 orders every day", "dollar cost average 500 USDC into SOL over 5 weeks", "recurring swap", "schedule recurring", "DCA", "recurring", "automated orders")
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
5. Balance checks can be either "about_wallet" or "get_balance"
6. If user mentions "recurring", "DCA", "dollar cost average", "schedule", or "automated orders", use "recurring_order"
7. If user mentions "trigger", "limit order", or "price target", use "trigger_swap"`

        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.2,
      max_tokens: 30
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
  "inputMint": "token symbol (e.g., SOL, USDC, JUP, BONK)",
  "outputMint": "token symbol (e.g., USDC, SOL, USDT)",
  "amount": number (amount of input token),
  "targetPrice": number (target price in USD)
}

Examples:
- "trigger 1 SOL to USDC at $50" → {"inputMint": "SOL", "outputMint": "USDC", "amount": 1, "targetPrice": 50}
- "limit order 2 SOL for USDT when price is $45" → {"inputMint": "SOL", "outputMint": "USDT", "amount": 2, "targetPrice": 45}
- "set trigger for 0.5 SOL to JUP at $100" → {"inputMint": "SOL", "outputMint": "JUP", "amount": 0.5, "targetPrice": 100}
- "create a trigger order for 1.5 SOL to USDC at price $150" → {"inputMint": "SOL", "outputMint": "USDC", "amount": 1.5, "targetPrice": 150}
- "I want to trigger 0.1 SOL to BONK at $0.00001" → {"inputMint": "SOL", "outputMint": "BONK", "amount": 0.1, "targetPrice": 0.00001}
- "make a limit order 3 SOL to USDC at $200" → {"inputMint": "SOL", "outputMint": "USDC", "amount": 3, "targetPrice": 200}

Important:
- Extract targetPrice as a number (remove $ sign and any currency symbols)
- Extract amount as a number (can be decimal like 0.5, 1.5, etc.)
- Use uppercase token symbols (SOL, USDC, JUP, BONK, etc.)
- The targetPrice is the price at which the order should execute
- Minimum order size is 5 USD worth
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

/**
 * Extract recurring order parameters from user message
 * @param {string} text - User's message
 * @returns {Promise<Object|null>} - Recurring order parameters {inputMint, outputMint, totalAmount, numberOfOrders, intervalDays}
 */
export async function parseRecurringIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Extract recurring order parameters from the user's message for Jupiter Recurring API (time-based orders). Return a valid JSON object with:
{
  "inputMint": "token symbol (e.g., USDC, SOL)",
  "outputMint": "token symbol (e.g., SOL, USDC, JUP)",
  "totalAmount": number (total amount in USD or input token),
  "numberOfOrders": number (number of orders, minimum 2),
  "intervalDays": number (days between orders, e.g., 1 for daily, 7 for weekly)
}

Examples:
- "recurring order 1000 USDC to SOL 10 orders every day" → {"inputMint": "USDC", "outputMint": "SOL", "totalAmount": 1000, "numberOfOrders": 10, "intervalDays": 1}
- "recurring order 1000 USDC to SOL 10 orders every day" → {"inputMint": "USDC", "outputMint": "SOL", "totalAmount": 1000, "numberOfOrders": 10, "intervalDays": 1}
- "recurring order 1000 USDC to SOL 10 orders every day" → {"inputMint": "USDC", "outputMint": "SOL", "totalAmount": 1000, "numberOfOrders": 10, "intervalDays": 1}
- "dollar cost average 500 USDC into SOL over 5 weeks" → {"inputMint": "USDC", "outputMint": "SOL", "totalAmount": 500, "numberOfOrders": 5, "intervalDays": 7}
- "schedule recurring swap 2000 USDC to JUP 20 times every 2 days" → {"inputMint": "USDC", "outputMint": "JUP", "totalAmount": 2000, "numberOfOrders": 20, "intervalDays": 2}
- "recurring 100 USDC to SOL weekly for 4 weeks" → {"inputMint": "USDC", "outputMint": "SOL", "totalAmount": 100, "numberOfOrders": 4, "intervalDays": 7}
- "recurring order 1000 USDC to SOL 10 orders every day" → {"inputMint": "USDC", "outputMint": "SOL", "totalAmount": 1000, "numberOfOrders": 10, "intervalDays": 1}
- "create recurring order for 500 USDC to JUP 5 orders every 3 days" → {"inputMint": "USDC", "outputMint": "JUP", "totalAmount": 500, "numberOfOrders": 5, "intervalDays": 3}

Important:
- Extract totalAmount as a number (total amount to invest, remove currency symbols)
- Extract numberOfOrders as a number (minimum 2, look for "orders", "times", "weeks", etc.)
- Extract intervalDays as a number (days between orders: "every day" = 1, "every 2 days" = 2, "weekly" = 7, "every week" = 7)
- Use uppercase token symbols (USDC, SOL, JUP, etc.)
- "every day" or "daily" = 1 day
- "every week" or "weekly" = 7 days
- "every 2 days" = 2 days
- "over 5 weeks" with 5 orders = 7 days interval
- Minimum total: 100 USD, minimum per order: 50 USD
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
    
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("JSON parse error in parseRecurringIntent:", parseError, "Raw result:", result);
      // Try to extract manually if JSON parsing fails
      const textLower = text.toLowerCase();
      const usdcMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:USDC|usdc)/i);
      const solMatch = text.match(/to\s+(SOL|sol)/i);
      const ordersMatch = text.match(/(\d+)\s*(?:orders?|times?)/i);
      const dayMatch = text.match(/every\s+(?:(\d+)\s*)?day/i) || text.match(/daily/i);
      
      if (usdcMatch && solMatch && ordersMatch) {
        const totalAmount = parseFloat(usdcMatch[1]);
        const numberOfOrders = parseInt(ordersMatch[1]);
        const intervalDays = dayMatch && dayMatch[1] ? parseFloat(dayMatch[1]) : (dayMatch ? 1 : 1);
        
        return {
          inputMint: "USDC",
          outputMint: "SOL",
          totalAmount,
          numberOfOrders,
          intervalDays
        };
      }
      return null;
    }
    
    // Validate required fields
    if (!parsed.inputMint || !parsed.outputMint || !parsed.totalAmount || !parsed.numberOfOrders || !parsed.intervalDays) {
      return null;
    }
    
    // Validate minimums
    if (parsed.numberOfOrders < 2) {
      return null;
    }
    
    return {
      inputMint: parsed.inputMint.toUpperCase(),
      outputMint: parsed.outputMint.toUpperCase(),
      totalAmount: parseFloat(parsed.totalAmount),
      numberOfOrders: parseInt(parsed.numberOfOrders),
      intervalDays: parseFloat(parsed.intervalDays)
    };
  } catch (error) {
    console.error("Error parsing recurring intent:", error);
    return null;
  }
}
