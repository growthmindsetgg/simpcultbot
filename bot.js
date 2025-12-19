require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

// ------------------------------------------------------
// BOT + ENV CONFIG
// ------------------------------------------------------
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const NFT_CONTRACT = process.env.NFT_CONTRACT;
const RPC_URL = process.env.RPC_URL;
const GROUP_ID = process.env.GROUP_ID;
const PRIVATE_LINK = process.env.PRIVATE_LINK;

// ------------------------------------------------------
// SIMPLE JSON DATABASE
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
// CHECK IF USER ALREADY IN GROUP
// ------------------------------------------------------
async function checkAlreadyMember(userId) {
    try {
        const member = await bot.getChatMember(GROUP_ID, userId);
        if (member.status !== "left" && member.status !== "kicked") return true;
    } catch (e) {
        console.log("checkAlreadyMember error:", e.message);
    }
    return false;
}

// ------------------------------------------------------
// CHECK IF USER HOLDS NFT
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
// VERIFY 0 MON TX — FULLY SAFE
// ------------------------------------------------------
async function verifyZeroMonTx(wallet, txHash) {
    if (!txHash || typeof txHash !== "string") {
        console.log("txHash undefined");
        return false;
    }

    try {
        const res = await axios.post(RPC_URL, {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getTransactionByHash",
            params: [txHash]
        });

        const tx = res.data.result;

        if (!tx) {
            console.log("Tx not found");
            return false;
        }

        if (!tx.from) return false;
        if (tx.from.toLowerCase() !== wallet.toLowerCase()) {
            console.log("Sender mismatch");
            return false;
        }

        const value = parseInt(tx.value, 16);
        if (value !== 0) {
            console.log("Value not 0 MON");
            return false;
        }

        return true;
    } catch (err) {
        console.log("verifyZeroMonTx error:", err.message);
        return false;
    }
}

// ------------------------------------------------------
// DAILY NFT RECHECK (24 HOURS)
// ------------------------------------------------------
async function dailyRecheck() {
    console.log("Running 24-hour NFT recheck...");

    for (const uid in db) {
        const user = db[uid];
        if (!user.inGroup) continue;

        const stillHasNFT = await ownsNFT(user.wallet);

        if (!stillHasNFT) {
            if (!user.warned) {
                bot.sendMessage(uid, "Warning: You no longer hold a SIMP CULT NFT. You have 48 hours to re-buy or be removed.");
                user.warned = true;
                user.warnTime = Date.now();
                saveDb();
            }
        }
    }
}
setInterval(dailyRecheck, 24 * 60 * 60 * 1000);

// ------------------------------------------------------
// PURGE AFTER 48 HOURS
// ------------------------------------------------------
async function purgeCheck() {
    console.log("Running purge check...");

    for (const uid in db) {
        const user = db[uid];
        if (user.warned && user.warnTime) {
            const hrs = (Date.now() - user.warnTime) / (3600 * 1000);

            if (hrs >= 48) {
                const stillHasNFT = await ownsNFT(user.wallet);
                if (!stillHasNFT) {
                    try {
                        await bot.kickChatMember(GROUP_ID, uid);
                        bot.sendMessage(uid, "You have been removed from the SIMP CULT private group.");

                        user.inGroup = false;
                        user.warned = false;
                        user.warnTime = null;
                        saveDb();
                    } catch (e) {
                        console.log("Kick error:", e.message);
                    }
                }
            }
        }
    }
}
setInterval(purgeCheck, 60 * 60 * 1000);

// ------------------------------------------------------
// BOT COMMANDS
// ------------------------------------------------------
bot.onText(/\/start/, async (msg) => {
    const uid = msg.from.id.toString();

    const already = await checkAlreadyMember(uid);
    if (already) {
        return bot.sendMessage(uid, "You are already verified and inside the SIMP CULT private group.");
    }

    bot.sendMessage(uid, "Welcome! Send your wallet address to begin verification.");

    db[uid] = db[uid] || {};
    db[uid].step = "wallet";
    db[uid].verified = false;
    saveDb();
});

// ------------------------------------------------------
// MAIN MESSAGE HANDLER (CRASH-PROOF)
// ------------------------------------------------------
bot.on("message", async (msg) => {
    const uid = msg.from.id.toString();

    // Ignore non-text messages fully
    if (!msg.text || typeof msg.text !== "string") {
        return bot.sendMessage(uid, "Send text only.");
    }

    const text = msg.text.trim();

    if (!db[uid] || !db[uid].step) return;

    // STEP 1: WALLET
    if (db[uid].step === "wallet") {
        if (!text.startsWith("0x") || text.length !== 42) {
            return bot.sendMessage(uid, "Invalid wallet address. Send again.");
        }

        const holdsNFT = await ownsNFT(text);
        if (!holdsNFT) {
            return bot.sendMessage(uid, "You do NOT hold a SIMP CULT NFT.");
        }

        db[uid].wallet = text;
        db[uid].step = "tx";
        saveDb();

        return bot.sendMessage(uid, "Good. Now send your **0 MON transaction hash**.");
    }

    // STEP 2: TX HASH
    if (db[uid].step === "tx") {
        if (!text.startsWith("0x") || text.length !== 66) {
            return bot.sendMessage(uid, "Invalid transaction hash.");
        }

        const ok = await verifyZeroMonTx(db[uid].wallet, text);

        if (!ok) {
            return bot.sendMessage(uid, "INVALID transaction. Make sure it's a 0 MON self-transaction.");
        }

        db[uid].verified = true;
        db[uid].txHash = text;
        db[uid].warned = false;
        db[uid].warnTime = null;
        db[uid].inGroup = true;
        saveDb();

        return bot.sendMessage(uid, "🎉 Verified!\nHere is your private SIMP CULT invite link:\n\n" + PRIVATE_LINK);
    }
});
