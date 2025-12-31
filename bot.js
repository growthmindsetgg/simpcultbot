require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

// ------------------------------------------------------
// GLOBAL CRASH GUARDS (MOST IMPORTANT)
// ------------------------------------------------------
process.on("uncaughtException", (err) => {
    console.log("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
    console.log("❌ Unhandled Rejection:", reason);
});

// ------------------------------------------------------
// BOT + ENV CONFIG
// ------------------------------------------------------
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const NFT_CONTRACT = process.env.NFT_CONTRACT;
const RPC_URL = process.env.RPC_URL;
const GROUP_ID = process.env.GROUP_ID;
const PRIVATE_LINK = process.env.PRIVATE_LINK;

// ------------------------------------------------------
// JSON DATABASE (SAFE MODE)
// ------------------------------------------------------
let db = {};

function loadDb() {
    try {
        db = JSON.parse(fs.readFileSync("database.json"));
    } catch {
        db = {};
    }
}

function saveDb() {
    try {
        fs.writeFileSync("database.json", JSON.stringify(db, null, 2));
    } catch (e) {
        console.log("DB save error:", e.message);
    }
}

loadDb();

// ------------------------------------------------------
// CHECK MEMBER
// ------------------------------------------------------
async function checkAlreadyMember(userId) {
    try {
        const member = await bot.getChatMember(GROUP_ID, userId);
        if (member.status !== "left" && member.status !== "kicked") return true;
    } catch (e) {}
    return false;
}

// ------------------------------------------------------
// NFT CHECK
// ------------------------------------------------------
async function ownsNFT(wallet) {
    try {
        const res = await axios.post(RPC_URL, {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
                {
                    to: NFT_CONTRACT,
                    data: "0x70a08231" + wallet.replace("0x", "").padStart(64, "0")
                },
                "latest",
            ],
        });

        const hex = res.data.result;
        if (!hex) return false;

        const balance = parseInt(hex, 16);
        return balance > 0;

    } catch (err) {
        console.log("NFT check error:", err.message);
        return false;
    }
}

// ------------------------------------------------------
// VERIFY 0 MON TRANSACTION
// ------------------------------------------------------
async function verifyZeroMonTx(wallet, txHash) {
    if (!txHash || typeof txHash !== "string") return false;

    try {
        const res = await axios.post(RPC_URL, {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getTransactionByHash",
            params: [txHash]
        });

        const tx = res.data.result;
        if (!tx) return false;
        if (!tx.from) return false;

        if (tx.from.toLowerCase() !== wallet.toLowerCase()) return false;

        const value = parseInt(tx.value, 16);
        if (value !== 0) return false;

        return true;

    } catch (err) {
        console.log("verifyZeroMonTx error:", err.message);
        return false;
    }
}

// ------------------------------------------------------
// DAILY NFT RECHECK
// ------------------------------------------------------
setInterval(async () => {
    console.log("Running daily NFT recheck...");

    for (const uid in db) {
        const user = db[uid];
        if (!user.inGroup) continue;

        let stillHasNFT = false;
        try {
            stillHasNFT = await ownsNFT(user.wallet);
        } catch {}

        if (!stillHasNFT && !user.warned) {
            bot.sendMessage(uid, "Warning: You no longer hold a SIMP CULT NFT. You have 48 hours to re-buy.");
            user.warned = true;
            user.warnTime = Date.now();
            saveDb();
        }
    }
}, 24 * 60 * 60 * 1000);

// ------------------------------------------------------
// PURGE CHECK
// ------------------------------------------------------
setInterval(async () => {
    console.log("Running purge check...");

    for (const uid in db) {
        const user = db[uid];
        if (!user.warned || !user.warnTime) continue;

        const hours = (Date.now() - user.warnTime) / (3600 * 1000);
        if (hours < 48) continue;

        let stillHasNFT = false;
        try {
            stillHasNFT = await ownsNFT(user.wallet);
        } catch {}

        if (!stillHasNFT) {
            try {
                await bot.kickChatMember(GROUP_ID, uid);
                bot.sendMessage(uid, "You were removed from SIMP CULT (NFT missing).");

            } catch (e) {
                console.log("Kick error:", e.message);
            }

            user.inGroup = false;
            user.warned = false;
            saveDb();
        }
    }
}, 60 * 60 * 1000);

// ------------------------------------------------------
// /start COMMAND
// ------------------------------------------------------
bot.onText(/\/start/, async (msg) => {
    try {
        const uid = msg.from.id.toString();

        if (await checkAlreadyMember(uid)) {
            return bot.sendMessage(uid, "You are already verified.");
        }

        bot.sendMessage(uid, "Welcome! Send your wallet address to begin.");

        db[uid] = db[uid] || {};
        db[uid].step = "wallet";
        saveDb();

    } catch (err) {
        console.log("start crash:", err);
    }
});

// ------------------------------------------------------
// MAIN MESSAGE HANDLER (FULLY PROTECTED)
// ------------------------------------------------------
bot.on("message", async (msg) => {
    try {
        const uid = msg.from.id.toString();
        const text = msg.text?.trim();

        if (!text) return;

        if (!db[uid] || !db[uid].step) return;

        // STEP 1 — WALLET
        if (db[uid].step === "wallet") {
            if (!text.startsWith("0x") || text.length !== 42)
                return bot.sendMessage(uid, "Invalid wallet address.");

            const hasNFT = await ownsNFT(text);
            if (!hasNFT) return bot.sendMessage(uid, "You do NOT hold a SIMP CULT NFT.");

            db[uid].wallet = text;
            db[uid].step = "tx";
            saveDb();

            return bot.sendMessage(uid, "Now send your 0 MON transaction hash.");
        }

        // STEP 2 — TX HASH
        if (db[uid].step === "tx") {
            if (!text.startsWith("0x") || text.length !== 66)
                return bot.sendMessage(uid, "Invalid transaction hash.");

            const ok = await verifyZeroMonTx(db[uid].wallet, text);
            if (!ok) return bot.sendMessage(uid, "Invalid transaction. Try again.");

            db[uid].verified = true;
            db[uid].inGroup = true;
            db[uid].txHash = text;
            db[uid].warned = false;
            saveDb();

            return bot.sendMessage(uid, "🎉 Verified!\nYour private SIMP CULT link:\n" + PRIVATE_LINK);
        }

    } catch (err) {
        console.log("Message handler crash:", err);
    }
});
