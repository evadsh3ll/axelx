# AXELX Bot

A Telegram bot for Solana DeFi operations with in-app wallet management and natural language processing capabilities.

## Features

### Wallet Management
- `/createwallet` - Create your in-app wallet (private key shown once - save it!)
- `/exportwallet` - Export your wallet private key
- `/about` - Check your SOL balance

### Trading & DeFi Commands
- `/price <token>` - Get token price
- `/tokens` - List available tokens
- `/route <input> <output> <amount>` - Get swap route via Ultra Swap API and execute (supports gasless transactions)
- `/trigger <input> <output> <amount> <price>` - Create trigger order (with confirmation and execute buttons)
- `/trigger orders` - Show active orders with cancel buttons
- `/trigger orderhistory` - Show order history
- `/recurring <input> <output> <totalAmount> <numberOfOrders> <intervalDays>` - Create recurring order (DCA)
- `/recurring orders` - Show active recurring orders with cancel buttons
- `/recurring orderhistory` - Show recurring order history
- `/receivepayment <amount>` - Generate payment request (shows your wallet address)
- `/payto <wallet> <amount>` - Pay to specific wallet
- `/notify <token> <above/below> <price>` - Set price alerts (checks every 2 seconds)
- `/history [type]` - View your activity history

### Natural Language Commands (Auto-Execute)
The bot supports natural language processing and **automatically executes commands**! You can say things like:

- "create wallet" or "create a wallet" → **Executes** `/createwallet`
- "export my wallet" → **Executes** `/exportwallet`
- "what's my balance?" → **Executes** `/about`
- "get price of SOL" → **Executes** `/price SOL`
- "get route for 1 SOL to USDC" or "ultra swap 1 SOL to USDC" → **Executes** `/route SOL USDC 1` (via Ultra Swap API)
- "trigger 1 SOL to USDC at $50" → Shows confirmation button, then creates order, then shows execute button
- "show my orders" or "show orders" → Shows active trigger orders with cancel buttons
- "recurring order 1000 USDC to SOL 10 orders every day" → Shows confirmation button for recurring order
- "dollar cost average 500 USDC into SOL over 5 weeks" → Shows confirmation button for recurring order
- "show my recurring orders" → Shows active recurring orders with cancel buttons
- "receive payment of 10 USDC" → **Executes** `/receivepayment 10000000`
- "pay 5 USDC to [wallet]" → **Executes** `/payto [wallet] 5000000`
- "notify me when SOL goes above $100" → **Executes** `/notify SOL above 100`

## Project Structure

```
├── index.js                 # Main bot file
├── nlp.js                   # NLP processing functions
├── commands/                # Command modules
│   ├── balance.js          # Balance checking functions
│   └── price.js            # Price checking functions
├── handlers/                # Command handlers
│   └── commandHandler.js   # NLP command processor
└── utils/                   # Utility functions
    ├── wallet.js           # Wallet encryption and keypair management
    ├── database.js         # Database operations
    └── tokens.js           # Token resolution utilities
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables in `.env`:
```
TELEGRAM_BOT_TOKEN=your_bot_token
SERVER_URL=your_server_url
GROQ_API_KEY=your_groq_api_key
MONGODB_URI=your_mongodb_connection_string
DB_NAME=your_database_name
WALLET_SECRET=some-long-random-string-for-encryption
JUP_API_KEY=your_jupiter_api_key  # Required for Jupiter API V2
PORT=3000
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com  # Optional
```

**Important**: The `WALLET_SECRET` is used to encrypt all wallet private keys. Use a long, random string (at least 32 characters recommended). Keep this secret secure!

3. Run the bot:
```bash
node index.js
```

## How It Works

### In-App Wallet System
1. **Wallet Creation**: Users create wallets with `/createwallet` - a Solana keypair is generated
2. **Encryption**: Private keys are encrypted using AES-256-CBC with the `WALLET_SECRET`
3. **Storage**: Encrypted private keys are stored in MongoDB
4. **Transaction Signing**: All transactions are signed server-side using the user's wallet
5. **Export**: Users can export their private key anytime with `/exportwallet`

### NLP Processing
1. **Intent Detection**: When a user sends a message, the bot uses Groq's LLM to determine the intent
2. **Intent Classification**: The bot classifies the intent into categories (create_wallet, get_price, etc.)
3. **Parameter Extraction**: For complex commands, the bot extracts parameters like token names, amounts, and prices
4. **Automatic Execution**: The bot automatically executes the appropriate command using the extracted parameters

### Security Notes
- ⚠️ **This is a beta demo wallet system**
- 🔑 **Users must save their private key** - it's shown once during wallet creation
- 💰 **Only deposit test funds** - this is for demonstration purposes
- 🔒 Private keys are encrypted at rest using AES-256-CBC

## Supported Tokens

The bot supports many popular Solana tokens including:
- SOL, USDC, USDT
- WBTC, WETH
- JUP (Jupiter), BONK
- And many more!

## Examples

### Wallet Management:
```
User: /createwallet
Bot: ✅ Your AXELX Wallet is ready
     Public Key: ABC123...
     Private Key (SAVE THIS): xyz789...
     ⚠️ We cannot recover this for you. Save it securely!
```

### Trigger Orders Flow:
1. **Request**: User requests trigger order (via command or natural language)
   - Example: `/trigger SOL USDC 1 50` or "trigger 1 SOL to USDC at $50"
2. **Confirmation**: Bot shows order details with confirmation button
   - User clicks "✅ Confirm & Create Order" or "❌ Cancel"
3. **Order Creation**: Order is created (not executed yet)
   - Bot shows order details with "🚀 Execute Order" button
4. **Execution**: User clicks "Execute Order" button to execute
   - Transaction is signed and sent to the network
5. **View Orders**: Use `/trigger orders` to see active orders
   - Each order has a cancel button
6. **Cancel**: Click cancel button to cancel an active order

### Prerequisites for Trigger Orders:
- ✅ Wallet must be created (`/createwallet`)
- ✅ Minimum order size: **5 USD worth**
- ✅ Sufficient balance in your wallet
- ✅ Valid token pairs (e.g., SOL/USDC, SOL/JUP)

### Recurring Orders Flow (Dollar Cost Averaging):
1. **Request**: User requests recurring order (via command or natural language)
   - Example: `/recurring USDC SOL 1000 10 1` or "recurring order 1000 USDC to SOL 10 orders every day"
2. **Confirmation**: Bot shows order details with confirmation button
   - Shows total amount, number of orders, interval, and amount per order
   - User clicks "✅ Confirm & Create Order" or "❌ Cancel"
3. **Order Creation**: Order is created (not executed yet)
   - Bot shows order details with "🚀 Execute Order" button
4. **Execution**: User clicks "Execute Order" button to execute
   - Transaction is signed and sent to the network
   - Orders will execute automatically at specified intervals
5. **View Orders**: Use `/recurring orders` to see active recurring orders
   - Each order has a cancel button
6. **Cancel**: Click cancel button to cancel an active recurring order

### Prerequisites for Recurring Orders:
- ✅ Wallet must be created (`/createwallet`)
- ✅ Minimum total amount: **100 USD**
- ✅ Minimum per order: **50 USD**
- ✅ Minimum number of orders: **2**
- ✅ Sufficient balance in your wallet
- ✅ Valid token pairs (e.g., USDC/SOL, USDC/JUP)

### Natural Language Examples (All Auto-Execute):
- "I want to create a wallet" → **Executes** `/createwallet`
- "Show me the price of Bitcoin" → **Executes** `/price WBTC`
- "Get me a route for 2 SOL to USDC" → **Executes** `/route SOL USDC 2` (and automatically executes the swap!)
- "Create a trigger order for 1 SOL to USDC at $45" → Shows confirmation button → Creates order → Shows execute button
- "Show my orders" → Shows active trigger orders with cancel buttons
- "Create recurring order 1000 USDC to SOL 10 orders every day" → Shows confirmation button → Creates order → Shows execute button
- "Dollar cost average 500 USDC into JUP weekly for 4 weeks" → Shows confirmation button → Creates order → Shows execute button
- "Show my recurring orders" → Shows active recurring orders with cancel buttons
- "I need to receive 20 USDC" → **Executes** `/receivepayment 20000000` (shows your wallet address)
- "Pay 5 USDC to ABC123..." → **Executes** `/payto ABC123... 5000000` (and automatically executes!)
- "Alert me when JUP goes below $0.5" → **Executes** `/notify JUP below 0.5` (checks every 2 seconds)

### Key Features:
- **No manual command typing**: Just describe what you want
- **Interactive trigger orders**: Confirmation and execute buttons for safety
- **Order management**: View and cancel orders with buttons
- **Automatic transaction execution**: Routes are automatically signed and executed
- **Automatic parameter conversion**: "1 SOL" automatically becomes the correct lamport amount
- **Smart token recognition**: "Bitcoin" → WBTC, "Jupiter" → JUP, etc.
- **Price conversion**: "at $50" automatically becomes the target price parameter
- **In-app wallet**: No external wallet needed - everything happens in the bot
- **Real-time price alerts**: Notifications check price every 2 seconds

## API Integration

The bot integrates with:
- **Jupiter Ultra Swap API** - For swaps with gasless support, best execution, and transaction handling
- **Jupiter Trigger API** - For limit orders
- **Jupiter Recurring API** - For recurring orders (DCA)
- **Jupiter Tokens API V2** - For token search and information
- **Jupiter Price API V2** - For token price data
- **Solana Web3.js** - For transaction signing and wallet management

### Jupiter Ultra Swap API

The `/route` command uses **Jupiter Ultra Swap API** which provides:

- **Gasless Transactions**: Automatic gasless support when applicable (5-10 bps fee)
- **Best Execution**: Routes through Metis Routing Engine for optimal prices across all DEXes
- **Transaction Handling**: Automatic handling of slippage, priority fees, and transaction landing
- **Status Polling**: Built-in transaction status polling (up to 2 minutes)
- **Multiple Swap Types**: Supports both aggregator (Iris) and RFQ (JupiterZ) swap types
- **Error Handling**: Comprehensive error codes for better user experience

**Ultra Swap Features:**
- ✅ Gasless support (when applicable)
- ✅ Automatic priority fee calculation
- ✅ Transaction retry and status polling
- ✅ Best price routing across all DEXes
- ✅ Support for any token pair on Solana
- ✅ Dynamic rate limits based on swap volume

**How it works:**
1. User requests a route (e.g., `/route SOL USDC 1` or "get route for 1 SOL to USDC")
2. Bot fetches quote and swap transaction from Ultra API
3. Transaction is signed with user's wallet
4. Transaction is executed via Ultra API `/execute` endpoint
5. Bot polls for transaction status and reports success/failure

**Ultra API Endpoints Used:**
- `GET /ultra/v1/order` - Get quote and swap transaction
- `POST /ultra/v1/execute` - Execute signed transaction with status polling
- `GET /ultra/v1/search` - Search tokens by symbol, name, or mint address (via Tokens API V2)
- `GET /ultra/v1/holdings/{address}` - Get detailed token holdings (future feature)

**Ultra Swap Response Codes:**
- Success: `status: "Success"` with transaction signature
- Error Codes: Comprehensive error handling for insufficient funds, expired transactions, slippage exceeded, etc.
- Transaction Status: Automatic polling for up to 2 minutes

**Fees:**
- Without custom fees: Jupiter takes 5-10 bps of swap amount
- Gasless transactions: No signature fees when applicable
- Dynamic rate limits: Scale with swap volume (no payment needed)

## Database

The bot uses MongoDB to store:
- Encrypted wallet private keys
- Route history
- Trigger order history
- Recurring order history
- Payment history
- Price check history
- Notification settings

## Development

### Prerequisites
- Node.js 18+
- MongoDB database
- Groq API key (for NLP)
- Telegram Bot Token

### Installation
```bash
npm install
```

### Running
```bash
node index.js
```

The bot makes DeFi operations as easy as having a conversation! 🚀 